// PRs whichever host they're on: drafting them, labelling their status and opening them in the browser,
// and the host a project's PRs live on, picked from its origin remote: GitHub (through gh) or Bitbucket (through twg).

import { spawn } from 'node:child_process';
import { execa } from 'execa';
import { askClaude, truncateDiff } from './claude.js';
import { bitbucket } from './bitbucket.js';
import { github } from './github.js';
import type { Thread } from './state.js';
import { isGithubKey, type TicketRef } from './tickets.js';

export type Pr = NonNullable<Thread['pr']>;
export type PrState = 'OPEN' | 'CLOSED' | 'MERGED';
/**
 * Have claude draft the PR's title and description from the thread's commits and diff against
 * `base`, what the PR will merge into. Returns undefined if claude fails or says nothing usable.
 */
export async function draftPr(cwd: string, thread: Thread, base: string, signal?: AbortSignal): Promise<{ title: string; body: string } | undefined> {
	const git = async (args: string[]) => (await execa('git', ['-C', cwd, ...args])).stdout;
	const log = await git(['log', '--reverse', '--format=commit %h%n%B', `${base}..HEAD`]);
	const stat = await git(['diff', '--stat', `${base}...HEAD`]);
	const diff = truncateDiff(await git(['diff', `${base}...HEAD`]));
	const prompt = [
		'Write the title and description for a pull request of the changes below.',
		'Reply with only the title on the first line, a blank line, then the description in Markdown:',
		'what changed and why, in short paragraphs or bullets a reviewer can skim. No preamble.',
		'',
		`Thread title: ${thread.title}`,
		// withTicket adds these, so claude's own would double up.
		thread.ticket ? `Ticket: ${thread.ticket.key} (the title prefix and the link to it are added for you; leave them out)` : '',
		thread.plan ? `Thread plan:\n${thread.plan}` : '',
		'',
		'Commits:',
		log,
		'',
		'Diff stat:',
		stat,
		'',
		'Diff:',
		diff,
	].join('\n');
	const reply = await askClaude(cwd, prompt, signal);
	if (!reply) return;
	const [title, ...rest] = reply.split('\n');
	const cleanTitle = title?.replace(/^#+\s*/, '').trim();
	if (!cleanTitle) return;
	return { title: cleanTitle, body: rest.join('\n').trim() };
}

/**
 * The PR titled and linked to the ticket: `AV-123: ` or `#45: ` in front of the title, and
 * `Closes #45` (so merging closes the issue) or a link to the Jira ticket at the end of the body.
 * Leaves either alone if it's already there.
 */
export function withTicket(draft: { title: string; body: string }, ticket: TicketRef | undefined): { title: string; body: string } {
	if (!ticket) return draft;
	// Keys are only letters, digits, - and #, so need no escaping.
	const keyed = new RegExp(`^${ticket.key}(?![\\w-])`, 'i').test(draft.title);
	const footer = ticketFooter(ticket, draft.body);
	return {
		title: keyed ? draft.title : `${ticket.key}: ${draft.title}`,
		body: footer ? [draft.body, footer].filter(Boolean).join('\n\n') : draft.body,
	};
}

/** What the body should end with to reference the ticket, unless it already does. */
function ticketFooter({ key, url }: TicketRef, body: string): string | undefined {
	if (isGithubKey(key)) {
		const closes = new RegExp(`\\b(close[sd]?|fix(e[sd])?|resolve[sd]?) ${key}(?!\\d)`, 'i');
		return closes.test(body) ? undefined : `Closes ${key}`;
	}
	if (url && !body.includes(url)) return `Jira: [${key}](${url})`;
}

/**
 * Whether the PR can merge: `mergeable` is UNKNOWN while the host is still working it out, and
 * `mergeStateStatus` says what's in the way (DIRTY is conflicts, BEHIND, BLOCKED, UNSTABLE, CLEAN...).
 */
export type PrStatus = { state: PrState; mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'; mergeStateStatus: string };

/** What's in the way of merging, in words (and a color), when it's worth saying. */
export function mergeLabel(status: PrStatus): [string, string] | undefined {
	if (status.mergeable === 'CONFLICTING') return ['conflicts with base', 'red'];
	switch (status.mergeStateStatus) {
		case 'DIRTY':
			return ['conflicts with base', 'red'];
		case 'BEHIND':
			return ['behind base', 'yellow'];
		case 'BLOCKED':
			return ['blocked (reviews/checks)', 'yellow'];
		case 'UNSTABLE':
			return ['checks failing', 'yellow'];
		case 'CLEAN':
		case 'HAS_HOOKS':
			return ['ready to merge', 'green'];
	}
}

/** A check on the PR's head: a CheckRun (Actions and other apps) or a StatusContext (the older status API). */
export type PrCheck =
	| { __typename: 'CheckRun'; name: string; status: string; conclusion: string }
	| { __typename: 'StatusContext'; context: string; state: string };

export type PrDetails = PrStatus & {
	number: number;
	title: string;
	body: string;
	url: string;
	author: { login: string };
	isDraft: boolean;
	// APPROVED, CHANGES_REQUESTED or REVIEW_REQUIRED; empty when the repo doesn't require reviews.
	reviewDecision: string;
	reviews: { author: { login: string }; state: string; body: string }[];
	statusCheckRollup: PrCheck[];
	headRefName: string;
	baseRefName: string;
	headRefOid: string;
	additions: number;
	deletions: number;
};

/** How the PR's checks stand, in words (and a color), or undefined if it has none. */
export function checksLabel(checks: PrCheck[]): [string, string] | undefined {
	let failing = 0;
	let pending = 0;
	let passing = 0;
	for (const check of checks) {
		const result = check.__typename === 'CheckRun' ? (check.status === 'COMPLETED' ? check.conclusion : 'PENDING') : check.state;
		if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(result)) failing++;
		else if (['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', ''].includes(result)) pending++;
		// SUCCESS, NEUTRAL, SKIPPED and STALE don't hold anything up.
		else passing++;
	}
	if (checks.length === 0) return;
	const counts = [failing && `${failing} failing`, pending && `${pending} pending`, passing && `${passing} passing`].filter(Boolean).join(', ');
	return [`checks: ${counts}`, failing ? 'red' : pending ? 'yellow' : 'green'];
}

export type ReviewRequest = { number: number; title: string; url: string; author: { login: string }; updatedAt: string; isDraft: boolean };

export const REVIEW_EVENTS = ['approve', 'request-changes', 'comment'] as const;
export type ReviewEvent = (typeof REVIEW_EVENTS)[number];

/** A review comment on one line of the PR's diff; LEFT is the old side, RIGHT the new. */
export type ReviewComment = { path: string; line: number; side: 'LEFT' | 'RIGHT'; body: string };

/**
 * Open the PR in the browser: $BROWSER if set, else the OS's opener. Under WSL that's Windows'
 * explorer.exe, since xdg-open usually has no browser there (explorer exits 1 even when it works).
 */
export async function openPrInBrowser(pr: Pr): Promise<void> {
	// Not waited on: a browser started this way can run until it's closed.
	if (process.env.BROWSER) return void spawn(process.env.BROWSER, [pr.url], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
	if (process.env.WSL_DISTRO_NAME) return void (await execa('explorer.exe', [pr.url], { reject: false }));
	await execa(process.platform === 'darwin' ? 'open' : 'xdg-open', [pr.url]);
}

/** What the board does with PRs, the same way whichever host they're on. */
export type PrHost = {
	name: 'GitHub' | 'Bitbucket';
	/** Whether PRs can be reviewed from the viewer; Bitbucket's are reviewed in its web UI. */
	canReview: boolean;
	findPr(cwd: string, branch: string): Promise<Pr | undefined>;
	createPr(cwd: string, thread: Thread, title: string, body: string, base?: string): Promise<Pr>;
	retargetPr(cwd: string, pr: Pr, base: string): Promise<void>;
	prStatus(cwd: string, pr: Pr): Promise<PrStatus>;
	prDetails(cwd: string, number: number): Promise<PrDetails>;
	prDiff(cwd: string, number: number): Promise<string>;
	viewerLogin(cwd: string): Promise<string>;
	reviewRequests(cwd: string): Promise<ReviewRequest[]>;
	submitReview(cwd: string, number: number, event: ReviewEvent, body: string, comments?: ReviewComment[]): Promise<void>;
	mergePr(cwd: string, number: number): Promise<string>;
	/** The ref to fetch for the PR's commits: GitHub keeps one per PR, Bitbucket only has the branch. */
	headRef(pr: PrDetails): string;
	/** The command that points the PR at `base`, for the user to run when the board couldn't. */
	retargetCommand(pr: Pr, base: string): string;
};

/** Which host a remote URL is on: https, ssh (git@) and user@ forms alike. */
export function hostOf(url: string): PrHost['name'] {
	return /(^|[@/.])bitbucket\.org[:/]/i.test(url) ? 'Bitbucket' : 'GitHub';
}

const HOSTS: Record<PrHost['name'], PrHost> = { GitHub: github, Bitbucket: bitbucket };

const hosts = new Map<string, Promise<PrHost>>();

/** The host of the repo at `cwd`'s PRs, asked of git once per directory. */
export function prHost(cwd: string): Promise<PrHost> {
	let host = hosts.get(cwd);
	if (!host) {
		host = execa('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { reject: false }).then(r => HOSTS[hostOf(r.stdout.trim())]);
		hosts.set(cwd, host);
	}
	return host;
}

export const findPr = async (cwd: string, branch: string) => (await prHost(cwd)).findPr(cwd, branch);
export const createPr = async (cwd: string, thread: Thread, title: string, body: string, base?: string) => (await prHost(cwd)).createPr(cwd, thread, title, body, base);
export const retargetPr = async (cwd: string, pr: Pr, base: string) => (await prHost(cwd)).retargetPr(cwd, pr, base);
export const prStatus = async (cwd: string, pr: Pr) => (await prHost(cwd)).prStatus(cwd, pr);
export const prState = async (cwd: string, pr: Pr): Promise<PrState> => (await prStatus(cwd, pr)).state;
export const prDetails = async (cwd: string, number: number) => (await prHost(cwd)).prDetails(cwd, number);
export const prDiff = async (cwd: string, number: number) => (await prHost(cwd)).prDiff(cwd, number);
export const viewerLogin = async (cwd: string) => (await prHost(cwd)).viewerLogin(cwd);
export const reviewRequests = async (cwd: string) => (await prHost(cwd)).reviewRequests(cwd);
export const submitReview = async (cwd: string, number: number, event: ReviewEvent, body: string, comments: ReviewComment[] = []) =>
	(await prHost(cwd)).submitReview(cwd, number, event, body, comments);
export const mergePr = async (cwd: string, number: number) => (await prHost(cwd)).mergePr(cwd, number);
