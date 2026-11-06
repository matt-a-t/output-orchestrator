// A project's commands (set in P, run with r on the board): each run is its own tmux session, outside
// the `oo` session, so it can be watched from a separate terminal window and keeps going once that's closed.
import { execa } from 'execa';
import { threadEnv } from './hooks.js';
import type { Project, ProjectCommand, Thread } from './state.js';

export const RUN_PREFIX = 'oo-run';

/** Names in run sessions are cut down to what tmux takes, and `_` is kept to separate them. */
const slug = (s: string) => s.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';

/** The start of the session names for the project's runs, all of them or just the thread's (`main` without one). */
export function runPrefix(project: Project, thread?: Thread | 'any'): string {
	const base = `${RUN_PREFIX}_${slug(project.name)}_`;
	if (thread === 'any') return base;
	return `${base}${thread ? thread.id : 'main'}_`;
}

/** The tmux session `cmd` runs in for the thread: one per project, thread and command, so #12's dev server isn't #14's. */
export function runSessionName(project: Project, thread: Thread | undefined, cmd: ProjectCommand): string {
	return `${runPrefix(project, thread)}${slug(cmd.name)}`;
}

/** A run still going, or the status its command exited with (its session stays open as a shell). */
export type RunStatus = { running: true } | { running: false; exit: number };

/** `list-sessions` output (name, then @oo-exit, tab-separated) as the status of each run session. */
export function parseRunStatuses(stdout: string): Map<string, RunStatus> {
	const statuses = new Map<string, RunStatus>();
	for (const line of stdout.split('\n')) {
		const [name, exit = ''] = line.split('\t');
		if (!name?.startsWith(`${RUN_PREFIX}_`)) continue;
		statuses.set(name, exit.trim() === '' ? { running: true } : { running: false, exit: Number(exit) });
	}
	return statuses;
}

/** Every run session's status; none without a tmux server. */
export async function runStatuses(): Promise<Map<string, RunStatus>> {
	const result = await execa('tmux', ['list-sessions', '-F', '#{session_name}\t#{@oo-exit}'], { reject: false });
	return result.exitCode === 0 ? parseRunStatuses(result.stdout) : new Map();
}

// The command comes in through the environment so it needs no quoting. Once it's done the session
// records how it went (for the board) and stays open as a shell, so its output can still be read.
const RUN_SCRIPT = [
	'sh -c "$OO_CMD"',
	'status=$?',
	'tmux set-option @oo-exit "$status"',
	'echo',
	'echo "[oo] $OO_COMMAND_NAME exited with status $status (r on the board runs it again)"',
	'exec "${SHELL:-sh}"',
].join('; ');

/** Start `cmd` for the thread in a new detached session named `session`, in `cwd`. */
export async function startCommand(session: string, project: Project, thread: Thread | undefined, cmd: ProjectCommand, cwd: string): Promise<void> {
	const env = { OO_CMD: cmd.command, OO_COMMAND_NAME: cmd.name, ...threadEnv(project, thread) };
	const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
	await execa('tmux', ['new-session', '-d', '-s', session, '-c', cwd, ...envArgs, 'sh', '-c', RUN_SCRIPT]);
}

/** Stop a run, closing its session. */
export async function stopCommand(session: string): Promise<void> {
	await execa('tmux', ['kill-session', '-t', `=${session}`], { reject: false });
}

/** Close every run session whose name starts with `prefix` (all of them by default); none without a tmux server. */
export async function killRunSessions(prefix = `${RUN_PREFIX}_`): Promise<void> {
	for (const name of (await runStatuses()).keys()) if (name.startsWith(prefix)) await stopCommand(name);
}
