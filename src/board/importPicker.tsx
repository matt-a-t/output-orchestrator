// Importing a claude thread started outside the board (`i`): which project, then which thread.

import { useState } from 'react';
import { Text } from 'ink';
import type { Project, Thread } from '../state.js';
import { addThread } from '../threads.js';
import { recentlyActive, timeAgo, type OutsideThread } from '../transcripts.js';
import type { Board } from './board.js';
import { ScrollList } from './scrollList.js';

type ProjectProps = {
	board: Board;
	// Whether it takes keys (not while the board is busy).
	active: boolean;
	onPick: (project: Project) => void;
	onClose: () => void;
};

/** Picking the project to import from, when there's no filter to say, in place of the columns. */
export function ImportProject({ board, active, onPick, onClose }: ProjectProps) {
	const [row, setRow] = useState(0);
	const pick = (project: Project) => {
		onClose();
		onPick(project);
	};
	return (
		<ScrollList
			board={board}
			items={board.state().projects}
			itemKey={p => p.name}
			title={
				<>
					Import — which project? <Text dimColor>(j/k move  ⏎ choose  esc/q/i cancel, or click, double-click, scroll)</Text>
				</>
			}
			row={row}
			setRow={setRow}
			active={active}
			onActivate={pick}
			onInput={(input, key) => {
				if (input !== 'q' && input !== 'i' && !key.escape) return;
				onClose();
				board.setMessage('Cancelled');
			}}
			renderItem={(p, selected) => (
				<Text wrap="truncate" inverse={selected}>
					{'  '}
					<Text color={p.color}>{p.name}</Text>
					<Text dimColor> {p.path}</Text>
				</Text>
			)}
		/>
	);
}

type ListProps = {
	board: Board;
	project: string;
	threads: OutsideThread[];
	active: boolean;
	onClose: () => void;
	/** Jump to a thread on the board; false if it can't be shown (it's archived). */
	onShow: (thread: Thread) => boolean;
};

const entryHeight = (t: OutsideThread) => (t.title === t.firstPrompt ? 1 : 2);

/** The import list, in place of the columns: the project's claude threads, newest first. */
export function ImportList({ board, project, threads, active, onClose, onShow }: ListProps) {
	const [row, setRow] = useState(0);
	const linkedThread = (outside: OutsideThread) => board.state().threads.find(t => t.sessionId === outside.id);

	const importThread = (outside: OutsideThread) => {
		onClose();
		const linked = linkedThread(outside);
		if (linked) {
			if (!onShow(linked)) board.setMessage(`That thread is already imported as archived #${linked.id}`);
			return;
		}
		const { thread } = addThread(board.state(), {
			title: outside.title,
			plan: outside.title === outside.firstPrompt ? '' : outside.firstPrompt,
			project,
			sessionId: outside.id,
			transcriptPath: outside.transcriptPath,
			cwd: outside.cwd,
		});
		board.setState(s => ({ ...s, threads: [...s.threads, thread] }));
		board.showAtEnd('planned');
		board.setMessage(
			recentlyActive(outside.transcriptPath)
				? `⚠ Imported #${thread.id}, but it looks active elsewhere — close it there before ⏎`
				: `Imported #${thread.id} — ⏎ resumes it`,
		);
	};

	return (
		<ScrollList
			board={board}
			items={threads}
			itemKey={t => t.id}
			itemHeight={entryHeight}
			title={
				<>
					Import a {project} thread <Text dimColor>(j/k move  ⏎ import  esc/q/i cancel, or click, double-click, scroll)</Text>
				</>
			}
			row={row}
			setRow={setRow}
			active={active}
			onActivate={importThread}
			onInput={(input, key) => {
				if (input === 'q' || input === 'i' || key.escape) onClose();
			}}
			renderItem={(s, selected) => {
				const linked = linkedThread(s);
				const recent = recentlyActive(s.transcriptPath);
				return (
					<>
						<Text wrap="truncate" inverse={selected}>
							<Text dimColor>{timeAgo(s.lastActivity).padEnd(9)}</Text>
							{linked ? <Text color="cyan">#{linked.id} </Text> : null}
							{recent ? <Text color="yellow">● active </Text> : null}
							{s.title}
						</Text>
						{s.title !== s.firstPrompt ? (
							<Text wrap="truncate" dimColor>
								{'         '}
								{s.firstPrompt}
							</Text>
						) : null}
					</>
				);
			}}
		/>
	);
}
