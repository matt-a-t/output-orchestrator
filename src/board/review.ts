// Reviewing a thread's changes: diffs, comments, approving a step, and rebasing it on main.

import { COMMIT_FORM, type CommitForm } from '../commitForm.js';
import { commit, currentRef, defaultBranch, forcePushBranch, rebaseInProgress, rebaseOnMain, stageAll } from '../git.js';
import { openChanges, reviewDiff, showDiff, writeCommit } from '../review.js';
import { USER_SENDER, type Thread } from '../state.js';
import { approvedPrompt } from '../threadCommand.js';
import { applyRequest, approvedTodo, conflictPrompt, setTodoStatus, withDrafts } from '../threads.js';
import { pasteInto, progressPopup, threadWindowName, windowNames } from '../tmux.js';
import type { Binding } from './bindings.js';
import { onThread, type Board } from './board.js';
import { stalled, wakeThread } from './claude.js';
import { checkPr } from './pr.js';
import { inWorktree } from './worktree.js';

/**
 * Approve the step: stage everything in `cwd`, have claude draft the message, and commit it once
 * it's edited in the commit form. A claude at its prompt is then told to move on (or stop, after the
 * last step), with any comments from the form; any other claude gets that as a message in its inbox.
 */
export async function approveStep(board: Board, cwd: string, thread: Thread) {
	if (!(await stageAll(cwd))) return board.setMessage('Nothing to commit');
	const window = threadWindowName(thread.id);
	// Stopped, or just reopened (idle): not one that's working or waiting on a question, where the paste would land as an answer.
	const status = board.statuses()[thread.id];
	const waiting = (status === 'stopped' || status === 'idle') && (await windowNames()).includes(window);
	let form: CommitForm | null;
	const progress = progressPopup(' commit ', COMMIT_FORM);
	try {
		// The stored thread, for a draft claude saved after this copy was taken.
		form = await writeCommit(progress, cwd, board.state().threads.find(t => t.id === thread.id) ?? thread);
		if (!form) return board.setMessage('⚠ Commit cancelled (changes left staged)');
		progress.status('committing');
		await commit(cwd, `${form.message}\n`);
	} finally {
		await progress.close();
	}
	// Approving the step is what ticks off the checkpoint claude handed over.
	const stored = board.state().threads.find(t => t.id === thread.id);
	const todos = stored?.todos ?? [];
	const item = approvedTodo(todos);
	const ticked = item === -1 ? todos : setTodoStatus(todos, item, 'done');
	// The draft was for this step, so the next one can't reuse it.
	board.updateThread(thread.id, { todos: ticked, drafts: withDrafts(stored?.drafts, { commit: null }) });
	const prompt = approvedPrompt(ticked, item, form.message, form.notes);
	const open = (await windowNames()).includes(window);
	const told = !!prompt && waiting && open;
	if (told) await pasteInto(window, prompt);
	const said = prompt ? await tellClaude(board, thread, prompt, told ? 'told' : open ? 'busy' : 'closed') : '';
	board.setMessage(`Committed step on ${thread.branch ?? cwd}${item === -1 ? '' : ` · ✓ ${todos[item]!.subject}`}${said}${form.notes ? ' (with your comments)' : ''}`);
}

/**
 * The end of approving's message about claude, putting what it wasn't told in its inbox: the board
 * pastes it in when a busy claude's turn ends, and a closed one's SessionStart briefing carries it.
 */
async function tellClaude(board: Board, thread: Thread, prompt: string, claude: 'told' | 'busy' | 'closed'): Promise<string> {
	if (claude === 'told') return ' · told claude';
	const sent = await applyRequest(board.store, { id: 'approve', op: 'send', thread: thread.id, from: USER_SENDER, text: prompt });
	if (!sent.ok) return ` · ⚠ claude not told: ${sent.message}`;
	return ` · ✉ claude hears it ${claude === 'busy' ? 'when its turn ends' : 'when it next starts'}`;
}

