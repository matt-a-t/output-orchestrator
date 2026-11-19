// Starting, stopping and waking a thread's claude in its tmux window.

import { existsSync } from 'node:fs';
import { useEffect, useRef } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { stillWorking, unknownProject } from '../errors.js';
import { DEFAULT_WAKE_PROMPT, hidden, type State, type Thread } from '../state.js';
import { CLAUDE_SETTINGS_FILE, CONTAINER_SETTINGS_FILE, type Status } from '../status.js';
import { containerName, containerProject, forThread, stopKeyed, threadShell } from '../container.js';
import { inCheckout, threadDir } from '../threads.js';
import { killWindow, openSplit, openWindow, pasteInto, threadWindowLabel, threadWindowName, windowNames } from '../tmux.js';
import { cacheLeft, contextUse, formatTokens, LARGE_CONTEXT, recentlyActive, shortDuration, type ContextUse } from '../transcripts.js';
import type { Binding } from './bindings.js';
import { onThread, type Board } from './board.js';
import { createWorktree, inWorktree } from './worktree.js';

export type PermissionMode = 'plan' | 'auto';

/** What w tells a thread's claude that has never run, e.g. one made with no initial prompt. */
const START_PROMPT = 'This is a new oo thread. Run `oo thread show` to read its title, plan, ticket and checkpoints, then get started on it.';

/** What the fresh claude that takes over from a large planning conversation is told (see useFreshStarts). */
const PLANNED_PROMPT = "This oo thread's plan is approved and its checkpoints are saved. Run `oo thread show` to read its title, plan, ticket and checkpoints, then start on the first checkpoint.";

/** Claude session ID to resume the thread with, if its transcript still exists. */
export function resumeId(thread: Thread): string | undefined {
	if (thread.sessionId && thread.transcriptPath && existsSync(thread.transcriptPath)) return thread.sessionId;
}

/**
 * The thread's context, if resuming it would be costly: its claude is closed, and it carries a large context
 * whose prompt cache has gone cold, so its next turn re-reads all of it at full price.
 */
export function coldResume(board: Board, thread: Thread, now = Date.now()): ContextUse | undefined {
	if (board.liveWindows().has(threadWindowName(thread.id)) || !(thread.branch || thread.cwd) || !resumeId(thread)) return;
	const use = contextUse(thread.transcriptPath!, { fresh: true });
	if (use && use.tokens >= LARGE_CONTEXT && cacheLeft(use, now) <= 0) return use;
}

/**
 * Go on with `start` (resuming as usual), unless resuming would be costly (coldResume): then ask first,
 * y resuming anyway and n starting a fresh claude (`start(true)`) that reads the thread's plan and checkpoints.
 */
function askBeforeColdResume(board: Board, thread: Thread, start: (fresh: boolean) => unknown) {
	const use = coldResume(board, thread);
	if (!use) return start(false);
	board.ask(
		`#${thread.id} has ${formatTokens(use.tokens)} tokens of context and its cache went cold ${shortDuration(-cacheLeft(use, Date.now()))} ago, so resuming re-reads it all — y resumes · n starts a fresh claude on its plan and checkpoints`,
		() => start(false),
		() => start(true),
	);
}

/**
 * Closed while claude was still working, e.g. its window was killed. Still working with no window
 * covers a claude killed too hard to report SessionEnd.
 */
export function stalled(board: Board, thread: Thread) {
	const status = board.statuses()[thread.id];
	return !board.liveWindows().has(threadWindowName(thread.id)) && (status === 'interrupted' || status === 'working');
}

/**
 * Jump to the thread's claude window, starting claude in `cwd` (resuming the thread if it can) if needed.
 * `background` starts it without leaving the board; `resumeAnyway` skips the check for it being open elsewhere.
 * A thread in Planned is for planning only, so its claude starts in plan mode unless `mode` says otherwise.
 * `prompt` is sent as a new claude's first message. `fresh` starts a new claude even if the thread could be resumed.
 */
