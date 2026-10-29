import { Box, Text } from 'ink';
import { TODO_MARKS, type Todo, type TodoStatus } from '../state.js';
import { todoProgress, todoRows } from '../threads.js';

const TODO_COLORS: Record<TodoStatus, string> = { pending: 'gray', active: 'yellow', review: 'magenta', done: 'green' };

/**
 * One step of claude's task list: its number (`index` + 1, right-aligned to `width` so the subjects
 * line up past step 9), its mark and its subject. After-merge steps are marked ⤳, and dimmed until
 * the PR has merged (`merged`).
 */
export function TodoRow({ todo, index, width, merged }: { todo: Todo; index: number; width: number; merged: boolean }) {
	return (
		<Text wrap="truncate">
			{'  '}
			<Text color={TODO_COLORS[todo.status]} dimColor={todo.status === 'done'}>
				{String(index + 1).padStart(width)}.
			</Text>{' '}
			<Text color={TODO_COLORS[todo.status]}>{TODO_MARKS[todo.status]}</Text>{' '}
			{todo.afterMerge ? <Text color="blue">⤳ </Text> : null}
			<Text bold={todo.status === 'active' || todo.status === 'review'} dimColor={todo.status === 'done' || (todo.afterMerge && !merged)}>
				{todo.subject}
			</Text>
		</Text>
	);
}

/**
 * The highlighted thread's progress through claude's task list, with the current step in view, in
 * `lines` rows below its header; the rest are summed up as "N more", and T shows them all.
 */
export function TodoList({ todos, lines, merged }: { todos: Todo[]; lines: number; merged: boolean }) {
	const { start, end } = todoRows(todos, lines);
	const width = String(todos.length).length;
	const indent = ' '.repeat(width + 4);
	const more = (n: number, arrow: string) =>
		n > 0 ? (
			<Text dimColor>
				{indent}
				{arrow} {n} more
			</Text>
		) : null;
	return (
		<Box flexDirection="column">
			<Text>
				<Text bold>todo</Text> {todoProgress(todos)}
				{start > 0 || end < todos.length ? <Text dimColor> · T shows all</Text> : null}
			</Text>
			{more(start, '↑')}
			{todos.slice(start, end).map((todo, i) => (
				<TodoRow key={start + i} todo={todo} index={start + i} width={width} merged={merged} />
			))}
			{more(todos.length - end, '↓')}
		</Box>
	);
}
