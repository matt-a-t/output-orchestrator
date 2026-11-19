import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToString } from 'ink';
import { Legend } from './keysView.js';
import { LEGEND } from './card.js';

test('the legend wraps only between entries, a gap apart', () => {
	for (const width of [60, 80, 120, 160, 200]) {
		const lines = renderToString(<Legend width={width} />, { columns: width }).split('\n');
		assert.ok(lines.length > 1 || width >= 200, `the legend fits on one line at ${width} columns`);
		for (const line of lines) assert.ok([...line].length <= width, `a line at ${width} columns is too wide: ${line}`);
		// Each entry is whole on one line, starting it or three spaces after the one before.
		for (const [badge, , label] of LEGEND) {
			const entry = `${badge} ${label}`;
			const line = lines.find(l => l.includes(entry));
			assert.ok(line, `"${label}" is split at ${width} columns`);
			const before = line.slice(0, line.indexOf(entry));
			assert.ok(before === '' || before.endsWith('   '), `"${label}" runs into the entry before it at ${width} columns: ${line}`);
		}
	}
});
