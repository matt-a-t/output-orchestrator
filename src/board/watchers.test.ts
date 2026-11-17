import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bitbucket } from '../bitbucket.js';
import { github } from '../github.js';
import { prPollDue } from './watchers.js';

test('a PR is checked on the first poll, then once its host allows another', () => {
	const every = bitbucket.pollEvery;
	assert.ok(prPollDue(undefined, 0, every));
	assert.ok(!prPollDue(0, 60_000, every));
	assert.ok(!prPollDue(0, every - 60_000, every));
	// The minute poll lands a little early or late; that still counts as due.
	assert.ok(prPollDue(0, every - 1_000, every));
	assert.ok(prPollDue(0, 59_000, github.pollEvery));
});
