import assert from 'node:assert/strict';
import { test } from 'node:test';
import { columnHook, hookEnv, hookWindowName } from './hooks.js';
import type { Project, Thread } from './state.js';

const project = { name: 'web' } as Project;
const thread = { id: '7', title: 'Fix login', branch: 'oo/7-fix-login' } as Thread;

test('moves into and out of Polish set off its hooks', () => {
	assert.equal(columnHook('active', 'polish'), 'enterPolish');
	assert.equal(columnHook('pr', 'polish'), 'enterPolish');
	assert.equal(columnHook('polish', 'active'), 'leavePolish');
	assert.equal(columnHook('polish', 'pr'), 'leavePolish');
	assert.equal(columnHook('polish', 'archived'), 'leavePolish');
});

test('other moves set off nothing', () => {
	assert.equal(columnHook('polish', 'polish'), undefined);
	assert.equal(columnHook('active', 'pr'), undefined);
	assert.equal(columnHook('pr', 'done'), undefined);
});

test('each kind of hook has its own window, so one doesn\'t stop another', () => {
	assert.equal(hookWindowName(project, 'enterLocal'), 'oo-hook-web');
	assert.equal(hookWindowName(project, 'leaveLocal'), 'oo-hook-web');
	assert.equal(hookWindowName(project, 'enterPolish'), 'oo-hook-web-polish');
	assert.equal(hookWindowName(project, 'newThread'), 'oo-hook-web-new');
	assert.equal(hookWindowName(project, 'worktreeCreated'), 'oo-hook-web-worktree');
});

test('hooks are told about the thread, and the new thread hook its prompt', () => {
	assert.deepEqual(hookEnv(project, 'newThread', thread, { OO_PROMPT: 'go' }), {
		OO_HOOK_NAME: 'new thread',
		OO_THREAD_ID: '7',
		OO_THREAD_TITLE: 'Fix login',
		OO_PROJECT: 'web',
		OO_BRANCH: 'oo/7-fix-login',
		OO_PROMPT: 'go',
	});
	assert.equal(hookEnv(project, 'enterLocal', { ...thread, branch: undefined }).OO_BRANCH, '');
});
