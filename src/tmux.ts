import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { execa } from 'execa';

export const BOARD_WINDOW = 'oo-board';
export const BOARD_LABEL = 'board';
export const SESSION = 'oo';

export function insideTmux(): boolean {
	return Boolean(process.env.TMUX);
}

export function threadWindowName(threadId: string): string {
	return `oo-${threadId}`;
}

/** What a thread's window shows in the status bar: its #id and the start of its title. */
export function threadWindowLabel(thread: { id: string; title: string }): string {
	const title = thread.title.length > 16 ? `${thread.title.slice(0, 15)}…` : thread.title;
	return `#${thread.id} ${title}`;
}

/**
 * Show `label` in the status bar in place of the window's name, which stays as the key code finds
 * it by. Only this window's formats change, keeping the user's own (theme and all) apart from the name.
 */
export async function labelWindow(name: string, label: string): Promise<void> {
	const target = ['-w', '-t', `:${name}`];
	// The status bar reads #[ as a style, so a title's # is doubled; ## shows as one #.
	await execa('tmux', ['set-option', ...target, '@oo-label', label.replaceAll('#', '##')]);
	for (const option of ['window-status-format', 'window-status-current-format']) {
		const { stdout } = await execa('tmux', ['show-options', '-gwv', option]);
		const format = stdout.replaceAll('#{window_name}', '#{@oo-label}').replaceAll('#W', '#{@oo-label}');
		await execa('tmux', ['set-option', ...target, option, format]);
	}
}

export async function renameCurrentWindow(name: string): Promise<void> {
	await execa('tmux', ['rename-window', name]);
}

export async function windowNames(): Promise<string[]> {
	const { stdout } = await execa('tmux', ['list-windows', '-F', '#{window_name}']);
	return stdout.split('\n');
}

export async function killWindow(name: string): Promise<void> {
	if ((await windowNames()).includes(name)) await execa('tmux', ['kill-window', '-t', `:${name}`]);
}

/**
 * Jump to the thread's window, creating it (running `command` in `cwd`) if needed; `background`
 * creates it without jumping. Either way it's shown in the status bar as `label`.
 */
export async function openWindow(
	name: string,
	label: string,
	cwd: string,
	command: string[],
	env: Record<string, string> = {},
	{ background = false } = {},
): Promise<'created' | 'selected'> {
	if ((await windowNames()).includes(name)) {
		// Relabelled so a title changed since it opened shows up.
		await labelWindow(name, label);
		if (!background) await execa('tmux', ['select-window', '-t', `:${name}`]);
		return 'selected';
	}
	const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
	await execa('tmux', ['new-window', ...(background ? ['-d'] : []), '-n', name, '-c', cwd, ...envArgs, ...command]);
	await labelWindow(name, label);
	return 'created';
}

/**
 * Open `command` in a pane on the right of the thread's window (or swap the one already there,
 * if it's showing something else), then jump to it. `role` tags the pane so it's found again.
 */
export async function openSplit(window: string, cwd: string, role: string, command: string[], env: Record<string, string> = {}): Promise<void> {
	const { stdout } = await execa('tmux', ['list-panes', '-t', `:${window}`, '-F', '#{pane_id}\t#{@oo-split}']);
	const split = stdout
		.split('\n')
		.map(line => line.split('\t'))
		.find(([, r]) => r);
	const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
	let pane = split?.[0];
	if (!pane) {
		const created = await execa('tmux', ['split-window', '-h', '-l', '50%', '-P', '-F', '#{pane_id}', '-t', `:${window}`, '-c', cwd, ...envArgs, ...command]);
		pane = created.stdout.trim();
	} else if (split![1] !== role) {
		await execa('tmux', ['respawn-pane', '-k', '-t', pane, '-c', cwd, ...envArgs, ...command]);
	}
	await execa('tmux', ['set-option', '-p', '-t', pane, '@oo-split', role]);
	await execa('tmux', ['select-pane', '-t', pane]);
	await execa('tmux', ['select-window', '-t', `:${window}`]);
}

