import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import { DATA_DIR, type Thread } from './state.js';

const git = (cwd: string, args: string[]) => execa('git', ['-C', cwd, ...args]);

export function worktreePath(thread: Thread): string {
	return join(DATA_DIR, 'worktrees', thread.project, thread.id);
}

export function hasWorktree(thread: Thread): boolean {
	return existsSync(worktreePath(thread));
}

function slug(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.slice(0, 40)
		.replace(/^-+|-+$/g, '');
}

/**
 * Create the thread's worktree if it's missing. The first time, this also creates the thread's
 * branch from the repo's current branch and returns the branch/base to record on the thread;
 * after that (e.g. reopening a Done thread) it checks the existing branch out again.
 */
export async function ensureWorktree(repo: string, thread: Thread): Promise<Pick<Thread, 'branch' | 'base'> | undefined> {
	const path = worktreePath(thread);
	if (existsSync(path)) return;
	mkdirSync(dirname(path), { recursive: true });
	// Forget worktrees whose directories were deleted by hand, so `add` doesn't refuse the path.
	await git(repo, ['worktree', 'prune']);
	if (thread.branch) {
		await git(repo, ['worktree', 'add', path, thread.branch]);
		return;
	}
	const symbolic = await execa('git', ['-C', repo, 'symbolic-ref', '--short', '-q', 'HEAD'], { reject: false });
	const base = symbolic.stdout || (await git(repo, ['rev-parse', 'HEAD'])).stdout;
	const branch = `oo/${thread.id}${slug(thread.title) ? `-${slug(thread.title)}` : ''}`;
	await git(repo, ['worktree', 'add', '-b', branch, path, base]);
	return { branch, base };
}

/** Whether the worktree has uncommitted changes (including untracked files). */
export async function isDirty(cwd: string): Promise<boolean> {
	return (await git(cwd, ['status', '--porcelain'])).stdout !== '';
}

/** Remove the thread's worktree, keeping its branch. */
export async function removeWorktree(repo: string, thread: Thread): Promise<void> {
	await git(repo, ['worktree', 'remove', worktreePath(thread)]);
}

export type DiffKind = 'step' | 'thread';

/** `git diff` arguments: the step is everything since HEAD; the thread is everything since branching from base. */
function diffRevs(kind: DiffKind, thread: Thread): string[] {
	return kind === 'step' ? ['HEAD'] : ['--merge-base', thread.base ?? 'HEAD'];
}

/**
 * The `git diff` arguments for this kind of diff, or null if it's empty. New files are marked
 * intent-to-add first so diffs include them.
 */
export async function diffArgs(cwd: string, kind: DiffKind, thread: Thread): Promise<string[] | null> {
	await git(cwd, ['add', '--all', '--intent-to-add']);
	const args = ['diff', ...diffRevs(kind, thread)];
	const quiet = await execa('git', ['-C', cwd, ...args, '--quiet'], { reject: false });
	return quiet.exitCode === 0 ? null : args;
}

/** Quickfix entries (`file:line:text`) for the first changed line of each hunk in the diff. */
export async function hunkLocations(cwd: string, args: string[]): Promise<string[]> {
	const { stdout } = await git(cwd, [args[0]!, '-U0', '--no-color', '--no-ext-diff', ...args.slice(1)]);
	const locations: string[] = [];
	let file: string | undefined;
	let remaining = 0; // lines left in the current hunk
	let hunk: number | undefined; // new-side line of a hunk whose first change we haven't seen yet
	for (const line of stdout.split('\n')) {
		if (remaining > 0) {
			remaining--;
			if (hunk !== undefined && file) locations.push(`${file}:${hunk}:${line}`);
			hunk = undefined;
		} else if (line.startsWith('+++ ')) {
			file = line === '+++ /dev/null' ? undefined : line.slice('+++ b/'.length);
		} else {
			const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
			if (!m) continue;
			remaining = Number(m[1] ?? 1) + Number(m[3] ?? 1);
			hunk = Math.max(1, Number(m[2]));
		}
	}
	return locations;
}

export async function head(cwd: string): Promise<string> {
	return (await git(cwd, ['rev-parse', 'HEAD'])).stdout;
}

/** Stage everything; returns false if there's nothing to commit. */
export async function stageAll(cwd: string): Promise<boolean> {
	await git(cwd, ['add', '--all']);
	const staged = await execa('git', ['-C', cwd, 'diff', '--cached', '--quiet'], { reject: false });
	return staged.exitCode !== 0;
}
