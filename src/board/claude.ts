// Starting, stopping and waking a thread's claude in its tmux window.

import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { diffPaneCommand } from '../review.js';
import { DEFAULT_WAKE_PROMPT, type Thread } from '../state.js';
import { CLAUDE_SETTINGS_FILE } from '../status.js';
import { threadDir } from '../threads.js';
import { killWindow, openSplit, openWindow, pasteInto, threadWindowLabel, threadWindowName, windowNames } from '../tmux.js';
import { recentlyActive } from '../transcripts.js';
import type { Binding } from './bindings.js';
import { onThread, type Board } from './board.js';
import { createWorktree, inWorktree } from './worktree.js';

export type PermissionMode = 'plan' | 'auto';

/** What w tells a thread's claude that has never run, e.g. one made with no initial prompt. */
const START_PROMPT = 'This is a new oo thread. Run `oo thread show` to read its title, plan, ticket and checkpoints, then get started on it.';

/** Claude session ID to resume the thread with, if its transcript still exists. */
export function resumeId(thread: Thread): string | undefined {
	if (thread.sessionId && thread.transcriptPath && existsSync(thread.transcriptPath)) return thread.sessionId;
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
 * `prompt` is sent as a new claude's first message.
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
	}: { background?: boolean; resumeAnyway?: boolean; mode?: PermissionMode; prompt?: string } = {},
): Promise<void> {
	// No branch yet means the worktree was just created, so there's nothing to resume in it.
	const sessionId = thread.branch || thread.cwd ? resumeId(thread) : undefined;
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
	const command = [
		'claude',
		'--settings',
		CLAUDE_SETTINGS_FILE,
		...(sessionId ? ['--resume', sessionId] : []),
		...(mode ? ['--permission-mode', mode] : []),
		// After `--` so a prompt starting with `-` isn't taken for an option.
		...(prompt ? ['--', prompt] : []),
	];
	const result = await openWindow(window, threadWindowLabel(thread), cwd, command, { OO_THREAD_ID: thread.id }, { background });
	await board.refreshWindows();
	if (result === 'selected') board.setMessage('');
	else board.setMessage(`${sessionId ? 'Resumed' : 'Started'} claude for #${thread.id}`);
}

/** Close the thread's claude window, if it's open; returns whether it was. */
export async function closeClaude(board: Board, thread: Thread): Promise<boolean> {
	const open = (await windowNames()).includes(threadWindowName(thread.id));
	await killWindow(threadWindowName(thread.id));
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

/** ⏎: jump to the thread's claude, starting it in the thread's worktree (made if need be) if it isn't running. */
export const openThread = (board: Board, thread: Thread) =>
	board.run(async () => {
		const project = board.project(thread.project);
		if (!project) return board.setMessage(`✗ Unknown project "${thread.project}"`);
		const cwd = thread.cwd ?? (thread.local ? project.path : await createWorktree(board, project, thread));
		await launchClaude(board, thread, cwd);
	});

/**
 * Resume the thread's claude in the background if it's closed, then tell it `prompt`: by default, keep going,
 * or, for a claude that has never run, start on the thread. Returns whether it did.
 */
export async function wakeThread(board: Board, thread: Thread, prompt?: string): Promise<boolean> {
	const project = board.project(thread.project);
	if (!project) {
		board.setMessage(`✗ Unknown project "${thread.project}"`);
		return false;
	}
	const cwd = thread.cwd ?? (thread.local ? project.path : await createWorktree(board, project, thread));
	const window = threadWindowName(thread.id);
	const open = (await windowNames()).includes(window);
	// Nothing to resume, so the claude starts fresh (as in launchClaude).
	const fresh = !open && !resumeId(thread);
	if (!open) {
		const starts = board.sessionStarts.get(thread.id) ?? 0;
		await launchClaude(board, thread, cwd, { background: true });
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

/** w: wake the thread, unless its claude is plainly still at it. */
export function wake(board: Board, thread: Thread) {
	if (board.statuses()[thread.id] === 'working' && !stalled(board, thread)) return board.setMessage(`⚠ claude is still working on #${thread.id}`);
	return board.run(async () => void (await wakeThread(board, thread)), `waking #${thread.id}`);
}

/** W: wake every one of `threads` (those shown) that was closed mid-work, once asked. */
export function wakeStalled(board: Board, threads: Thread[]) {
	const woken = threads.filter(t => t.column !== 'done' && t.column !== 'archived' && stalled(board, t));
	if (woken.length === 0) return board.setMessage('No interrupted threads');
	const ids = (threads: Thread[]) => threads.map(t => `#${t.id}`).join(', ');
	return board.ask(`Wake ${ids(woken)}?`, async () => {
		const failed: Thread[] = [];
		// One at a time, as each waits for its claude to start.
		for (const t of woken) await board.run(async () => void ((await wakeThread(board, t)) || failed.push(t)), `waking #${t.id}`);
		if (woken.length > 1) board.setMessage(failed.length ? `⚠ Woke all but ${ids(failed)}` : `Woke ${ids(woken)}`);
	});
}

/** Open claude with a shell or a live diff beside it, starting claude first if it isn't running. */
export const openBeside = (board: Board, thread: Thread, role: 'shell' | 'diff') =>
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
			const command = role === 'shell' ? [process.env.SHELL || 'bash'] : await diffPaneCommand(cwd, thread);
			await openSplit(window, cwd, role, command, { OO_THREAD_ID: thread.id });
		},
		{ git: role === 'diff' },
	);

export const claudeKeys: Binding[] = [
	{ key: '⏎', run: onThread(openThread) },
	{ key: 'w', run: onThread(wake) },
	{ key: 'W', run: board => wakeStalled(board, board.shown()) },
	{ key: 's', run: onThread((board, thread) => openBeside(board, thread, 'shell')) },
	{ key: 'd', meta: true, run: onThread((board, thread) => openBeside(board, thread, 'diff')) },
	{ key: 'D', meta: true, run: onThread((board, thread) => openBeside(board, thread, 'diff')) },
];
