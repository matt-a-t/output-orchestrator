import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRunStatuses, runPrefix, runSessionName, terminalCommand, tmuxAttach } from './commands.js';
import type { Project, Thread } from './state.js';

const project = { name: 'my.web' } as Project;
const thread = { id: '12' } as Thread;

test("each thread's run of a command gets its own session, named in what tmux takes", () => {
	assert.equal(runSessionName(project, thread, { name: 'dev server', command: 'npm run dev' }), 'oo-run_my-web_12_dev-server');
	assert.equal(runSessionName(project, undefined, { name: 'test:unit', command: 'npm test' }), 'oo-run_my-web_main_test-unit');
	assert.equal(runSessionName(project, thread, { name: '!!', command: 'x' }), 'oo-run_my-web_12_x');
});

test("a thread's prefix doesn't take in another project's runs", () => {
	// Project "my-web" thread 1 against project "my-web-1": _ keeps them apart.
	const other = runSessionName({ name: 'my-web-1' } as Project, { id: '2' } as Thread, { name: 'dev', command: '' });
	assert.ok(!other.startsWith(runPrefix(project, { id: '1' } as Thread)));
	assert.ok(runSessionName(project, thread, { name: 'dev', command: '' }).startsWith(runPrefix(project, thread)));
});

test('run sessions are running until they record how their command exited', () => {
	const statuses = parseRunStatuses(['oo\t', 'oo-run_web_12_dev\t', 'oo-run_web_12_test\t0', 'oo-run_web_main_lint\t2', 'mine\t1'].join('\n'));
	assert.deepEqual([...statuses], [
		['oo-run_web_12_dev', { running: true }],
		['oo-run_web_12_test', { running: false, exit: 0 }],
		['oo-run_web_main_lint', { running: false, exit: 2 }],
	]);
});

const attach = ['/usr/bin/tmux', 'attach-session', '-t', '=oo-run_web_12_dev'];

test('OO_TERMINAL opens runs in the terminal you name, with tmux attaching to the run added on', () => {
	const env = { OO_TERMINAL: 'kitty --single-instance -e', WSL_DISTRO_NAME: 'Ubuntu' };
	assert.deepEqual(terminalCommand({ env, hasWt: true }, attach, 'web dev'), { argv: ['kitty', '--single-instance', '-e', ...attach] });
});

test('on WSL a run opens in a new Windows Terminal window, in this distro', () => {
	assert.deepEqual(terminalCommand({ env: { WSL_DISTRO_NAME: 'Ubuntu' }, hasWt: true }, attach, '#12 dev; rm'), {
		argv: ['wt.exe', '-w', 'new', 'new-tab', '--title', '#12 dev, rm', 'wsl.exe', '-d', 'Ubuntu', '--', ...attach],
	});
});

test("on a Linux desktop it's $TERMINAL or x-terminal-emulator, and without one the board switches to the run", () => {
	assert.deepEqual(terminalCommand({ env: { DISPLAY: ':0', TERMINAL: 'alacritty' }, hasWt: false }, attach, 't'), { argv: ['alacritty', '-e', ...attach] });
	assert.deepEqual(terminalCommand({ env: { WAYLAND_DISPLAY: 'wayland-0' }, hasWt: false }, attach, 't'), { argv: ['x-terminal-emulator', '-e', ...attach] });
	assert.deepEqual(terminalCommand({ env: { WSL_DISTRO_NAME: 'Ubuntu' }, hasWt: false }, attach, 't'), { switchClient: true });
	assert.deepEqual(terminalCommand({ env: {}, hasWt: false }, attach, 't'), { switchClient: true });
});

test("the window's tmux attaches on the board's own server", () => {
	assert.deepEqual(tmuxAttach('/usr/bin/tmux', { TMUX: '/tmp/tmux-1000/work,123,0' }, 'oo-run_web_main_dev'), [
		'/usr/bin/tmux',
		'-S',
		'/tmp/tmux-1000/work',
		'attach-session',
		'-t',
		'=oo-run_web_main_dev',
	]);
	assert.deepEqual(tmuxAttach('tmux', {}, 's'), ['tmux', 'attach-session', '-t', '=s']);
});
