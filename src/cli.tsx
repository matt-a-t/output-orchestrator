#!/usr/bin/env node
import { basename, resolve } from 'node:path';
import { render } from 'ink';
import { App } from './app.js';
import { COLORS, loadState, projectProblem, saveState } from './state.js';
import { writeClaudeSettings } from './status.js';
import { BOARD_WINDOW, attachBoard, bindBoardKey, insideTmux, renameCurrentWindow, selectExistingBoard } from './tmux.js';

const USAGE = `usage:
  oo                          open the board (starts/attaches the "oo" tmux session if needed)
  oo project add <path> [name]
  oo project list
  oo project rm <name>`;

function projectCommand(args: string[]): number {
	const state = loadState();
	const [sub, ...rest] = args;
	if (sub === 'add' && rest[0]) {
		const path = resolve(rest[0]);
		const project = { name: rest[1] ?? basename(path), abbrev: '', path, color: COLORS[state.projects.length % COLORS.length]! };
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

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'project') {
	process.exit(projectCommand(args));
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
	await bindBoardKey();
	writeClaudeSettings();
	render(<App />);
}
