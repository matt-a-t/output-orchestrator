// Running the project's commands (r): a list over the bottom of the board, each opened in its own terminal window.

import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { openRun, restartCommand, runSessionName, startCommand, stopCommand, type RunStatus } from '../commands.js';
import { loop } from '../input.js';
import type { Project, ProjectCommand, Thread } from '../state.js';
import { threadDir } from '../threads.js';
import type { Board } from './board.js';

/** Who a run is for: the thread whose worktree it runs in, or none for the project's own checkout. */
export type RunTarget = { project: Project; thread?: Thread };

/**
 * The highlighted thread's runs, if it has somewhere to run them (not before its worktree is made,
 * or while it's in IDEAS or archived); otherwise the project checkout's.
 */
export function runTarget(board: Board, project: Project, thread: Thread | undefined): RunTarget {
	return thread && thread.project === project.name && threadDir(board.state(), thread) ? { project, thread } : { project };
}

const where = ({ project, thread }: RunTarget) => (thread ? `#${thread.id}${thread.local ? ' (in Local, the project checkout)' : ''}` : `${project.name}'s checkout`);

/** How a run is going, for the list. */
function statusText(status: RunStatus | undefined): [string, string | undefined] {
	if (!status) return ['', undefined];
	const windows = status.attached ? ` · ${status.attached} window${status.attached === 1 ? '' : 's'}` : '';
	if (status.running) return [`● running${windows}`, 'green'];
	return [`${status.exit === 0 ? '✓' : '✗'} exited ${status.exit}${windows}`, status.exit === 0 ? 'gray' : 'red'];
}

/**
 * Run `cmd` for the target: start it, run it again if it's finished, or (`restart`) start it over if
 * it's going. A window opens on it unless one's already on it; a running one opens another, since
 * ⏎ on it is asking to see it.
 */
async function runCommand(board: Board, target: RunTarget, cmd: ProjectCommand, restart: boolean) {
	const { project, thread } = target;
	const session = runSessionName(project, thread, cmd);
	const cwd = (thread && threadDir(board.state(), thread)) || project.path;
	const status = board.runs().get(session);
	const title = `${thread ? `#${thread.id} ` : ''}${cmd.name}`;
	let did: string;
	if (!status) {
		await startCommand(session, project, thread, cmd, cwd);
		did = `Started ${cmd.name} for ${where(target)}`;
	} else if (restart || !status.running) {
		await restartCommand(session, project, thread, cmd, cwd);
		did = `${status.running ? 'Restarted' : 'Ran'} ${cmd.name} again for ${where(target)}`;
	} else {
		did = `${cmd.name} is running for ${where(target)}`;
	}
	const showing = status && status.attached > 0 && (restart || !status.running);
	const opened = showing ? 'in its open window' : await openRun(session, title);
	await board.refreshRuns();
	board.setMessage(opened.startsWith('✗') ? `${did}; ${opened}` : `${did} — ${opened}`);
}

type Props = {
	board: Board;
	target: RunTarget;
	// Whether it takes keys (not while the board is busy).
	active: boolean;
	onClose: () => void;
};

/** The target project's commands with how each is going: ⏎ (or 1-9) runs or shows one, R restarts it, X stops it. */
export function RunPicker({ board, target, active, onClose }: Props) {
	const [index, setIndex] = useState(0);
	const { project, thread } = target;
	const commands = project.commands;
	const statusOf = (cmd: ProjectCommand) => board.runs().get(runSessionName(project, thread, cmd));
	useInput(
		(input, key) => {
			board.setMessage('');
			if (key.escape || input === 'q' || input === 'r') return onClose();
			const count = commands.length;
			if (input === 'j' || key.downArrow) return setIndex(loop(index, 1, count));
			if (input === 'k' || key.upArrow) return setIndex(loop(index, -1, count));
			const picked = /^[1-9]$/.test(input) ? Number(input) - 1 : index;
			const cmd = commands[picked];
			if (!cmd) return;
			if (key.return || /^[1-9]$/.test(input) || input === 'R') {
				onClose();
				return void board.run(() => runCommand(board, target, cmd, input === 'R'), `running ${cmd.name}`);
			}
			if (input === 'X') {
				if (!statusOf(cmd)) return board.setMessage(`${cmd.name} isn't running for ${where(target)}`);
				return void board.run(async () => {
					await stopCommand(runSessionName(project, thread, cmd));
					await board.refreshRuns();
					board.setMessage(`Stopped ${cmd.name} for ${where(target)}`);
				}, `stopping ${cmd.name}`);
			}
		},
		{ isActive: active },
	);
	if (commands.length === 0) {
		return (
			<Box flexDirection="column">
				<Text bold>
					Run — {project.name} has no commands <Text dimColor>(add some in P; esc closes)</Text>
				</Text>
			</Box>
		);
	}
	const nameWidth = Math.max(...commands.map(c => c.name.length)) + 2;
	return (
		<Box flexDirection="column">
			<Text bold>
				Run for {where(target)} <Text dimColor>(j/k move  ⏎/1-9 run or open its window  R restart  X stop  esc close)</Text>
			</Text>
			{commands.map((cmd, i) => {
				const [text, color] = statusText(statusOf(cmd));
				return (
					<Text key={cmd.name} wrap="truncate" inverse={i === index}>
						{'  '}
						<Text dimColor>{i < 9 ? `${i + 1} ` : '  '}</Text>
						<Text color={project.color}>{cmd.name.padEnd(nameWidth)}</Text>
						<Text color={color}>{text.padEnd(22)}</Text>
						<Text dimColor>{cmd.command}</Text>
					</Text>
				);
			})}
		</Box>
	);
}
