// A project's commands (set in P, run with r on the board): each run is its own tmux session, outside
// the `oo` session, so it can be watched from a separate terminal window and keeps going once that's closed.
import { spawn } from 'node:child_process';
import { execa } from 'execa';
import { threadEnv } from './hooks.js';
import { currentSessionId, shellQuote } from './tmux.js';
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

/** A run still going, or the status its command exited with (its session stays open as a shell), and how many windows are on it. */
export type RunStatus = ({ running: true } | { running: false; exit: number }) & { attached: number };

/** `list-sessions` output (name, @oo-exit, clients attached; tab-separated) as the status of each run session. */
export function parseRunStatuses(stdout: string): Map<string, RunStatus> {
	const statuses = new Map<string, RunStatus>();
	for (const line of stdout.split('\n')) {
		const [name, exit = '', attached = '0'] = line.split('\t');
		if (!name?.startsWith(`${RUN_PREFIX}_`)) continue;
		const clients = Number(attached) || 0;
		statuses.set(name, exit.trim() === '' ? { running: true, attached: clients } : { running: false, exit: Number(exit), attached: clients });
	}
	return statuses;
}

/** Every run session's status; none without a tmux server. */
export async function runStatuses(): Promise<Map<string, RunStatus>> {
	const result = await execa('tmux', ['list-sessions', '-F', '#{session_name}\t#{@oo-exit}\t#{session_attached}'], { reject: false });
	return result.exitCode === 0 ? parseRunStatuses(result.stdout) : new Map();
}

/** What the board polls tmux for: the windows in its own session, and the run sessions' statuses. */
export type TmuxSnapshot = { windows: string[]; runs: Map<string, RunStatus> };

const SNAPSHOT_FORMAT = ['#{session_id}', '#{window_name}', '#{session_name}', '#{@oo-exit}', '#{session_attached}'].join('\t');

/** `list-windows -a` output in SNAPSHOT_FORMAT as a snapshot, the windows being those of `session` (an ID). */
export function parseSnapshot(stdout: string, session: string): TmuxSnapshot {
	const windows: string[] = [];
	const sessions: string[] = [];
	for (const line of stdout.split('\n').filter(Boolean)) {
		const [id, window = '', ...rest] = line.split('\t');
		if (id === session) windows.push(window);
		sessions.push(rest.join('\t'));
	}
	return { windows, runs: parseRunStatuses(sessions.join('\n')) };
}

/** Both of the board's tmux polls in one call. */
export async function tmuxSnapshot(): Promise<TmuxSnapshot> {
	const [session, { stdout }] = await Promise.all([currentSessionId(), execa('tmux', ['list-windows', '-a', '-F', SNAPSHOT_FORMAT])]);
	return parseSnapshot(stdout, session);
}

/** Whether any of the thread's commands are running (the ▶ on its card). */
export function threadRunning(runs: Map<string, RunStatus>, project: Project, thread: Thread): boolean {
	const prefix = runPrefix(project, thread);
	return [...runs].some(([name, status]) => status.running && name.startsWith(prefix));
}

const runEnv = (project: Project, thread: Thread | undefined, cmd: ProjectCommand) => ({ OO_CMD: cmd.command, OO_COMMAND_NAME: cmd.name, ...threadEnv(project, thread) });

/**
 * What a run's session runs. The command comes in through the environment so it needs no quoting. Once it's done
 * the session records how it went (for the board) and stays open as a shell, so its output can still be read.
 * With `container` (a thread's, see container.ts), only the command runs in it, through `docker exec` in `cwd`
 * with the same environment; recording how it went and the shell after stay on the host, with tmux.
 */
export function runScript(container?: { name: string; cwd: string; env: string[]; session: string }): string {
	// docker exec doesn't pass a hangup on, so killing the session would leave the command running in the container:
	// it records its process group (its pid, as the exec's session leader) for stopInContainer to end it by.
	const command = container
		? `docker exec -it -w ${shellQuote(container.cwd)} ${container.env.map(name => `-e ${name}`).join(' ')} ${shellQuote(container.name)} sh -c ${shellQuote(`echo $$ > ${runPidFile(container.session)}; exec sh -c "$OO_CMD"`)}`
		: 'sh -c "$OO_CMD"';
	return [
		command,
		'status=$?',
		'tmux set-option @oo-exit "$status"',
		'echo',
		'echo "[oo] $OO_COMMAND_NAME exited with status $status (r on the board runs it again)"',
		'exec "${SHELL:-sh}"',
	].join('; ');
}

/** Where, in its container, a run's process group is recorded. */
const runPidFile = (session: string) => `/tmp/oo-run-${session}.pid`;

