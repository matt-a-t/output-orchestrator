// The rules for adding and moving threads, shared by the board and `oo thread …`.
import { relative, resolve, isAbsolute } from 'node:path';
import { ensureWorktree, hasWorktree, isDirty, removeWorktree, worktreePath } from './git.js';
import { prState } from './github.js';
import { runColumnHook } from './hooks.js';
import type { Request, Response } from './requests.js';
import { COLUMN_LABELS, newThreadId, type Column, type Project, type State, type Thread, type Todo, type TodoStatus } from './state.js';
import { killWindow, threadWindowName } from './tmux.js';

/** Where the thread's work happens, if it has anywhere yet. */
export function threadDir(state: State, thread: Thread): string | undefined {
	if (thread.cwd) return thread.cwd;
	if (thread.local) return state.projects.find(p => p.name === thread.project)?.path;
	if (hasWorktree(thread)) return worktreePath(thread);
}

/** Whether `cwd` is `dir` or somewhere inside it. */
export function inDir(cwd: string, dir: string): boolean {
	const rel = relative(resolve(dir), resolve(cwd));
	return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** How many of the todos are done, as `3/7`. */
export function todoProgress(todos: Todo[]): string {
	return `${todos.filter(t => t.status === 'done').length}/${todos.length}`;
}

/** The new list, keeping the status of items that were already on it. */
export function replaceTodos(todos: Todo[], subjects: string[]): Todo[] {
	return subjects.map(subject => ({ subject, status: todos.find(t => t.subject === subject)?.status ?? 'pending' }));
}

/** Which item approving a step ticks off: the first waiting for review, else the first being worked on. */
export function approvedTodo(todos: Todo[]): number {
	const review = todos.findIndex(t => t.status === 'review');
	return review === -1 ? todos.findIndex(t => t.status === 'active') : review;
}

export function setTodoStatus(todos: Todo[], index: number, status: TodoStatus): Todo[] {
	return todos.map((t, i) => (i === index ? { ...t, status } : t));
}

/**
 * Which `max` todos to show: from just before the first unfinished one, so the current step stays in
 * view with the one finished before it, pulled back if that would leave space at the end.
 */
export function todoWindow(todos: Todo[], max: number): { start: number; end: number } {
	const current = todos.findIndex(t => t.status !== 'done');
	const first = current === -1 ? todos.length : Math.max(0, current - 1);
	const start = Math.max(0, Math.min(first, todos.length - max));
	return { start, end: Math.min(todos.length, start + max) };
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
	if (thread.local) return `⚠ Bring #${thread.id} back from Local before archiving`;
	// Archived threads are hidden, so don't leave uncommitted work behind in one.
	if (hasWorktree(thread) && (await isDirty(worktreePath(thread)))) {
		return `⚠ #${thread.id} has uncommitted changes — approve them (d, then a) or discard them before archiving`;
	}
}

/** Why the thread can't move to Done, if it can't: its PR is still open (merging moves it there itself). */
export async function doneProblem(project: Project, thread: Thread): Promise<string | undefined> {
	if (!thread.pr) return;
	const state = await prState(project.path, thread.pr).catch(() => undefined);
	if (!state) return `⚠ Couldn't check whether #${thread.id}'s PR #${thread.pr.number} is still open — try again`;
	if (state === 'OPEN') return `⚠ #${thread.id}'s PR #${thread.pr.number} is still open — merge or close it before moving to Done`;
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
	// claude can't carry on in a deleted directory. No tmux server (`oo thread move` from a plain shell) means no window.
	await killWindow(threadWindowName(thread.id)).catch(() => {});
	if (!hasWorktree(thread)) return {};
	await removeWorktree(project.path, thread);
	return { message: `Removed #${thread.id}'s worktree (kept branch ${thread.branch})` };
}

/** Why only the board can make this move (it needs the board's popups or its checkout handling), if it does. */
export function boardOnlyMove(thread: Thread, column: Column): string | undefined {
	if (thread.local) return `#${thread.id} is in Local, on the project's own checkout — bring it back first (oo thread local out, or t on the board)`;
	if (column === 'pr') return `Moving #${thread.id} to PR opens the PR description editor — do it from the board`;
}

/** The state being changed: the board's, or state.json when it isn't running. */
export type Store = { get(): State; update(fn: (state: State) => State): void };

/** Apply a request from `oo thread …` with the same rules as the board's keys. */
export async function applyRequest(store: Store, request: Request): Promise<Response> {
	const { id } = request;
	const state = store.get();
	if (request.op === 'add') {
		if (!state.projects.some(p => p.name === request.project)) return { id, ok: false, message: `Unknown project "${request.project}"` };
		const { thread } = addThread(state, { project: request.project, title: request.title, plan: request.plan });
		store.update(s => ({ ...s, threads: [...s.threads, thread] }));
		return { id, ok: true, message: `Created #${thread.id}`, thread: thread.id };
	}
	const thread = state.threads.find(t => t.id === request.thread);
	if (!thread) return { id, ok: false, message: `No thread #${request.thread}` };
	const project = state.projects.find(p => p.name === thread.project);
	if (!project) return { id, ok: false, message: `Unknown project "${thread.project}"` };
	const done = (message: string) => ({ id, ok: true, message, thread: thread.id });
	// The board handles these itself, before they get here.
	if (request.op === 'local') return { id, ok: false, message: 'Moving into or out of Local needs the board running' };
	if (request.op === 'plan') {
		const now = new Date().toISOString();
		store.update(s => ({ ...s, threads: s.threads.map(t => (t.id === thread.id ? { ...t, plan: request.plan, updatedAt: now } : t)) }));
		return done(`Saved #${thread.id}'s plan`);
	}
	if (request.op === 'todos' || request.op === 'todo') {
		const current = thread.todos ?? [];
		if (request.op === 'todo' && !current[request.item - 1]) {
			return { id, ok: false, message: `#${thread.id} has no todo ${request.item} (it has ${current.length})` };
		}
		const todos =
			request.op === 'todos' ? replaceTodos(current, request.subjects) : setTodoStatus(current, request.item - 1, request.status);
		const now = new Date().toISOString();
		store.update(s => ({ ...s, threads: s.threads.map(t => (t.id === thread.id ? { ...t, todos, updatedAt: now } : t)) }));
		const what = request.op === 'todos' ? 'todos' : `todo ${request.item} (${request.status})`;
		return done(`Updated #${thread.id}'s ${what}: ${todoProgress(todos)} done`);
	}
	if (thread.column === request.column) return done(`#${thread.id} is already in ${COLUMN_LABELS[thread.column]}`);
	const problem =
		boardOnlyMove(thread, request.column) ??
		(request.column === 'archived' ? await archiveProblem(thread) : undefined) ??
		(request.column === 'done' ? await doneProblem(project, thread) : undefined);
	if (problem) return { id, ok: false, message: problem };
	const moved = { ...thread, column: request.column };
	store.update(s => setColumn(s, thread.id, request.column));
	const { patch, message } = await syncWorktree(project, moved);
	if (patch) store.update(s => ({ ...s, threads: s.threads.map(t => (t.id === thread.id ? { ...t, ...patch } : t)) }));
	const ran = await runColumnHook(project, thread.column, { ...moved, ...patch });
	const messages = [moveWarning(state, thread, request.column), message, `Moved #${thread.id} to ${COLUMN_LABELS[request.column]}`, ran];
	return done(messages.filter(Boolean).join('\n'));
}
