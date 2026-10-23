import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fromThreadDir, nextStatus, type HookEvent } from './status.js';

const dir = '/home/matt/.local/share/output-orchestrator/worktrees/output-orchestrator/15';
const event = (cwd?: string): HookEvent => ({ thread: '15', event: 'SessionStart', cwd, ts: '' });

test('keeps events from the thread directory', () => {
	assert.ok(fromThreadDir(event(dir), dir));
	assert.ok(fromThreadDir(event(dir + '/'), dir));
});

test('keeps events from a subfolder of the thread directory', () => {
	assert.ok(fromThreadDir(event(dir + '/src'), dir));
});

test('drops events from another directory', () => {
	assert.ok(!fromThreadDir(event('/home/matt/.local/share/output-orchestrator/worktrees/rensim-data/17'), dir));
	assert.ok(!fromThreadDir(event('/home/matt'), dir));
});

test('drops events from a sibling sharing the directory as a prefix', () => {
	assert.ok(!fromThreadDir(event(dir + '0'), dir));
});

test('keeps events it cannot check', () => {
	assert.ok(fromThreadDir(event(), dir));
	assert.ok(fromThreadDir(event(dir), undefined));
});

const named = (name: string): HookEvent => ({ thread: '15', event: name, ts: '' });

test('a session ending mid-work is interrupted', () => {
	assert.equal(nextStatus('working', named('SessionEnd')), 'interrupted');
	assert.equal(nextStatus('stopped', named('SessionEnd')), 'ended');
	assert.equal(nextStatus('interrupted', named('SessionStart')), 'idle');
});
