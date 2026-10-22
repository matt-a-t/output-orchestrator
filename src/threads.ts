// The rules for adding and moving threads, shared by the board and `oo thread …`.
import { relative, resolve, isAbsolute } from 'node:path';
import { ensureWorktree, hasWorktree, isDirty, removeWorktree, worktreePath } from './git.js';
import { newThreadId, type Column, type Project, type State, type Thread } from './state.js';
import { killWindow, threadWindowName } from './tmux.js';

/** Where the thread's work happens, if it has anywhere yet. */
export function threadDir(state: State, thread: Thread): string | undefined {
	if (thread.cwd) return thread.cwd;
	if (thread.column === 'uitest') return state.projects.find(p => p.name === thread.project)?.path;
	if (hasWorktree(thread)) return worktreePath(thread);
}

/** Whether `cwd` is `dir` or somewhere inside it. */
export function inDir(cwd: string, dir: string): boolean {
	const rel = relative(resolve(dir), resolve(cwd));
	return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Add a thread to the bottom of Planned. */
export function addThread(
	state: State,
	fields: Pick<Thread, 'project' | 'title'> & Partial<Omit<Thread, 'id' | 'column'>>,
): { state: State; thread: Thread } {
	const now = new Date().toISOString();
	const thread: Thread = { plan: '', createdAt: now, updatedAt: now, ...fields, id: newThreadId(state), column: 'planned' };
	return { state: { ...state, threads: [...state.threads, thread] }, thread };
}

/** Move the thread to the bottom of the column. */
export function setColumn(state: State, id: string, column: Column, patch: Partial<Thread> = {}): State {
	const thread = state.threads.find(t => t.id === id);
	if (!thread) return state;
	const moved = { ...thread, ...patch, column, updatedAt: new Date().toISOString() };
	// Moving to the end of the array puts it at the bottom of the target column.
	return { ...state, threads: [...state.threads.filter(t => t.id !== id), moved] };
}

/** A heads-up about moving the thread to `column` that doesn't stop the move. */
export function moveWarning(state: State, thread: Thread, column: Column): string | undefined {
	if (column !== 'active') return;
	const other = state.threads.find(t => t.column === 'active' && t.project === thread.project && t.id !== thread.id);
	if (other) return `⚠ ${thread.project} already has an active thread: #${other.id} ${other.title}`;
}

/** Why the thread can't be archived, if it can't. */
export async function archiveProblem(thread: Thread): Promise<string | undefined> {
	if (thread.column === 'uitest') return `⚠ Move #${thread.id} out of UI testing before archiving`;
	// Archived threads are hidden, so don't leave uncommitted work behind in one.
	if (hasWorktree(thread) && (await isDirty(worktreePath(thread)))) {
		return `⚠ #${thread.id} has uncommitted changes — approve them (d, then a) or discard them before archiving`;
	}
}

/** What to record on the thread after touching its worktree, and what to tell the user. */
export type WorktreeChange = { patch?: Partial<Thread>; message?: string };

/** Create the thread's worktree if it's missing. */
export async function createWorktree(project: Project, thread: Thread): Promise<WorktreeChange & { path: string }> {
	const path = worktreePath(thread);
	const created = await ensureWorktree(project.path, thread);
	if (!created) return { path };
	return {
		path,
		// Until now it ran in the main checkout, so `claude --resume` wouldn't find them from here.
		patch: { ...created, sessionId: undefined, transcriptPath: undefined },
		message: `Created worktree for #${thread.id} on ${created.branch}`,
	};
}

/** Keep the worktree in step with the column: there from Active on, removed (branch kept) once Done/archived. */
export async function syncWorktree(project: Project, thread: Thread): Promise<WorktreeChange> {
	// Imported threads stay where they were started.
	if (thread.column === 'planned' || thread.cwd) return {};
	if (thread.column !== 'done' && thread.column !== 'archived') return createWorktree(project, thread);
	if (hasWorktree(thread) && (await isDirty(worktreePath(thread)))) {
		return { message: `⚠ Kept #${thread.id}'s worktree: it has uncommitted changes` };
	}
	// claude can't carry on in a deleted directory.
	await killWindow(threadWindowName(thread.id));
	if (!hasWorktree(thread)) return {};
	await removeWorktree(project.path, thread);
	return { message: `Removed #${thread.id}'s worktree (kept branch ${thread.branch})` };
}
