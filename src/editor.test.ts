import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planFromEditor } from './editor.js';

test("a plan keeps its markdown headings, losing only oo's note", () => {
	const edited = '# Card rethink\n\n## Context\nFour lines a card.\n\n<!-- oo: the plan for #1 Cards. This line is dropped when you save. -->\n';
	assert.equal(planFromEditor(edited), '# Card rethink\n\n## Context\nFour lines a card.');
	assert.equal(planFromEditor('<!-- a comment of the plan’s own -->\nText'), '<!-- a comment of the plan’s own -->\nText');
});
