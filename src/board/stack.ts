// Local for a container project with a compose stack: the board runs the stack on the host (the thread's container
// has no Docker socket) with the thread's worktree as its project directory, so its bind mounts and builds are the
// thread's code, and joins the thread's container to the stack's networks so it reaches the services by name.
//
// The compose files and .env are read from the project checkout, not the worktree: the thread's container can write
// its worktree, and a compose file it wrote (privileged, mounting / or the Docker socket) would run on the host.
// So a thread's change to the compose file takes effect once it's merged; a change to a Dockerfile it builds
// takes effect straight away (up always builds).

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import type { ComposeSetting, Project } from '../state.js';

type ComposeProject = Project & { container: { compose: ComposeSetting } };

/** The project's stack setting, if it has one. */
export const stackOf = (project: Project | undefined): ComposeProject | undefined => (project?.container?.compose ? (project as ComposeProject) : undefined);

/**
 * The `docker compose` args that pick the project's stack: its files and .env from the project checkout, the
 * project directory `dir` (the thread's worktree, so `.` is its code) and the stack's name. Without a .env in the
 * checkout it's /dev/null, so compose doesn't read the worktree's instead.
 */
export function composeArgs(project: ComposeProject, dir: string, name: string, existing: (path: string) => boolean = existsSync): string[] {
	const env = join(project.path, '.env');
	return [
		'compose',
		...project.container.compose.files.flatMap(f => ['-f', resolve(project.path, f)]),
		'--project-directory',
		dir,
		'--env-file',
		existing(env) ? env : '/dev/null',
		'-p',
		name,
	];
}

/** The host ports the stack's services publish, from `docker compose config --format json`. */
export function stackPorts(config: string): number[] {
	const parsed = JSON.parse(config) as { services?: Record<string, { ports?: { published?: string | number }[] }> };
	const ports = new Set<number>();
	for (const service of Object.values(parsed.services ?? {}))
		for (const { published } of service.ports ?? []) {
			// A range ("8000-8002"), one port, or none (docker picks one, so it can't clash).
			if (published === undefined || published === '') continue;
			const [from, to = from] = String(published).split('-').map(Number);
			if (!Number.isInteger(from) || !Number.isInteger(to)) continue;
			for (let p = from!; p <= to!; p++) ports.add(p);
		}
	return [...ports].sort((a, b) => a - b);
}

/** Why Local can't forward `forwarded` alongside a stack publishing `published` on the host, if it can't. */
export function portClash(forwarded: number[], published: number[]): string | undefined {
	const both = forwarded.filter(p => published.includes(p));
	if (!both.length) return;
	const ports = both.join(', ');
	return `the stack publishes port${both.length === 1 ? '' : 's'} ${ports} on the host, and Local forwards ${both.length === 1 ? 'it' : 'them'} to the container too — take ${ports} out of the project's container ports or the compose file`;
}

const docker = (args: string[], cwd?: string) => execa('docker', args, { cwd, reject: false });

/** A failed docker command as an error, with the end of what it said. */
function failed(what: string, result: { stderr: string; stdout: string }): Error {
	const said = (result.stderr.trim() || result.stdout.trim()).split('\n').slice(-5).join('\n');
	return new Error(`${what} failed${said ? `: ${said}` : ''}`);
}

/**
 * The stack's compose project name: the setting's, else the one `docker compose` picks in the project checkout
 * (its compose files' `name:`, else the checkout's directory name), so it's the same stack as one run there by hand.
 */
export async function stackName(project: ComposeProject): Promise<string> {
	if (project.container.compose.name) return project.container.compose.name;
	const files = project.container.compose.files.flatMap(f => ['-f', resolve(project.path, f)]);
	const result = await docker(['compose', ...files, 'config', '--format', 'json'], project.path);
	if (result.exitCode !== 0) throw failed('docker compose config', result);
	return (JSON.parse(result.stdout) as { name: string }).name;
}

