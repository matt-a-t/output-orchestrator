// Per-project hooks: shell commands set in the project's settings (P) for things that happen on the board.
import { hasWorktree, worktreePath } from './git.js';
import { HOOK_LABELS, type Column, type Project, type ProjectHook, type Thread } from './state.js';
import { killWindow, openWindow } from './tmux.js';

/**
 * One window per project for the local hooks and one for the polish hooks, so a hook still running
 * (e.g. a dev server) is stopped by the next of its kind but not by the other kind.
 */
export function hookWindowName(project: Project, hook: ProjectHook): string {
	return hook === 'enterPolish' || hook === 'leavePolish' ? `oo-hook-${project.name}-polish` : `oo-hook-${project.name}`;
}

/**
 * Run the project's `hook` for the thread in `cwd`, in a background tmux window that stays open
 * as a shell afterwards so its output can be read. Returns what to tell the user, if it ran.
 */
export async function runHook(project: Project, hook: ProjectHook, thread: Thread, cwd: string): Promise<string | undefined> {
	const command = project.hooks[hook]?.trim();
	if (!command) return;
	const window = hookWindowName(project, hook);
	await killWindow(window);
	// The command comes in through the environment so it needs no quoting.
	const script = 'sh -c "$OO_HOOK"; status=$?; echo; echo "[oo] $OO_HOOK_NAME hook exited with status $status"; exec "${SHELL:-sh}"';
	const env = {
		OO_HOOK: command,
		OO_HOOK_NAME: HOOK_LABELS[hook],
		OO_THREAD_ID: thread.id,
		OO_PROJECT: project.name,
		OO_BRANCH: thread.branch ?? '',
	};
	await openWindow(window, `hook:${project.name}`, cwd, ['sh', '-c', script], env, { background: true });
	return `running ${project.name}'s ${HOOK_LABELS[hook]} hook in window ${window}`;
}

/** `runHook`, saying so if it couldn't start (e.g. no tmux server for `oo thread move` from a plain shell). */
export async function tryHook(project: Project, hook: ProjectHook, thread: Thread, cwd: string): Promise<string | undefined> {
	return runHook(project, hook, thread, cwd).catch(
		err => `✗ ${HOOK_LABELS[hook]} hook didn't start: ${err instanceof Error ? err.message : String(err)}`,
	);
}

/** The hook a move from `from` to `to` sets off, if any. */
export function columnHook(from: Column, to: Column): ProjectHook | undefined {
	if (from === to) return;
	if (to === 'polish') return 'enterPolish';
	if (from === 'polish') return 'leavePolish';
}

/**
 * Run the hook for the thread's move out of `from`, once its worktree is in step with where it is
 * now. It runs in the thread's worktree, or the project's checkout once that's gone (Done, archived).
 */
export async function runColumnHook(project: Project, from: Column, thread: Thread): Promise<string | undefined> {
	const hook = columnHook(from, thread.column);
	if (!hook) return;
	const cwd = thread.cwd ?? (hasWorktree(thread) ? worktreePath(thread) : project.path);
	return tryHook(project, hook, thread, cwd);
}
