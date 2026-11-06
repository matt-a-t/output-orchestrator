import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorMessage } from './errors.js';

test('errorMessage takes an Error’s message and stringifies anything else', () => {
	assert.equal(errorMessage(new Error('no such branch')), 'no such branch');
	assert.equal(errorMessage('gh not found'), 'gh not found');
	assert.equal(errorMessage(undefined), 'undefined');
});
