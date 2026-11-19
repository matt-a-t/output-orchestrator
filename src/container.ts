// A thread's own docker container, for projects with a container setting: claude, its shells and the
// project's commands run in it with `docker exec`, while tmux and the board stay on the host.
// Everything is mounted at its host path, so worktree paths, transcripts and `--resume` mean the same inside.

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { joinStack, stackOf } from './stack.js';
import { currentSessionId, shellQuote, threadWindowName } from './tmux.js';
import { transcriptDir } from './transcripts.js';
import { DATA_DIR, hidden, PRIVATE_FILE, type ContainerSetting, type Project, type Thread } from './state.js';

/** The checkout oo runs from (its dist, and the node_modules that needs), mounted read-only for claude's hooks and `oo`. */
const OO_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Claude's long-lived token, from `claude setup-token`: the container gets it in place of ~/.claude's credentials. */
export const TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';

/** Where things are on the host; tests pass their own. */
export type Paths = { home: string; dataDir: string; ooDir: string; uid: number; gid: number; git?: GitIdentity };

/** Your git name and email, as the host's git has them for the project. */
export type GitIdentity = { name?: string; email?: string };

const identities = new Map<string, Promise<GitIdentity>>();

/** The project's git identity on the host, which may come from includes and places the container doesn't see. Read once per repo. */
function gitIdentity(repo: string): Promise<GitIdentity> {
	const get = (key: string) => execa('git', ['-C', repo, 'config', key], { reject: false }).then(r => r.stdout.trim() || undefined);
	let identity = identities.get(repo);
	if (!identity) identities.set(repo, (identity = Promise.all([get('user.name'), get('user.email')]).then(([name, email]) => ({ name, email }))));
	return identity;
}

/** Git's own variables for the identity, so commits in the container are yours. */
const gitEnv = ({ name, email }: GitIdentity = {}) => [
	...(name ? [`GIT_AUTHOR_NAME=${name}`, `GIT_COMMITTER_NAME=${name}`] : []),
	...(email ? [`GIT_AUTHOR_EMAIL=${email}`, `GIT_COMMITTER_EMAIL=${email}`] : []),
];

const hostPaths = (): Paths => ({ home: homedir(), dataDir: DATA_DIR, ooDir: OO_DIR, uid: userInfo().uid, gid: userInfo().gid });

export type ContainerProject = Project & { container: ContainerSetting };

export type Mount = { kind: 'bind'; source: string; target: string; readonly?: boolean } | { kind: 'tmpfs'; target: string };

export const containerName = (thread: Pick<Thread, 'project' | 'id'>) => `oo-${thread.project.replace(/[^a-zA-Z0-9_.-]/g, '-')}-${thread.id}`;

/** Where claude keeps a directory's transcripts, and the project's memory. */
const claudeProjectDir = (home: string, cwd: string) => transcriptDir(cwd, home);

/**
 * The container's own home directory, on the host: claude's config and caches live there between runs.
 * Under DATA_DIR, which every container sees, so `mounts` covers the lot with a tmpfs.
 */
const homesDir = (paths: Paths) => join(paths.dataDir, 'homes');
export const containerHome = (paths: Paths, thread: Pick<Thread, 'project' | 'id'>) => join(homesDir(paths), containerName(thread));

/** The bits of ~/.claude a container's claude reads but mustn't change: the user's settings, instructions and skills. */
const CLAUDE_READONLY = ['settings.json', 'CLAUDE.md', 'skills', 'agents', 'commands', 'keybindings.json'];

/** Your git config, read-only, for your aliases and settings (your name and email come through gitEnv). */
const GIT_READONLY = ['.gitconfig', '.config/git'];

/**
 * The only files in DATA_DIR a container writes: claude's hooks' events and `oo thread`'s requests. The rest
 * (state.json, the claude settings host claudes run hooks from, bin/oo) is read-only, else a container could
 * have the host run what it liked. Both are only ever appended to or emptied, never replaced, so their binds hold.
 */
const DATA_WRITABLE = ['events.jsonl', 'requests.jsonl'];

