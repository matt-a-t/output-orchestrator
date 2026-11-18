import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { fixture } from './testHelpers.js';
import { containerText, loadState, parseContainer, projectProblem, saveState, stillSaved, withHome } from './state.js';

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

test('a container setting is typed as text and parsed on save', () => {
	assert.deepEqual(parseContainer({ image: ' oo-thread ', ports: '3000, 5173 3000', allow: 'registry.example.com,  pypi.org' }), {
		container: { image: 'oo-thread', ports: [3000, 5173], allow: ['registry.example.com', 'pypi.org'] },
	});
	assert.deepEqual(parseContainer({ image: '', ports: '', allow: '' }), {});
	assert.match(parseContainer({ image: '', ports: '3000', allow: '' }).problem ?? '', /need an image/);
	assert.match(parseContainer({ image: 'x', ports: '70000', allow: '' }).problem ?? '', /70000 isn't a port/);
	assert.deepEqual(containerText({ image: 'x', ports: [3000, 5173], allow: ['a.com'] }), { image: 'x', ports: '3000, 5173', allow: 'a.com' });
});

test('a container needs worktrees, since each thread mounts its own', () => {
	const { state } = fixture();
	const p = { ...state.projects[0]!, worktrees: false, container: { image: 'x', ports: [], allow: [] } };
	assert.match(projectProblem(state, p, 'p') ?? '', /needs worktrees on/);
});

test('the state file is only readable by you', () => {
	const { dir, state } = fixture();
	const file = join(dir, 'data', 'state.json');
	saveState(state, file);
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.equal(statSync(join(dir, 'data')).mode & 0o777, 0o700);
});

test('projects saved before commands load with none', () => {
	const { dir, project } = fixture();
	const file = join(dir, 'old.json');
	writeFileSync(file, JSON.stringify({ version: 1, projects: [{ name: 'p', path: project, color: 'cyan' }], threads: [] }));
	assert.deepEqual(loadState(file).projects[0]!.commands, []);
});

test("a thread's last pop quiz is saved and loaded with it", () => {
	const quiz = {
		questions: [
			{ kind: 'choice' as const, question: 'Who is told?', choices: ['Nobody', 'The board'], answer: 1, why: 'It sets a message.' },
			{ kind: 'text' as const, question: 'Why only once?', answer: 'Second failures are real.' },
		],
		answers: [0, 'flaky'],
		grades: [{ correct: false, note: 'It sets a message.' }, { correct: true, note: 'Right idea.' }],
		result: 'overridden' as const,
		score: '1/2',
		at: '2026-11-11T00:00:00.000Z',
	};
	const { dir, state } = fixture([{ quiz }]);
	const file = join(dir, 'data', 'state.json');
	saveState(state, file);
	assert.deepEqual(loadState(file).threads[0]!.quiz, quiz);
});

test('a save is compact and recognised as its own until something else writes the file', () => {
	const { dir, state } = fixture([{}]);
	const file = join(dir, 'data', 'state.json');
	const saved = saveState(state, file);
	assert.equal(readFileSync(file, 'utf8'), JSON.stringify(state));
	assert.ok(stillSaved(saved, statSync(file)));
	writeFileSync(file, JSON.stringify({ ...state, threads: [] }));
	assert.ok(!stillSaved(saved, statSync(file)));
	assert.ok(!stillSaved(null, statSync(file)));
});
