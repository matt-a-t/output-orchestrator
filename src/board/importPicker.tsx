// Importing a claude thread started outside the board (`i`): which project, then which thread.

import { useEffect, useRef, useState } from 'react';
import { Box, Text, measureElement, useInput, useWindowSize, type DOMElement } from 'ink';
import { loop } from '../input.js';
import { mouse, type MouseEvent } from '../mouse.js';
import type { Project, Thread } from '../state.js';
import { addThread } from '../threads.js';
import { recentlyActive, timeAgo, type OutsideThread } from '../transcripts.js';
import type { Board } from './board.js';
import { LIST_TOP } from './card.js';
import { useDoubleClick } from './doubleClick.js';

type ProjectProps = {
	board: Board;
	// Whether it takes keys (not while the board is busy).
	active: boolean;
	onPick: (project: Project) => void;
	onClose: () => void;
};

/** Picking the project to import from, when there's no filter to say. */
export function ImportProject({ board, active, onPick, onClose }: ProjectProps) {
	const [index, setIndex] = useState(0);
	const { projects } = board.state();
	useInput(
		(input, key) => {
			board.setMessage('');
			if (key.escape) {
				onClose();
				return board.setMessage('Cancelled');
			}
			const count = projects.length;
			if (input === 'j' || key.downArrow) return setIndex((index + 1) % count);
			if (input === 'k' || key.upArrow) return setIndex((index + count - 1) % count);
			if (key.return) {
				onClose();
				return onPick(projects[index]!);
			}
		},
		{ isActive: active },
	);
	return (
		<Box flexDirection="column">
			<Text bold>Import — project? (j/k move, ⏎ choose, esc cancel)</Text>
			{projects.map((p, i) => (
				<Text key={p.name} inverse={i === index}>
					{'  '}
					<Text color={p.color}>{p.name}</Text>
					<Text dimColor> {p.path}</Text>
				</Text>
			))}
		</Box>
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
	const { columns: width } = useWindowSize();
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

	useInput(
		(input, key) => {
			board.setMessage('');
			const count = threads.length;
			if (input === 'q' || input === 'i' || key.escape) return onClose();
			if (input === 'j' || key.downArrow) return setRow(loop(row, 1, count));
			if (input === 'k' || key.upArrow) return setRow(loop(row, -1, count));
			if (key.return) return importThread(threads[row]!);
		},
		{ isActive: active },
	);

	// The list scrolls to keep the selected entry in view; it shows what fits in the space
	// measured after each render, starting at entry `top`.
	const list = useRef<DOMElement>(null);
	const [lines, setLines] = useState(0);
	useEffect(() => {
		if (!list.current) return;
		const measured = measureElement(list.current).height;
		if (measured !== lines) setLines(measured);
	});
	const top = useRef(0);
	const linesFrom = (from: number, to: number) => threads.slice(from, to + 1).reduce((n, t) => n + entryHeight(t), 0);
	top.current = Math.min(top.current, row);
	while (top.current < row && linesFrom(top.current, row) > lines) top.current++;
	const shown: OutsideThread[] = [];
	let used = 0;
	for (const t of threads.slice(top.current)) {
		used += entryHeight(t);
		if (used > lines) break;
		shown.push(t);
	}

	/** The entry at screen row `y`; an entry is one line, or two when it shows its first prompt. */
	const rowAt = (y: number) => {
		let bottom = LIST_TOP;
		for (const [r, t] of shown.entries()) {
			bottom += entryHeight(t);
			if (y < bottom) return top.current + r;
		}
	};

	const isDoubleClick = useDoubleClick();
	// The wheel stops at the ends rather than looping.
	const onMouse = ({ button, y }: MouseEvent) => {
		if (!active) return;
		board.setMessage('');
		const wheel = button === 'wheelDown' ? 1 : button === 'wheelUp' ? -1 : 0;
		if (wheel) return setRow(r => Math.max(0, Math.min(threads.length - 1, r + wheel)));
		const r = y >= LIST_TOP ? rowAt(y) : undefined;
		if (button !== 'left' || r === undefined) return;
		setRow(r);
		if (isDoubleClick(threads[r]!.id)) importThread(threads[r]!);
	};
	const onMouseRef = useRef(onMouse);
	onMouseRef.current = onMouse;
	useEffect(() => {
		const listener = (event: MouseEvent) => onMouseRef.current(event);
		mouse.on('press', listener);
		return () => void mouse.off('press', listener);
	}, []);

	return (
		<Box flexGrow={1} overflow="hidden" flexDirection="column">
			<Text bold>
				Import a {project} thread <Text dimColor>(j/k move  ⏎ import  esc/q/i cancel, or click, double-click, scroll)</Text>
			</Text>
			<Text dimColor>
				{'─'.repeat(Math.max(0, width - 13))} {String(row + 1).padStart(4)} of {String(threads.length).padEnd(3)}
			</Text>
			<Box ref={list} flexGrow={1} flexBasis={0} flexDirection="column" overflow="hidden">
				{shown.map((s, i) => {
					const r = top.current + i;
					const linked = linkedThread(s);
					const recent = recentlyActive(s.transcriptPath);
					return (
						<Box key={s.id} flexDirection="column" flexShrink={0}>
							<Text wrap="truncate" inverse={r === row}>
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
						</Box>
					);
				})}
			</Box>
		</Box>
	);
}