/**
 * Bring the stack up (building what it builds) from `worktree`, recreating whatever runs another worktree's code.
 * Throws, with nothing started, if it publishes a port the project's container ports forward too.
 */
export async function stackUp(project: ComposeProject, worktree: string): Promise<string> {
	const name = await stackName(project);
	const args = composeArgs(project, worktree, name);
	const config = await docker([...args, 'config', '--format', 'json'], worktree);
	if (config.exitCode !== 0) throw failed('docker compose config', config);
	const clash = portClash(project.container.ports, stackPorts(config.stdout));
	if (clash) throw new Error(clash);
	const up = await docker([...args, 'up', '-d', '--build', '--remove-orphans'], worktree);
	if (up.exitCode !== 0) throw failed('docker compose up', up);
	return name;
}

/** Take the stack down; its volumes stay, so the next Local thread finds its data. */
export async function stackDown(project: ComposeProject): Promise<void> {
	const name = await stackName(project);
	const down = await docker([...composeArgs(project, project.path, name), 'down', '--remove-orphans'], project.path);
	if (down.exitCode !== 0) throw failed('docker compose down', down);
}

/** The stack's networks: the ones compose made for it, by its label (not external ones it only uses). */
async function stackNetworks(name: string): Promise<string[]> {
	const result = await docker(['network', 'ls', '--filter', `label=com.docker.compose.project=${name}`, '--format', '{{.Name}}']);
	if (result.exitCode !== 0) throw failed('docker network ls', result);
	return result.stdout.split('\n').filter(Boolean);
}

async function subnets(network: string): Promise<string[]> {
	const result = await docker(['network', 'inspect', '--format', '{{range .IPAM.Config}}{{.Subnet}} {{end}}', network]);
	if (result.exitCode !== 0) throw failed(`docker network inspect ${network}`, result);
	// The firewall is IPv4 only (IPv6 egress is dropped outright).
	return result.stdout.split(/\s+/).filter(s => s && !s.includes(':'));
}

/** The shell that adds (`-I`) or removes (`-D`) the firewall rule letting the container reach `subnet`, as it needs. */
export const ruleScript = (subnet: string, action: '-I' | '-D') =>
	action === '-I'
		? `iptables -C OUTPUT -d ${subnet} -j ACCEPT 2>/dev/null || iptables -I OUTPUT -d ${subnet} -j ACCEPT`
		: `while iptables -D OUTPUT -d ${subnet} -j ACCEPT 2>/dev/null; do :; done`;

/**
 * Join the thread's container to the stack's networks and let it through its firewall to them. Safe to run again:
 * after a restart the container is still on the networks but its firewall rules are gone.
 */
export async function joinStack(project: ComposeProject, container: string): Promise<void> {
	const networks = await stackNetworks(await stackName(project));
	if (!networks.length) throw new Error("the stack has no networks — is it up? Leave Local and go in again to start it");
	for (const network of networks) {
		const connect = await docker(['network', 'connect', network, container]);
		if (connect.exitCode !== 0 && !/already exists|already attached/i.test(connect.stderr)) throw failed(`docker network connect ${network}`, connect);
		for (const subnet of await subnets(network)) {
			const rule = await docker(['exec', '-u', 'root', container, 'sh', '-c', ruleScript(subnet, '-I')]);
			if (rule.exitCode !== 0) throw failed(`letting ${container} reach ${subnet}`, rule);
		}
	}
}

/**
 * Take the thread's container off the stack's networks and out of its firewall, as far as it can: it may be stopped
 * or gone. Before stackDown, which can't remove a network something is still on.
 */
export async function leaveStack(project: ComposeProject, container: string): Promise<void> {
	const networks = await stackNetworks(await stackName(project)).catch(() => [] as string[]);
	for (const network of networks) {
		for (const subnet of await subnets(network).catch(() => [] as string[]))
			await docker(['exec', '-u', 'root', container, 'sh', '-c', ruleScript(subnet, '-D')]);
		await docker(['network', 'disconnect', '--force', network, container]);
	}
}
