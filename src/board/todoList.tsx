import { Box, Text } from 'ink';
import { TODO_MARKS, type Todo, type TodoStatus } from '../state.js';
import { todoProgress, todoWindow } from '../threads.js';

// The highlighted thread's todos shown below the board; the rest are summed up as "N more".
const MAX_TODO_LINES = 5;
const TODO_COLORS: Record<TodoStatus, string> = { pending: 'gray', active: 'yellow', review: 'magenta', done: 'green' };

/** The highlighted thread's progress through claude's task list, with the current step in view. */
export function TodoList({ todos }: { todos: Todo[] }) {
	const { start, end } = todoWindow(todos, MAX_TODO_LINES);
	// Step numbers are right-aligned so the subjects line up past step 9.
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
			</Text>
			{more(start, '↑')}
			{todos.slice(start, end).map((todo, i) => (
				<Text key={start + i} wrap="truncate">
					{'  '}
					<Text color={TODO_COLORS[todo.status]} dimColor={todo.status === 'done'}>
						{String(start + i + 1).padStart(width)}.
					</Text>{' '}
					<Text color={TODO_COLORS[todo.status]}>{TODO_MARKS[todo.status]}</Text>{' '}
					<Text bold={todo.status === 'active' || todo.status === 'review'} dimColor={todo.status === 'done'}>
						{todo.subject}
					</Text>
				</Text>
			))}
			{more(todos.length - end, '↓')}
		</Box>
	);
}