/** Where init-firewall marks the firewall as up: a root-owned tmpfs, so it goes when the container stops (and its rules with it) and only root can write it. */
const FIREWALL_DIR = '/run/oo';

/**
 * What the container mounts, in order: a parent before what's mounted inside it.
 * - Its own home at $HOME, with DATA_DIR (state, requests, events) on top, read-only but for DATA_WRITABLE, and
 *   not the other threads' worktrees or homes, which tmpfs hides; then only this thread's worktree.
 * - The project's .git, which the worktree's commits go into, with its hooks read-only, since git on the host runs
 *   them. Its config stays writable: `git push -u` and tracking branches write there.
 * - Only this directory's transcripts and the project's memory from ~/.claude, not every project's or the credentials.
 * `existing` says which optional host paths are there (the ~/.claude bits and your git config).
 */
export function mounts(project: Project, thread: Pick<Thread, 'project' | 'id'>, cwd: string, paths: Paths, existing: (path: string) => boolean = existsSync): Mount[] {
	const bind = (path: string, readonly = false): Mount => ({ kind: 'bind', source: resolve(path), target: resolve(path), ...(readonly ? { readonly } : {}) });
	const git = join(project.path, '.git');
	const claude = join(paths.home, '.claude');
	const all: Mount[] = [
		{ kind: 'bind', source: containerHome(paths, thread), target: paths.home },
		bind(paths.dataDir, true),
		...DATA_WRITABLE.map(name => bind(join(paths.dataDir, name))),
		{ kind: 'tmpfs', target: join(paths.dataDir, 'worktrees') },
		{ kind: 'tmpfs', target: homesDir(paths) },
		bind(cwd),
		bind(git),
		bind(join(git, 'hooks'), true),
		bind(paths.ooDir, true),
		bind(claudeProjectDir(paths.home, cwd)),
		bind(join(claudeProjectDir(paths.home, project.path), 'memory')),
		...CLAUDE_READONLY.map(name => join(claude, name))
			.filter(existing)
			.map(path => bind(path, true)),
		...GIT_READONLY.map(name => join(paths.home, name))
			.filter(existing)
			.map(path => bind(path, true)),
	];
	// Docker refuses two mounts at one place, e.g. oo's checkout when it's the worktree too (oo working on itself): the first wins.
	return all.filter((m, i) => all.findIndex(o => o.target === m.target) === i);
}

const mountArg = (m: Mount) =>
	m.kind === 'tmpfs' ? ['--tmpfs', m.target] : ['--mount', `type=bind,source=${m.source},target=${m.target}${m.readonly ? ',readonly' : ''}`];

/**
 * The `docker run` args for the thread's container: it sleeps, running as you with your home path, with every
 * capability dropped but the two the firewall (init-firewall, run as root once it starts) needs. Ports are
 * published on the host's loopback only, at ports docker picks (publishedPorts reads them).
 * The label `oo.config` is a hash of the rest, so a container made from different settings is made again.
 */
export function runArgs(project: ContainerProject, thread: Pick<Thread, 'project' | 'id'>, cwd: string, paths: Paths, existing?: (path: string) => boolean): string[] {
	const args = [
		'--name',
		containerName(thread),
		'--init',
		'--user',
		`${paths.uid}:${paths.gid}`,
		'-e',
		`HOME=${paths.home}`,
		...gitEnv(paths.git).flatMap(v => ['-e', v]),
		'-w',
		cwd,
		'--cap-drop',
		'ALL',
		'--cap-add',
		'NET_ADMIN',
		'--cap-add',
		'NET_RAW',
		'--security-opt',
		'no-new-privileges',
		...mounts(project, thread, cwd, paths, existing).flatMap(mountArg),
		'--tmpfs',
		`${FIREWALL_DIR}:mode=755`,
		...project.container.ports.flatMap(port => ['-p', `127.0.0.1::${port}`]),
		'--label',
		`oo.thread=${thread.id}`,
		'--label',
		`oo.project=${thread.project}`,
	];
	const config = configHash([...args, project.container.image, ...project.container.allow]);
	return ['run', '-d', ...args, '--label', `oo.config=${config}`, project.container.image, 'sleep', 'infinity'];
}

