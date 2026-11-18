// A thread's own docker container, for projects with a container setting: claude, its shells and the
// project's commands run in it with `docker exec`, while tmux and the board stay on the host.
// Everything is mounted at its host path, so worktree paths, transcripts and `--resume` mean the same inside.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { DATA_DIR, PRIVATE_FILE, type ContainerSetting, type Project, type Thread } from './state.js';

/** The checkout oo runs from (its dist, and the node_modules that needs), mounted read-only for claude's hooks and `oo`. */
export const OO_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Claude's long-lived token, from `claude setup-token`: the container gets it in place of ~/.claude's credentials. */
export const TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';

/** Where things are on the host; tests pass their own. */
export type Paths = { home: string; dataDir: string; ooDir: string; uid: number; gid: number };

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
export async function ensureContainer(project: Project & { container: ContainerSetting }, thread: Thread, cwd: string, paths = hostPaths()): Promise<Map<number, number>> {
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
	return publishedPorts(name);
}

export async function publishedPorts(name: string): Promise<Map<number, number>> {
	const result = await docker(['port', name], { reject: false });
	return result.exitCode === 0 ? parsePorts(result.stdout) : new Map();
}

/** Stop the container, keeping it to start again: what's in it stops using memory meanwhile. */
export async function stopContainer(name: string): Promise<void> {
	await docker(['stop', '-t', '5', name], { reject: false });
}

/** Remove the container, whatever it's doing. Its home stays, for the next one. */
export async function removeContainer(name: string): Promise<void> {
	await docker(['rm', '-f', name], { reject: false });
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
