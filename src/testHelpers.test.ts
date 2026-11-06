import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execa } from 'execa';
import { currentRef, defaultBranch } from './git.js';
import { fakeGh, gitFixture } from './testHelpers.js';

test('the fake gh answers what it was given, fails anything else and records each call', async t => {
	const gh = fakeGh(t, { 'pr view': { stdout: '{"number":3}' }, 'pr view 3': { stdout: 'three', exitCode: 2 } });
	assert.equal((await execa('gh', ['pr', 'view', 'branch'])).stdout, '{"number":3}');
	const three = await execa('gh', ['pr', 'view', '3'], { reject: false });
	assert.deepEqual([three.stdout, three.exitCode], ['three', 2]);
	const other = await execa('gh', ['auth', 'status'], { reject: false });
	assert.equal(other.exitCode, 1);
	assert.match(other.stderr, /fake gh: no answer for: auth status/);
	assert.deepEqual(gh.calls(), [['pr', 'view', 'branch'], ['pr', 'view', '3'], ['auth', 'status']]);
});

test('a real gh reached by mistake has no login to act with', () => {
	assert.match(process.env.GH_CONFIG_DIR ?? '', /oo-gh-config-/);
	assert.equal(process.env.GH_TOKEN, undefined);
	assert.equal(process.env.GITHUB_TOKEN, undefined);
});

test('the git fixture is on main with an origin on disk, and its threads get worktrees in the temp dir', async () => {
	const { dir, project, state } = await gitFixture([{}]);
	assert.equal(await currentRef(project), 'main');
	assert.equal(await defaultBranch(project), 'main');
	assert.ok(state.threads[0]!.worktree!.startsWith(dir));
});
