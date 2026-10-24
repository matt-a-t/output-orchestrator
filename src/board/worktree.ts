import { runColumnHook } from '../hooks.js';
import type { Column, Project, Thread } from '../state.js';
import { createWorktree as worktreeFor, noRepo, syncWorktree as syncWorktreeFor, threadDir, type WorktreeChange } from '../threads.js';
import type { Board } from './board.js';

function applyChange(board: Board, thread: Thread, { patch, message }: WorktreeChange) {
	if (patch) board.updateThread(thread.id, patch);
	if (message) board.setMessage(message);
}

/** Create the thread's worktree if it's missing; returns its path. */
export async function createWorktree(board: Board, project: Project, thread: Thread): Promise<string> {
	const change = await worktreeFor(project, thread);
	applyChange(board, thread, change);
	return change.path;
}

/** Keep the worktree in step with the column (see threads.ts), then run the project's hook for leaving `from`, if any. */
export async function syncWorktree(board: Board, thread: Thread, from?: Column) {
	const project = board.project(thread.project);
	if (!project) return board.setMessage(`✗ Unknown project "${thread.project}"`);
	const change = await syncWorktreeFor(project, thread);
	const ran = from && (await runColumnHook(project, from, { ...thread, ...change.patch }));
	applyChange(board, thread, { ...change, message: [change.message, ran].filter(Boolean).join('; ') || undefined });
	await board.refreshWindows();
}

/** Run fn in the thread's worktree (or an imported thread's directory), if it has one; `git` if fn needs the thread's branch. */
export const inWorktree = (
	board: Board,
	thread: Thread,
	fn: (cwd: string) => Promise<void>,
	{ git = false, label }: { git?: boolean; label?: string } = {},
) =>
	board.run(async () => {
		const reason = git && noRepo(board.state(), thread);
		if (reason) return board.setMessage(`⚠ ${reason} — it has no branch of its own for git to work on`);
		const dir = threadDir(board.state(), thread);
		if (dir) return await fn(dir);
		if (thread.local) return board.setMessage(`✗ Unknown project "${thread.project}"`);
		board.setMessage(`#${thread.id} has no worktree — open it or move it out of Planned`);
	}, label);
