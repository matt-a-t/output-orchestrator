import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToString } from 'ink';
import { Legend, planSummary } from './footer.js';
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

test('the plan line skips blank lines and drops heading marks', () => {
	assert.equal(planSummary('# #61 Rework the keys\n\n## Context\nThe keys are confusing.\n- more'), '#61 Rework the keys · Context · The keys are confusing.');
	assert.equal(planSummary('  \n#hashtag, not a heading\n### Plan  '), '#hashtag, not a heading · Plan');
	assert.equal(planSummary('\n\n'), '');
});
