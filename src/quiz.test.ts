import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gradeChoices, parseAnswers, parseGrade, parseOverride, parseQuiz, quizText, resultsText, score, type Quiz } from './quiz.js';
import type { Thread } from './state.js';

const thread = { id: '7', title: 'Retry pushes' } as Thread;
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

/** `text` with the boxes of `ticked` choices crossed and `written` under the last question. */
const answer = (text: string, ticked: string[], written: string) =>
	ticked.reduce((t, choice) => t.replace(`[ ] ${choice}`, `[x] ${choice}`), text).replace('3. Why only once?\n', `3. Why only once?\n${written}\n`);

test('parseAnswers reads the one box ticked per choice question and the written answer', () => {
	const text = quizText(quiz, thread);
	assert.match(text, /^# Pop quiz on #7 Retry pushes/);
	assert.deepEqual(parseAnswers(text, quiz), [null, null, '']);
	assert.deepEqual(parseAnswers(answer(text, ['It retries once', 'Nobody'], 'Second failures\nare real.'), quiz), [0, 1, 'Second failures\nare real.']);
	// Two ticked is no answer.
	assert.deepEqual(parseAnswers(answer(text, ['It retries once', 'It loops forever', 'Nobody'], ''), quiz), [null, 1, '']);
	assert.deepEqual(parseAnswers(answer(text, ['It deletes the branch', 'The board'], '# a note\nreal'), quiz), [3, 0, 'real']);
});

test('parseGrade reads PASS or FAIL and the note after it', () => {
	assert.deepEqual(parseGrade('PASS\nRight idea.'), { correct: true, note: 'Right idea.' });
	assert.deepEqual(parseGrade('**FAIL** — misses the point\nof retries.'), { correct: false, note: 'misses the point of retries.' });
	assert.equal(parseGrade('Maybe?'), undefined);
});

test('resultsText asks whether to open the PR anyway only when something is wrong', () => {
	const answers = [0, 0, 'Flaky networks.'];
	const choices = gradeChoices(quiz, answers);
	assert.deepEqual(choices.map(g => g.correct), [true, true]);
	const passed = resultsText(quiz, answers, [...choices, { correct: true, note: 'Right idea.' }]);
	assert.match(passed, /^# Pop quiz: 3\/3\./);
	assert.doesNotMatch(passed, /anyway\?/);
	const grades = [...gradeChoices(quiz, [1, 0, '']), { correct: false, note: '' }];
	assert.equal(score(grades), '1/3');
	const failed = resultsText(quiz, [1, 0, ''], grades);
	assert.match(failed, /1\. ✗ What happens when the push fails\?\n {3}you: It gives up\n {3}answer: It retries once/);
	assert.match(failed, /3\. ✗ Why only once\?\n {3}you: \(no answer\)/);
	assert.equal(parseOverride(failed), false);
	assert.equal(parseOverride(failed.replace('anyway? n', 'anyway? y')), true);
	assert.equal(parseOverride(failed.replace('open the PR anyway? n', '')), false);
});
