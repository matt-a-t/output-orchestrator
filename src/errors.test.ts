import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorMessage, messageColor, resultMessage } from './errors.js';

test('errorMessage takes an Error’s message and stringifies anything else', () => {
	assert.equal(errorMessage(new Error('no such branch')), 'no such branch');
	assert.equal(errorMessage('gh not found'), 'gh not found');
	assert.equal(errorMessage(undefined), 'undefined');
});

test('messageColor: ✗ is red, ⚠ or a question is yellow, the rest green', () => {
	assert.equal(messageColor("✗ Couldn't pull"), 'red');
	assert.equal(messageColor('⚠ claude is still working on #3'), 'yellow');
	assert.equal(messageColor('Archive #3? y to confirm', true), 'yellow');
	assert.equal(messageColor('✗ failed', true), 'red');
	assert.equal(messageColor('Saved #3'), 'green');
});

test('resultMessage marks what didn’t go through with ⚠, once', () => {
	assert.equal(resultMessage({ ok: true, message: 'Moved #3 to Done' }), 'Moved #3 to Done');
	assert.equal(resultMessage({ ok: false, message: 'claude is still working on #3' }), '⚠ claude is still working on #3');
	assert.equal(resultMessage({ ok: false, message: '⚠ #3 is blocked by #2 the base' }), '⚠ #3 is blocked by #2 the base');
	assert.equal(resultMessage({ ok: false, message: '✗ gh failed' }), '✗ gh failed');
});
