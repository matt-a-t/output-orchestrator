import { Text } from 'ink';
import { TODO_MARKS, type Todo, type TodoStatus } from '../state.js';

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