const configHash = (parts: string[]) => createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16);

/** The config hash runArgs labels a container with. */
export const configLabel = (args: string[]) => args.find(a => a.startsWith('oo.config='))?.slice('oo.config='.length);

/**
 * The command a tmux window or pane runs to have `command` run in the container, in `cwd`: `env` is set there,
 * DATA_DIR/bin (the `oo` wrapper) goes on the image's own PATH, and claude's token passes through by name, so
 * it's in no process's arguments. Like paneCommand, it records its session under `key` (the thread's window),
 * for stopKeyed: closing the window doesn't end it.
 */
export function execCommand(name: string, cwd: string, command: string[], env: Record<string, string>, { dataDir = DATA_DIR, interactive = true, key = name } = {}): string[] {
	return [
		'docker',
		'exec',
		...(interactive ? ['-it'] : ['-i']),
		'-w',
		cwd,
		...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
		'-e',
		TOKEN_ENV,
		name,
		'sh',
		'-c',
		`echo $$ >> ${pidFile(key)}; PATH="$0:$PATH" exec "$@"`,
		join(dataDir, 'bin'),
		...command,
	];
}

/** `docker port` output as container port → host port. */
export function parsePorts(stdout: string): Map<number, number> {
	const ports = new Map<number, number>();
	for (const line of stdout.split('\n')) {
		const match = line.match(/^(\d+)\/tcp -> [^\s]*:(\d+)$/);
		if (match && !ports.has(Number(match[1]))) ports.set(Number(match[1]), Number(match[2]));
	}
	return ports;
}

/**
 * Directories and files the mounts land on inside the container's home, made on the host first: docker would
 * make the missing ones as root, which claude (running as you) then couldn't write in. Also starts claude's config
 * with onboarding done and the worktree trusted, so each new container doesn't ask.
 */
export function prepareHome(project: Project, thread: Pick<Thread, 'project' | 'id'>, cwd: string, paths: Paths, existing: (path: string) => boolean = existsSync): void {
	const home = containerHome(paths, thread);
	mkdirSync(home, { recursive: true, mode: 0o700 });
	for (const name of DATA_WRITABLE) appendFileSync(join(paths.dataDir, name), '', { mode: PRIVATE_FILE });
	for (const m of mounts(project, thread, cwd, paths, existing)) {
		if (m.kind !== 'bind') continue;
		if (m.target === paths.home) continue;
		// The host side of the bind has to be there too: these two are claude's, made on first use.
		if (m.source.startsWith(join(paths.home, '.claude', 'projects'))) mkdirSync(m.source, { recursive: true });
		const rel = relative(paths.home, m.target);
		if (rel.startsWith('..')) continue;
		const inHome = join(home, rel);
		if (existsSync(inHome)) continue;
		// A file is mounted on a file, so the mount point needs to be one.
		if (existsSync(m.source) && statSync(m.source).isFile()) {
			mkdirSync(dirname(inHome), { recursive: true });
			writeFileSync(inHome, '');
		} else mkdirSync(inHome, { recursive: true });
	}
	const config = join(home, '.claude.json');
	if (!existsSync(config)) {
		writeFileSync(config, JSON.stringify({ hasCompletedOnboarding: true, projects: { [cwd]: { hasTrustDialogAccepted: true } } }), { mode: PRIVATE_FILE });
	}
}

const docker = (args: string[], options: { reject?: boolean } = {}) => execa('docker', args, options);

/** Whether the container exists and runs, and the config it was made with. */
async function inspect(name: string): Promise<{ running: boolean; config?: string } | undefined> {
	const result = await docker(['inspect', '--format', '{{.State.Running}}\t{{index .Config.Labels "oo.config"}}', name], { reject: false });
	if (result.exitCode !== 0) return;
	const [running, config] = result.stdout.trim().split('\t');
	return { running: running === 'true', config: config || undefined };
}

