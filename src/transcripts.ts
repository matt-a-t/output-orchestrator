import { readFile, readdir, stat } from 'node:fs/promises';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
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

/**
 * How much context the thread's claude carries, from its transcript: what its last turn sent (fresh, cached and
 * newly cached tokens together), when, and how long the prompt cache keeps it. Past that, resuming re-reads the
 * whole context at full price instead of from the cache. `compacted` when the conversation has been compacted since
 * its last turn: `tokens` is then a rough guess from the summary's length, and `at` when it was compacted.
 */
export type ContextUse = { tokens: number; at: number; cacheMs: number; compacted?: boolean };

const CACHE_5M = 5 * 60_000;
// Roughly, for English and code.
const CHARS_PER_TOKEN = 4;
// What every turn sends besides the conversation (system prompt, tools), give or take, for guessing a compacted one's size.
const BASE_CONTEXT = 20_000;
const CACHE_1H = 60 * 60_000;
// The last turn is near the end, so read only this much of a long transcript, unless it isn't there.
const TAIL_BYTES = 1024 * 1024;

const contextCache = new Map<string, { mtimeMs: number; size: number; use: ContextUse | undefined }>();

/** The thread's ContextUse, or undefined with no transcript or no turn in it yet. Re-read only once the transcript changes. */
export function contextUse(transcriptPath: string): ContextUse | undefined {
	let stats;
	try {
		stats = statSync(transcriptPath);
	} catch {
		return;
	}
	const cached = contextCache.get(transcriptPath);
	if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached.use;
	let use: ContextUse | undefined;
	try {
		use = readContextUse(readTail(transcriptPath, stats.size, TAIL_BYTES));
		if (!use && stats.size > TAIL_BYTES) use = readContextUse(readFileSync(transcriptPath, 'utf8'));
	} catch {
		return;
	}
	contextCache.set(transcriptPath, { mtimeMs: stats.mtimeMs, size: stats.size, use });
	return use;
}

function readTail(path: string, size: number, bytes: number): string {
	const fd = openSync(path, 'r');
	try {
		const length = Math.min(size, bytes);
		const buffer = Buffer.alloc(length);
		readSync(fd, buffer, 0, length, size - length);
		// The first line is likely cut off part way; it won't parse, so it's skipped.
		return buffer.toString('utf8');
	} finally {
		closeSync(fd);
	}
}

type Usage = {
	input_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
	cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
};

/** ContextUse from transcript text: the last main-thread turn, and the cache lifetime the latest cache write asked for. */
export function readContextUse(text: string): ContextUse | undefined {
	const lines = text.split('\n');
	let last: { tokens: number; at: number } | undefined;
	// Characters of conversation since the last turn, for a guess at its size if it was compacted since.
	let chars = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		let entry;
		try {
			entry = JSON.parse(lines[i]!);
		} catch {
			continue;
		}
		// The files claude re-attaches after compacting count too.
		if (!last && !entry.isSidechain && (entry.type === 'user' || entry.type === 'assistant')) chars += JSON.stringify(entry.message?.content ?? '').length;
		if (!last && !entry.isSidechain && entry.type === 'attachment') chars += JSON.stringify(entry.attachment ?? '').length;
		// Compacted after its last turn: what's left is the summary and what came after, and nothing of it is cached.
		if (!last && entry.type === 'system' && entry.subtype === 'compact_boundary' && !entry.isSidechain) {
			const at = Date.parse(entry.timestamp);
			if (!Number.isNaN(at)) return { tokens: BASE_CONTEXT + Math.round(chars / CHARS_PER_TOKEN), at, cacheMs: 0, compacted: true };
		}
		if (entry.type !== 'assistant' || entry.isSidechain) continue;
		const usage: Usage | undefined = entry.message?.usage;
		if (!usage) continue;
		const tokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
		// Errors claude reports as messages of its own sent nothing.
		if (tokens === 0) continue;
		const at = Date.parse(entry.timestamp);
		if (!last) {
			if (Number.isNaN(at)) continue;
			last = { tokens, at };
		}
		// A turn read wholly from the cache doesn't say how long it lasts, so look back to the last write.
		const { ephemeral_1h_input_tokens: hour = 0, ephemeral_5m_input_tokens: minutes = 0 } = usage.cache_creation ?? {};
		if (hour > 0) return { ...last, cacheMs: CACHE_1H };
		if (minutes > 0) return { ...last, cacheMs: CACHE_5M };
	}
	return last && { ...last, cacheMs: CACHE_5M };
}

/** How long the cache stays warm from `now` (ms); 0 or less once it's gone cold. */
export const cacheLeft = (use: ContextUse, now: number) => use.at + use.cacheMs - now;

/** Context of this many tokens or more is worth a second thought before resuming cold. */
export const LARGE_CONTEXT = 150_000;

/** Tokens, short: 850, 12k, 1.2M. */
export function formatTokens(tokens: number): string {
	if (tokens < 1000) return `${tokens}`;
	if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** A length of time, short and rounded up so a warm cache never reads 0m: 3m, 1h, 2d. */
export function shortDuration(ms: number): string {
	const minutes = Math.max(1, Math.ceil(ms / 60_000));
	if (minutes < 60) return `${minutes}m`;
	if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h`;
	return `${Math.floor(minutes / (24 * 60))}d`;
}

/** One line on the thread's context: its size and whether the cache is still warm. */
export function describeContext(use: ContextUse, now: number): string {
	if (use.compacted) return `~${formatTokens(use.tokens)} tokens, compacted ${shortDuration(now - use.at)} ago`;
	const left = cacheLeft(use, now);
	const cache = left > 0 ? `cache warm for ${shortDuration(left)}` : `cache went cold ${shortDuration(-left)} ago, so resuming re-reads it all`;
	return `${formatTokens(use.tokens)} tokens, ${cache}`;
}

export function timeAgo(date: Date): string {
	const minutes = Math.floor((Date.now() - date.getTime()) / 60_000);
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes}m ago`;
	if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h ago`;
	return `${Math.floor(minutes / (24 * 60))}d ago`;
}