/** d / D: the step's (uncommitted) or whole thread's diff, approving the step from it if asked. */
export const diffThread = (board: Board, thread: Thread, kind: 'step' | 'thread') =>
	inWorktree(
		board,
		thread,
		async cwd => {
			const result = await showDiff(cwd, kind, thread);
			if (result === 'empty') board.setMessage(`No ${kind} changes`);
			if (result === 'approved') await approveStep(board, cwd, thread);
		},
		{ git: true },
	);

/** c: comment on the diff in vim and send the comments to the thread's claude. */
export const commentOnDiff = (board: Board, thread: Thread) =>
	inWorktree(
		board,
		thread,
		async cwd => {
			const window = threadWindowName(thread.id);
			// Checked first so notes aren't written only to be thrown away.
			if (!(await windowNames()).includes(window)) return board.setMessage(`#${thread.id} has no claude window — open it with ⏎ first`);
			const feedback = await reviewDiff(cwd, thread);
			if (feedback === null) return board.setMessage('No changes');
			if (!feedback) return board.setMessage('No comments');
			if (!(await windowNames()).includes(window)) return board.setMessage(`✗ #${thread.id}'s claude window closed; comments not sent`);
			await pasteInto(window, feedback);
			board.setMessage(`Sent comments to #${thread.id}`);
		},
		{ git: true },
	);

/** o: the changed hunks as a vim quickfix list. */
export const listChanges = (board: Board, thread: Thread) =>
	inWorktree(
		board,
		thread,
		async cwd => {
			if (!(await openChanges(cwd, thread))) board.setMessage('No changes');
		},
		{ git: true },
	);

/**
 * u: rebase the thread's branch on origin's default branch, keeping uncommitted changes, and push
 * it if it has a PR. Conflicts are left for the thread's claude to resolve (and push).
 */
export const updateFromMain = (board: Board, thread: Thread) =>
	inWorktree(
		board,
		thread,
		async cwd => {
			const status = board.statuses()[thread.id];
			if (status === 'working' && !stalled(board, thread)) return board.setMessage(`⚠ claude is still working on #${thread.id}`);
			// The conflict prompt would land as its answer.
			if (status === 'waiting') return board.setMessage(`⚠ #${thread.id}'s claude is waiting on a question — answer it first`);
			if (await rebaseInProgress(cwd)) return board.setMessage(`⚠ #${thread.id} is already partway through a rebase — finish or abort it first`);
			const branch = thread.branch ?? (await currentRef(cwd));
			if (/^[0-9a-f]{40}$/.test(branch)) return board.setMessage(`⚠ ${cwd} isn't on a branch`);
			const base = (await defaultBranch(cwd)) ?? thread.base ?? 'main';
			const rebased = await rebaseOnMain(cwd, base);
			if (rebased.result === 'up-to-date') return board.setMessage(`#${thread.id} is already on origin/${base}`);
			if (rebased.result === 'conflicts') {
				const count = `${rebased.files.length} file${rebased.files.length === 1 ? '' : 's'}`;
				if (!(await wakeThread(board, thread, conflictPrompt(base, rebased.files, !!thread.pr)))) return;
				return board.setMessage(`⚠ Rebasing #${thread.id} on origin/${base} conflicts in ${count} — handed to claude`);
			}
			if (!thread.pr) return board.setMessage(`Rebased #${thread.id} on origin/${base}`);
			await forcePushBranch(cwd, branch);
			board.setMessage(`Rebased #${thread.id} on origin/${base} and pushed`);
			// The push may have fixed the PR's conflicts, so don't wait for the next poll to show it.
			void checkPr(board, thread);
		},
		{ git: true, label: 'rebasing on main' },
	);

export const reviewKeys: Binding[] = [
	{ key: 'd', run: onThread((board, thread) => diffThread(board, thread, 'step')) },
	{ key: 'D', run: onThread((board, thread) => diffThread(board, thread, 'thread')) },
	{ key: 'c', run: onThread(commentOnDiff) },
	{ key: 'o', run: onThread(listChanges) },
	{ key: 'u', run: onThread(updateFromMain) },
];