// The tmux option a run's session keeps its container's name in.
const CONTAINER_OPTION = '@oo-container';

/**
 * The script that ends a run's command in its container: TERM to its process group, then KILL if it's still going
 * after 5s, so a restarted dev server finds its port free.
 */
export function stopScript(session: string): string {
	const file = runPidFile(session);
	return [
		`pid=$(cat ${file} 2>/dev/null) || exit 0`,
		'kill -TERM -$pid 2>/dev/null',
		'i=0; while kill -0 -$pid 2>/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done',
		'kill -KILL -$pid 2>/dev/null',
		`rm -f ${file}`,
	].join('; ');
}

/** End the run's command in its container, if it was started in one. */
async function stopInContainer(session: string): Promise<void> {
	const option = await execa('tmux', ['show-options', '-v', '-t', `=${session}:`, CONTAINER_OPTION], { reject: false });
	const name = option.exitCode === 0 ? option.stdout.trim() : '';
	if (name) await execa('docker', ['exec', name, 'sh', '-c', stopScript(session)], { reject: false });
}

async function recordContainer(session: string, container: string | undefined): Promise<void> {
	await execa('tmux', ['set-option', ...(container ? [] : ['-u']), '-t', `=${session}:`, CONTAINER_OPTION, ...(container ? [container] : [])]);
}

const runArgs = (session: string, project: Project, thread: Thread | undefined, cmd: ProjectCommand, cwd: string, container: string | undefined) => {
	const env = runEnv(project, thread, cmd);
	return [
		'-c',
		cwd,
		...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
		'sh',
		'-c',
		runScript(container ? { name: container, cwd, env: Object.keys(env), session } : undefined),
	];
};

/** Start `cmd` for the thread in a new detached session named `session`, in `cwd`, and in `container` if given. */
export async function startCommand(session: string, project: Project, thread: Thread | undefined, cmd: ProjectCommand, cwd: string, container?: string): Promise<void> {
	await execa('tmux', ['new-session', '-d', '-s', session, ...runArgs(session, project, thread, cmd, cwd, container)]);
	if (container) await recordContainer(session, container);
}

/** Run `cmd` again in its session, stopping it if it's still going; windows on it stay open and see it start over. */
export async function restartCommand(session: string, project: Project, thread: Thread | undefined, cmd: ProjectCommand, cwd: string, container?: string): Promise<void> {
	await execa('tmux', ['set-option', '-u', '-t', `=${session}:`, '@oo-exit']);
	await stopInContainer(session);
	await recordContainer(session, container);
	await execa('tmux', ['respawn-pane', '-k', '-t', `=${session}:`, ...runArgs(session, project, thread, cmd, cwd, container)]);
}

/** Stop a run, closing its session. */
export async function stopCommand(session: string): Promise<void> {
	await stopInContainer(session);
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
		const child = spawn(program!, args, { detached: true, stdio: 'ignore' });
		child.unref();
		// One that fails straight off (not found, or exiting non-zero) is worth hearing about; most hand off and exit 0.
		const problem = await new Promise<string | undefined>(resolve => {
			child.on('error', err => resolve(err.message));
			child.on('exit', code => resolve(code ? `exited with status ${code}` : undefined));
			setTimeout(() => resolve(undefined), 1000);
		});
		return problem ? `✗ Couldn't open a terminal with ${program}: ${problem}` : `Opened ${title} in a new window`;
	}
	await execa('tmux', ['switch-client', '-t', `=${session}`]);
	return `Switched to ${title} (no terminal to open it in: set OO_TERMINAL); prefix b comes back`;
}

/** The project's commands as `editCommands` shows them in $EDITOR: one `name: command` a line. */
export function commandsText(commands: ProjectCommand[]): string {
	return commands.map(c => `${c.name}: ${c.command}`).join('\n');
}

/**
 * Read back commandsText once edited: the name is up to the first `:`. Lines with no name or no
 * command are dropped, as is a second command of the same name (`problems` says which).
 */
export function parseCommands(lines: string[]): { commands: ProjectCommand[]; problems: string[] } {
	const commands: ProjectCommand[] = [];
	const problems: string[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		const colon = line.indexOf(':');
		const name = colon < 0 ? '' : line.slice(0, colon).trim();
		const command = colon < 0 ? '' : line.slice(colon + 1).trim();
		if (!name || !command) problems.push(`"${line.trim()}" isn't name: command`);
		else if (commands.some(c => c.name === name)) problems.push(`a second "${name}"`);
		else commands.push({ name, command });
	}
	return { commands, problems };
}
