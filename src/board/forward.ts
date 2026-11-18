// Local for a project with containers: rather than check the thread's branch out in the project's checkout,
// the board forwards the project's own ports on the host to the thread's container, so the browser (or anything
// else) reaches the thread's dev server where it always does. Nothing moves, so switching threads is instant.

import { createServer, connect, type Server, type Socket } from 'node:net';

/** Each Local thread's listeners, by thread id. They live in the board, so they go when it quits; it sets them up again as it starts. */
const forwards = new Map<string, Server[]>();

/**
 * Which host port goes to which of the container's published ports, for its configured `ports`: each forwarded
 * at its own number. A port the container didn't publish (it hasn't been made again since the setting changed) is an error.
 */
export function forwardMapping(ports: number[], published: Map<number, number>): { mapping: [number, number][]; problem?: string } {
	if (!ports.length) return { mapping: [], problem: 'its project has no container ports to forward — set them in the projects screen (P)' };
	const missing = ports.filter(p => !published.has(p));
	if (missing.length) return { mapping: [], problem: `its container doesn't publish port ${missing.join(', ')} — reopen its claude to make the container again` };
	return { mapping: ports.map(p => [p, published.get(p)!]) };
}

/** Each listener's open connections: closing a listener waits for them, and a browser's keep-alive or a dev server's live reload never ends. */
const connections = new WeakMap<Server, Set<Socket>>();

function listen(port: number, host: string, target: number): Promise<Server> {
	return new Promise((resolve, reject) => {
		const open = new Set<Socket>();
		const server = createServer(client => {
			const upstream = connect(target, '127.0.0.1');
			open.add(client);
			client.pipe(upstream).pipe(client);
			const end = () => {
				open.delete(client);
				client.destroy();
				upstream.destroy();
			};
			for (const socket of [client, upstream]) socket.on('error', end).on('close', end);
		});
		connections.set(server, open);
		server.once('error', reject);
		server.listen({ port, host, exclusive: true }, () => {
			server.off('error', reject);
			server.on('error', () => {});
			resolve(server);
		});
	});
}

/** Stop listening and drop the connections still open, which would otherwise keep going to this container. */
const close = (server: Server) =>
	new Promise<void>(resolve => {
		server.close(() => resolve());
		for (const socket of connections.get(server) ?? []) socket.destroy();
	});

/**
 * Forward each host port in `mapping` to its container port, on loopback: 127.0.0.1, and ::1 too where there is one,
 * since a browser's localhost may be either. A port already taken on the host stops it, with nothing left listening.
 */
export async function forward(threadId: string, mapping: [number, number][]): Promise<void> {
	await unforward(threadId);
	const servers: Server[] = [];
	let port: number | undefined;
	try {
		for (const [hostPort, target] of mapping) {
			port = hostPort;
			servers.push(await listen(port, '127.0.0.1', target));
			// No IPv6 loopback, or something of the user's on it: 127.0.0.1 still works.
			await listen(port, '::1', target).then(s => servers.push(s), () => {});
		}
	} catch (err) {
		await Promise.all(servers.map(close));
		if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new Error(`port ${port} is in use on the host — stop what's on it and try again`);
		throw err;
	}
	forwards.set(threadId, servers);
}

/** Stop forwarding the thread's ports, if they are. */
export async function unforward(threadId: string): Promise<void> {
	const servers = forwards.get(threadId);
	forwards.delete(threadId);
	if (servers) await Promise.all(servers.map(close));
}

/** Whether the thread's ports are being forwarded. */
export const forwarding = (threadId: string) => forwards.has(threadId);
