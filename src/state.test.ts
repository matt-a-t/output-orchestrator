import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execa } from 'execa';
import { fixture } from './testHelpers.js';
import { projectProblem } from './state.js';

test('worktrees need the project to be a git repo', async () => {
	const { project, state } = fixture();
	const p = state.projects[0]!;
	assert.match(projectProblem(state, p, 'p') ?? '', /isn't a git repo — turn worktrees off/);
	assert.equal(projectProblem(state, { ...p, worktrees: false }, 'p'), undefined);
	await execa('git', ['init', '-q', project]);
	assert.equal(projectProblem(state, p, 'p'), undefined);
});
