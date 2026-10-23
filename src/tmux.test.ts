import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tmuxVersionOk } from './tmux.js';

test('accepts tmux 3.2 and later', () => {
	assert.ok(tmuxVersionOk('tmux 3.2'));
	assert.ok(tmuxVersionOk('tmux 3.3a'));
	assert.ok(tmuxVersionOk('tmux 3.10'));
	assert.ok(tmuxVersionOk('tmux 4.0'));
	assert.ok(tmuxVersionOk('tmux next-3.6'));
});

test('rejects tmux before 3.2', () => {
	assert.ok(!tmuxVersionOk('tmux 3.1c'));
	assert.ok(!tmuxVersionOk('tmux 2.9a'));
});

test('accepts versions it cannot read', () => {
	assert.ok(tmuxVersionOk('tmux master'));
	assert.ok(tmuxVersionOk(''));
});
