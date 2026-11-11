// PRs on Bitbucket, through twg (`twg bitbucket pull-requests …`), which finds the repo from the checkout's
// remote. Reviewing and commenting are left to Bitbucket's web UI, so only what the board shows and merging are here.

import { execa } from 'execa';
import type { Pr, PrCheck, PrDetails, PrHost, PrState, PrStatus } from './prHost.js';
import { parseUntrusted } from './sanitize.js';
import type { Thread } from './state.js';

/** A pull request as Bitbucket's API has it, with what twg adds (`_statuses`) and only the fields used here. */
export type BitbucketPr = {
	id: number;
	title: string;
	description?: string;
	state: 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED';
	draft?: boolean;
	author?: BitbucketUser;
	source: { branch: { name: string }; commit?: { hash: string } };
	destination: { branch: { name: string } };
	links?: { html?: { href: string } };
	participants?: { role?: string; approved?: boolean; state?: string | null; user?: BitbucketUser }[];
	_statuses?: BitbucketStatus[];
};

type BitbucketUser = { display_name?: string; nickname?: string };

/** A build status on the PR's head commit. */
export type BitbucketStatus = { state: string; name?: string; key?: string };

/** One of what `prs mergeability` checks: FAILED and blocking means it's in the way. */
export type MergeCheck = { type: string; status: string; blocking?: boolean; reason?: string };

/** What twg prints in place of the result when a call fails, with `-o json`. */
type TwgError = { ok: false; error: { code?: string; message?: string; summary?: string } };

/**
 * Run `twg bitbucket <args>` in `cwd` and return its JSON. A failure throws twg's own summary of it, plus
 * what to try when it's the Bitbucket token (twg's saved one may not work, though the same token in the
 * environment does).
 */
async function twg<T>(cwd: string, args: string[]): Promise<T> {
	const result = await execa('twg', ['bitbucket', ...args, '-o', 'json', '--output-summary', 'none'], { cwd, reject: false });
	if (result.failed && result.exitCode === undefined) throw new Error(`couldn't run twg (${result.shortMessage}); Bitbucket PRs need the twg CLI`);
	return parseTwg<T>(result.stdout, result.stderr, result.exitCode ?? 1);
}

export function parseTwg<T>(stdout: string, stderr: string, exitCode: number): T {
	let data: unknown;
	try {
		data = parseUntrusted<unknown>(stdout);
	} catch {
		data = undefined;
	}
	if (isTwgError(data)) {
		const { code, summary, message } = data.error;
		const said = summary ?? message ?? code ?? 'twg failed';
		const auth = code?.startsWith('AUTH') ? ' (if `twg setup bitbucket` keeps failing, set TWG_BBC_TOKEN and TWG_BBC_USER instead)' : '';
		throw new Error(`Bitbucket: ${said}${auth}`);
	}
	if (exitCode !== 0 || data === undefined) {
		// stderr also carries twg's progress and upgrade notices, so its last line is the likeliest to say what went wrong.
		const last = stderr.trim().split('\n').at(-1);
		throw new Error(`Bitbucket: ${last || `twg exited ${exitCode}`}`);
	}
	return data as T;
}

function isTwgError(data: unknown): data is TwgError {
	return typeof data === 'object' && data !== null && (data as { ok?: unknown }).ok === false && typeof (data as { error?: unknown }).error === 'object';
}

const prUrl = (pr: BitbucketPr): string => pr.links?.html?.href ?? '';

/** The board's record of a PR. */
export const toPr = (pr: BitbucketPr): Pr => ({ number: pr.id, url: prUrl(pr) });

const name = (user: BitbucketUser | undefined): string => user?.nickname ?? user?.display_name ?? '';

const STATES: Record<BitbucketPr['state'], PrState> = { OPEN: 'OPEN', MERGED: 'MERGED', DECLINED: 'CLOSED', SUPERSEDED: 'CLOSED' };

/**
 * Whether an open PR can merge, in GitHub's terms so the board's labels work unchanged: conflicts are
 * DIRTY, too far behind its destination BEHIND, anything else blocking (approvals, builds, tasks) BLOCKED.
 * No checks at all (twg couldn't say) is UNKNOWN, which leaves what the board last knew.
 */
