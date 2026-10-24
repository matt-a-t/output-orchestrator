// Per-project hooks: shell commands set in the project's settings (P) for things that happen on the board.
import { hasWorktree, worktreePath } from './git.js';
import { HOOK_LABELS, type Column, type Project, type ProjectHook, type Thread } from './state.js';
import { killWindow, openWindow } from './tmux.js';

/**
 * One window per project for each kind of hook (local, polish, new thread, worktree created), so a hook still running
 * (e.g. a dev server) is stopped by the next of its kind but not by another kind.
 */
export function hookWindowName(project: Project, hook: ProjectHook): string {
	if (hook === 'enterPolish' || hook === 'leavePolish') return `oo-hook-${project.name}-polish`;
	if (hook === 'newThread') return `oo-hook-${project.name}-new`;
	if (hook === 'worktreeCreated') return `oo-hook-${project.name}-worktree`;
	return `oo-hook-${project.name}`;
}

/** What a hook's command gets in its environment, besides `extra` (e.g. the new thread's prompt). */
export function hookEnv(project: Project, hook: ProjectHook, thread: Thread, extra: Record<string, string> = {}): Record<string, string> {
	return {
		OO_HOOK_NAME: HOOK_LABELS[hook],
		OO_THREAD_ID: thread.id,
		OO_THREAD_TITLE: thread.title,
		OO_PROJECT: project.name,
		OO_BRANCH: thread.branch ?? '',
		...extra,
	};
}

/**
 * Run the project's `hook` for the thread in `cwd`, in a background tmux window that stays open
 * as a shell afterwards so its output can be read. Returns what to tell the user, if it ran.
 */
export async function runHook(
	project: Project,
	hook: ProjectHook,
	thread: Thread,
	cwd: string,
	extraEnv: Record<string, string> = {},
): Promise<string | undefined> {
	const command = project.hooks[hook]?.trim();
	if (!command) return;
	const window = hookWindowName(project, hook);
	await killWindow(window);
	// The command comes in through the environment so it needs no quoting.
	const script = 'sh -c "$OO_HOOK"; status=$?; echo; echo "[oo] $OO_HOOK_NAME hook exited with status $status"; exec "${SHELL:-sh}"';
	const env = { OO_HOOK: command, ...hookEnv(project, hook, thread, extraEnv) };
	await openWindow(window, `hook:${project.name}`, cwd, ['sh', '-c', script], env, { background: true });
	return `running ${project.name}'s ${HOOK_LABELS[hook]} hook in window ${window}`;
}

/** `runHook`, saying so if it couldn't start (e.g. no tmux server for `oo thread move` from a plain shell). */
export async function tryHook(
	project: Project,
	hook: ProjectHook,
	thread: Thread,
	cwd: string,
	extraEnv: Record<string, string> = {},
): Promise<string | undefined> {
	return runHook(project, hook, thread, cwd, extraEnv).catch(
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

/**
 * Run the project's new thread hook for a thread just added, with its initial prompt (if any) as
 * OO_PROMPT. It runs where the thread works if that's there yet, else in the project's checkout.
 */
export async function runNewThreadHook(project: Project, thread: Thread, prompt = ''): Promise<string | undefined> {
	const cwd = thread.cwd ?? (hasWorktree(thread) ? worktreePath(thread) : project.path);
	return tryHook(project, 'newThread', thread, cwd, { OO_PROMPT: prompt });
}