/**
 * Lock egress down to the firewall's defaults and the project's hosts, unless it's up already (init-firewall marks
 * it in FIREWALL_DIR); the container goes if that fails, rather than run open.
 */
async function firewall(name: string, allow: string[]): Promise<void> {
	const script = `test -f ${FIREWALL_DIR}/firewall || exec init-firewall "$@"`;
	const result = await docker(['exec', '-u', 'root', name, 'sh', '-c', script, 'sh', ...allow], { reject: false });
	if (result.exitCode === 0) return;
	await removeContainer(name);
	const missing = /executable file not found|no such file|init-firewall: not found/i.test(result.stderr);
	throw new Error(
		missing
			? `The image has no init-firewall, so ${name} can't be locked down — build it FROM the reference image (docker/thread.Dockerfile)`
			: `The firewall in ${name} didn't start: ${result.stderr.trim() || result.stdout.trim()}`,
	);
}

/**
 * Have the thread's container running, making it (or making it again, if its settings changed since) or starting
 * it as needed, with its firewall up. Returns its published ports, container port → host port.
 */
export function ensureContainer(project: ContainerProject, thread: Thread, cwd: string, paths?: Paths): Promise<Map<number, number>> {
	// One at a time per container: two at once would both make it, and one would fail.
	const name = containerName(thread);
	const pending = ensuring.get(name);
	if (pending) return pending;
	const ensured = makeReady(project, thread, cwd, paths).finally(() => ensuring.delete(name));
	ensuring.set(name, ensured);
	return ensured;
}

const ensuring = new Map<string, Promise<Map<number, number>>>();

async function makeReady(project: ContainerProject, thread: Thread, cwd: string, paths?: Paths): Promise<Map<number, number>> {
	const name = containerName(thread);
	const [git, inspected] = await Promise.all([paths ? undefined : gitIdentity(project.path), inspect(name)]);
	paths ??= { ...hostPaths(), git };
	const args = runArgs(project, thread, cwd, paths);
	let current = inspected;
	// Made from other settings: made again, but not under something running in it (claude, a shell, a command),
	// which would go without warning. It's made again once they've stopped, e.g. when claude idles out.
	if (current && current.config !== configLabel(args) && !(current.running && (await inUse(name)))) {
		await removeContainer(name);
		current = undefined;
	}
	const restarted = !current?.running;
	if (!current) {
		prepareHome(project, thread, cwd, paths);
		const made = await docker(args, { reject: false });
		// Another oo (`oo split` from a tmux key) may have just made it.
		if (made.exitCode !== 0 && !/Conflict/i.test(made.stderr)) throw new Error(`docker couldn't make ${name}: ${made.stderr.trim()}`);
	} else if (!current.running) await docker(['start', name]);
	// Every time: a container left running without it (the board quit before it was up) mustn't be used open.
	await firewall(name, project.container.allow);
	// Made or started again while in Local with a stack: it's off the stack's networks, or its firewall forgot them.
	// Not worth failing over, which would stop claude starting; restoreForwards and o say what's wrong.
	const stack = stackOf(project);
	if (restarted && stack && thread.local && thread.forwarded) await joinStack(stack, name).catch(() => {});
	const ports = await publishedPorts(name);
	knownPorts.set(name, ports);
	return ports;
}

/** Whether anything was started in the container with docker exec: those are the processes whose parent is outside it (0). */
async function inUse(name: string): Promise<boolean> {
	return (await containerProcesses(name)).split('\n').some(line => {
		const [pid, ppid] = line.split(' ');
		return ppid === '0' && pid !== '1';
	});
}

/** Each container's published ports as ensureContainer last found them: read when it starts, never polled. */
export const knownPorts = new Map<string, Map<number, number>>();

/** The project, if its threads run in containers. */
export const containerProject = (project: Project | undefined): ContainerProject | undefined => (project?.container ? (project as ContainerProject) : undefined);

/** The shell `s` opens for a thread: yours, or in a container, whose image may not have yours, bash if it has it. */
export const threadShell = (project: Project | undefined): string[] =>
	containerProject(project) ? ['sh', '-c', 'command -v bash >/dev/null && exec bash || exec sh'] : [process.env.SHELL || 'bash'];

