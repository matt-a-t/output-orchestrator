import type { Dispatch, SetStateAction } from 'react';
import type { PrStatus } from '../github.js';
import type { Column, Project, State, Thread } from '../state.js';
import type { Status } from '../status.js';
import type { Store } from '../threads.js';

/** How a move went, for the message line or an `oo thread` response. */
export type Outcome = { ok: boolean; message: string };

/**
 * What the board's actions (the other files here) need from the board. Built afresh each render, but
 * everything on it reads the latest values, so one held by a poll or an awaited action never goes stale.
 */
export type Board = {
	// Writes go to the latest state straight away, so a request queued right behind one sees it.
	store: Store;
	state: () => State;
	setState: Dispatch<SetStateAction<State>>;
	updateThread: (id: string, patch: Partial<Thread>) => void;
	/** Move the thread to the bottom of the column. */
	setColumn: (id: string, column: Column, patch?: Partial<Thread>) => void;
	project: (name: string) => Project | undefined;
	statuses: () => Record<string, Status>;
	// When each thread's status last changed (ms), so quiet claudes can be closed after a while.
	statusSince: Map<string, number>;
	liveWindows: () => Set<string>;
	// How many times each thread's claude has started this run, so waking can wait for the one it starts.
	sessionStarts: Map<string, number>;
	refreshWindows: () => Promise<void>;
	setMerge: Dispatch<SetStateAction<Record<string, PrStatus>>>;
	// `oo thread local` moves waiting for the thread's claude to finish its turn: thread id → entering.
	pendingLocal: Map<string, boolean>;
	setMessage: (message: string) => void;
	setBusy: (label: string | null) => void;
	/** Run fn with `label` shown as busy, putting any error on the message line. */
	run: (fn: () => Promise<void>, label?: string) => Promise<void>;
	/** An action waiting on y (any other key cancels); its question is shown as the message. */
	ask: (question: string, action: () => void) => void;
	/** The threads on the board, with the filter applied. */
	shown: () => Thread[];
	/** The columns on the board: COLUMNS, with IDEAS and ARCHIVED while I and A show them. */
	shownColumns: () => readonly Column[];
	/** Put the cursor where a thread just added to the bottom of `column` lands. */
	showAtEnd: (column: Column) => void;
};

/**
 * For a key binding that acts on the highlighted thread, and does nothing when there isn't one.
 * Threads in IDEAS or archived have no worktree or window, so only bindings that say `hidden` act on them.
 */
export const onThread =
	(run: (board: Board, thread: Thread) => unknown, { hidden = false } = {}) =>
	(board: Board, thread: Thread | undefined) => {
		if (!thread) return;
		if (thread.column === 'archived' && !hidden) return board.setMessage(`⚠ #${thread.id} is archived — H brings it back to Done`);
		if (thread.column === 'ideas' && !hidden) return board.setMessage(`⚠ #${thread.id} is in IDEAS — L brings it back to Planned`);
		return run(board, thread);
	};
