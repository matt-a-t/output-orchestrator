import { execa } from 'execa';
import { askClaude, truncateDiff } from './claude.js';
import type { Thread } from './state.js';

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
 * Have claude draft the PR's title and description from the thread's commits and diff against its
 * base. Returns undefined if claude fails or says nothing usable.
 */
export async function draftPr(cwd: string, thread: Thread): Promise<{ title: string; body: string } | undefined> {
	const base = thread.base ?? 'HEAD';
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
	const reply = await askClaude(cwd, prompt);
	if (!reply) return;
	const [title, ...rest] = reply.split('\n');
	const cleanTitle = title?.replace(/^#+\s*/, '').trim();
	if (!cleanTitle) return;
	return { title: cleanTitle, body: rest.join('\n').trim() };
}

/** Open a PR for the thread's branch, which must already be pushed. */
export async function createPr(cwd: string, thread: Thread, title: string, body: string): Promise<Pr> {
	const branch = thread.branch!;
	// A base that's a commit (the repo was on a detached HEAD) isn't a branch gh can target; let it pick the default.
	const base = thread.base && !/^[0-9a-f]{40}$/.test(thread.base) ? ['--base', thread.base] : [];
	const { stdout } = await execa('gh', ['pr', 'create', '--head', branch, ...base, '--title', title, '--body-file', '-'], {
		cwd,
		input: body,
	});
	const url = stdout.trim().split('\n').at(-1)!;
	return { number: Number(/\/pull\/(\d+)/.exec(url)?.[1]), url };
}

export async function prState(cwd: string, pr: Pr): Promise<PrState> {
	const { stdout } = await execa('gh', ['pr', 'view', String(pr.number), '--json', 'state'], { cwd });
	return (JSON.parse(stdout) as { state: PrState }).state;
}