export const NO_TOKEN = `${TOKEN_ENV} isn't set: a thread's container needs it to sign claude in — run claude setup-token, export it where you start oo, and start oo again`;

/**
 * What tmux runs for `command` in the thread's window or pane: as it is, or for a project with a container, in
 * the thread's container (started first). The token reaches docker through tmux's environment, not its arguments.
 */
export async function forThread(
	project: Project | undefined,
	thread: Thread,
	cwd: string,
	command: string[],
	env: Record<string, string>,
	{ needsToken = false, token = process.env[TOKEN_ENV] } = {},
): Promise<{ command: string[]; env: Record<string, string> }> {
	const withContainer = containerProject(project);
	if (!withContainer) return { command, env };
	if (needsToken && !token) throw new Error(NO_TOKEN);
	if (token) await shareToken(token);
	await ensureContainer(withContainer, thread, cwd);
	return { command: execCommand(containerName(thread), cwd, command, env, { key: threadWindowName(thread.id) }), env };
}

let sharedToken: string | undefined;

/**
 * Put claude's token in the tmux session's environment, which its new windows and panes get, so docker exec can
 * pass it on by name. Through a private file tmux reads rather than its arguments, where any process could see it.
 */
async function shareToken(token: string): Promise<void> {
	if (sharedToken === token) return;
	if (!/^[\w.~+/=-]+$/.test(token)) throw new Error(`${TOKEN_ENV} has characters oo can't pass on safely — check it's what claude setup-token printed`);
	const dir = mkdtempSync(join(tmpdir(), 'oo-token-'));
	const file = join(dir, 'token.conf');
	try {
		writeFileSync(file, `set-environment -t ${await currentSessionId()} ${TOKEN_ENV} '${token}'\n`, { mode: PRIVATE_FILE });
		await execa('tmux', ['source-file', file]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	sharedToken = token;
}

export async function publishedPorts(name: string): Promise<Map<number, number>> {
	const result = await docker(['port', name], { reject: false });
	return result.exitCode === 0 ? parsePorts(result.stdout) : new Map();
}

/** Stop the container, keeping it to start again: what's in it stops using memory meanwhile. */
export async function stopContainer(name: string): Promise<void> {
	// It gets new ones when it starts again.
	knownPorts.delete(name);
	await docker(['stop', '-t', '5', name], { reject: false });
}

/** Remove the container, whatever it's doing. Its home stays, for the next one. */
export async function removeContainer(name: string): Promise<void> {
	knownPorts.delete(name);
	await docker(['rm', '-f', name], { reject: false });
}

/** A thread's published ports for its card and `oo thread show`, e.g. `3000→49153 5173→49155`; empty with none. */
export function portsText(ports: Map<number, number> | undefined): string {
	return [...(ports ?? [])].map(([inside, host]) => `${inside}→${host}`).join(' ');
}

/** Every process in the container as `pid ppid args`, like processList, for claudeShellRunning; its image may have no ps. */
export async function containerProcesses(name: string): Promise<string> {
	// The parent pid is the second field after the name in its stat, which is in brackets and may have spaces in it.
	// Not this script itself, which docker exec started too.
	const script = 'for d in /proc/[0-9]*; do [ "${d#/proc/}" = $$ ] && continue; read -r s < $d/stat 2>/dev/null || continue; set -- ${s##*) }; echo "${d#/proc/} $2 $(tr "\\0" " " < $d/cmdline 2>/dev/null)"; done';
	const result = await docker(['exec', name, 'sh', '-c', script], { reject: false });
	return result.exitCode === 0 ? result.stdout : '';
}

/**
 * Which of the board's containers to remove at startup: ones whose thread is gone, or has no worktree to run in
 * now (Done, archived, in IDEAS), or whose project no longer has a container.
 */
export function strayContainers(containers: Map<string, string>, threads: Thread[], projects: Project[]): string[] {
	return [...containers]
		.filter(([name, id]) => {
			const thread = threads.find(t => t.id === id && containerName(t) === name);
			const project = thread && projects.find(p => p.name === thread.project);
			return !thread || !project?.container || thread.column === 'done' || hidden(thread.column);
		})
		.map(([name]) => name);
}

/** The containers the board made: name → the thread id it's for. */
export async function threadContainers(): Promise<Map<string, string>> {
	const result = await docker(['ps', '-a', '--filter', 'label=oo.thread', '--format', '{{.Names}}\t{{.Label "oo.thread"}}'], { reject: false });
	if (result.exitCode !== 0) return new Map();
	return new Map(
		result.stdout
			.split('\n')
			.filter(Boolean)
			.map(line => line.split('\t') as [string, string]),
	);
}

/** Where, in its container, the commands started under a key (paneCommand, execCommand) record their sessions, one pid a line. */
const pidFile = (key: string) => `/tmp/oo-${key.replace(/[^\w.-]/g, '-')}.pid`;

/** Where a tmux pane's command runs in a container: its name, the directory, the environment passed through by name, and the key it's stopped by. */
export type PaneContainer = { name: string; cwd: string; env: string[]; key: string };

/**
 * The shell line a tmux pane runs for the command in `$variable` (which needs no quoting there): as it is, or in
 * `container`. docker exec doesn't pass a hangup on, so closing the pane would leave the command running in the
 * container: there it records its session (its pid, as the exec's session leader) under the key, for
 * stopPaneContainer to end it by.
 */
export function paneCommand(variable: string, container?: PaneContainer): string {
	if (!container) return `sh -c "$${variable}"`;
	const { name, cwd, env, key } = container;
	const inner = `echo $$ >> ${pidFile(key)}; exec sh -c "$${variable}"`;
	return `docker exec -it -w ${shellQuote(cwd)} ${env.map(v => `-e ${v}`).join(' ')} ${shellQuote(name)} sh -c ${shellQuote(inner)}`;
}

/**
 * The script that ends what was started in a container under `key`: each recorded docker exec is a session leader,
 * so every process in its session (claude's shells, a dev server, an interactive shell's jobs) gets HUP and TERM,
 * then KILL if any are still there after 5s, so a dev server started again finds its port free.
 */
export function stopScript(key: string): string {
	const file = pidFile(key);
	return [
		`leaders=$(cat ${file} 2>/dev/null) || exit 0`,
		`rm -f ${file}`,
		'members() { for d in /proc/[0-9]*; do read -r s < $d/stat 2>/dev/null || continue; set -- ${s##*) }; for l in $leaders; do [ "$4" = "$l" ] && echo ${d#/proc/}; done; done; }',
		'm=$(members); [ -n "$m" ] || exit 0',
		'kill -HUP $m 2>/dev/null; kill -TERM $m 2>/dev/null',
		'i=0; while [ -n "$(members)" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done',
		'm=$(members); [ -z "$m" ] || kill -KILL $m 2>/dev/null; true',
	].join('; ');
}

/** End what was started in the container under `key`, if any of it's still going. */
export async function stopKeyed(name: string, key: string): Promise<void> {
	await docker(['exec', name, 'sh', '-c', stopScript(key)], { reject: false });
}

// The tmux option a session or window running paneCommand in a container keeps the container's name in.
const CONTAINER_OPTION = '@oo-container';

/** Remember (or with no name, forget) which container the tmux `target` (e.g. `['-t', '=session:']`, or `['-w', '-t', ':window']`) runs its command in. */
export async function recordPaneContainer(target: string[], name: string | undefined): Promise<void> {
	await execa('tmux', ['set-option', ...(name ? [] : ['-u']), ...target, CONTAINER_OPTION, ...(name ? [name] : [])], { reject: false });
}

/** End what the tmux `target` started under `key` in its container (see recordPaneContainer), if it did and it's still going. */
export async function stopPaneContainer(target: string[], key: string): Promise<void> {
	const option = await execa('tmux', ['show-options', '-v', ...target, CONTAINER_OPTION], { reject: false });
	const name = option.exitCode === 0 ? option.stdout.trim() : '';
	if (name) await stopKeyed(name, key);
}
