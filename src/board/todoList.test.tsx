import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Box, renderToString } from 'ink';
import { TODO_STATUSES } from '../state.js';
import { TodoRow } from './todoList.js';

test('a todo row too long for the box ends in an ellipsis, whatever its status', () => {
	const subject = 'Forms: a submit row ([Create]/[Save]/[Commit]) that ⏎ triggers, shift-⏎ the shortcut, and nothing else';
	for (const status of TODO_STATUSES)
		for (const afterMerge of [false, true]) {
			const out = renderToString(
				<Box width={60} flexDirection="column">
					<TodoRow todo={{ subject, status, afterMerge }} index={0} width={1} merged={false} />
				</Box>,
				{ columns: 80 },
			);
			assert.equal(out.split('\n').length, 1, `a ${status} row wraps`);
			assert.ok([...out].length <= 60, `a ${status} row is too wide: ${out}`);
			assert.ok(out.endsWith('…'), `a ${status} row isn't cut with an ellipsis: ${out}`);
		}
});
