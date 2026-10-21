import { readFile, readdir, stat } from 'node:fs/promises';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

// Written to within this long ago, a session may still be running in another terminal.
const ACTIVE_MS = 2 * 60_000;

export type Session = {
	id: string;
	transcriptPath: string;
	// Where claude ran; `--resume` only finds the session from here.
	cwd: string;
	// The session's /rename title or claude's own, else the first prompt.
	title: string;
	firstPrompt: string;
	lastActivity: Date;
};

/** Claude Code keeps a directory's transcripts under its path with everything but letters and digits as `-`. */
function transcriptDir(cwd: string): string {
	return join(PROJECTS_DIR, resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
}

/**
 * Copy a transcript to where claude looks for sessions started in `cwd`, so `claude --resume`
 * finds it after the thread moves directory (see UI testing). Returns the new path.
 */
export function copySession(transcriptPath: string, cwd: string): string | undefined {
	if (!existsSync(transcriptPath)) return;
	const dir = transcriptDir(cwd);
	const target = join(dir, basename(transcriptPath));
	mkdirSync(dir, { recursive: true });
	copyFileSync(transcriptPath, target);
	return target;
}

function promptText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content
		.filter(block => block?.type === 'text' && typeof block.text === 'string')
		.map(block => block.text)
		.join(' ');
}

/** Pull the cwd, first typed prompt and title out of a transcript; undefined if nothing was ever asked. */
function summarise(id: string, transcriptPath: string, text: string, lastActivity: Date): Session | undefined {
	let cwd: string | undefined;
	let firstPrompt: string | undefined;
	let customTitle: string | undefined;
	let aiTitle: string | undefined;
	for (const line of text.split('\n')) {
		if (!line) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		cwd ??= entry.cwd;
		if (entry.type === 'custom-title') customTitle = entry.customTitle;
		if (entry.type === 'ai-title') aiTitle = entry.aiTitle;
		if (firstPrompt === undefined && entry.type === 'user' && !entry.isMeta && !entry.isSidechain) {
			// Older transcripts have no origin; tool results and slash-command wrappers aren't prompts.
			const typed = entry.origin ? entry.origin.kind === 'human' : true;
			const prompt = promptText(entry.message?.content).replace(/\s+/g, ' ').trim();
			if (typed && prompt && !prompt.startsWith('<')) firstPrompt = prompt;
		}
	}
	if (!cwd || !firstPrompt) return;
	return { id, transcriptPath, cwd, title: customTitle ?? aiTitle ?? firstPrompt, firstPrompt, lastActivity };
}

/** The most recent sessions from any directory, newest first. */
export async function listSessions(limit = 30): Promise<Session[]> {
	let dirs: string[];
	try {
		dirs = await readdir(PROJECTS_DIR);
	} catch {
		return [];
	}
	const files = (
		await Promise.all(
			dirs.map(async dir => {
				const names = await readdir(join(PROJECTS_DIR, dir)).catch(() => []);
				return Promise.all(
					names
						.filter(name => name.endsWith('.jsonl'))
						.map(async name => {
							const path = join(PROJECTS_DIR, dir, name);
							return { name, path, mtime: (await stat(path)).mtime };
						}),
				);
			}),
		)
	).flat();
	files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
	const sessions: Session[] = [];
	// Read a few spare in case some turn out empty.
	for (const file of files.slice(0, limit * 2)) {
		const session = summarise(file.name.slice(0, -'.jsonl'.length), file.path, await readFile(file.path, 'utf8'), file.mtime);
		if (session) sessions.push(session);
		if (sessions.length === limit) break;
	}
	return sessions;
}

/** Whether the transcript was written to recently enough that its claude may still be running. */
export function recentlyActive(transcriptPath: string): boolean {
	try {
		return Date.now() - statSync(transcriptPath).mtimeMs < ACTIVE_MS;
	} catch {
		return false;
	}
}

export function timeAgo(date: Date): string {
	const minutes = Math.floor((Date.now() - date.getTime()) / 60_000);
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes}m ago`;
	if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h ago`;
	return `${Math.floor(minutes / (24 * 60))}d ago`;
}
