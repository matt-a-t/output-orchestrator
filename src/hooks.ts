// Per-project hooks: shell commands set in the project's settings (P) for things that happen on the board.
import { execa } from 'execa';
import { containerScript, stopKeyed } from './container.js';
import { errorMessage } from './errors.js';
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

/** What the project's hooks and commands are told about the thread they run for (empty without one). */
export function threadEnv(project: Project, thread: Thread | undefined): Record<string, string> {
	return {
		OO_THREAD_ID: thread?.id ?? '',
		OO_THREAD_TITLE: thread?.title ?? '',
		OO_PROJECT: project.name,
		OO_BRANCH: thread?.branch ?? '',
	};
}

/** What a hook's command gets in its environment, besides `extra` (e.g. the new thread's prompt). */
export function hookEnv(project: Project, hook: ProjectHook, thread: Thread, extra: Record<string, string> = {}): Record<string, string> {
	return { OO_HOOK_NAME: HOOK_LABELS[hook], ...threadEnv(project, thread), ...extra };
}

/** Where a hook runs besides the host: the thread's container, by name. */
export type HookOptions = { container?: string };

/**
 * The script a hook's window runs: the hook (from `$OO_HOOK`, so it needs no quoting), on the host or with only the
 * hook itself in `container`, then a line saying how it exited and a shell on the host to read its output in.
 */
export function hookScript(env: string[], cwd: string, window: string, container?: string): string {
	const command = container ? containerScript({ name: container, cwd, env, key: window }, 'OO_HOOK') : 'sh -c "$OO_HOOK"';
	return `${command}; status=$?; echo; echo "[oo] $OO_HOOK_NAME hook exited with status $status"; exec "\${SHELL:-sh}"`;
}

// The tmux option a hook's window keeps its container's name in, so the next hook of its kind can stop it there.
const CONTAINER_OPTION = '@oo-container';

/** Close the hook's window, stopping what it started in a container too: closing the window alone leaves that running. */
async function stopHook(window: string): Promise<void> {
	const option = await execa('tmux', ['show-options', '-w', '-v', '-t', `:${window}`, CONTAINER_OPTION], { reject: false });
	const container = option.exitCode === 0 ? option.stdout.trim() : '';
	if (container) await stopKeyed(container, window);
	await killWindow(window);
}

/**
 * Run the project's `hook` for the thread in `cwd`, in a background tmux window that stays open
 * as a shell afterwards so its output can be read, and in the thread's container if `container` names it.
 * Returns what to tell the user, if it ran.
 */
export async function runHook(
	project: Project,
	hook: ProjectHook,
	thread: Thread,
	cwd: string,
	extraEnv: Record<string, string> = {},
	{ container }: HookOptions = {},
): Promise<string | undefined> {
	const command = project.hooks[hook]?.trim();
	if (!command) return;
	const window = hookWindowName(project, hook);
	await stopHook(window);
	const env = { OO_HOOK: command, ...hookEnv(project, hook, thread, extraEnv) };
	await openWindow(window, `hook:${project.name}`, cwd, ['sh', '-c', hookScript(Object.keys(env), cwd, window, container)], env, { background: true });
	if (container) await execa('tmux', ['set-option', '-w', '-t', `:${window}`, CONTAINER_OPTION, container]);
	return `running ${project.name}'s ${HOOK_LABELS[hook]} hook in window ${window}${container ? ` (in ${container})` : ''}`;
}

/** `runHook`, saying so if it couldn't start (e.g. no tmux server for `oo thread move` from a plain shell). */
export async function tryHook(
	project: Project,
	hook: ProjectHook,
	thread: Thread,
	cwd: string,
	extraEnv: Record<string, string> = {},
	options: HookOptions = {},
): Promise<string | undefined> {
	return runHook(project, hook, thread, cwd, extraEnv, options).catch(
		err => `✗ ${HOOK_LABELS[hook]} hook didn't start: ${errorMessage(err)}`,
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
