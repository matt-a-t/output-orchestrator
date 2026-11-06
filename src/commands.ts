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

/** How to open a separate terminal window: the argv to spawn, or switching the board's tmux client to the run as a last resort. */
export type TerminalLaunch = { argv: string[] } | { switchClient: true };

/** What terminalCommand goes on: the environment and whether wt.exe (Windows Terminal) is on the PATH. */
export type TerminalEnv = { env: NodeJS.ProcessEnv; hasWt: boolean };

/**
 * The window to watch a run in, running `attach` (tmux attaching to its session): `$OO_TERMINAL`
 * (a command it's added to the end of, e.g. `kitty -e`), a Windows Terminal window on WSL, the
 * desktop's terminal on Linux, else none.
 */
export function terminalCommand({ env, hasWt }: TerminalEnv, attach: string[], title: string): TerminalLaunch {
	const custom = env.OO_TERMINAL?.trim();
	if (custom) return { argv: [...custom.split(/\s+/), ...attach] };
	if (env.WSL_DISTRO_NAME && hasWt) {
		// wt reads ; as the start of its next command, even in the title.
		const safeTitle = title.replaceAll(';', ',');
		return { argv: ['wt.exe', '-w', 'new', 'new-tab', '--title', safeTitle, 'wsl.exe', '-d', env.WSL_DISTRO_NAME, '--', ...attach] };
	}
	if (env.DISPLAY || env.WAYLAND_DISPLAY) return { argv: [env.TERMINAL || 'x-terminal-emulator', '-e', ...attach] };
	return { switchClient: true };
}

/** tmux, by its full path (the new window's shell may not have the same PATH), on the board's server (its socket is the first part of $TMUX). */
export function tmuxAttach(tmuxPath: string, env: NodeJS.ProcessEnv, session: string): string[] {
	const socket = env.TMUX?.split(',')[0];
	return [tmuxPath, ...(socket ? ['-S', socket] : []), 'attach-session', '-t', `=${session}`];
}

const onPath = async (program: string) => {
	const result = await execa('sh', ['-c', 'command -v "$1"', 'sh', program], { reject: false });
	return result.exitCode === 0 ? result.stdout.trim() : undefined;
};

/**
 * Open a separate terminal window on the run in `session`; closing it leaves the run going. With no
 * way to open one, the board's own tmux client switches to it (prefix b switches back). Returns what
 * to tell the user.
 */
export async function openRun(session: string, title: string): Promise<string> {
	const launch = terminalCommand({ env: process.env, hasWt: Boolean(await onPath('wt.exe')) }, tmuxAttach((await onPath('tmux')) ?? 'tmux', process.env, session), title);
	if ('argv' in launch) {
		const [program, ...args] = launch.argv;
		const child = execa(program!, args, { detached: true, stdio: 'ignore', reject: false });
		child.unref();
		const result = await Promise.race([child, new Promise(resolve => setTimeout(resolve, 1000))]);
		// One that fails straight off (not found, or exiting non-zero) is worth hearing about; most hand off and exit 0.
		if (result && typeof result === 'object' && 'failed' in result && result.failed) {
			return `✗ Couldn't open a terminal with ${program}: ${result.shortMessage}`;
		}
		return `Opened ${title} in a new window`;
	}
	await execa('tmux', ['switch-client', '-t', `=${session}`]);
	return `Switched to ${title} (no terminal to open it in: set OO_TERMINAL); prefix b comes back`;
}
