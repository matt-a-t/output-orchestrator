import { randomUUID } from 'node:crypto';
import { execa } from 'execa';

export const BOARD_WINDOW = 'oo-board';

export function insideTmux(): boolean {
	return Boolean(process.env.TMUX);
}

export function threadWindowName(threadId: string): string {
	return `oo-${threadId}`;
}

export async function renameCurrentWindow(name: string): Promise<void> {
	await execa('tmux', ['rename-window', name]);
}

async function windowNames(): Promise<string[]> {
	const { stdout } = await execa('tmux', ['list-windows', '-F', '#{window_name}']);
	return stdout.split('\n');
}

/** Jump to the thread's window, creating it (running `command` in `cwd`) if needed. */
export async function openWindow(name: string, cwd: string, command: string[]): Promise<'created' | 'selected'> {
	if ((await windowNames()).includes(name)) {
		await execa('tmux', ['select-window', '-t', `:${name}`]);
		return 'selected';
	}
	await execa('tmux', ['new-window', '-n', name, '-c', cwd, ...command]);
	return 'created';
}

/** Run a command in a tmux popup and resolve once it exits. */
export async function popup(command: string, opts: { cwd?: string; title?: string } = {}): Promise<void> {
	const channel = `oo-${randomUUID()}`;
	const args = ['display-popup', '-E', '-w', '90%', '-h', '90%'];
	if (opts.cwd) args.push('-d', opts.cwd);
	if (opts.title) args.push('-T', opts.title);
	// wait-for makes this independent of whether display-popup blocks.
	args.push(`${command}; tmux wait-for -S ${channel}`);
	await execa('tmux', args);
	await execa('tmux', ['wait-for', channel]);
}

export function shellQuote(s: string): string {
	return `'${s.replaceAll("'", `'\\''`)}'`;
}
