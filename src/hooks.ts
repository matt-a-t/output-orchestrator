// Per-project hooks: shell commands set in the project's settings (P) for things that happen on the board.
import { HOOK_LABELS, type Project, type ProjectHook, type Thread } from './state.js';
import { killWindow, openWindow } from './tmux.js';

/** One window per project, so a hook still running (e.g. a dev server) is stopped by the next one. */
export function hookWindowName(project: Project): string {
	return `oo-hook-${project.name}`;
}

/**
 * Run the project's `hook` for the thread in `cwd`, in a background tmux window that stays open
 * as a shell afterwards so its output can be read. Returns what to tell the user, if it ran.
 */
export async function runHook(project: Project, hook: ProjectHook, thread: Thread, cwd: string): Promise<string | undefined> {
	const command = project.hooks[hook]?.trim();
	if (!command) return;
	const window = hookWindowName(project);
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
	await openWindow(window, cwd, ['sh', '-c', script], env, { background: true });
	return `running ${project.name}'s ${HOOK_LABELS[hook]} hook in window ${window}`;
}
