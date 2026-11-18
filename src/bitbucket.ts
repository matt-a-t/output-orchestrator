// PRs on Bitbucket, through its REST API (api.bitbucket.org/2.0) with the API token in BITBUCKET_EMAIL and
// BITBUCKET_API_TOKEN, for the repo the checkout's origin names. Reviewing and commenting are left to
// Bitbucket's web UI, so only what the board shows and merging are here.

import { execa } from 'execa';
import type { Pr, PrCheck, PrDetails, PrHost, PrState, PrStatus } from './prHost.js';
import { parseUntrusted, sanitize } from './sanitize.js';
import type { Thread } from './state.js';

/** A pull request as Bitbucket's API has it, with only the fields used here. */
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
	participants?: Participant[];
};

type BitbucketUser = { display_name?: string; nickname?: string };
type Participant = { role?: string; approved?: boolean; state?: string | null; user?: BitbucketUser };

/** A build status on the PR's head commit. */
export type BitbucketStatus = { state: string; name?: string; key?: string };

/** One file in a PR's diffstat; `status` is "merge conflict" for one that conflicts with the destination. */
export type DiffstatEntry = { status: string };

/** What Bitbucket's API has to say about a PR's mergeability, short of its merge checks, which it doesn't publish. */
export type MergeSignals = { diffstat: DiffstatEntry[]; statuses: BitbucketStatus[] };

type Page<T> = { values: T[] };

const API = 'https://api.bitbucket.org';

const CREDENTIALS = 'BITBUCKET_EMAIL (your Atlassian email) and BITBUCKET_API_TOKEN (an Atlassian API token with Bitbucket pull request and repository scopes)';

/** The Bitbucket workspace and repo a remote URL names (https, ssh and git@ forms), if it's on bitbucket.org. */
export function bitbucketRepo(url: string): { workspace: string; repo: string } | undefined {
	const match = /(?:^|[@/])bitbucket\.org[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
	return match ? { workspace: match[1]!, repo: match[2]! } : undefined;
}

const repos = new Map<string, Promise<string>>();

/** `/2.0/repositories/{workspace}/{repo}` for the repo `cwd`'s origin is, asked of git once per directory. */
function repoPath(cwd: string): Promise<string> {
	let path = repos.get(cwd);
	if (!path) {
		path = execa('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { reject: false }).then(r => {
			const repo = bitbucketRepo(r.stdout);
			if (!repo) throw new Error(`Bitbucket: couldn't tell the repo from origin (${r.stdout.trim() || 'no origin'})`);
			return `/2.0/repositories/${encodeURIComponent(repo.workspace)}/${encodeURIComponent(repo.repo)}`;
		});
		path.catch(() => repos.delete(cwd));
		repos.set(cwd, path);
	}
	return path;
}

/** What to throw for a failed call: what to fix when it's the token, else Bitbucket's own message. */
export function bitbucketError(status: number, body: string): Error {
	if (status === 401 || status === 403) return new Error(`Bitbucket said ${status}: check ${CREDENTIALS}`);
	let said = '';
	try {
		const { error } = parseUntrusted<{ error?: { message?: string; detail?: string } }>(body);
		said = [error?.message, error?.detail].filter(Boolean).join(': ');
	} catch {}
	return new Error(`Bitbucket said ${status}${said ? `: ${said}` : ''}`);
}

/**
 * A request to `url` on api.bitbucket.org with the API token. Nothing else is ever sent the token: a URL
 * on any other host (a task link from a response, say) is refused.
 */
