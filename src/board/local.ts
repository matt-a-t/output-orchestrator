// Moving a thread into Local (its branch checked out in the project's own checkout) and back.

import { useEffect } from 'react';
import { carryChanges, checkout, defaultBranch, hasWorktree, isDirty, pullBranch, removeWorktree, restoreChanges, worktreePath } from '../git.js';
import { tryHook } from '../hooks.js';
import type { Project, ProjectHook, Thread } from '../state.js';
import type { Status } from '../status.js';
import { noRepo } from '../threads.js';
import { copyTranscript } from '../transcripts.js';
import type { Board, Outcome } from './board.js';
import { closeClaude, launchClaude } from './claude.js';
import { createWorktree } from './worktree.js';

/** Copy the thread's transcript to where `claude --resume` looks from `cwd`. */
function moveTranscript(thread: Thread, cwd: string): Pick<Thread, 'transcriptPath'> {
	const transcriptPath = thread.transcriptPath && copyTranscript(thread.transcriptPath, cwd);
	return transcriptPath ? { transcriptPath } : {};
}

/** Run the project's hook; returns `done` with how it went. A hook that can't start doesn't undo the move. */
async function hook(project: Project, event: ProjectHook, thread: Thread, cwd: string, done: string): Promise<string> {
	const ran = await tryHook(project, event, thread, cwd);
	return ran ? `${done}; ${ran}` : done;
}

/**
 * Why the thread can't go into (`entering`) or come out of Local now, if it can't; shared by t and
 * `oo thread local`. Claude still working is checked separately, since the command waits for it instead.
 */
export async function localProblem(board: Board, thread: Thread, entering: boolean): Promise<string | undefined> {
	const project = board.project(thread.project);
	if (!project) return `Unknown project "${thread.project}"`;
	if (entering) {
		const other = board.state().threads.find(t => t.local && t.project === thread.project);
		if (other) return `${thread.project} already has #${other.id} ${other.title} in Local`;
		if (thread.column === 'done') return `#${thread.id} is done — move it back to Polish first`;
		const reason = noRepo(board.state(), thread);
		if (reason) return `${reason} — there's no checkout to bring it into`;
	}
	// Imported threads already run in their own directory, with no branch to move.
	if (thread.cwd) return;
	if (entering) {
		if (!thread.branch) return `#${thread.id} has no branch yet — open it first`;
		// The thread's own uncommitted changes come along (see enterLocal), but the checkout's tracked ones are yours.
		// Untracked files there get in the way only if the branch has them too, which checkout catches.
		if (await isDirty(project.path, { untracked: false })) return `${project.path} has uncommitted changes — commit or stash them first`;
	}
}

/**
 * Check the thread's branch out in the project's own checkout, so changes show up in the local
 * dev environment, and move claude there with it, then run the project's enter local hook.
 * The worktree is removed meanwhile. Only one thread per project fits.
 */
export async function enterLocal(board: Board, thread: Thread): Promise<Outcome> {
	const problem = await localProblem(board, thread, true);
	if (problem) return { ok: false, message: problem };
	const project = board.project(thread.project)!;
	if (thread.cwd) {
		board.updateThread(thread.id, { local: true });
		return { ok: true, message: await hook(project, 'enterLocal', thread, thread.cwd, `#${thread.id} is in Local`) };
	}
	if (board.statuses()[thread.id] === 'working') return { ok: false, message: `claude is still working on #${thread.id}` };
	const wasOpen = await closeClaude(board, thread);
	// Uncommitted changes ride along on a temporary commit on the branch, undone once it's checked out here.
	let carried = false;
	if (hasWorktree(thread)) {
		await restoreChanges(worktreePath(thread));
		carried = await carryChanges(worktreePath(thread));
		await removeWorktree(project.path, thread);
	}
	try {
		await checkout(project.path, thread.branch!);
	} catch (err) {
		// Put the thread back in its worktree as it was, e.g. when an untracked file here clashes with the branch.
		await restoreChanges(await createWorktree(board, project, thread));
		if (wasOpen) await launchClaude(board, thread, worktreePath(thread), { background: true });
		throw err;
	}
	await restoreChanges(project.path);
	const moved: Thread = { ...thread, local: true, ...moveTranscript(thread, project.path) };
	board.updateThread(thread.id, moved);
	if (wasOpen) await launchClaude(board, moved, project.path, { background: true });
	const done = `${project.name} checkout is on ${thread.branch}${carried ? ' with its uncommitted changes' : ''}; claude works there until it leaves Local`;
	return { ok: true, message: await hook(project, 'enterLocal', moved, project.path, done) };
}

