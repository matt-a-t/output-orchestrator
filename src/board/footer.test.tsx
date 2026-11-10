import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToString } from 'ink';
import { Legend } from './footer.js';
import { LEGEND } from './card.js';

test('the legend wraps only between entries', () => {
	for (const width of [60, 80, 120, 160, 200]) {
		const lines = renderToString(<Legend width={width} />, { columns: width }).split('\n');
		assert.ok(lines.length > 1 || width >= 200, `the legend fits on one line at ${width} columns`);
		for (const line of lines) {
			assert.ok([...line].length <= width, `a line at ${width} columns is too wide: ${line}`);
			assert.doesNotMatch(line, /\S {0,2}[⚙⏸✓○↻±⚡✉⧗⤳▲▽▶] /u, `entries run together at ${width} columns: ${line}`);
		}
		const text = lines.join('\n');
		for (const [badge, , label] of LEGEND) assert.ok(text.includes(`${badge} ${label}`), `"${label}" is split at ${width} columns`);
	}
});
