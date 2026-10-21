import { execa } from 'execa';
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
