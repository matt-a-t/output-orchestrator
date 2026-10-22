import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonlReader } from './jsonl.js';
import { DATA_DIR } from './state.js';
import { THREAD_USAGE } from './threadCommand.js';

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

export const SKILL_FILE = join(homedir(), '.claude', 'skills', 'oo', 'SKILL.md');

export const SKILL = `---
name: oo
description: Read and change the output-orchestrator (oo) board of threads with the \`oo thread\` CLI. Use when OO_THREAD_ID is set (this claude was launched from the board), when the user mentions the board, a thread by number (#12) or oo, or when follow-up work turns up that belongs in its own thread.
---

# The oo board

The user tracks work as threads on a kanban board (Planned → Active → Polish → UI testing → PR → Done).
Each thread has its own git worktree, branch and claude. If \`OO_THREAD_ID\` is set, you are that thread's
claude, and \`oo thread show\` describes your thread, including its plan.

## Commands

\`\`\`
${THREAD_USAGE}
\`\`\`

## When to use them

- **Follow-up work goes in a new thread.** When you notice a bug, cleanup or feature outside this thread's
  plan, don't do it here: file it with \`oo thread add <title> --plan-file - <<'EOF'\` and a plan saying what
  and why, then tell the user its id. Keep the title short; put the detail in the plan.
- **Read before you plan.** \`oo thread show\` has this thread's plan; \`oo thread list\` shows what else is
  in flight, so you don't duplicate it.
- **Move threads only when the user asks.** Never move your own thread to done or archived: that removes
  its worktree and closes this claude. Moves into or out of UI testing, and to PR, happen on the board.
`;

/** Install the skill that tells claude about \`oo thread\` (see threadCommand.ts). */
export function writeOoSkill(): void {
	mkdirSync(dirname(SKILL_FILE), { recursive: true });
	writeFileSync(SKILL_FILE, SKILL);
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

/** Incrementally reads hook events appended to the events file. */
export class EventReader extends JsonlReader<HookEvent> {
	constructor() {
		super(EVENTS_FILE, e => typeof e.thread === 'string' && typeof e.event === 'string');
	}
}
