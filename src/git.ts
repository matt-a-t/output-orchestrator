import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import { DATA_DIR, type Thread } from './state.js';
import { ticketBranchPart } from './tickets.js';

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
 * The branch the thread should be on: `av-123-<slug>` for a ticket, `oo/<slug>` without one. Not
 * the thread's id, which only means something on this machine.
 */
export function branchName(thread: Pick<Thread, 'title' | 'ticket'>): string {
	const name = slug(thread.title);
	if (thread.ticket) return [ticketBranchPart(thread.ticket), name].filter(Boolean).join('-');
	return `oo/${name || 'thread'}`;
}

const refExists = async (repo: string, ref: string) =>
	(await execa('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', ref], { reject: false })).exitCode === 0;

/** `name`, or `name-2`, `name-3`… if a local or origin branch already has it. */
async function freeBranchName(repo: string, name: string): Promise<string> {
	for (let n = 1; ; n++) {
		const candidate = n === 1 ? name : `${name}-${n}`;
		if (!(await refExists(repo, `refs/heads/${candidate}`)) && !(await refExists(repo, `refs/remotes/origin/${candidate}`))) return candidate;
	}
}

/** Whether the branch has gone to origin: it tracks something, or origin has a copy we've fetched. */
async function isPushed(repo: string, branch: string): Promise<boolean> {
	const upstream = await execa('git', ['-C', repo, 'config', `branch.${branch}.remote`], { reject: false });
	return upstream.exitCode === 0 || (await refExists(repo, `refs/remotes/origin/${branch}`));
}

/**
 * Rename the thread's branch to match its ticket and title (see branchName), unless it's been
 * pushed or has a PR, since that would leave them pointing at the old name.
 */
export async function renameBranch(repo: string, thread: Thread): Promise<{ branch?: string; message?: string }> {
	const old = thread.branch;
	if (!old) return {};
	const wanted = branchName(thread);
	// Already there, give or take a collision suffix.
	if (old === wanted || (old.startsWith(`${wanted}-`) && /^\d+$/.test(old.slice(wanted.length + 1)))) return {};
	if (thread.pr || (await isPushed(repo, old))) return { message: `⚠ Kept #${thread.id}'s branch ${old}: it's already pushed` };
	const branch = await freeBranchName(repo, wanted);
	await git(repo, ['branch', '-m', old, branch]);
	return { branch, message: `Renamed #${thread.id}'s branch to ${branch}` };
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
	const branch = await freeBranchName(repo, branchName(thread));
	await git(repo, ['worktree', 'add', '-b', branch, '--no-track', path, start]);
	return { branch, base };
}

/** The checked-out branch, or the commit if HEAD is detached. */
export async function currentRef(repo: string): Promise<string> {
	const symbolic = await execa('git', ['-C', repo, 'symbolic-ref', '--short', '-q', 'HEAD'], { reject: false });
	return symbolic.stdout || (await git(repo, ['rev-parse', 'HEAD'])).stdout;
}

/**
 * The remote's default branch (e.g. `main`), if origin has told us one. Asks origin first: the
 * local `origin/HEAD` is set at clone time and goes stale when the remote's default changes (a
 * retired `master`). Offline, it falls back to that local ref.
 */
export async function defaultBranch(repo: string): Promise<string | undefined> {
	const remote = await execa('git', ['-C', repo, 'ls-remote', '--symref', 'origin', 'HEAD'], { reject: false, timeout: 10_000 });
	const named = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(remote.stdout)?.[1];
	if (named) return named;
	const result = await execa('git', ['-C', repo, 'symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'], { reject: false });
	return result.stdout.replace(/^origin\//, '') || undefined;
}

export async function checkout(repo: string, ref: string): Promise<void> {
	await git(repo, ['checkout', ref]);
}

/** Bring the checked-out branch up to origin's `branch`, refusing anything but a fast-forward. */
export async function pullBranch(repo: string, branch: string): Promise<void> {
	await git(repo, ['pull', '-q', '--ff-only', 'origin', branch]);
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

// The subject of the temporary commit that carries a thread's uncommitted changes to its new
// checkout when it moves into or out of Local.
const CARRY_SUBJECT = 'oo: carry uncommitted changes';

/**
 * Commit everything uncommitted (untracked files too), so it moves with the branch; returns false
 * if there was nothing. Skips hooks and signing, and uses its own identity: it's undone by
 * restoreChanges as soon as the branch is checked out again.
 */
export async function carryChanges(cwd: string): Promise<boolean> {
	if (!(await stageAll(cwd))) return false;
	const config = ['-c', 'user.name=oo', '-c', 'user.email=oo@localhost', '-c', 'commit.gpgsign=false'];
	await git(cwd, [...config, 'commit', '-q', '--no-verify', '-m', CARRY_SUBJECT]);
	return true;
}

/** Undo carryChanges' commit, leaving its changes uncommitted. Does nothing unless HEAD is that commit. */
export async function restoreChanges(cwd: string): Promise<void> {
	const subject = await execa('git', ['-C', cwd, 'log', '-1', '--format=%s'], { reject: false });
	if (subject.stdout === CARRY_SUBJECT) await git(cwd, ['reset', '-q', 'HEAD~1']);
}

export async function pushBranch(cwd: string, branch: string): Promise<void> {
	await git(cwd, ['push', '-u', 'origin', branch]);
}

/** Force-push after a rebase, unless origin has commits we haven't seen. */
export async function forcePushBranch(cwd: string, branch: string): Promise<void> {
	await git(cwd, ['push', '--force-with-lease', '-u', 'origin', branch]);
}

/** Whether a rebase in `cwd` stopped partway, e.g. on conflicts. */
export async function rebaseInProgress(cwd: string): Promise<boolean> {
	for (const dir of ['rebase-merge', 'rebase-apply']) {
		const { stdout } = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', dir]);
		if (existsSync(stdout)) return true;
	}
	return false;
}

export type RebaseResult = { result: 'up-to-date' | 'rebased' } | { result: 'conflicts'; files: string[] };

/**
 * Fetch origin's `base` and rebase the checked-out branch onto it, keeping uncommitted changes
 * (autostashed in the rebase's own state, not the stash list shared with other worktrees). On
 * conflicts the rebase is left in progress for someone to finish.
 */
export async function rebaseOnMain(cwd: string, base: string): Promise<RebaseResult> {
	await git(cwd, ['fetch', 'origin', base]);
	const upstream = `origin/${base}`;
	const behind = await execa('git', ['-C', cwd, 'merge-base', '--is-ancestor', upstream, 'HEAD'], { reject: false });
	if (behind.exitCode === 0) return { result: 'up-to-date' };
	const rebased = await execa('git', ['-C', cwd, 'rebase', '--autostash', upstream], { reject: false });
	if (rebased.exitCode === 0) return { result: 'rebased' };
	if (!(await rebaseInProgress(cwd))) throw new Error(rebased.stderr || rebased.stdout);
	const { stdout } = await git(cwd, ['diff', '--name-only', '--diff-filter=U']);
	return { result: 'conflicts', files: stdout.split('\n').filter(Boolean) };
}
