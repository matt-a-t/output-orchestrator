// A thread's own docker container, for projects with a container setting: claude, its shells and the
// project's commands run in it with `docker exec`, while tmux and the board stay on the host.
// Everything is mounted at its host path, so worktree paths, transcripts and `--resume` mean the same inside.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { shellQuote } from './tmux.js';
import { DATA_DIR, PRIVATE_FILE, type ContainerSetting, type Project, type Thread } from './state.js';

/** The checkout oo runs from (its dist, and the node_modules that needs), mounted read-only for claude's hooks and `oo`. */
export const OO_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Claude's long-lived token, from `claude setup-token`: the container gets it in place of ~/.claude's credentials. */
export const TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';

/** Where things are on the host; tests pass their own. */
export type Paths = { home: string; dataDir: string; ooDir: string; uid: number; gid: number; git?: GitIdentity };

/** Your git name and email, as the host's git has them for the project. */
export type GitIdentity = { name?: string; email?: string };

/** The project's git identity on the host, which may come from includes and places the container doesn't see. */
export async function gitIdentity(repo: string): Promise<GitIdentity> {
	const get = (key: string) => execa('git', ['-C', repo, 'config', key], { reject: false }).then(r => r.stdout.trim() || undefined);
	const [name, email] = await Promise.all([get('user.name'), get('user.email')]);
	return { name, email };
}

/** Git's own variables for the identity, so commits in the container are yours. */
const gitEnv = ({ name, email }: GitIdentity = {}) => [
	...(name ? [`GIT_AUTHOR_NAME=${name}`, `GIT_COMMITTER_NAME=${name}`] : []),
	...(email ? [`GIT_AUTHOR_EMAIL=${email}`, `GIT_COMMITTER_EMAIL=${email}`] : []),
];

export const hostPaths = (): Paths => ({ home: homedir(), dataDir: DATA_DIR, ooDir: OO_DIR, uid: userInfo().uid, gid: userInfo().gid });

export type Mount = { kind: 'bind'; source: string; target: string; readonly?: boolean } | { kind: 'tmpfs'; target: string };

export const containerName = (thread: Pick<Thread, 'project' | 'id'>) => `oo-${thread.project.replace(/[^a-zA-Z0-9_.-]/g, '-')}-${thread.id}`;

