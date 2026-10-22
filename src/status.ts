import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonlReader } from './jsonl.js';
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

/** Incrementally reads hook events appended to the events file. */
export class EventReader extends JsonlReader<HookEvent> {
	constructor() {
		super(EVENTS_FILE, e => typeof e.thread === 'string' && typeof e.event === 'string');
	}
}
