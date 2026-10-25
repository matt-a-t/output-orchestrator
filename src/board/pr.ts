// A thread's pull request: opening it, keeping up with its merge status, and showing it.

import { existsSync } from 'node:fs';
import { EDITOR, parsePr, prText } from '../editor.js';
import { currentRef, defaultBranch, isDirty, pushBranch } from '../git.js';
import { createPr, draftPr, findPr, mergePr, openPrInBrowser, prStatus, submitReview, withTicket } from '../github.js';
import { runColumnHook } from '../hooks.js';
import { showPr } from '../review.js';
import type { Thread } from '../state.js';
import { withDrafts } from '../threads.js';
import { CLOSED, progressPopup, type ProgressPopup } from '../tmux.js';
import type { Binding } from './bindings.js';
import { onThread, type Board, type Outcome } from './board.js';
import { leaveLocalForDone, localProblem } from './local.js';
import { createWorktree, inWorktree, syncWorktree } from './worktree.js';

/** How opening a PR says how it's going and gets its title and description (null: cancelled). */
export type PrSteps = {
	status: (text: string) => void;
	describe: (cwd: string, thread: Thread, base: string) => Promise<{ title: string; body: string } | null>;
	close: () => Promise<void>;
};

/**
 * Push the thread's branch and open its PR (unless it has one already), then move it to PR.
 * `steps` says how it's going and writes the title and description; null from `describe` is cancelled.
 */
export async function openPr(board: Board, thread: Thread, steps: PrSteps): Promise<Outcome> {
	const project = board.project(thread.project);
	if (!project) return { ok: false, message: `Unknown project "${thread.project}"` };
	if (thread.cwd) {
		if (!existsSync(thread.cwd)) return { ok: false, message: `${thread.cwd} no longer exists` };
		// An imported thread has no branch of its own until now: it's whatever its directory is on.
		if (!thread.branch) {
			const branch = await currentRef(thread.cwd);
			const base = await defaultBranch(thread.cwd);
			if (/^[0-9a-f]{40}$/.test(branch) || branch === base) {
				return { ok: false, message: `${thread.cwd} is on ${branch} — switch #${thread.id}'s work onto a branch there first` };
			}
			thread = { ...thread, branch, base };
		}
	}
	if (!thread.branch) return { ok: false, message: `#${thread.id} has no branch yet — open it first` };
	// In Local its branch is checked out in the project's checkout, so the PR is opened from there. Otherwise
	// this reopens the worktree if the thread is coming back from Done.
	const cwd = thread.cwd ?? (thread.local ? project.path : await createWorktree(board, project, thread));
	if (await isDirty(cwd)) return { ok: false, message: `#${thread.id} has uncommitted changes — approve them (d, then a) or discard them first` };
	const branch = thread.branch;
	let existing: Thread['pr'];
	let pr: Thread['pr'];
	try {
		steps.status('looking for a PR');
		existing = pr = thread.pr ?? (await findPr(cwd, branch));
		if (!pr) {
			// The PR goes into the default branch (see createPr), so describe the changes against that.
			const target = await defaultBranch(cwd);
			const draft = await steps.describe(cwd, { ...thread, branch }, target ? `origin/${target}` : (thread.base ?? 'HEAD'));
			if (!draft) return { ok: true, message: 'Cancelled' };
			steps.status(`pushing ${branch}`);
			await pushBranch(cwd, branch);
			steps.status('opening PR');
			pr = await createPr(cwd, thread, draft.title, draft.body);
		} else {
			steps.status(`pushing ${branch}`);
			await pushBranch(cwd, branch);
		}
	} finally {
		await steps.close();
	}
	// The saved PR draft is used up, whether it went into this PR or there already was one.
	const drafts = withDrafts(board.state().threads.find(t => t.id === thread.id)?.drafts, { pr: null });
	const patch = { pr, branch, base: thread.base, drafts };
	board.setColumn(thread.id, 'pr', patch);
	board.showAtEnd('pr');
	const opened = `${existing ? 'Pushed' : 'Opened'} PR #${pr.number}: ${pr.url}`;
	const ran = await runColumnHook(project, thread.column, { ...thread, ...patch, column: 'pr' });
	// A push may have fixed (or caused) conflicts, so don't wait for the next poll to show it.
	void checkPr(board, { ...thread, ...patch, column: 'pr' });
	return { ok: true, message: ran ? `${opened}; ${ran}` : opened };
}

