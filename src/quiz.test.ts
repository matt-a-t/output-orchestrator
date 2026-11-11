import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gradeChoices, parseGrade, parseQuiz, score, shortstatLines } from './quiz.js';
const reply = JSON.stringify({
	choices: [
		{ question: 'What happens when the push fails?', right: 'It retries once', wrong: ['It gives up', 'It loops forever', 'It deletes the branch'], why: 'pushBranch catches the first failure.' },
		{ question: 'Who is told?', right: 'The board', wrong: ['Nobody', 'The PR'], why: 'It sets a message.' },
	],
	written: { question: 'Why only once?', answer: 'A second failure is almost never transient.' },
});
// No shuffling: the right choice stays first.
const quiz = parseQuiz(reply, () => 0.999)!;

test('parseQuiz shuffles the choices and keeps track of the right one', () => {
	assert.deepEqual(quiz[0], {
		kind: 'choice',
		question: 'What happens when the push fails?',
		choices: ['It retries once', 'It gives up', 'It loops forever', 'It deletes the branch'],
		answer: 0,
		why: 'pushBranch catches the first failure.',
	});
	assert.deepEqual(quiz[2], { kind: 'text', question: 'Why only once?', answer: 'A second failure is almost never transient.' });
	const shuffled = parseQuiz(reply, () => 0)!;
	assert.equal(shuffled[0].choices[shuffled[0].answer], 'It retries once');
	assert.notEqual(shuffled[0].answer, 0);
});

test('parseQuiz takes JSON with words around it, and nothing that isn\'t two choice questions and a written one', () => {
	assert.ok(parseQuiz(`Here you go:\n${reply}\nGood luck!`));
	assert.equal(parseQuiz('no quiz today'), undefined);
	const json = JSON.parse(reply);
	assert.equal(parseQuiz(JSON.stringify({ ...json, choices: json.choices.slice(1) })), undefined);
	assert.equal(parseQuiz(JSON.stringify({ ...json, written: { question: 'Why?' } })), undefined);
	assert.equal(parseQuiz(JSON.stringify({ ...json, choices: [json.choices[0], { ...json.choices[1], wrong: ['Nobody'] }] })), undefined);
});

test('parseGrade reads PASS or FAIL and the note after it', () => {
	assert.deepEqual(parseGrade('PASS\nRight idea.'), { correct: true, note: 'Right idea.' });
	assert.deepEqual(parseGrade('**FAIL** — misses the point\nof retries.'), { correct: false, note: 'misses the point of retries.' });
	assert.equal(parseGrade('Maybe?'), undefined);
});

test('gradeChoices marks each choice question against its answer, and score counts the right ones', () => {
	const choices = gradeChoices(quiz, [0, 0, 'Flaky networks.']);
	assert.deepEqual(choices.map(g => g.correct), [true, true]);
	const grades = [...gradeChoices(quiz, [1, null, '']), { correct: false, note: '' }];
	assert.deepEqual(grades.map(g => g.correct), [false, false, false]);
	assert.equal(grades[0]!.note, 'pushBranch catches the first failure.');
	assert.equal(score([...choices, { correct: false, note: '' }]), '2/3');
});

test('shortstatLines adds up the lines inserted and deleted', () => {
	assert.equal(shortstatLines(' 3 files changed, 25 insertions(+), 4 deletions(-)'), 29);
	assert.equal(shortstatLines(' 1 file changed, 1 insertion(+)'), 1);
	assert.equal(shortstatLines(' 1 file changed, 7 deletions(-)'), 7);
	assert.equal(shortstatLines(''), 0);
});
