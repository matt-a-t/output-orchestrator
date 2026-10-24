import { spawn } from 'node:child_process';
import { execa } from 'execa';
import { askClaude, truncateDiff } from './claude.js';
import type { Thread } from './state.js';
import { isGithubKey, type TicketRef } from './tickets.js';

export type Pr = NonNullable<Thread['pr']>;
export type PrState = 'OPEN' | 'CLOSED' | 'MERGED';

/** The PR whose head is this branch, if there is one (e.g. opened by hand). */
export async function findPr(cwd: string, branch: string): Promise<Pr | undefined> {
	const result = await execa('gh', ['pr', 'view', branch, '--json', 'number,url'], { cwd, reject: false });
	if (result.exitCode !== 0) return;
	const { number, url } = JSON.parse(result.stdout) as Pr;
	return { number, url };
}

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
		'Write the title and description for a GitHub pull request of the changes below.',
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
 * Open a PR for the thread's branch, which must already be pushed, into the repo's default branch:
 * not the thread's base, which is whatever the checkout happened to be on when the thread started.
 */
export async function createPr(cwd: string, thread: Thread, title: string, body: string): Promise<Pr> {
	const branch = thread.branch!;
	const { stdout } = await execa('gh', ['pr', 'create', '--head', branch, '--title', title, '--body-file', '-'], {
		cwd,
		input: body,
	});
	const url = stdout.trim().split('\n').at(-1)!;
	return { number: Number(/\/pull\/(\d+)/.exec(url)?.[1]), url };
}

/**
 * Whether the PR can merge: `mergeable` is UNKNOWN while GitHub is still working it out, and
 * `mergeStateStatus` says what's in the way (DIRTY is conflicts, BEHIND, BLOCKED, UNSTABLE, CLEAN...).
 */
export type PrStatus = { state: PrState; mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'; mergeStateStatus: string };

export async function prStatus(cwd: string, pr: Pr): Promise<PrStatus> {
	const { stdout } = await execa('gh', ['pr', 'view', String(pr.number), '--json', 'state,mergeable,mergeStateStatus'], { cwd });
	return JSON.parse(stdout) as PrStatus;
}

export async function prState(cwd: string, pr: Pr): Promise<PrState> {
	return (await prStatus(cwd, pr)).state;
}

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