export async function launchClaude(
	board: Board,
	thread: Thread,
	cwd: string,
	{
		background = false,
		resumeAnyway = false,
		mode = thread.column === 'planned' ? 'plan' : undefined,
		prompt,
		fresh = false,
	}: { background?: boolean; resumeAnyway?: boolean; mode?: PermissionMode; prompt?: string; fresh?: boolean } = {},
): Promise<void> {
	// No branch yet means the worktree was just created, so there's nothing to resume in it.
	const sessionId = !fresh && (thread.branch || thread.cwd) ? resumeId(thread) : undefined;
	const window = threadWindowName(thread.id);
	// A thread the board hasn't heard from this run but that was written to just now is
	// probably still open in another terminal; two claudes on one thread would clash.
	if (
		sessionId &&
		!board.liveWindows().has(window) &&
		board.statuses()[thread.id] === undefined &&
		recentlyActive(thread.transcriptPath!) &&
		!resumeAnyway
	) {
		return board.ask(`⚠ #${thread.id} was active elsewhere in the last few minutes — close it there first, or resume anyway?`, () =>
			board.run(() => launchClaude(board, thread, cwd, { background, mode, prompt, resumeAnyway: true })),
		);
	}
	const project = board.project(thread.project);
	const command = [
		'claude',
		'--settings',
		containerProject(project) ? CONTAINER_SETTINGS_FILE : CLAUDE_SETTINGS_FILE,
		...(sessionId ? ['--resume', sessionId] : []),
		...(mode ? ['--permission-mode', mode] : []),
		// After `--` so a prompt starting with `-` isn't taken for an option.
		...(prompt ? ['--', prompt] : []),
	];
	const env = { OO_THREAD_ID: thread.id };
	// Already open, it's only selected; otherwise, for a project with a container, it starts in the thread's.
	const run = (await windowNames()).includes(window) ? { command, env } : await forThread(project, thread, cwd, command, env, { needsToken: true });
	const result = await openWindow(window, threadWindowLabel(thread), cwd, run.command, run.env, { background });
	await board.refreshWindows();
	if (result === 'selected') board.setMessage('');
	// The new claude's session replaces the old one on the thread, so say where the old one still is.
	else if (fresh && thread.sessionId) board.setMessage(`Started a fresh claude for #${thread.id} · its old conversation: claude --resume ${thread.sessionId}`);
	else board.setMessage(`${sessionId ? 'Resumed' : 'Started'} claude for #${thread.id}`);
}

/** Close the thread's claude window, if it's open; returns whether it was. */
export async function closeClaude(board: Board, thread: Thread): Promise<boolean> {
	const window = threadWindowName(thread.id);
	const open = (await windowNames()).includes(window);
	// Closing the window doesn't end what it runs in a container (claude, its shells), so that's ended first.
	if (open && containerProject(board.project(thread.project))) await stopKeyed(containerName(thread), window);
	await killWindow(window);
	await board.refreshWindows();
	return open;
}

/** Close the thread's claude and resume it in the background in `mode`. */
export async function restartClaude(board: Board, thread: Thread, mode: PermissionMode) {
	const cwd = threadDir(board.state(), thread);
	if (!cwd || !(await closeClaude(board, thread))) return;
	await launchClaude(board, thread, cwd, { background: true, mode });
	board.setMessage(`Restarted claude for #${thread.id} in ${mode} mode`);
}

/**
 * ⏎: jump to the thread's claude, starting it in the thread's worktree (made if need be) if it isn't running.
 * Asks first if resuming would be costly (askBeforeColdResume).
 */
export const openThread = (board: Board, thread: Thread) =>
	askBeforeColdResume(board, thread, fresh =>
		board.run(async () => {
			const project = board.project(thread.project);
			if (!project) return board.setMessage(`✗ ${unknownProject(thread.project)}`);
			const cwd = thread.cwd ?? (inCheckout(project, thread) ? project.path : await createWorktree(board, project, thread));
			await launchClaude(board, thread, cwd, fresh ? { fresh, prompt: START_PROMPT } : {});
		}),
	);

/**
 * Resume the thread's claude in the background if it's closed, then tell it `prompt`: by default, keep going,
 * or, for a claude that has never run, start on the thread. Returns whether it did. `fresh` starts a new claude
 * on the thread instead of resuming it.
 */
export async function wakeThread(board: Board, thread: Thread, prompt?: string, { fresh: startFresh = false } = {}): Promise<boolean> {
	const project = board.project(thread.project);
	if (!project) {
		board.setMessage(`✗ ${unknownProject(thread.project)}`);
		return false;
	}
	const cwd = thread.cwd ?? (inCheckout(project, thread) ? project.path : await createWorktree(board, project, thread));
	const window = threadWindowName(thread.id);
	const open = (await windowNames()).includes(window);
	// Nothing to resume, so the claude starts fresh (as in launchClaude).
	const fresh = !open && (startFresh || !resumeId(thread));
	if (!open) {
		const starts = board.sessionStarts.get(thread.id) ?? 0;
		await launchClaude(board, thread, cwd, { background: true, fresh });
		// It may be waiting on "resume anyway?" instead.
		if (!(await windowNames()).includes(window)) return false;
		const deadline = Date.now() + 30_000;
		while ((board.sessionStarts.get(thread.id) ?? 0) === starts) {
			if (Date.now() > deadline) {
				board.setMessage(`✗ #${thread.id}'s claude didn't start in time; not woken`);
				return false;
			}
			await sleep(250);
		}
		// SessionStart comes a little before the prompt takes input.
		await sleep(1000);
	}
	await pasteInto(window, prompt ?? (fresh ? START_PROMPT : project.wakePrompt || DEFAULT_WAKE_PROMPT));
	board.setMessage(fresh && !prompt ? `Started #${thread.id} on its thread` : `Woke #${thread.id}`);
	return true;
}

