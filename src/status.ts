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
const fromSource = import.meta.url.endsWith('.ts');
const HOOK_SCRIPT = fileURLToPath(new URL(fromSource ? './hook.ts' : './hook.js', import.meta.url));
// These import the rest of oo, so from source they need tsx's loader too, which execArgv carries.
const ooHook = (name: string) => [
	...(fromSource ? process.execArgv : []),
	fileURLToPath(new URL(fromSource ? `./${name}.ts` : `./${name}.js`, import.meta.url)),
];
const PLAN_HOOK = ooHook('planHook');
const SESSION_HOOK = ooHook('sessionHook');
/** oo itself (this same dist or source), for tmux keys and panes that call back into it. */
export const OO_COMMAND = [
	process.execPath,
	...(fromSource ? process.execArgv : []),
	fileURLToPath(new URL(fromSource ? './cli.tsx' : './cli.js', import.meta.url)),
];

const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd'];

/** Write the settings file passed to every thread's claude via `--settings`. */
export function writeClaudeSettings(): void {
	const node = (args: string[]) => [process.execPath, '--no-warnings', ...args].map(arg => JSON.stringify(arg)).join(' ');
	const command = node([HOOK_SCRIPT]);
	const hooks: Record<string, { matcher: string; hooks: { type: string; command: string }[] }[]> = Object.fromEntries(
		HOOK_EVENTS.map(event => [event, [{ matcher: '*', hooks: [{ type: 'command', command }] }]]),
	);
	hooks.PostToolUse!.push({ matcher: 'ExitPlanMode', hooks: [{ type: 'command', command: node(PLAN_HOOK) }] });
	hooks.SessionStart!.push({ matcher: '*', hooks: [{ type: 'command', command: node(SESSION_HOOK) }] });
	mkdirSync(DATA_DIR, { recursive: true });
	writeFileSync(CLAUDE_SETTINGS_FILE, JSON.stringify({ hooks }, null, 2));
}

export const SKILL_FILE = join(homedir(), '.claude', 'skills', 'oo', 'SKILL.md');

export const SKILL = `---
name: oo
description: Read and change the output-orchestrator (oo) board of threads with the \`oo thread\` CLI. Use when OO_THREAD_ID is set (this claude was launched from the board), when the user mentions the board, a thread by number (#12) or oo, or when follow-up work turns up that belongs in its own thread.
---

# The oo board

The user tracks work as threads on a kanban board (Planned → Active → Polish → PR → Done).
A thread can also be put in Local (it stays in its column, outlined in yellow), which checks its branch out in the project's own checkout
(one per project) so the user can try it in their own dev setup; claude then works there until it comes back to its worktree.
Each thread has its own git worktree, branch and claude. If \`OO_THREAD_ID\` is set, you are that thread's
claude, and \`oo thread show\` describes your thread, including its plan.

## Commands

\`\`\`
${THREAD_USAGE}
\`\`\`

## When to use them

- **Planned means planning only.** If \`oo thread show\` says your thread is in PLANNED, don't change code,
  create files or commit: its claude starts in plan mode. Work out what to build (read the code, ask questions)
  and save it with \`oo thread plan --plan-file - <<'EOF'\`. When the user approves your plan as you leave plan
  mode, the board saves it as the thread's plan and moves the thread to Active, and the work can start.
- **Work through the thread's checkpoints.** Once the plan is approved, save its checkpoints with
  \`oo thread todo set --file - <<'EOF'\`, one per line: each a step the user can review and commit on its own.
  Mark one \`active\` as you start it and \`review\` when it's ready, then stop for the user to review it;
  approving the step on the board commits it, marks it \`done\` and tells you to move on. The list stays on the thread across claude
  runs and shows on its card, so keep it current.
- **Follow-up work goes in a new thread.** When you notice a bug, cleanup or feature outside this thread's
  plan, don't do it here: file it with \`oo thread add <title> --plan-file - <<'EOF'\` and a plan saying what
  and why, then tell the user its id. Keep the title short; put the detail in the plan. If it's for a Jira
  ticket or GitHub issue, pass \`--ticket <key>\`: the thread's branch and PR are named after it.
- **Threads' ids are local to this board.** \`#12\` means nothing on another machine, so don't put a thread
  id in commits, branches or PRs. Refer to the thread's ticket (\`oo thread show\` lists it) instead.
- **Read before you plan.** \`oo thread show\` has this thread's plan; \`oo thread list\` shows what else is
  in flight, so you don't duplicate it.
- **Move threads only when the user asks.** Never move your own thread to done or archived: that removes
  its worktree and closes this claude. Moving to PR happens on the board.
- **Offer Local when the user wants to try the change.** If they want to test or try it themselves, offer to
  put the thread in Local and run \`oo thread local in\` once they agree; \`oo thread local out\` brings it back.
  Commit or approve the changes first, because the worktree has to be clean. This claude is closed and resumed
  in the project's checkout (or back in its worktree) once the turn ends, so finish what you're saying first.
  Never move a thread into or out of Local without asking.
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

/** working ⚙, waiting ⏸ (needs you), stopped ✓, idle (window open, nothing yet), ended, or interrupted (ended mid-work). */
export type Status = 'working' | 'waiting' | 'stopped' | 'idle' | 'ended' | 'interrupted';

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
			// Closed while it was still going, e.g. its window was killed: w wakes it.
			return current === 'working' ? 'interrupted' : 'ended';
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
	constructor(file = EVENTS_FILE) {
		super(file, e => typeof e.thread === 'string' && typeof e.event === 'string');
	}
}

/** The thread's status from all its events so far, as the board works it out, for commands run outside it. */
export function threadStatus(thread: string, dir: string | undefined, file = EVENTS_FILE): Status | undefined {
	let status: Status | undefined;
	for (const e of new EventReader(file).read()) {
		if (e.thread === thread && fromThreadDir(e, dir)) status = nextStatus(status, e) ?? status;
	}
	return status;
}
