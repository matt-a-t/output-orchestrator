// Which threads the board checks for uncommitted changes, and when. `git status` costs 80–375ms a
// worktree, so the check covers only threads whose files can still change, and runs a few at a time.

import type { Column, State } from '../state.js';
import type { Status } from '../status.js';
import { noRepo, threadDir } from '../threads.js';
import { threadWindowName } from '../tmux.js';

/** Columns where a thread's work goes on. Planned threads have no changes yet, and Done ones are finished. */
const WORKING_COLUMNS: readonly Column[] = ['active', 'polish', 'pr', 'followup'];

/** The longest the board leaves a thread unchecked. That's how late it notices edits made outside claude, from a shell or an editor. */
export const SWEEP_INTERVAL = 30_000;

/** How many `git status` calls run at once. */
export const CHECK_CONCURRENCY = 3;

/**
 * The threads whose files can change, with their directories: those in a working column, in Local,
 * imported from outside the board (`cwd`), or with their claude's window open.
 */
export function threadsToCheck(state: State, liveWindows: Set<string>): Map<string, string> {
	const dirs = new Map<string, string>();
	for (const t of state.threads) {
		if (t.column === 'archived' || noRepo(state, t)) continue;
		if (!(WORKING_COLUMNS.includes(t.column) || t.local || t.cwd || liveWindows.has(threadWindowName(t.id)))) continue;
		const dir = threadDir(state, t);
		if (dir) dirs.set(t.id, dir);
	}
	return dirs;
}

/** Threads whose claude has just stopped working, i.e. the moments a step's changes land. */
export function settled(prev: Record<string, Status>, next: Record<string, Status>): string[] {
	return Object.keys(next).filter(id => next[id] !== prev[id] && next[id] !== 'working');
}

/** Run fn on every item, at most `limit` at a time. */
export async function eachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async () => {
		while (next < items.length) await fn(items[next++]!);
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