async function request(url: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
	if (new URL(url).origin !== API) throw new Error(`Bitbucket: won't send the token to ${new URL(url).host}`);
	const { BITBUCKET_EMAIL: email, BITBUCKET_API_TOKEN: token } = process.env;
	if (!email || !token) throw new Error(`Set ${CREDENTIALS} to use Bitbucket PRs`);
	const response = await fetch(url, {
		method: init.method ?? (init.body ? 'POST' : 'GET'),
		headers: {
			Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
			Accept: 'application/json',
			...(init.body ? { 'Content-Type': 'application/json' } : {}),
		},
		body: init.body ? JSON.stringify(init.body) : undefined,
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) throw bitbucketError(response.status, await response.text());
	return response;
}

/** A call on the repo's API (`path` under `/repositories/{workspace}/{repo}`), its answer as JSON. */
async function api<T>(cwd: string, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
	const response = await request(`${API}${await repoPath(cwd)}${path}`, init);
	const text = await response.text();
	return (text ? parseUntrusted<T>(text) : undefined) as T;
}

/** The `q` filter for a branch's open PRs, its name quoted as Bitbucket's query language wants. */
export const openPrQuery = (branch: string): string => `source.branch.name = "${branch.replace(/[\\"]/g, c => `\\${c}`)}" AND state = "OPEN"`;

const prUrl = (pr: BitbucketPr): string => pr.links?.html?.href ?? '';

/** The board's record of a PR. */
export const toPr = (pr: BitbucketPr): Pr => ({ number: pr.id, url: prUrl(pr) });

const name = (user: BitbucketUser | undefined): string => user?.nickname ?? user?.display_name ?? '';

const STATES: Record<BitbucketPr['state'], PrState> = { OPEN: 'OPEN', MERGED: 'MERGED', DECLINED: 'CLOSED', SUPERSEDED: 'CLOSED' };

const FAILED_BUILDS = new Set(['FAILED', 'STOPPED']);

/**
 * Whether an open PR can merge, in GitHub's terms so the board's labels work unchanged: a file in conflict
 * is DIRTY, changes requested or a failed build BLOCKED, anything else CLEAN. Bitbucket doesn't publish its
 * merge checks, so the repo's own rules (required approvals, tasks, commits behind) aren't seen; a merge
 * they block fails with Bitbucket's explanation. No signals (they couldn't be fetched) is UNKNOWN, which
 * leaves what the board last knew.
 */
export function mergeStatus(pr: Pick<BitbucketPr, 'state' | 'participants'>, signals: MergeSignals | undefined): PrStatus {
	const prState = STATES[pr.state] ?? 'OPEN';
	if (pr.state !== 'OPEN' || !signals) return { state: prState, mergeable: 'UNKNOWN', mergeStateStatus: '' };
	if (signals.diffstat.some(f => f.status === 'merge conflict')) return { state: prState, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' };
	const changesRequested = (pr.participants ?? []).some(p => p.state === 'changes_requested');
	if (changesRequested || signals.statuses.some(s => FAILED_BUILDS.has(s.state))) return { state: prState, mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' };
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

/** What the viewer shows above the diff, from the PR, its mergeability signals and its diff. */
export function toDetails(pr: BitbucketPr, signals: MergeSignals | undefined, diff: string): PrDetails {
	const reviewers = (pr.participants ?? []).filter(p => p.approved || p.state === 'changes_requested');
	const reviews = reviewers.map(p => ({ author: { login: name(p.user) }, state: p.state === 'changes_requested' ? 'CHANGES_REQUESTED' : 'APPROVED', body: '' }));
	const reviewDecision = reviews.some(r => r.state === 'CHANGES_REQUESTED') ? 'CHANGES_REQUESTED' : reviews.length ? 'APPROVED' : '';
	return {
		...mergeStatus(pr, signals),
		number: pr.id,
		title: pr.title,
		body: pr.description ?? '',
		url: prUrl(pr),
		author: { login: name(pr.author) },
		isDraft: pr.draft ?? false,
		reviewDecision,
		reviews,
		statusCheckRollup: toChecks(signals?.statuses),
		headRefName: pr.source.branch.name,
		baseRefName: pr.destination.branch.name,
		headRefOid: pr.source.commit?.hash ?? '',
		...diffCounts(diff),
	};
}

const getPr = (cwd: string, number: number) => api<BitbucketPr>(cwd, `/pullrequests/${number}`);

/** The diffstat and build statuses; they can fail without the PR failing, and then the board just doesn't say. */
async function mergeSignals(cwd: string, number: number): Promise<MergeSignals | undefined> {
	try {
		const [diffstat, statuses] = await Promise.all([
			api<Page<DiffstatEntry>>(cwd, `/pullrequests/${number}/diffstat?pagelen=100`),
			api<Page<BitbucketStatus>>(cwd, `/pullrequests/${number}/statuses?pagelen=50`),
		]);
		return { diffstat: diffstat.values, statuses: statuses.values };
	} catch {
		return undefined;
	}
}

async function prDiff(cwd: string, number: number): Promise<string> {
	const response = await request(`${API}${await repoPath(cwd)}/pullrequests/${number}/diff`);
	return sanitize(await response.text());
}

const noReviews = (): never => {
	throw new Error('reviewing Bitbucket PRs is done in its web UI (b opens the PR)');
};

/** How often a merge Bitbucket finishes in the background is checked on, and for how long. */
export const MERGE_WAIT = { every: 2_000, for: 120_000 };

type MergeTask = { task_status?: string; merge_result?: BitbucketPr };

/** PRs on Bitbucket, through its REST API. */
export const bitbucket: PrHost = {
	name: 'Bitbucket',
	canReview: false,
	pollEvery: 60_000,

	async findPr(cwd: string, branch: string) {
		const query = new URLSearchParams({ q: openPrQuery(branch), pagelen: '1' });
		const open = await api<Page<BitbucketPr>>(cwd, `/pullrequests?${query}`);
		return open.values[0] && toPr(open.values[0]);
	},

	async createPr(cwd: string, thread: Thread, title: string, body: string, base?: string) {
		const pr = await api<BitbucketPr>(cwd, '/pullrequests', {
			body: { title, description: body, source: { branch: { name: thread.branch! } }, ...(base ? { destination: { branch: { name: base } } } : {}) },
		});
		if (typeof pr?.id !== 'number') throw new Error("Bitbucket didn't say which PR it opened");
		return toPr(pr);
	},

	async retargetPr(cwd: string, pr: Pr, base: string) {
		await api(cwd, `/pullrequests/${pr.number}`, { method: 'PUT', body: { destination: { branch: { name: base } } } });
	},

	async prStatus(cwd: string, pr: Pr) {
		const details = await getPr(cwd, pr.number);
		return mergeStatus(details, details.state === 'OPEN' ? await mergeSignals(cwd, pr.number) : undefined);
	},

	async prDetails(cwd: string, number: number) {
		const [details, signals, diff] = await Promise.all([getPr(cwd, number), mergeSignals(cwd, number), prDiff(cwd, number)]);
		return toDetails(details, signals, diff);
	},

	prDiff,

	viewerLogin: noReviews,
	submitReview: noReviews,

	/**
	 * Merge with a merge commit. Bitbucket may finish it in the background (202, with a task to check on),
	 * so wait for that. A failure (conflicts, approvals, the repo not allowing merge commits) is Bitbucket's to explain.
	 */
	async mergePr(cwd: string, number: number) {
		const response = await request(`${API}${await repoPath(cwd)}/pullrequests/${number}/merge`, { body: { merge_strategy: 'merge_commit' } });
		if (response.status !== 202) return 'merge commit';
		const task = response.headers.get('location');
		if (!task) throw new Error("Bitbucket is merging in the background but didn't say where to check on it");
		const until = Date.now() + MERGE_WAIT.for;
		while (Date.now() < until) {
			const { task_status: status } = parseUntrusted<MergeTask>(await (await request(new URL(task, API).href)).text());
			if (status === 'SUCCESS') return 'merge commit';
			if (status && status !== 'PENDING') throw new Error(`Bitbucket's merge ended ${status}`);
			await new Promise(resolve => setTimeout(resolve, MERGE_WAIT.every));
		}
		throw new Error("Bitbucket's merge is still going; check the PR in its web UI (b)");
	},

	headRef: pr => `refs/heads/${pr.headRefName}`,
	retargetCommand: () => "change the PR's destination in Bitbucket's web UI; b opens it",
};
