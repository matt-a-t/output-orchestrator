#!/usr/bin/env node
import { basename, resolve } from 'node:path';
import { render } from 'ink';
import { App } from './app.js';
import { claimBoard } from './requests.js';
import { COLORS, loadState, projectProblem, saveState } from './state.js';
import { THREAD_USAGE, threadCommand } from './threadCommand.js';
import { mouseStdin, reportMouse } from './mouse.js';
import { editCommit } from './editor.js';
import { commit, stageAll } from './git.js';
import { diffPaneCommand, draftCommit } from './review.js';
import { OO_COMMAND, writeClaudeSettings, writeOoSkill } from './status.js';
import { threadDir } from './threads.js';
import {
	BOARD_WINDOW,
	attachBoard,
	bindBoardKeys,
	enableTmuxMouse,
	insideTmux,
	openSplit,
	renameCurrentWindow,
	selectExistingBoard,
	threadWindowName,
} from './tmux.js';

const USAGE = `usage:
  oo                          open the board (starts/attaches the "oo" tmux session if needed)
  oo project add <path> [name]
  oo project list
  oo project rm <name>
${THREAD_USAGE}`;

function projectCommand(args: string[]): number {
	const state = loadState();
	const [sub, ...rest] = args;
	if (sub === 'add' && rest[0]) {
		const path = resolve(rest[0]);
		const project = { name: rest[1] ?? basename(path), abbrev: '', path, color: COLORS[state.projects.length % COLORS.length]!, hooks: {} };
		const problem = projectProblem(state, project);
		if (problem) {
			console.error(problem);
			return 1;
		}
		saveState({ ...state, projects: [...state.projects, project] });
		console.log(`Added ${project.name} → ${path}`);
		return 0;
	}
	if (sub === 'list') {
		for (const p of state.projects) console.log(`${p.name}\t${p.path}`);
		return 0;
	}
	if (sub === 'rm' && rest[0]) {
		if (state.threads.some(t => t.project === rest[0] && t.column !== 'archived')) {
			console.error(`Project "${rest[0]}" still has unarchived threads`);
			return 1;
		}
		saveState({ ...state, projects: state.projects.filter(p => p.name !== rest[0]) });
		return 0;
	}
	console.error(USAGE);
	return 1;
}

/** `oo split <shell|diff> <id>`, for M-s / M-d in a thread's window: what `s` / `v` do on the board. */
async function splitCommand([role, id]: string[]): Promise<number> {
	const state = loadState();
	const thread = state.threads.find(t => t.id === id);
	const cwd = thread && threadDir(state, thread);
	if ((role !== 'shell' && role !== 'diff') || !thread || !cwd) {
		console.error(thread ? `#${id} has no worktree` : `usage: oo split <shell|diff> <id>`);
		return 1;
	}
	const command = role === 'shell' ? [process.env.SHELL || 'bash'] : await diffPaneCommand(cwd, thread);
	await openSplit(threadWindowName(id), cwd, role, command, { OO_THREAD_ID: id });
	return 0;
}

/**
 * `oo commit <id>`, for `a` in the diff beside claude: stage everything, have claude draft the
 * message, edit it in $EDITOR and commit, as approving a step on the board does.
 */
async function commitCommand([id]: string[]): Promise<number> {
	const state = loadState();
	const thread = state.threads.find(t => t.id === id);
	const cwd = thread && threadDir(state, thread);
	if (!thread || !cwd) {
		console.error(thread ? `#${id} has no worktree` : 'usage: oo commit <id>');
		return 1;
	}
	if (!(await stageAll(cwd))) {
		console.log('Nothing to commit');
		return 0;
	}
	const message = await editCommit((await draftCommit(cwd, thread)) ?? '', thread.branch ?? cwd);
	if (!message) {
		console.log('Commit cancelled (changes left staged)');
		return 1;
	}
	await commit(cwd, message);
	console.log(`Committed on ${thread.branch ?? cwd}: ${message.split('\n')[0]}`);
	return 0;
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'project') {
	process.exit(projectCommand(args));
} else if (cmd === 'thread') {
	process.exit(await threadCommand(args));
} else if (cmd === 'split') {
	process.exit(await splitCommand(args));
} else if (cmd === 'commit') {
	process.exit(await commitCommand(args));
} else if (cmd) {
	console.error(USAGE);
	process.exit(1);
} else {
	if (!insideTmux()) {
		// Re-run this same script (dist or tsx) as the board inside tmux.
		process.exit(await attachBoard([process.execPath, ...process.execArgv, process.argv[1]!]));
	}
	if (await selectExistingBoard()) process.exit(0);
	await renameCurrentWindow(BOARD_WINDOW);
	// Not just `oo`, so the keys don't depend on it being on tmux's PATH.
	await bindBoardKeys([...OO_COMMAND, 'split'].map(arg => JSON.stringify(arg)).join(' '));
	await enableTmuxMouse();
	writeClaudeSettings();
	writeOoSkill();
	claimBoard();
	render(<App />, { stdin: mouseStdin() });
	reportMouse();
}
