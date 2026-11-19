import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Project } from '../state.js';
import { composeArgs, portClash, ruleScript, stackOf, stackPorts } from './stack.js';

const project = (compose?: { files: string[]; name?: string }): Project => ({
	name: 'gpd',
	abbrev: 'gpd',
	color: 'yellow',
	path: '/src/gpd',
	worktrees: true,
	wakePrompt: '',
	closeIdleAfter: 30,
	hooks: {},
	commands: [],
	tracker: 'none',
	jiraSite: '',
	jiraProject: '',
	container: { image: 'oo-thread', ports: [], allow: [], ...(compose ? { compose } : {}) },
});

test('only a container project with compose files has a stack', () => {
	assert.equal(stackOf(project()), undefined);
	assert.equal(stackOf(undefined), undefined);
	assert.ok(stackOf(project({ files: ['docker-compose.yml'] })));
});

test("the stack's compose files and .env come from the project checkout, with the worktree as its directory", () => {
	const stack = stackOf(project({ files: ['docker-compose.yml', 'dev/override.yml'] }))!;
	assert.deepEqual(composeArgs(stack, '/wt/12', 'gpd', path => path === '/src/gpd/.env'), [
		'compose',
		'-f',
		'/src/gpd/docker-compose.yml',
		'-f',
		'/src/gpd/dev/override.yml',
		'--project-directory',
		'/wt/12',
		'--env-file',
		'/src/gpd/.env',
		'-p',
		'gpd',
	]);
	// No .env in the checkout: not the worktree's either.
	assert.deepEqual(composeArgs(stack, '/wt/12', 'gpd', () => false).slice(7, 9), ['--env-file', '/dev/null']);
});

test('the ports a stack publishes on the host, ranges included and unpublished ones not', () => {
	const config = JSON.stringify({
		services: {
			web: { ports: [{ target: 80, published: '8085' }] },
			db: { ports: [{ target: 3306, published: '3307', host_ip: '127.0.0.1' }] },
			range: { ports: [{ target: 9000, published: '9000-9002' }] },
			picked: { ports: [{ target: 5000 }] },
			cache: {},
		},
	});
	assert.deepEqual(stackPorts(config), [3307, 8085, 9000, 9001, 9002]);
	assert.deepEqual(stackPorts('{}'), []);
});

test("a port both the stack publishes and Local forwards can't be in both", () => {
	assert.equal(portClash([3000], [8085, 3307]), undefined);
	assert.equal(portClash([], [8085]), undefined);
	assert.match(portClash([3000, 8085], [8085, 3307]) ?? '', /publishes port 8085 on the host, and Local forwards it/);
	assert.match(portClash([8085, 3307], [8085, 3307]) ?? '', /ports 8085, 3307 .* forwards them/);
});

test('the firewall rule is added once and removed however many times it was', () => {
	assert.equal(ruleScript('172.20.0.0/16', '-I'), 'iptables -C OUTPUT -d 172.20.0.0/16 -j ACCEPT 2>/dev/null || iptables -I OUTPUT -d 172.20.0.0/16 -j ACCEPT');
	assert.match(ruleScript('172.20.0.0/16', '-D'), /^while iptables -D OUTPUT -d 172\.20\.0\.0\/16 -j ACCEPT/);
});
