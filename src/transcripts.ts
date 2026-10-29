import { readFile, readdir, stat } from 'node:fs/promises';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { sanitize } from './sanitize.js';

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

// Written to within this long ago, a thread may still be running in another terminal.
const ACTIVE_MS = 2 * 60_000;

/** A thread claude ran outside the board, read from its transcript. */
export type OutsideThread = {
	id: string;
	transcriptPath: string;
	// Where claude ran; `--resume` only finds the thread from here.
	cwd: string;
	// The thread's /rename title or claude's own, else the first prompt.
	title: string;
	firstPrompt: string;
	lastActivity: Date;
};

/** Claude Code keeps a directory's transcripts under its path with everything but letters and digits as `-`. */
function transcriptDir(cwd: string): string {
	return join(PROJECTS_DIR, resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
}

/**
 * Copy a transcript to where claude looks for threads started in `cwd`, so `claude --resume`
 * finds it after the thread moves directory (see Local). Returns the new path.
 */
export function copyTranscript(transcriptPath: string, cwd: string): string | undefined {
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
function summarise(id: string, transcriptPath: string, text: string, lastActivity: Date): OutsideThread | undefined {
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

/** The most recent threads started in `cwd`, newest first. */
export async function listOutsideThreads(cwd: string, limit = 20): Promise<OutsideThread[]> {
	const dir = transcriptDir(cwd);
	let names: string[];
	try {
		names = (await readdir(dir)).filter(name => name.endsWith('.jsonl'));
	} catch {
		return [];
	}
	const files = await Promise.all(
		names.map(async name => ({ name, path: join(dir, name), mtime: (await stat(join(dir, name))).mtime })),
	);
	files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
	const threads: OutsideThread[] = [];
	// Read a few spare in case some turn out empty.
	for (const file of files.slice(0, limit * 2)) {
		const thread = summarise(file.name.slice(0, -'.jsonl'.length), file.path, await readFile(file.path, 'utf8'), file.mtime);
		// The encoding isn't reversible, so make sure it's really this directory's.
		if (thread && resolve(thread.cwd) === resolve(cwd)) threads.push(thread);
		if (threads.length === limit) break;
	}
	return threads;
}

/**
 * The text of claude's last message in a transcript, sanitized: its text blocks, which the transcript
 * keeps one per entry under the message's id. undefined if it has none (or there's no transcript).
 */
export function lastAssistantText(transcriptPath: string): string | undefined {
	let text: string;
	try {
		text = readFileSync(transcriptPath, 'utf8');
	} catch {
		return;
	}
	const entries: { id?: string; text: string }[] = [];
	for (const line of text.split('\n')) {
		if (!line) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type !== 'assistant' || entry.isSidechain) continue;
		const content = entry.message?.content;
		const blocks = Array.isArray(content) ? content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text as string) : [];
		if (blocks.length) entries.push({ id: entry.message?.id, text: blocks.join('\n\n') });
	}
	const last = entries.at(-1);
	if (!last) return;
	const parts = last.id ? entries.filter(e => e.id === last.id).map(e => e.text) : [last.text];
	return sanitize(parts.join('\n\n')).trim() || undefined;
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