/** The board's way: claude drafts the PR in a popup, then the user edits it there. */
export async function openPrFromBoard(board: Board, thread: Thread) {
	// Open from here until the PR is, so the board isn't left looking usable while it waits.
	let progress: ProgressPopup | undefined;
	const popup = () => (progress ??= progressPopup(' pull request ', EDITOR));
	const { ok, message } = await openPr(board, thread, {
		status: text => popup().status(text),
		describe: async (cwd, thread, base) => {
			const saved = board.state().threads.find(t => t.id === thread.id)?.drafts?.pr;
			const written = saved ?? (await popup().cancellable('claude is writing the PR description', signal => draftPr(cwd, thread, base, signal)));
			if (written === CLOSED) return null;
			if (written && !saved && popup().accepted()) return withTicket(written, thread.ticket);
			const edited = await popup().edit(
				written
					? prText(withTicket(written, thread.ticket), thread.branch!)
					: prText(
							withTicket({ title: thread.title, body: thread.plan }, thread.ticket),
							thread.branch!,
							"claude couldn't write the PR description; this is from the thread.",
						),
			);
			return edited === CLOSED ? null : parsePr(edited);
		},
		close: async () => void (await progress?.close()),
	});
	board.setMessage(ok ? message : `⚠ ${message}`);
}

/** Record the merge status of the thread's PR, or move the thread to Done (cleaning up its worktree) if it's merged. */
export async function checkPr(board: Board, thread: Thread) {
	const project = board.project(thread.project);
	if (thread.column !== 'pr' || !thread.pr || !project) return;
	// gh failing (offline, logged out) just means trying again next time.
	const status = await prStatus(project.path, thread.pr).catch(() => undefined);
	if (!status) return;
	if (status.state !== 'MERGED') {
		// While GitHub is still working out mergeability, keep what we knew so the card doesn't flicker.
		if (status.mergeable !== 'UNKNOWN') board.setMerge(m => ({ ...m, [thread.id]: status }));
		return;
	}
	let left: string | undefined;
	if (thread.local) {
		// Its branch is in the project's checkout, so that has to go back to main first; the next poll tries again.
		// Leaving Local carries uncommitted changes back to the worktree, but Done has none, so they'd be left on main.
		const problem =
			(await localProblem(board, thread, false)) ??
			(!thread.cwd && (await isDirty(project.path)) ? `#${thread.id} has uncommitted changes — approve them (d, then a) or discard them first` : undefined);
		if (problem) return board.setMessage(`⚠ #${thread.id}'s PR #${thread.pr.number} merged, but it stays in PR until it can leave Local: ${problem}`);
		if (board.statuses()[thread.id] === 'working') return;
		try {
			left = await leaveLocalForDone(board, thread);
		} catch (err) {
			return board.setMessage(`✗ ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	board.setMerge(({ [thread.id]: _, ...rest }) => rest);
	board.setColumn(thread.id, 'done');
	board.setMessage([`#${thread.id}'s PR #${thread.pr.number} merged → Done`, left].filter(Boolean).join('; '));
	await syncWorktree(board, { ...thread, local: undefined, column: 'done' }).catch(err => board.setMessage(`✗ ${err instanceof Error ? err.message : String(err)}`));
}

const REVIEW_DONE: Record<string, string> = { approve: 'Approved', 'request-changes': 'Requested changes on', comment: 'Commented on' };

/**
 * Show a PR in the viewer and do what was picked there: merge it (moving `thread`, if it's the
 * thread's, to Done) or submit a review. Returns whether anything was done.
 */
export async function viewPr(board: Board, cwd: string, number: number, thread?: Thread): Promise<boolean> {
	const picked = await showPr(cwd, number);
	if (picked === 'closed') return false;
	if (picked.action === 'review') {
		board.setBusy(`reviewing PR #${number}`);
		await submitReview(cwd, number, picked.event, picked.body, picked.comments);
		const lines = picked.comments.length;
		board.setMessage(`${REVIEW_DONE[picked.event]} PR #${number}${lines ? ` with ${lines} line comment${lines === 1 ? '' : 's'}` : ''}`);
		return true;
	}
	board.setBusy(`merging PR #${number}`);
	const method = await mergePr(cwd, number);
	board.setMessage(`Merged PR #${number} (${method})`);
	// Straight to Done rather than on the next poll.
	if (thread) await checkPr(board, thread);
	return true;
}

/** v: view the thread's PR, to merge or review it. */
export function viewThreadPr(board: Board, thread: Thread) {
	const { pr } = thread;
	if (!pr) return board.setMessage(`#${thread.id} has no PR`);
	return inWorktree(board, thread, async cwd => void (await viewPr(board, cwd, pr.number, thread)), { git: true, label: `loading PR #${pr.number}` });
}

/** b: open the thread's PR in the browser. */
export function browsePr(board: Board, thread: Thread) {
	const { pr } = thread;
	if (!pr) return board.setMessage(`#${thread.id} has no PR`);
	return board.run(async () => {
		await openPrInBrowser(pr);
		board.setMessage(`Opened PR #${pr.number} in the browser`);
	}, 'opening PR in the browser');
}

export const prKeys: Binding[] = [
	{ key: 'b', run: onThread(browsePr, { archived: true }) },
	{ key: 'v', run: onThread(viewThreadPr) },
];
