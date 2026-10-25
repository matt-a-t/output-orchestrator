import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execa } from 'execa';
import { fixture } from './testHelpers.js';
import { projectProblem, withHome } from './state.js';

test('worktrees need the project to be a git repo', async () => {
	const { project, state } = fixture();
	const p = state.projects[0]!;
	assert.match(projectProblem(state, p, 'p') ?? '', /isn't a git repo — turn worktrees off/);
	assert.equal(projectProblem(state, { ...p, worktrees: false }, 'p'), undefined);
	await execa('git', ['init', '-q', project]);
	assert.equal(projectProblem(state, p, 'p'), undefined);
});

test('there is always a home project, without worktrees', () => {
	const { dir, project, state } = fixture();
	const home = withHome(state, dir).projects;
	assert.deepEqual(home.map(p => [p.name, p.path, p.worktrees]), [['p', project, true], ['home', dir, false]]);
	// Not added twice, and named ~ if home is taken.
	assert.equal(withHome({ ...state, projects: home }, dir).projects.length, 2);
	const taken = { ...state, projects: [{ ...state.projects[0]!, name: 'home' }] };
	assert.equal(withHome(taken, dir).projects[1]!.name, '~');
});

test('the jira site has to be on atlassian.net, so the API token goes nowhere else', () => {
	const { state } = fixture();
	const p = { ...state.projects[0]!, worktrees: false, tracker: 'jira' as const };
	for (const site of ['example.com', 'yourco.atlassian.net.evil.com', 'yourco.atlassian.net@evil.com', 'evil.com/yourco.atlassian.net', 'yourco.atlassian.net:8443'])
		assert.match(projectProblem(state, { ...p, jiraSite: site }, 'p') ?? '', /must be yourco\.atlassian\.net/, site);
	assert.equal(projectProblem(state, { ...p, jiraSite: 'YourCo.atlassian.net' }, 'p'), undefined);
});
