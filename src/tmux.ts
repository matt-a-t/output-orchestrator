import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { execa } from 'execa';

export const BOARD_WINDOW = 'oo-board';
export const SESSION = 'oo';

export function insideTmux(): boolean {
	return Boolean(process.env.TMUX);
}

export function threadWindowName(threadId: string): string {
	return `oo-${threadId}`;
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

/** Jump to the thread's window, creating it (running `command` in `cwd`) if needed; `background` creates it without jumping. */
export async function openWindow(
	name: string,
	cwd: string,
	command: string[],
	env: Record<string, string> = {},
	{ background = false } = {},
): Promise<'created' | 'selected'> {
	if ((await windowNames()).includes(name)) {
		if (!background) await execa('tmux', ['select-window', '-t', `:${name}`]);
		return 'selected';
	}
	const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
	await execa('tmux', ['new-window', ...(background ? ['-d'] : []), '-n', name, '-c', cwd, ...envArgs, ...command]);
	return 'created';
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

/**
 * Bind `prefix b`, `prefix C-b` (for when ctrl is still held) and `M-b` (no prefix) to jump back
 * to the board, unless the user has bound them to something themselves.
 */
export async function bindBoardKeys(): Promise<void> {
	const back = ['select-window', '-t', BOARD_WINDOW];
	const bindings: [table: string, key: string, command: string[]][] = [
		['prefix', 'b', back],
		['prefix', 'C-b', back],
		// Only in thread windows; everywhere else M-b still reaches the program (e.g. readline's back-a-word).
		['root', 'M-b', ['if-shell', '-F', `#{m:oo-*,#{window_name}}`, back.join(' '), 'send-keys M-b']],
	];
	for (const [table, key, command] of bindings) {
		const existing = await execa('tmux', ['list-keys', '-T', table, key], { reject: false });
		// C-b is send-prefix out of the box, which is worth giving up for this.
		const taken = existing.exitCode === 0 && !existing.stdout.includes(BOARD_WINDOW) && !existing.stdout.includes('send-prefix');
		if (!taken) await execa('tmux', ['bind-key', '-T', table, key, ...command]);
	}
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
