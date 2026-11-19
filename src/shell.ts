// A thread's shell, in a terminal tab of its own (`oo shell`, M-s).
import { execa } from 'execa';
import { openTerminal, terminalCommand, terminalEnv } from './commands.js';
import { OO_COMMAND } from './status.js';
import type { Thread } from './state.js';

/** The tmux window a thread's shell opens in when there's no terminal to open a tab in. Not a thread window (see IN_THREAD_WINDOW). */
export const shellWindowName = (id: string) => `oo-shell-${id}`;

/**
 * Open a shell on the thread's worktree (in its container, for a container project) in a new terminal tab,
 * running `oo shell <id> --here` there. With no terminal to open, it's a tmux window in this session instead.
 * Returns what to tell the user.
 */
export async function openShellTab(thread: Pick<Thread, 'id'>): Promise<string> {
	const command = [...OO_COMMAND, 'shell', thread.id, '--here'];
	const title = `#${thread.id} shell`;
	const launch = terminalCommand(await terminalEnv(), command, title, { tab: true });
	if ('argv' in launch) return (await openTerminal(launch.argv)) ?? `Opened ${title} in a new tab`;
	const window = shellWindowName(thread.id);
	await execa('tmux', ['new-window', '-n', window, ...command]);
	return `Opened ${title} in tmux window ${window} (no terminal to open a tab in: set OO_TERMINAL)`;
}