/** w: wake the thread, unless its claude is plainly still at it. Asks first if resuming would be costly (askBeforeColdResume). */
export function wake(board: Board, thread: Thread) {
	if (board.statuses()[thread.id] === 'working' && !stalled(board, thread)) return board.setMessage(`⚠ ${stillWorking(thread.id)}`);
	return askBeforeColdResume(board, thread, fresh => board.run(async () => void (await wakeThread(board, thread, undefined, { fresh })), `waking #${thread.id}`));
}

/** W: wake every one of `threads` (those shown) that was closed mid-work, once asked. */
export function wakeStalled(board: Board, threads: Thread[]) {
	const woken = threads.filter(t => t.column !== 'done' && !hidden(t.column) && stalled(board, t));
	if (woken.length === 0) return board.setMessage('No interrupted threads');
	const ids = (threads: Thread[]) => threads.map(t => `#${t.id}`).join(', ');
	return board.ask(`Wake ${ids(woken)}?`, async () => {
		const failed: Thread[] = [];
		// One at a time, as each waits for its claude to start.
		for (const t of woken) await board.run(async () => void ((await wakeThread(board, t)) || failed.push(t)), `waking #${t.id}`);
		if (woken.length > 1) board.setMessage(failed.length ? `⚠ Woke all but ${ids(failed)}` : `Woke ${ids(woken)}`);
	});
}

/** Open claude with a shell beside it, starting claude first if it isn't running. */
export const openShell = (board: Board, thread: Thread) =>
	inWorktree(
		board,
		thread,
		async cwd => {
			const window = threadWindowName(thread.id);
			if (!(await windowNames()).includes(window)) {
				await launchClaude(board, thread, cwd, { background: true });
				// It may be waiting on "resume anyway?" instead.
				if (!(await windowNames()).includes(window)) return;
			}
			const project = board.project(thread.project);
			const shell = await forThread(project, thread, cwd, threadShell(project), { OO_THREAD_ID: thread.id });
			await openSplit(window, cwd, 'shell', shell.command, shell.env);
		},
	);

export const claudeKeys: Binding[] = [
	{ key: '⏎', run: onThread(openThread), help: { section: 'Board', what: 'open (or resume) its claude' } },
	{
		key: 'w',
		run: onThread(wake),
		help: { section: 'Board', keys: 'w / W', what: 'wake it ("keep going", or start it on its thread) / every thread closed mid-work' },
	},
	{ key: 'W', run: board => wakeStalled(board, board.shown()) },
	{ key: 's', run: onThread(openShell), help: { section: 'Reviewing', what: 'claude + a shell beside it' } },
];

/**
 * Once a thread whose plan was approved in a large conversation (Thread's freshStart) has its checkpoints
 * saved and its claude stopped, swap that claude for a fresh one on the plan and checkpoints. If it went on
 * to start a checkpoint anyway, it's left to carry on.
 */
export function useFreshStarts(board: Board, state: State, statuses: Record<string, Status>) {
	// Threads being restarted right now, so they're only restarted once.
	const starting = useRef(new Set<string>());
	useEffect(() => {
		for (const thread of state.threads) {
			if (!thread.freshStart || starting.current.has(thread.id)) continue;
			const todos = thread.todos ?? [];
			if (todos.some(t => t.status !== 'pending')) {
				board.updateThread(thread.id, { freshStart: undefined });
				continue;
			}
			const cwd = threadDir(state, thread);
			if (!todos.length || !cwd || statuses[thread.id] !== 'stopped' || !board.liveWindows().has(threadWindowName(thread.id))) continue;
			starting.current.add(thread.id);
			board.updateThread(thread.id, { freshStart: undefined });
			void board.run(async () => {
				try {
					if (!(await closeClaude(board, thread))) return;
					await launchClaude(board, thread, cwd, { background: true, fresh: true, mode: 'auto', prompt: PLANNED_PROMPT });
				} finally {
					starting.current.delete(thread.id);
				}
			}, `starting a fresh claude for #${thread.id}`);
		}
	}, [state, statuses]);
}
