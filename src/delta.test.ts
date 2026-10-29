import assert from 'node:assert/strict';
import { test } from 'node:test';
import { missing, navigateWarnings, parseDeltaConfig, RECOMMENDED } from './delta.js';

test('parses top-level delta keys, values with spaces and all', () => {
	const config = parseDeltaConfig('delta.file-style bold black #87afff\ndelta.navigate true\ndelta.side-by-side.line-numbers true\ndelta.light\n');
	assert.deepEqual([...config], [
		['file-style', 'bold black #87afff'],
		['navigate', 'true'],
		['light', ''],
	]);
	assert.equal(parseDeltaConfig('').size, 0);
});

test('only adds the keys you have not set', () => {
	assert.deepEqual(missing(new Map()), RECOMMENDED);
	const config = new Map([['file-style', 'red'], ['hunk-header-decoration-style', 'none']]);
	assert.deepEqual(missing(config).map(([key]) => key), ['file-decoration-style', 'hunk-header-style']);
});

test('warns about changed labels and features', () => {
	assert.deepEqual(navigateWarnings(new Map([['navigate', 'false'], ['file-style', 'red']])), []);
	const warnings = navigateWarnings(new Map([['hunk-label', '#'], ['file-modified-label', 'M'], ['features', 'decorations']]));
	assert.equal(warnings.length, 2);
	assert.match(warnings[0]!, /^hunk-label is set/);
	assert.match(warnings[1]!, /^features is set \(decorations\)/);
});