export function mergeStatus(state: BitbucketPr['state'], checks: MergeCheck[] | undefined): PrStatus {
	const prState = STATES[state] ?? 'OPEN';
	if (state !== 'OPEN' || !checks?.length) return { state: prState, mergeable: 'UNKNOWN', mergeStateStatus: '' };
	const failing = checks.filter(c => c.status === 'FAILED' && c.blocking !== false);
	if (failing.some(c => c.type === 'git_mergeability_check' || c.reason === 'conflicts')) return { state: prState, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' };
	if (failing.some(c => /behind/i.test(c.type))) return { state: prState, mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' };
	if (failing.length) return { state: prState, mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' };
	return { state: prState, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' };
}

const CHECK_STATES: Record<string, string> = { SUCCESSFUL: 'SUCCESS', INPROGRESS: 'PENDING', FAILED: 'FAILURE', STOPPED: 'FAILURE' };

/** Build statuses as the checks `checksLabel` counts. */
export const toChecks = (statuses: BitbucketStatus[] = []): PrCheck[] =>
	statuses.map(s => ({ __typename: 'StatusContext', context: s.name ?? s.key ?? '', state: CHECK_STATES[s.state] ?? s.state }));

/** Lines added and removed in a unified diff. */
export function diffCounts(diff: string): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;
	for (const line of diff.split('\n')) {
		if (line.startsWith('+++') || line.startsWith('---')) continue;
		if (line.startsWith('+')) additions++;
		else if (line.startsWith('-')) deletions++;
	}
	return { additions, deletions };
}

/** What the viewer shows above the diff, from the PR, its mergeability checks and its diff. */
export function toDetails(pr: BitbucketPr, checks: MergeCheck[] | undefined, diff: string): PrDetails {
	const reviewers = (pr.participants ?? []).filter(p => p.approved || p.state === 'changes_requested');
	const reviews = reviewers.map(p => ({ author: { login: name(p.user) }, state: p.state === 'changes_requested' ? 'CHANGES_REQUESTED' : 'APPROVED', body: '' }));
	const reviewDecision = reviews.some(r => r.state === 'CHANGES_REQUESTED') ? 'CHANGES_REQUESTED' : reviews.length ? 'APPROVED' : '';
	return {
		...mergeStatus(pr.state, checks),
		number: pr.id,
		title: pr.title,
		body: pr.description ?? '',
		url: prUrl(pr),
		author: { login: name(pr.author) },
		isDraft: pr.draft ?? false,
		reviewDecision,
		reviews,
		statusCheckRollup: toChecks(pr._statuses),
		headRefName: pr.source.branch.name,
		baseRefName: pr.destination.branch.name,
		headRefOid: pr.source.commit?.hash ?? '',
		...diffCounts(diff),
	};
}

const getPr = (cwd: string, number: number, extra: string[] = []) => twg<BitbucketPr>(cwd, ['pull-requests', 'get', String(number), ...extra]);

/** Mergeability can be slow or refused; without it the board just doesn't say. */
const mergeChecks = (cwd: string, number: number) => twg<MergeCheck[]>(cwd, ['pull-requests', 'mergeability', String(number)]).catch(() => undefined);

async function prDiff(cwd: string, number: number): Promise<string> {
	const { content } = await twg<{ content: string }>(cwd, ['pull-requests', 'diff', String(number)]);
	return content;
}

/** Bitbucket's merge strategies, in the order GitHub's are tried (merge commit, squash, rebase). */
const STRATEGIES = ['merge_commit', 'squash', 'fast_forward'] as const;

const noReviews = (): never => {
	throw new Error('reviewing Bitbucket PRs is done in its web UI (b opens the PR)');
};

/** PRs on Bitbucket, through twg. */
export const bitbucket: PrHost = {
	name: 'Bitbucket',
	canReview: false,

	async findPr(cwd: string, branch: string) {
		const open = await twg<BitbucketPr[]>(cwd, ['pull-requests', 'query', '--source', branch, '--state', 'OPEN', '--limit', '1']);
		return open[0] && toPr(open[0]);
	},

	async createPr(cwd: string, thread: Thread, title: string, body: string, base?: string) {
		// --x=value, so a title or description starting with - isn't taken for an option.
		const into = base ? [`--dest=${base}`] : [];
		const pr = await twg<BitbucketPr>(cwd, ['pull-requests', 'create', `--title=${title}`, `--source=${thread.branch!}`, ...into, `--description=${body}`]);
		if (typeof pr?.id !== 'number') throw new Error("Bitbucket: twg didn't say which PR it opened");
		return toPr(pr);
	},

	async retargetPr(cwd: string, pr: Pr, base: string) {
		await twg(cwd, ['pull-requests', 'update', '--pull-request', String(pr.number), '--dest', base]);
	},

	async prStatus(cwd: string, pr: Pr) {
		const [details, checks] = await Promise.all([getPr(cwd, pr.number), mergeChecks(cwd, pr.number)]);
		return mergeStatus(details.state, checks);
	},

	async prDetails(cwd: string, number: number) {
		const [details, checks, diff] = await Promise.all([getPr(cwd, number, ['--statuses']), mergeChecks(cwd, number), prDiff(cwd, number)]);
		return toDetails(details, checks, diff);
	},

	prDiff,

	viewerLogin: noReviews,
	reviewRequests: noReviews,
	submitReview: noReviews,

	/**
	 * Merge with the first strategy the repo allows, waiting for Bitbucket to finish. A strategy the repo
	 * doesn't allow is refused, so on to the next; any other failure (conflicts, missing approvals) is final.
	 */
	async mergePr(cwd: string, number: number) {
		let refused: unknown;
		for (const strategy of STRATEGIES) {
			try {
				await twg(cwd, ['pull-requests', 'merge', '--pull-request', String(number), '--merge-strategy', strategy, '--wait']);
				return strategy.replace('_', ' ');
			} catch (err) {
				if (!/strateg/i.test(String(err))) throw err;
				refused = err;
			}
		}
		throw refused;
	},

	headRef: pr => `refs/heads/${pr.headRefName}`,
	retargetCommand: (pr, base) => `twg bitbucket pull-requests update --pull-request ${pr.number} --dest ${base}`,
};
