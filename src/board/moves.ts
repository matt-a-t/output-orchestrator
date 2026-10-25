// Moving a thread between columns, and out of them (Done, archived).

import { COLUMNS, type Thread } from '../state.js';
import { archiveProblem, doneProblem, moveProblem, moveWarning } from '../threads.js';
import { threadWindowName } from '../tmux.js';
import type { Binding } from './bindings.js';
import { onThread, type Board } from './board.js';
import { restartClaude } from './claude.js';
import { openPrFromBoard } from './pr.js';
import { syncWorktree } from './worktree.js';

export function moveThread(board: Board, thread: Thread, column: (typeof COLUMNS)[number]) {
	if (thread.column === column) return;
	// Its branch is checked out in the project's checkout, not its worktree, until it comes back. Opening its PR works from there.
	if (thread.local && column !== 'pr') return board.setMessage(`⚠ #${thread.id} is in Local — t brings it back to the board first`);
	const problem = moveProblem(board.state(), thread, column);
	if (problem) return board.setMessage(problem);
	const status = board.statuses()[thread.id];
	// Its claude is in plan mode just while it's Planned (see launchClaude), so an open one restarts on the way in or out.
	const restart = (thread.column === 'planned') !== (column === 'planned') && board.liveWindows().has(threadWindowName(thread.id));
	if (restart && status === 'working') return board.setMessage(`⚠ claude is still working on #${thread.id}`);
	const warning = moveWarning(board.state(), thread, column);
	if (warning) board.setMessage(warning);
	// Done closes its claude window.
	if (column === 'done' && status === 'working') return board.setMessage(`⚠ claude is still working on #${thread.id}`);
	if (column === 'pr') return void board.run(() => openPrFromBoard(board, thread), 'opening PR');
	const move = async () => {
		board.setColumn(thread.id, column);
		board.showAtEnd(column);
		await syncWorktree(board, { ...thread, column }, thread.column);
		if (restart) await restartClaude(board, { ...thread, column }, column === 'planned' ? 'plan' : 'auto');
	};
	const project = board.project(thread.project);
	if (column !== 'done' || !thread.pr || !project) return void board.run(move, 'updating worktree');
	board.run(async () => {
		const problem = await doneProblem(project, thread);
		if (problem) return board.setMessage(problem);
		await move();
	}, 'checking PR');
}

/** H / L: one column left or right. H on an archived thread brings it back to Done. */
export function moveColumn(board: Board, thread: Thread, delta: number) {
	if (thread.column === 'archived') return delta < 0 && moveThread(board, thread, 'done');
	const col = COLUMNS.indexOf(thread.column as (typeof COLUMNS)[number]) + delta;
	if (col < 0 || col >= COLUMNS.length) return;
	moveThread(board, thread, COLUMNS[col]!);
}

/** F: straight to Done, once asked. */
export function finishThread(board: Board, thread: Thread) {
	if (thread.column === 'done') return;
	// Imported threads keep their directory and window.
	const closes = thread.cwd ? '' : ' It closes its claude window and removes its worktree (branch kept).';
	board.ask(`Move #${thread.id} ${thread.title} to Done?${closes}`, () => moveThread(board, thread, 'done'));
}

/** x: archive the thread, once asked, unless it has uncommitted changes. */
export const archiveThread = (board: Board, thread: Thread) =>
	board.run(async () => {
		const problem = await archiveProblem(thread);
		if (problem) return board.setMessage(problem);
		board.ask(`Archive #${thread.id}?`, () =>
			board.run(async () => {
				board.updateThread(thread.id, { column: 'archived' });
				board.setMessage(`Archived #${thread.id}`);
				await syncWorktree(board, { ...thread, column: 'archived' }, thread.column);
			}, 'archiving'),
		);
	}, 'checking for uncommitted changes');

export const moveKeys: Binding[] = [
	{ key: 'H', run: onThread((board, thread) => moveColumn(board, thread, -1), { archived: true }) },
	{ key: 'L', run: onThread((board, thread) => moveColumn(board, thread, 1)) },
	{ key: 'F', run: onThread(finishThread) },
	{ key: 'x', run: onThread(archiveThread) },
];
