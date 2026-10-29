// Every todo on the highlighted thread (`T`), in place of the columns, for lists too long for the details box.

import { useEffect, useRef, useState } from 'react';
import { Box, Text, measureElement, useInput, type DOMElement } from 'ink';
import { mouse, type MouseEvent } from '../mouse.js';
import type { Thread } from '../state.js';
import { merged, todoProgress, todoWindow } from '../threads.js';
import { TodoRow } from './todoList.js';

type Props = {
	// Read live, so the list keeps up as claude ticks steps off.
	thread: Thread;
	// Whether it takes keys and the wheel (not while the board is busy).
	active: boolean;
	onClose: () => void;
};

export function TodoView({ thread, active, onClose }: Props) {
	const todos = thread.todos ?? [];

	// Todos are a line each; the list shows what fits in the space measured after each render.
	const list = useRef<DOMElement>(null);
	const [lines, setLines] = useState(0);
	useEffect(() => {
		if (!list.current) return;
		const measured = measureElement(list.current).height;
		if (measured !== lines) setLines(measured);
	});
	const shown = Math.max(1, lines);
	const last = Math.max(0, todos.length - shown);
	// Opens with the current step in view, once there's a height to place it in.
	const [scrolled, setScrolled] = useState<number | null>(null);
	const top = Math.min(last, scrolled ?? (lines ? todoWindow(todos, shown).start : 0));
	const scrollTo = (to: number) => setScrolled(Math.max(0, Math.min(last, to)));

	useInput(
		(input, key) => {
			if (input === 'q' || input === 'T' || key.escape) return onClose();
			if (input === 'j' || key.downArrow) return scrollTo(top + 1);
			if (input === 'k' || key.upArrow) return scrollTo(top - 1);
			if (input === 'g') return scrollTo(0);
			if (input === 'G') return scrollTo(last);
		},
		{ isActive: active },
	);

	const onMouse = ({ button }: MouseEvent) => {
		if (!active) return;
		if (button === 'wheelDown') scrollTo(top + 1);
		if (button === 'wheelUp') scrollTo(top - 1);
	};
	const onMouseRef = useRef(onMouse);
	onMouseRef.current = onMouse;
	useEffect(() => {
		const listener = (event: MouseEvent) => onMouseRef.current(event);
		mouse.on('press', listener);
		return () => void mouse.off('press', listener);
	}, []);

	const width = String(todos.length).length;
	const end = Math.min(todos.length, top + shown);
	return (
		<Box flexGrow={1} overflow="hidden" flexDirection="column">
			<Text wrap="truncate">
				<Text bold>
					#{thread.id} {thread.title}
				</Text>{' '}
				<Text dimColor>(j/k scroll  g/G top/bottom  esc/q/T close, or scroll)</Text>
			</Text>
			<Text dimColor>
				todo {todoProgress(todos)}
				{todos.length > shown ? ` · ${top + 1}–${end} of ${todos.length}` : ''}
			</Text>
			<Box ref={list} flexGrow={1} flexBasis={0} flexDirection="column" overflow="hidden">
				{todos.slice(top, end).map((todo, i) => (
					<TodoRow key={top + i} todo={todo} index={top + i} width={width} merged={merged(thread)} />
				))}
			</Box>
		</Box>
	);
}