/** Where claude keeps a directory's transcripts (see transcripts.ts), and the project's memory. */
const claudeProjectDir = (home: string, cwd: string) => join(home, '.claude', 'projects', resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-'));

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
 * What the container mounts, in order: a parent before what's mounted inside it.
 * - Its own home at $HOME, with DATA_DIR (state, requests, events) on top, but not the other threads' worktrees
 *   or homes, which tmpfs hides, and then only this thread's worktree.
 * - The project's .git, which the worktree's commits go into, with its hooks and config read-only: the host runs
 *   those, so a container writing them could get out.
 * - Only this directory's transcripts and the project's memory from ~/.claude, not every project's or the credentials.
 * `existing` says which optional host paths are there (the ~/.claude bits and the project's .git/config).
 */
export function mounts(project: Project, thread: Pick<Thread, 'project' | 'id'>, cwd: string, paths: Paths, existing: (path: string) => boolean = existsSync): Mount[] {
	const bind = (path: string, readonly = false): Mount => ({ kind: 'bind', source: resolve(path), target: resolve(path), ...(readonly ? { readonly } : {}) });
	const git = join(project.path, '.git');
	const claude = join(paths.home, '.claude');
	const all: Mount[] = [
		{ kind: 'bind', source: containerHome(paths, thread), target: paths.home },
		bind(paths.dataDir),
		{ kind: 'tmpfs', target: join(paths.dataDir, 'worktrees') },
		{ kind: 'tmpfs', target: homesDir(paths) },
		bind(cwd),
		bind(git),
		bind(join(git, 'hooks'), true),
		...(existing(join(git, 'config')) ? [bind(join(git, 'config'), true)] : []),
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
export function runArgs(project: Project & { container: ContainerSetting }, thread: Pick<Thread, 'project' | 'id'>, cwd: string, paths: Paths, existing?: (path: string) => boolean): string[] {
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
 * it's in no process's arguments.
 */
export function execCommand(name: string, cwd: string, command: string[], env: Record<string, string>, { dataDir = DATA_DIR, interactive = true } = {}): string[] {
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
		'PATH="$0:$PATH" exec "$@"',
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

/** Lock egress down to the firewall's defaults and the project's hosts; the container goes if that fails, rather than run open. */
async function firewall(name: string, allow: string[]): Promise<void> {
	const result = await docker(['exec', '-u', 'root', name, 'init-firewall', ...allow], { reject: false });
	if (result.exitCode === 0) return;
	await removeContainer(name);
	const missing = /executable file not found|no such file/i.test(result.stderr);
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
export async function ensureContainer(project: Project & { container: ContainerSetting }, thread: Thread, cwd: string, paths?: Paths): Promise<Map<number, number>> {
	paths ??= { ...hostPaths(), git: await gitIdentity(project.path) };
	const name = containerName(thread);
	const args = runArgs(project, thread, cwd, paths);
	let current = await inspect(name);
	if (current && current.config !== configLabel(args)) {
		await removeContainer(name);
		current = undefined;
	}
	if (!current) {
		prepareHome(project, thread, cwd, paths);
		await docker(args);
		await firewall(name, project.container.allow);
	} else if (!current.running) {
		await docker(['start', name]);
		// A stopped container loses its network, and the rules with it.
		await firewall(name, project.container.allow);
	}
	const ports = await publishedPorts(name);
	knownPorts.set(name, ports);
	return ports;
}

/** Each container's published ports as ensureContainer last found them: read when it starts, never polled. */
export const knownPorts = new Map<string, Map<number, number>>();

export type ContainerProject = Project & { container: ContainerSetting };

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
	await ensureContainer(withContainer, thread, cwd);
	return { command: execCommand(containerName(thread), cwd, command, env), env: { ...env, ...(token ? { [TOKEN_ENV]: token } : {}) } };
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
	const script = 'for d in /proc/[0-9]*; do p=${d#/proc/}; pp=$(cut -d" " -f4 $d/stat 2>/dev/null) || continue; echo "$p $pp $(tr "\\0" " " < $d/cmdline 2>/dev/null)"; done';
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
			return !thread || !project?.container || thread.column === 'done' || thread.column === 'archived' || thread.column === 'ideas';
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

/** Where, in its container, a command containerScript started records its process group. */
const pidFile = (key: string) => `/tmp/oo-${key.replace(/[^\w.-]/g, '-')}.pid`;

/**
 * The shell line a tmux pane runs to have the command in `$variable` run in the container, in `cwd`, with each of
 * `env` passed through by name. docker exec doesn't pass a hangup on, so closing the pane would leave the command
 * running in the container: it records its process group (its pid, as the exec's session leader) under `key`,
 * for stopKeyed to end it by.
 */
export function containerScript({ name, cwd, env, key }: { name: string; cwd: string; env: string[]; key: string }, variable: string): string {
	const inner = `echo $$ > ${pidFile(key)}; exec sh -c "$${variable}"`;
	return `docker exec -it -w ${shellQuote(cwd)} ${env.map(v => `-e ${v}`).join(' ')} ${shellQuote(name)} sh -c ${shellQuote(inner)}`;
}

/**
 * The script that ends what containerScript started under `key`: TERM to its process group, then KILL if it's still
 * going after 5s, so a dev server started again finds its port free.
 */
export function stopScript(key: string): string {
	const file = pidFile(key);
	return [
		`pid=$(cat ${file} 2>/dev/null) || exit 0`,
		'kill -TERM -$pid 2>/dev/null',
		'i=0; while kill -0 -$pid 2>/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done',
		'kill -KILL -$pid 2>/dev/null',
		`rm -f ${file}`,
	].join('; ');
}

/** End what containerScript started under `key` in the container, if it's still going. */
export async function stopKeyed(name: string, key: string): Promise<void> {
	await docker(['exec', name, 'sh', '-c', stopScript(key)], { reject: false });
}
