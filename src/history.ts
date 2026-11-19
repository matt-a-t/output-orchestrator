import { appendFileSync, existsSync } from 'node:fs';
import type { Column, Origin, State, Thread } from './state.js';

/**
 * One line of history.jsonl: a change in a thread's life, worked out by diffing the state on each save (see
 * saveState), so every writer is covered. It's there for claude to answer questions about how you work
 * (cycle times, where threads come from), so it records facts and leaves the analysis to whoever reads it.
 */
export type HistoryEntry = { ts: string; thread: string; project: string } & (
	| {
			event: 'created';
			title: string;
			column: Column;
			plan: boolean;
			// Unset for threads made before origin was recorded.
			origin?: Origin;
			ticket?: string;
			stackedOn?: string;
			// Written for a thread that was already there when history started: `ts` is its createdAt, and
			// nothing it did before then is known.
			backfilled?: true;
	  }
	| { event: 'moved'; from: Column; to: Column }
	| { event: 'local'; on: boolean }
	| { event: 'pr'; number: number; url: string }
	| { event: 'ticket'; key: string }
	| { event: 'plan' }
	| { event: 'removed'; column: Column }
);

function created(t: Thread, ts: string, backfilled = false): HistoryEntry {
	return {
		ts,
		thread: t.id,
		project: t.project,
		event: 'created',
		title: t.title,
		column: t.column,
		plan: !!t.plan,
		...(t.origin && { origin: t.origin }),
		...(t.ticket && { ticket: t.ticket.key }),
		...(t.stackedOn && { stackedOn: t.stackedOn }),
		...(backfilled && { backfilled: true as const }),
	};
}

/** What changed in each thread's life between two saves of the state, at `ts`. */
export function threadChanges(before: State, after: State, ts: string): HistoryEntry[] {
	const entries: HistoryEntry[] = [];
	const old = new Map(before.threads.map(t => [t.id, t]));
	for (const t of after.threads) {
		const was = old.get(t.id);
		old.delete(t.id);
		if (!was) {
			entries.push(created(t, ts));
			continue;
		}
		const base = { ts, thread: t.id, project: t.project };
		if (was.column !== t.column) entries.push({ ...base, event: 'moved', from: was.column, to: t.column });
		if (!!was.local !== !!t.local) entries.push({ ...base, event: 'local', on: !!t.local });
		if (t.pr && (t.pr.number !== was.pr?.number || t.pr.url !== was.pr?.url)) entries.push({ ...base, event: 'pr', number: t.pr.number, url: t.pr.url });
		if (t.ticket && t.ticket.key !== was.ticket?.key) entries.push({ ...base, event: 'ticket', key: t.ticket.key });
		if (t.plan !== was.plan) entries.push({ ...base, event: 'plan' });
	}
	for (const t of old.values()) entries.push({ ts, thread: t.id, project: t.project, event: 'removed', column: t.column });
	return entries;
}

/** A `created` entry for each thread already in `state`, for starting history on a board that has threads. */
export const backfill = (state: State): HistoryEntry[] => state.threads.map(t => created(t, t.createdAt, true));

/**
 * Append what changed between `before` and `after` to the history file. With no file yet, history starts with a
 * backfilled `created` entry for each thread in `before`. Never throws: losing a line beats losing a save.
 */
export function recordHistory(before: State, after: State, file: string, ts = new Date().toISOString()): void {
	try {
		const entries = [...(existsSync(file) ? [] : backfill(before)), ...threadChanges(before, after, ts)];
		if (!entries.length) return;
		// Private, like the rest of oo's data (PRIVATE_FILE in state.ts, which this can't import at runtime).
		appendFileSync(file, entries.map(e => JSON.stringify(e) + '\n').join(''), { mode: 0o600 });
	} catch {}
}
