import { closeSync, openSync, readSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './state.js';

export const EVENTS_FILE = join(DATA_DIR, 'events.jsonl');
export const CLAUDE_SETTINGS_FILE = join(DATA_DIR, 'claude-settings.json');

// Run from source (tsx) we point at hook.ts and let Node strip the types.
const HOOK_SCRIPT = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './hook.ts' : './hook.js', import.meta.url));

const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd'];

/** Write the settings file passed to every thread's claude via `--settings`. */
export function writeClaudeSettings(): void {
	const command = `${JSON.stringify(process.execPath)} --no-warnings ${JSON.stringify(HOOK_SCRIPT)}`;
	const hooks = Object.fromEntries(
		HOOK_EVENTS.map(event => [event, [{ matcher: '*', hooks: [{ type: 'command', command }] }]]),
	);
	mkdirSync(DATA_DIR, { recursive: true });
	writeFileSync(CLAUDE_SETTINGS_FILE, JSON.stringify({ hooks }, null, 2));
}

export type HookEvent = {
	thread: string;
	event: string;
	session?: string;
	transcript?: string;
	/** Where claude was running. Missing from lines written before it was recorded. */
	cwd?: string;
	type?: string;
	ts: string;
};

/** working ⚙, waiting ⏸ (needs you), stopped ✓, idle (window open, nothing yet), ended. */
export type Status = 'working' | 'waiting' | 'stopped' | 'idle' | 'ended';

export function nextStatus(current: Status | undefined, e: HookEvent): Status | undefined {
	switch (e.event) {
		case 'SessionStart':
			return 'idle';
		case 'UserPromptSubmit':
		case 'PostToolUse':
			return 'working';
		case 'Notification':
			// idle_prompt fires a while after Stop; it isn't a request for attention.
			return e.type === 'idle_prompt' || e.type === 'auth_success' ? current : 'waiting';
		case 'Stop':
			return 'stopped';
		case 'SessionEnd':
			return 'ended';
		default:
			return current;
	}
}

/**
 * Whether the event came from a claude working in the thread's directory (or a subfolder).
 * OO_THREAD_ID can leak into a claude started for another thread, e.g. when Claude Code's
 * background daemon re-hosts every running claude with the environment of the first, so the
 * thread ID alone can't be trusted. Events without a cwd, or for threads with no directory,
 * can't be checked and are kept.
 */
export function fromThreadDir(e: HookEvent, dir: string | undefined): boolean {
	if (!e.cwd || !dir) return true;
	const cwd = resolve(e.cwd);
	const root = resolve(dir);
	return cwd === root || cwd.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Incrementally reads complete lines appended to the events file. */
export class EventReader {
	private offset = 0;
	private partial = '';

	read(): HookEvent[] {
		let size: number;
		try {
			size = statSync(EVENTS_FILE).size;
		} catch {
			return [];
		}
		if (size < this.offset) {
			// Truncated or replaced: start over.
			this.offset = 0;
			this.partial = '';
		}
		if (size === this.offset) return [];
		const buf = Buffer.alloc(size - this.offset);
		const fd = openSync(EVENTS_FILE, 'r');
		try {
			readSync(fd, buf, 0, buf.length, this.offset);
		} finally {
			closeSync(fd);
		}
		this.offset = size;
		const lines = (this.partial + buf.toString('utf8')).split('\n');
		this.partial = lines.pop() ?? '';
		const events: HookEvent[] = [];
		for (const line of lines) {
			try {
				const e = JSON.parse(line);
				if (typeof e.thread === 'string' && typeof e.event === 'string') events.push(e);
			} catch {}
		}
		return events;
	}
}
