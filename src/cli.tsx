#!/usr/bin/env node
import { basename, resolve } from 'node:path';
import { execa } from 'execa';
import { render } from 'ink';
import { App } from './app.js';
import { claimBoard } from './requests.js';
import { COLORS, isRepo, loadState, projectProblem, saveState } from './state.js';
import { approvedPrompt, approveTodo, THREAD_USAGE, threadCommand } from './threadCommand.js';
import { mouseStdin, reportMouse } from './mouse.js';
import { editCommit } from './editor.js';
import { commit, stageAll } from './git.js';
import { diffPaneCommand, draftCommit } from './review.js';
import { OO_COMMAND, threadStatus, writeClaudeSettings, writeOoSkill } from './status.js';
import { approvedTodo, threadDir } from './threads.js';
import {
	BOARD_LABEL,
	BOARD_WINDOW,
	attachBoard,
	bindBoardKeys,
	enableTmuxMouse,
	insideTmux,
	labelWindow,
	MIN_TMUX,
	openSplit,
	pasteInto,
	renameCurrentWindow,
	selectExistingBoard,
	threadWindowName,
	tmuxVersionOk,
	windowNames,
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
		const project = {
			name: rest[1] ?? basename(path),
			abbrev: '',
			path,
			worktrees: isRepo(path),
			color: COLORS[state.projects.length % COLORS.length]!,
			wakePrompt: '',
			hooks: {},
			tracker: 'none' as const,
			jiraSite: '',
			jiraProject: '',
		};
		const problem = projectProblem(state, project);
		if (problem) {
			console.error(problem);
			return 1;
		}
		saveState({ ...state, projects: [...state.projects, project] });
		console.log(`Added ${project.name} → ${path}${project.worktrees ? '' : ' (not a git repo: threads run there directly)'}`);
		return 0;
	}
	if (sub === 'list') {
		for (const p of state.projects) console.log(`${p.name}\t${p.path}${p.worktrees ? '' : '\t(no worktrees)'}`);
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

/** The output of `<cmd> <versionFlag>`, or null if it isn't installed. */
async function version(cmd: string, versionFlag = '--version'): Promise<string | null> {
	const result = await execa(cmd, [versionFlag], { reject: false });
	return (result as { code?: string }).code === 'ENOENT' ? null : result.stdout;
}

const REQUIRED = [
	['git', 'https://git-scm.com/downloads'],
	['claude', 'https://docs.anthropic.com/en/docs/claude-code'],
] as const;
const OPTIONAL = [
	['gh', 'moving a thread to PR', 'https://cli.github.com'],
	['delta', 'reviewing diffs (d, D, M-d)', 'https://github.com/dandavison/delta'],
	['vim', 'commenting on diffs (o, c)', 'https://www.vim.org'],
] as const;

/**
 * Check the tools oo shells out to before starting the board: false (having said why) if a required
 * one is missing. `warn` also mentions missing optional ones, which only some actions need.
 */
async function checkTools(warn: boolean): Promise<boolean> {
	const minTmux = MIN_TMUX.join('.');
	const [tmux, required, optional] = await Promise.all([
		version('tmux', '-V'),
		Promise.all(REQUIRED.map(([cmd]) => version(cmd))),
		warn ? Promise.all(OPTIONAL.map(([cmd]) => version(cmd))) : [],
	]);
	const problems: string[] = [];
	if (tmux === null) problems.push(`tmux ${minTmux}+ is not installed: https://github.com/tmux/tmux/wiki/Installing`);
	else if (!tmuxVersionOk(tmux)) problems.push(`${tmux} is too old, oo needs ${minTmux} or later for popups`);
	REQUIRED.forEach(([cmd, url], i) => {
		if (required[i] === null) problems.push(`${cmd} is not installed: ${url}`);
	});
	optional.forEach((found, i) => {
		const [cmd, forWhat, url] = OPTIONAL[i]!;
		if (found === null) console.warn(`oo: ${cmd} is not installed, which ${forWhat} needs: ${url}`);
	});
	for (const problem of problems) console.error(`oo: ${problem}`);
	return problems.length === 0;
}

/** `oo split <shell|diff> <id>`, for M-s / M-d in a thread's window: what `s` / `M-d` do on the board. */
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
 * message, edit it in $EDITOR and commit, as approving a step on the board does (telling a stopped
 * claude to move on included).
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
	const window = threadWindowName(id);
	const waiting = threadStatus(id, cwd) === 'stopped' && (await windowNames()).includes(window);
	const message = await editCommit((await draftCommit(cwd, thread)) ?? '', thread.branch ?? cwd);
	if (!message) {
		console.log('Commit cancelled (changes left staged)');
		return 1;
	}
	await commit(cwd, message);
	console.log(`Committed on ${thread.branch ?? cwd}: ${message.split('\n')[0]}`);
	const item = approvedTodo(thread.todos ?? []);
	const ticked = await approveTodo(thread.id);
	if (ticked) console.log(ticked);
	if (waiting && (await windowNames()).includes(window)) {
		const todos = loadState().threads.find(t => t.id === id)?.todos ?? [];
		await pasteInto(window, approvedPrompt(todos, item, message.split('\n')[0]!));
		console.log('Told claude to move on');
	}
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
	// Outside tmux warnings stay readable in your shell; inside, they'd only be pushed up by the board.
	if (!(await checkTools(!insideTmux()))) process.exit(1);
	if (!insideTmux()) {
		// Re-run this same script (dist or tsx) as the board inside tmux.
		process.exit(await attachBoard([process.execPath, ...process.execArgv, process.argv[1]!]));
	}
	if (await selectExistingBoard()) process.exit(0);
	await renameCurrentWindow(BOARD_WINDOW);
	await labelWindow(BOARD_WINDOW, BOARD_LABEL);
	// Not just `oo`, so the keys don't depend on it being on tmux's PATH.
	await bindBoardKeys([...OO_COMMAND, 'split'].map(arg => JSON.stringify(arg)).join(' '));
	await enableTmuxMouse();
	writeClaudeSettings();
	writeOoSkill();
	claimBoard();
	render(<App />, { stdin: mouseStdin() });
	reportMouse();
}
