// PRs on GitHub, through gh. What isn't particular to GitHub is in prHost.ts.

import { execa } from 'execa';
import type { Pr, PrDetails, PrHost, PrStatus, ReviewComment, ReviewEvent, ReviewRequest } from './prHost.js';
import { parseUntrusted } from './sanitize.js';
import type { Thread } from './state.js';

/** The PR whose head is this branch, if there is one (e.g. opened by hand). */
export async function findPr(cwd: string, branch: string): Promise<Pr | undefined> {
	const result = await execa('gh', ['pr', 'view', branch, '--json', 'number,url'], { cwd, reject: false });
	if (result.exitCode !== 0) return;
	const { number, url } = parseUntrusted<Pr>(result.stdout);
	return { number, url };
}

/**
 * Open a PR for the thread's branch, which must already be pushed, into `base` (another thread's
 * branch it builds on, which must be pushed too), or the repo's default branch without one.
 */
export async function createPr(cwd: string, thread: Thread, title: string, body: string, base?: string): Promise<Pr> {
	const branch = thread.branch!;
	const into = base ? ['--base', base] : [];
	const { stdout } = await execa('gh', ['pr', 'create', '--head', branch, ...into, '--title', title, '--body-file', '-'], {
		cwd,
		input: body,
	});
	const url = stdout.trim().split('\n').at(-1)!;
	return { number: Number(/\/pull\/(\d+)/.exec(url)?.[1]), url };
}

/** Point the PR at `base`, for when the branch it went into has merged. */
export async function retargetPr(cwd: string, pr: Pr, base: string): Promise<void> {
	await execa('gh', ['pr', 'edit', String(pr.number), '--base', base], { cwd });
}

export async function prStatus(cwd: string, pr: Pr): Promise<PrStatus> {
	const { stdout } = await execa('gh', ['pr', 'view', String(pr.number), '--json', 'state,mergeable,mergeStateStatus'], { cwd });
	return parseUntrusted<PrStatus>(stdout);
}

const DETAIL_FIELDS = 'number,title,body,url,author,isDraft,state,mergeable,mergeStateStatus,reviewDecision,reviews,statusCheckRollup,headRefName,baseRefName,headRefOid,additions,deletions';

/** What the PR viewer shows above the diff. */
export async function prDetails(cwd: string, number: number): Promise<PrDetails> {
	const { stdout } = await execa('gh', ['pr', 'view', String(number), '--json', DETAIL_FIELDS], { cwd });
	return parseUntrusted<PrDetails>(stdout);
}

/** The PR's diff as GitHub has it: what's pushed, not what's in the worktree. */
export async function prDiff(cwd: string, number: number): Promise<string> {
	return (await execa('gh', ['pr', 'diff', String(number), '--color=never'], { cwd })).stdout;
}

let login: Promise<string> | undefined;

/** Who gh is logged in as, asked once; GitHub won't let them approve their own PRs. */
export function viewerLogin(cwd: string): Promise<string> {
	login ??= execa('gh', ['api', 'user', '-q', '.login'], { cwd }).then(r => r.stdout.trim());
	// Logged out (or offline) now needn't mean for the rest of the run.
	login.catch(() => (login = undefined));
	return login;
}

/** Open PRs in the repo that ask you (or a team you're on) for a review, most recently updated first. */
export async function reviewRequests(cwd: string): Promise<ReviewRequest[]> {
	const { stdout } = await execa(
		'gh',
		['pr', 'list', '--search', 'review-requested:@me sort:updated-desc', '--json', 'number,title,url,author,updatedAt,isDraft'],
		{ cwd },
	);
	return parseUntrusted<ReviewRequest[]>(stdout);
}

const API_EVENTS: Record<ReviewEvent, string> = { approve: 'APPROVE', 'request-changes': 'REQUEST_CHANGES', comment: 'COMMENT' };

/**
 * Submit a review of the PR, with `comments` on lines of its diff. GitHub wants a body when
 * requesting changes. gh pr review can't add line comments, so those go through the API.
 */
export async function submitReview(cwd: string, number: number, event: ReviewEvent, body: string, comments: ReviewComment[] = []): Promise<void> {
	if (comments.length === 0) {
		await execa('gh', ['pr', 'review', String(number), `--${event}`, '--body-file', '-'], { cwd, input: body });
		return;
	}
	// gh fills in {owner}/{repo} from the checkout's remote.
	const review = { event: API_EVENTS[event], body, comments };
	await execa('gh', ['api', `repos/{owner}/{repo}/pulls/${number}/reviews`, '--input', '-'], { cwd, input: JSON.stringify(review) });
}

/**
 * Merge the PR the first way the repo allows: a merge commit, else squash, else rebase. The branch
 * is left for the board to clean up when it sees the merge. Returns how it merged.
 */
export async function mergePr(cwd: string, number: number): Promise<string> {
	const { stdout } = await execa('gh', ['repo', 'view', '--json', 'mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed'], { cwd });
	const allowed = JSON.parse(stdout) as Record<string, boolean>;
	const fields = { merge: 'mergeCommitAllowed', squash: 'squashMergeAllowed', rebase: 'rebaseMergeAllowed' } as const;
	const method = (['merge', 'squash', 'rebase'] as const).find(m => allowed[fields[m]]);
	if (!method) throw new Error("the repo doesn't allow merging");
	await execa('gh', ['pr', 'merge', String(number), `--${method}`], { cwd });
	return method;
}

/** PRs on GitHub, through gh. */
export const github: PrHost = {
	name: 'GitHub',
	canReview: true,
	findPr,
	createPr,
	retargetPr,
	prStatus,
	prDetails,
	prDiff,
	viewerLogin,
	reviewRequests,
	submitReview,
	mergePr,
	headRef: pr => `pull/${pr.number}/head`,
	retargetCommand: (pr, base) => `gh pr edit ${pr.number} --base ${base}`,
};
