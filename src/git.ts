import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import { DATA_DIR, type Thread } from './state.js';

const git = (cwd: string, args: string[]) => execa('git', ['-C', cwd, ...args]);

/** Defaults to a path named after the project; renaming the project pins the old one on the thread. */
export function worktreePath(thread: Thread): string {
	return thread.worktree ?? join(DATA_DIR, 'worktrees', thread.project, thread.id);
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
 * branch from the latest main (origin's default branch, fetched first) and returns the
 * branch/base to record on the thread; after that (e.g. reopening a Done thread) it checks the
 * existing branch out again.
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
	const base = (await defaultBranch(repo)) ?? 'main';
	// Start from origin's copy when we can fetch it, so the branch isn't behind a stale local main.
	const fetched = await execa('git', ['-C', repo, 'fetch', 'origin', base], { reject: false });
	const start = fetched.exitCode === 0 ? `origin/${base}` : base;
	const branch = `oo/${thread.id}${slug(thread.title) ? `-${slug(thread.title)}` : ''}`;
	await git(repo, ['worktree', 'add', '-b', branch, '--no-track', path, start]);
	return { branch, base };
}

/** The checked-out branch, or the commit if HEAD is detached. */
export async function currentRef(repo: string): Promise<string> {
	const symbolic = await execa('git', ['-C', repo, 'symbolic-ref', '--short', '-q', 'HEAD'], { reject: false });
	return symbolic.stdout || (await git(repo, ['rev-parse', 'HEAD'])).stdout;
}

/** The remote's default branch (e.g. `main`), if origin has told us one. */
export async function defaultBranch(repo: string): Promise<string | undefined> {
	const result = await execa('git', ['-C', repo, 'symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'], { reject: false });
	return result.stdout.replace(/^origin\//, '') || undefined;
}

export async function checkout(repo: string, ref: string): Promise<void> {
	await git(repo, ['checkout', ref]);
}

/** Whether the worktree has uncommitted changes (including untracked files, unless told not to). */
export async function isDirty(cwd: string, { untracked = true } = {}): Promise<boolean> {
	// No optional locks: the board polls this, and must not trip up a commit running alongside.
	const args = ['--no-optional-locks', 'status', '--porcelain', ...(untracked ? [] : ['--untracked-files=no'])];
	return (await git(cwd, args)).stdout !== '';
}

/** Remove the thread's worktree, keeping its branch. */
export async function removeWorktree(repo: string, thread: Thread): Promise<void> {
	await git(repo, ['worktree', 'remove', worktreePath(thread)]);
}

export type DiffKind = 'step' | 'thread';

/** What to compare the thread against: origin's copy of its base if there is one, so a stale local main doesn't drag in upstream commits. */
export async function diffBase(cwd: string, thread: Thread): Promise<string> {
	if (!thread.base) return 'HEAD';
	const remote = `origin/${thread.base}`;
	const found = await execa('git', ['-C', cwd, 'rev-parse', '--verify', '--quiet', `refs/remotes/${remote}`], { reject: false });
	return found.exitCode === 0 ? remote : thread.base;
}

/** `git diff` arguments: the step is everything since HEAD; the thread is everything since branching from base. */
export async function diffRevs(cwd: string, kind: DiffKind, thread: Thread): Promise<string[]> {
	return kind === 'step' ? ['HEAD'] : ['--merge-base', await diffBase(cwd, thread)];
}

/**
 * The `git diff` arguments for this kind of diff, or null if it's empty. New files are marked
 * intent-to-add first so diffs include them.
 */
export async function diffArgs(cwd: string, kind: DiffKind, thread: Thread): Promise<string[] | null> {
	await git(cwd, ['add', '--all', '--intent-to-add']);
	const args = ['diff', ...(await diffRevs(cwd, kind, thread))];
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

export async function commit(cwd: string, message: string): Promise<void> {
	await execa('git', ['-C', cwd, 'commit', '-F', '-'], { input: message });
}

/** Stage everything; returns false if there's nothing to commit. */
export async function stageAll(cwd: string): Promise<boolean> {
	await git(cwd, ['add', '--all']);
	const staged = await execa('git', ['-C', cwd, 'diff', '--cached', '--quiet'], { reject: false });
	return staged.exitCode !== 0;
}

export async function pushBranch(cwd: string, branch: string): Promise<void> {
	await git(cwd, ['push', '-u', 'origin', branch]);
}