/**
 * Put the project's checkout back on the default branch and move the thread back into its
 * worktree, then run the project's leave local hook.
 */
export async function leaveLocal(board: Board, thread: Thread): Promise<Outcome> {
	const problem = await localProblem(board, thread, false);
	if (problem) return { ok: false, message: problem };
	const project = board.project(thread.project)!;
	if (thread.cwd) {
		board.updateThread(thread.id, { local: undefined });
		return { ok: true, message: await hook(project, 'leaveLocal', thread, project.path, `#${thread.id} is out of Local`) };
	}
	if (board.statuses()[thread.id] === 'working') return { ok: false, message: `claude is still working on #${thread.id}` };
	const main = (await defaultBranch(project.path)) ?? 'main';
	const wasOpen = await closeClaude(board, thread);
	// Including untracked files: anything new there is the thread's work.
	await restoreChanges(project.path);
	const carried = await carryChanges(project.path);
	await checkout(project.path, main);
	const back: Thread = { ...thread, local: undefined };
	const cwd = await createWorktree(board, project, back);
	await restoreChanges(cwd);
	Object.assign(back, moveTranscript(thread, cwd));
	board.updateThread(thread.id, back);
	if (wasOpen) await launchClaude(board, back, cwd, { background: true });
	const done = `${project.name} checkout is back on ${main}; #${thread.id} is back in its worktree${carried ? ' with its uncommitted changes' : ''}`;
	return { ok: true, message: await hook(project, 'leaveLocal', back, project.path, done) };
}

/**
 * Take a thread whose PR merged out of Local on its way to Done: put the project's checkout back
 * on the default branch with the merge pulled in, then run the project's leave local hook. Unlike
 * leaveLocal there's no worktree to bring back, and Done closes its claude anyway.
 */
export async function leaveLocalForDone(board: Board, thread: Thread): Promise<string> {
	const project = board.project(thread.project)!;
	const back: Thread = { ...thread, local: undefined };
	if (thread.cwd) {
		board.updateThread(thread.id, { local: undefined });
		return hook(project, 'leaveLocal', back, project.path, `#${thread.id} is out of Local`);
	}
	const main = (await defaultBranch(project.path)) ?? 'main';
	await closeClaude(board, thread);
	await checkout(project.path, main);
	// The checkout is back on main either way; it's just not up to date.
	const pulled = await pullBranch(project.path, main).then(
		() => 'pulled',
		(err: unknown) => `couldn't pull origin/${main}: ${err instanceof Error ? err.message : String(err)}`,
	);
	board.updateThread(thread.id, { local: undefined });
	return hook(project, 'leaveLocal', back, project.path, `${project.name} checkout is back on ${main}, ${pulled}`);
}

/** Into or out of Local, saying how it went on the message line. */
export const moveLocal = (board: Board, thread: Thread, entering: boolean) =>
	board.run(async () => {
		const { ok, message } = await (entering ? enterLocal : leaveLocal)(board, thread);
		board.setMessage(ok ? message : `⚠ ${message}`);
	}, entering ? 'checking out for Local' : 'leaving Local');

/** t: into or out of Local now, dropping any move `oo thread local` left waiting. */
export function toggleLocal(board: Board, thread: Thread) {
	board.pendingLocal.delete(thread.id);
	return moveLocal(board, thread, !thread.local);
}

/** Moves asked for while the thread's claude was working run once its turn ends (a permission prompt is still mid-turn). */
export function usePendingLocal(board: Board, statuses: Record<string, Status>) {
	useEffect(() => {
		for (const [id, entering] of board.pendingLocal) {
			if (statuses[id] === 'working' || statuses[id] === 'waiting') continue;
			board.pendingLocal.delete(id);
			const thread = board.state().threads.find(t => t.id === id);
			if (thread && entering !== !!thread.local) void moveLocal(board, thread, entering);
		}
	}, [statuses]);
}
