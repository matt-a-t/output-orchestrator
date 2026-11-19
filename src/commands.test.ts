import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandsText, parseCommands, parseRunStatuses, parseSnapshot, runPrefix, runSessionName, terminalCommand, threadRunning, tmuxAttach, runScript } from './commands.js';
import { stopScript } from './container.js';
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
	const statuses = parseRunStatuses(['oo\t\t1', 'oo-run_web_12_dev\t\t1', 'oo-run_web_12_test\t0\t0', 'oo-run_web_main_lint\t2\t2', 'mine\t1\t0'].join('\n'));
	assert.deepEqual([...statuses], [
		['oo-run_web_12_dev', { running: true, attached: 1 }],
		['oo-run_web_12_test', { running: false, exit: 0, attached: 0 }],
		['oo-run_web_main_lint', { running: false, exit: 2, attached: 2 }],
	]);
	const web = { name: 'web' } as Project;
	assert.equal(threadRunning(statuses, web, { id: '12' } as Thread), true);
	// Its tests finished; only running commands count.
	assert.equal(threadRunning(new Map([...statuses].filter(([n]) => n !== 'oo-run_web_12_dev')), web, { id: '12' } as Thread), false);
	assert.equal(threadRunning(statuses, web, { id: '1' } as Thread), false);
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

test('on WSL a tab opens in the most recent Windows Terminal window, while runs keep a window of their own', () => {
	const env = { WSL_DISTRO_NAME: 'Ubuntu' };
	const shell = ['/usr/bin/node', '/oo/dist/cli.js', 'shell', '12', '--here'];
	assert.deepEqual(terminalCommand({ env, hasWt: true }, shell, '#12 shell', { tab: true }), {
		argv: ['wt.exe', '-w', '0', 'new-tab', '--title', '#12 shell', 'wsl.exe', '-d', 'Ubuntu', '--', ...shell],
	});
	assert.deepEqual(terminalCommand({ env, hasWt: true }, attach, 't'), { argv: ['wt.exe', '-w', 'new', 'new-tab', '--title', 't', 'wsl.exe', '-d', 'Ubuntu', '--', ...attach] });
	// Elsewhere a tab is just another terminal.
	assert.deepEqual(terminalCommand({ env: { OO_TERMINAL: 'kitty -e' }, hasWt: false }, shell, 't', { tab: true }), { argv: ['kitty', '-e', ...shell] });
	assert.deepEqual(terminalCommand({ env: {}, hasWt: false }, shell, 't', { tab: true }), { switchClient: true });
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

test("commands are edited a line each, the name up to the first colon", () => {
	const commands = [
		{ name: 'dev', command: 'npm run dev' },
		{ name: 'migrate', command: 'DATABASE_URL=postgres://localhost:5432/x npm run migrate' },
	];
	assert.deepEqual(parseCommands(commandsText(commands).split('\n')), { commands, problems: [] });
	assert.deepEqual(parseCommands(['  test :  npm test  ', '', 'oops', 'empty:', 'test: again']), {
		commands: [{ name: 'test', command: 'npm test' }],
		problems: ['"oops" isn\'t name: command', '"empty:" isn\'t name: command', 'a second "test"'],
	});
});

test("parseSnapshot keeps the board session's windows and every run session's status", () => {
	const lines = ['$0\too-board\too\t\t1', '$0\too-12\too\t\t1', '$4\tdev\too-run_web_12_dev\t\t1', '$5\tsh\too-run_web_main_lint\t2\t0', '$5\tother\too-run_web_main_lint\t2\t0', '$6\tvim\tmine\t\t1'];
	const { windows, runs } = parseSnapshot(lines.join('\n'), '$0');
	assert.deepEqual(windows, ['oo-board', 'oo-12']);
	assert.deepEqual([...runs], [
		['oo-run_web_12_dev', { running: true, attached: 1 }],
		['oo-run_web_main_lint', { running: false, exit: 2, attached: 0 }],
	]);
});

test("a thread's run in its container runs only the command there, with its environment; tmux stays on the host", () => {
	assert.ok(runScript().startsWith('sh -c "$OO_CMD"; status=$?; tmux set-option @oo-exit'));
	const script = runScript({ name: 'oo-app-7', cwd: "/w/it's", env: ['OO_CMD', 'OO_THREAD_ID'], key: 'oo-run_app_7_dev' });
	assert.ok(
		script.startsWith(
			`docker exec -it -w '/w/it'\\''s' -e OO_CMD -e OO_THREAD_ID 'oo-app-7' sh -c 'echo $$ >> /tmp/oo-oo-run_app_7_dev.pid; exec sh -c "$OO_CMD"'; status=$?; tmux set-option @oo-exit`,
		),
		script,
	);
	assert.ok(script.endsWith('exec "${SHELL:-sh}"'));
});

test("stopping what ran in a container ends every process in its sessions, by force if they won't go", () => {
	const script = stopScript('oo-run_app_7_dev');
	assert.match(script, /^leaders=\$\(cat \/tmp\/oo-oo-run_app_7_dev\.pid 2>\/dev\/null\) \|\| exit 0;/);
	// A process's session is the 4th field after its name, which is in brackets and may have spaces.
	assert.match(script, /set -- \$\{s##\*\) \}; for l in \$leaders; do \[ "\$4" = "\$l" \]/);
	assert.match(script, /kill -HUP \$m 2>\/dev\/null; kill -TERM \$m/);
	assert.match(script, /kill -KILL \$m/);
});