/**
 * From outside tmux: attach to the `oo` session, starting it (or a board window in it) with
 * `command` if needed. Resolves with tmux's exit code once detached.
 */
export async function attachBoard(command: string[]): Promise<number> {
	const hasSession = await execa('tmux', ['has-session', '-t', `=${SESSION}`], { reject: false });
	if (hasSession.exitCode !== 0) {
		const result = await execa('tmux', ['new-session', '-s', SESSION, ...command], { stdio: 'inherit', reject: false });
		return result.exitCode ?? 1;
	}
	const { stdout } = await execa('tmux', ['list-windows', '-t', `=${SESSION}`, '-F', '#{window_name}']);
	if (!stdout.split('\n').includes(BOARD_WINDOW)) {
		await execa('tmux', ['new-window', '-d', '-t', `=${SESSION}:`, '-n', BOARD_WINDOW, ...command]);
	}
	await execa('tmux', ['select-window', '-t', `=${SESSION}:${BOARD_WINDOW}`]);
	const result = await execa('tmux', ['attach-session', '-t', `=${SESSION}`], { stdio: 'inherit', reject: false });
	return result.exitCode ?? 1;
}

/** Inside tmux: jump to a board already running in another window of this session, if any. */
export async function selectExistingBoard(): Promise<boolean> {
	const { stdout } = await execa('tmux', ['list-panes', '-s', '-F', '#{window_name}\t#{pane_id}']);
	const other = stdout
		.split('\n')
		.map(line => line.split('\t'))
		.some(([name, pane]) => name === BOARD_WINDOW && pane !== process.env.TMUX_PANE);
	if (other) await execa('tmux', ['select-window', '-t', `:${BOARD_WINDOW}`]);
	return other;
}

/** Type `text` into a window as a bracketed paste, then press Enter to submit it. */
export async function pasteInto(name: string, text: string): Promise<void> {
	const buffer = `oo-${randomUUID()}`;
	await execa('tmux', ['load-buffer', '-b', buffer, '-'], { input: text });
	await execa('tmux', ['paste-buffer', '-p', '-d', '-b', buffer, '-t', `:${name}`]);
	// An Enter arriving with the paste can be swallowed by it rather than submitting.
	await setTimeout(200);
	await execa('tmux', ['send-keys', '-t', `:${name}`, 'Enter']);
}

// Thread windows only, not the board or a project's hook window.
const IN_THREAD_WINDOW = '#{m/r:^oo-[0-9]+$,#{window_name}}';

/** Select the next (or, with -1, previous) thread window after the current one, wrapping around. */
function cycleThreads(step: 1 | -1): string[] {
	// run-shell expands formats, so ## leaves one for list-windows; no single quotes, as if-shell wraps this in them.
	const awk = `{i[NR]=\\$1} END{for(n=1;n<=NR;n++) if(i[n]==cur) break; print i[(n-1+${step}+NR)%NR+1]}`;
	const windows = 'tmux list-windows -F "##{window_index} ##{window_name}" | grep -E " oo-[0-9]+\\$"';
	return ['run-shell', `w=$(${windows} | awk -v cur=#{window_index} "${awk}"); [ -n "$w" ] && tmux select-window -t ":$w"`];
}

/**
 * Bind `prefix b`, `prefix C-b` (for when ctrl is still held), `M-b` and `M-q` (no prefix) to
 * jump back to the board, and in thread windows: `M-h` / `M-l` to move between claude and the pane
 * beside it, `M-j` / `M-k` to the next / previous thread, `M-s` / `M-d` to open a shell / diff
 * beside claude (via `split`, the command prefix that runs `oo split`), `M-u` to scroll up (copy
 * mode) and `M-z` to zoom the pane. Not `M-v` (claude's image paste) or `M-[` (the start of
 * arrow keys' escape codes). Keys the user has bound to something themselves are left alone.
 */
