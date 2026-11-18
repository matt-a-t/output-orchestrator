import assert from 'node:assert/strict';
import { createServer, connect, type AddressInfo, type Server } from 'node:net';
import { test } from 'node:test';
import { forward, forwarding, forwardMapping, unforward } from './forward.js';

/** A server on a free port that answers each line with `name: line`, standing in for a dev server in a container. */
async function echo(name: string): Promise<{ port: number; server: Server }> {
	const server = createServer(socket => socket.on('data', d => socket.write(`${name}: ${d}`)));
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	return { port: (server.address() as AddressInfo).port, server };
}

async function freePort(): Promise<number> {
	const { port, server } = await echo('');
	await new Promise(resolve => server.close(resolve));
	return port;
}

const ask = (port: number, line: string) =>
	new Promise<string>((resolve, reject) => {
		const socket = connect(port, '127.0.0.1', () => socket.write(line));
		socket.on('data', d => {
			resolve(String(d));
			socket.destroy();
		});
		socket.on('error', reject);
	});

test('each configured port forwards at its own number to what the container published it on', () => {
	assert.deepEqual(forwardMapping([3000, 5173], new Map([[3000, 49153], [5173, 49155]])), { mapping: [[3000, 49153], [5173, 49155]] });
	assert.match(forwardMapping([], new Map()).problem ?? '', /no container ports to forward/);
	assert.match(forwardMapping([3000, 8080], new Map([[3000, 1]])).problem ?? '', /doesn't publish port 8080 — reopen its claude/);
});

test("the host port reaches the thread's container, and switching Local to another thread repoints it", async () => {
	const one = await echo('one');
	const two = await echo('two');
	const port = await freePort();
	try {
		await forward('1', [[port, one.port]]);
		assert.ok(forwarding('1'));
		assert.equal(await ask(port, 'hi'), 'one: hi');
		await unforward('1');
		assert.ok(!forwarding('1'));
		await forward('2', [[port, two.port]]);
		assert.equal(await ask(port, 'hi'), 'two: hi');
	} finally {
		await unforward('1');
		await unforward('2');
		one.server.close();
		two.server.close();
	}
	await assert.rejects(ask(port, 'hi'));
});

test("a port taken on the host stops Local, with none of the thread's ports left listening", async () => {
	const target = await echo('t');
	const free = await freePort();
	const taken = await echo('yours');
	try {
		await assert.rejects(forward('3', [[free, target.port], [taken.port, target.port]]), { message: `port ${taken.port} is in use on the host — stop what's on it and try again` });
		assert.ok(!forwarding('3'));
		await assert.rejects(ask(free, 'hi'));
		// What was on the port is left alone.
		assert.equal(await ask(taken.port, 'hi'), 'yours: hi');
	} finally {
		target.server.close();
		taken.server.close();
	}
});
