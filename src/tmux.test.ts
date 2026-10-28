import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeShellRunning, isOoWindow, parseWindowInfo, pasteSafe, tmuxVersionOk } from './tmux.js';

test('accepts tmux 3.2 and later', () => {
	assert.ok(tmuxVersionOk('tmux 3.2'));
	assert.ok(tmuxVersionOk('tmux 3.3a'));
	assert.ok(tmuxVersionOk('tmux 3.10'));
	assert.ok(tmuxVersionOk('tmux 4.0'));
	assert.ok(tmuxVersionOk('tmux next-3.6'));
});

test('rejects tmux before 3.2', () => {
	assert.ok(!tmuxVersionOk('tmux 3.1c'));
	assert.ok(!tmuxVersionOk('tmux 2.9a'));
});

test('accepts versions it cannot read', () => {
	assert.ok(tmuxVersionOk('tmux master'));
	assert.ok(tmuxVersionOk(''));
});

test('closes thread and hook windows, not the board or the user\'s', () => {
	assert.ok(isOoWindow('oo-12'));
	assert.ok(isOoWindow('oo-hook-oo-new'));
	assert.ok(!isOoWindow('oo-board'));
	assert.ok(!isOoWindow('vim'));
	assert.ok(!isOoWindow('foo-1'));
});

test('pastes lose control characters that could end the paste early, not newlines or tabs', () => {
	assert.equal(pasteSafe('a\x1b[201~rm -rf\x1b[Z'), 'a[201~rm -rf[Z');
	assert.equal(pasteSafe('a\x9b201~b\x07\x7f'), 'a201~b');
	assert.equal(pasteSafe('one\r\ntwo\rthree\n\tfour · é ✓'), 'one\ntwo\nthree\n\tfour · é ✓');
});

test('reads each window from its panes: whether it is on screen, split, and claude\'s pane\'s process', () => {
	const stdout = ['oo-board\t1\t1\t10\t', 'oo-3\t0\t1\t30\t', 'oo-4\t0\t1\t40\t', 'oo-4\t0\t1\t41\tshell', 'oo-5\t1\t0\t50\t'].join('\n');
	assert.deepEqual(parseWindowInfo(stdout), [
		{ name: 'oo-board', viewed: true, split: false, pid: 10 },
		{ name: 'oo-3', viewed: false, split: false, pid: 30 },
		{ name: 'oo-4', viewed: false, split: true, pid: 40 },
		// Active, but with no one attached to see it.
		{ name: 'oo-5', viewed: false, split: false, pid: 50 },
	]);
});

test('finds a shell claude\'s Bash tool started anywhere under its pane, not its MCP servers', () => {
	const ps = [
		'  100     1 bash',
		'  101   100 claude --settings x',
		'  102   101 node /usr/lib/mcp-server.js',
		'  103   101 /bin/bash -c source /home/u/.claude/shell-snapshots/snapshot-bash-1.sh && sleep 300',
		'  104   103 sleep 300',
		'  200     1 claude',
		'  201   200 npx some-mcp',
	].join('\n');
	assert.ok(claudeShellRunning(ps, 100));
	assert.ok(!claudeShellRunning(ps, 200));
	assert.ok(!claudeShellRunning(ps, 999));
});