export async function bindBoardKeys(split: string): Promise<void> {
	const back = ['select-window', '-t', BOARD_WINDOW];
	// Only in thread windows; everywhere else the key still reaches the program (e.g. readline's M-b back-a-word).
	const inThreads = (key: string, command: string[]) => ['if-shell', '-F', IN_THREAD_WINDOW, tmuxCommand(command), `send-keys ${key}`];
	const beside = (role: string) => [
		'run-shell',
		'-b',
		`out=$(${split} ${role} #{s/^oo-//:window_name} 2>&1) || tmux display-message "$out"`,
	];
	const bindings: [table: string, key: string, command: string[]][] = [
		['prefix', 'b', back],
		['prefix', 'C-b', back],
		['root', 'M-b', inThreads('M-b', back)],
		['root', 'M-q', inThreads('M-q', back)],
		['root', 'M-h', inThreads('M-h', ['select-pane', '-L'])],
		['root', 'M-l', inThreads('M-l', ['select-pane', '-R'])],
		['root', 'M-j', inThreads('M-j', cycleThreads(1))],
		['root', 'M-k', inThreads('M-k', cycleThreads(-1))],
		['root', 'M-s', inThreads('M-s', beside('shell'))],
		['root', 'M-d', inThreads('M-d', beside('diff'))],
		['root', 'M-u', inThreads('M-u', ['copy-mode', '-u'])],
		['root', 'M-z', inThreads('M-z', ['resize-pane', '-Z'])],
	];
	for (const [table, key, command] of bindings) {
		const existing = await execa('tmux', ['list-keys', '-T', table, key], { reject: false });
		// C-b is send-prefix out of the box, which is worth giving up for this.
		const ours = existing.stdout.includes(BOARD_WINDOW) || existing.stdout.includes('oo-') || existing.stdout.includes('send-prefix');
		const taken = existing.exitCode === 0 && !ours;
		if (!taken) await execa('tmux', ['bind-key', '-T', table, key, ...command]);
	}
}

/** One tmux command as a string, quoting arguments that need it (for if-shell). */
function tmuxCommand(command: string[]): string {
	return command.map(arg => (/^[\w./:#{}-]+$/.test(arg) ? arg : shellQuote(arg))).join(' ');
}

/** Pass clicks through to the board (and claude); only for this session, so other sessions keep their own setting. */
export async function enableTmuxMouse(): Promise<void> {
	await execa('tmux', ['set-option', 'mouse', 'on']);
}

/** Run a command in a tmux popup and resolve with its exit status once it exits. */
export async function popup(command: string, opts: { cwd?: string; title?: string; width?: string; height?: string } = {}): Promise<number> {
	const channel = `oo-${randomUUID()}`;
	const statusFile = join(tmpdir(), `${channel}.status`);
	const args = ['display-popup', '-E', '-w', opts.width ?? '90%', '-h', opts.height ?? '90%'];
	if (opts.cwd) args.push('-d', opts.cwd);
	if (opts.title) args.push('-T', opts.title);
	// wait-for makes this independent of whether display-popup blocks.
	args.push(`${command}; echo $? > ${shellQuote(statusFile)}; tmux wait-for -S ${channel}`);
	await execa('tmux', args);
	await execa('tmux', ['wait-for', channel]);
	try {
		return Number(readFileSync(statusFile, 'utf8'));
	} catch {
		return 1;
	} finally {
		rmSync(statusFile, { force: true });
	}
}

/** Ask a question in a small popup; true if it's answered with y. */
export async function confirmPopup(question: string): Promise<boolean> {
	const text = `${question} y to confirm, any other key to go back `;
	const ask = `printf '%s' ${shellQuote(text)}; read -rsn1 key; [ "$key" = y ]`;
	// Two columns of border and one of padding either side.
	return (await popup(`bash -c ${shellQuote(ask)}`, { width: String(text.length + 4), height: '3', title: ' confirm ' })) === 0;
}

export function shellQuote(s: string): string {
	return `'${s.replaceAll("'", `'\\''`)}'`;
}
