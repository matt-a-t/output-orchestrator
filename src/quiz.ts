// A pop quiz on a thread's changes before its PR opens, to check they were read and not just approved.

import { execa } from 'execa';
import { askClaude, truncateDiff } from './claude.js';
import type { Thread } from './state.js';

/** A graded quiz as it's kept on the thread, for z to show again. */
export type QuizRecord = NonNullable<Thread['quiz']>;
import { parseAnswerReply, parseResultsReply, QUIZ_FORM, score, type QuizFormInput } from './quizForm.js';
import { CLOSED, SKIPPED, type ProgressPopup } from './tmux.js';

export { score };

export type ChoiceQuestion = { kind: 'choice'; question: string; choices: string[]; answer: number; why: string };
export type TextQuestion = { kind: 'text'; question: string; answer: string };
export type Quiz = [ChoiceQuestion, ChoiceQuestion, TextQuestion];
/** Per question: the index of the one choice ticked (null: none, or more than one), or the written answer. */
export type Answers = (number | null | string)[];
export type Grade = { correct: boolean; note: string };

/** Changes smaller than this (lines added and removed) skip the quiz. */
export const QUIZ_MIN_LINES = 30;

/** Have claude write a quiz on the thread's changes since `base`. undefined if it fails or replies with something else. */
export async function draftQuiz(cwd: string, thread: Thread, base: string, signal?: AbortSignal): Promise<Quiz | undefined> {
	const git = async (args: string[]) => (await execa('git', ['-C', cwd, ...args])).stdout;
	const log = await git(['log', '--reverse', '--format=commit %h%n%B', `${base}..HEAD`]);
	const diff = truncateDiff(await git(['diff', `${base}...HEAD`]));
	const prompt = [
		'Write a short pop quiz for the developer about to open a pull request of the changes below, to check',
		'they read the diff rather than skimmed it. Ask about behaviour and decisions in the change: what happens',
		'when something fails or is missing, why something is done the way it is, what a caller now has to do.',
		'Never ask trivia like file names, function names or line counts. Every question must be answerable from',
		'the diff alone. Wrong choices should be plausible to someone who skimmed.',
		'',
		'Reply with only this JSON, two multiple-choice questions and one to answer in a sentence or two:',
		'{"choices": [{"question": "…", "right": "…", "wrong": ["…", "…", "…"], "why": "one sentence"}, …],',
		' "written": {"question": "…", "answer": "the answer you would accept, in a sentence or two"}}',
		'',
		`Thread title: ${thread.title}`,
		'',
		'Commits:',
		log,
		'',
		'Diff:',
		diff,
	].join('\n');
	const reply = await askClaude(cwd, prompt, signal);
	return reply === undefined ? undefined : parseQuiz(reply);
}

/** draftQuiz's reply as a Quiz, each question's choices shuffled. undefined unless it's two choice questions and a written one. */
export function parseQuiz(reply: string, random = Math.random): Quiz | undefined {
	let json: any;
	try {
		// In case it says something before or after.
		json = JSON.parse(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1));
	} catch {
		return;
	}
	const text = (s: unknown) => (typeof s === 'string' && s.trim() ? s.replace(/\s+/g, ' ').trim() : undefined);
	const choice = (q: any): ChoiceQuestion | undefined => {
		const question = text(q?.question);
		const right = text(q?.right);
		const wrong = Array.isArray(q?.wrong) ? q.wrong.map(text) : [];
		if (!question || !right || wrong.length < 2 || wrong.some((w: unknown) => !w)) return;
		// claude tends to put the right one first.
		const choices: string[] = [right, ...wrong];
		for (let i = choices.length - 1; i > 0; i--) {
			const j = Math.floor(random() * (i + 1));
			[choices[i], choices[j]] = [choices[j]!, choices[i]!];
		}
		return { kind: 'choice', question, choices, answer: choices.indexOf(right), why: text(q.why) ?? '' };
	};
	const [first, second] = Array.isArray(json?.choices) && json.choices.length === 2 ? json.choices.map(choice) : [];
	const question = text(json?.written?.question);
	const answer = text(json?.written?.answer);
	if (!first || !second || !question || !answer) return;
	return [first, second, { kind: 'text', question, answer }];
}

/** Have claude grade a written answer against the quiz's. undefined if it fails or doesn't say PASS or FAIL. */
export async function gradeAnswer(cwd: string, question: TextQuestion, answer: string, signal?: AbortSignal): Promise<Grade | undefined> {
	const prompt = [
		"Grade a developer's answer to a quiz question about a code change they're about to open a pull request for.",
		'Be lenient about wording and detail: pass it if it has the right idea, fail it if it is wrong, vague or',
		'misses the point of the reference answer.',
		'Reply with PASS or FAIL on the first line, then one sentence on what they got right or missed. No preamble.',
		'',
		`Question: ${question.question}`,
		`Reference answer: ${question.answer}`,
		`Their answer: ${answer}`,
	].join('\n');
	const reply = await askClaude(cwd, prompt, signal);
	return reply === undefined ? undefined : parseGrade(reply);
}

export function parseGrade(reply: string): Grade | undefined {
	const [first, ...rest] = reply.trim().split('\n');
	const verdict = first?.match(/^\W*(PASS|FAIL)\b\W*(.*)$/i);
	if (!verdict) return;
	return { correct: verdict[1]!.toUpperCase() === 'PASS', note: [verdict[2], ...rest].join(' ').replace(/\s+/g, ' ').trim() };
}

/** Grades for the choice questions; the written one is graded by claude (see gradeAnswer). */
export function gradeChoices(quiz: Quiz, answers: Answers): Grade[] {
	return quiz.flatMap((q, i) => (q.kind === 'choice' ? [{ correct: answers[i] === q.answer, note: q.why }] : []));
}

export type QuizOutcome =
	// record is left out only by tests of how it's reported.
	| { result: 'passed' | 'overridden' | 'failed'; score: string; record?: QuizRecord }
	// You skipped it, the change was too small to bother, or claude couldn't write one.
	| { result: 'skipped'; reason: 'you' | 'claude' } | { result: 'skipped'; reason: 'small'; lines: number };

/** Lines added plus removed, from `git diff --shortstat`. */
export function shortstatLines(stat: string): number {
	const count = (word: string) => Number(stat.match(new RegExp(`(\\d+) ${word}`))?.[1] ?? 0);
	return count('insertion') + count('deletion');
}

/**
 * In `progress`, have claude write a quiz on the thread's changes since `base`, take your answers in the quiz
 * form, grade them and show how you did. null if cancelled; skipped if you skipped it, the change is under
 * QUIZ_MIN_LINES or claude couldn't write one.
 */
export async function popQuiz(progress: ProgressPopup, cwd: string, thread: Thread, base: string): Promise<QuizOutcome | null> {
	const lines = shortstatLines((await execa('git', ['-C', cwd, 'diff', '--shortstat', `${base}...HEAD`])).stdout);
	if (lines < QUIZ_MIN_LINES) return { result: 'skipped', reason: 'small', lines };
	const quiz = await progress.cancellable('claude is writing your pop quiz', signal => draftQuiz(cwd, thread, base, signal), { accept: false, skip: 'skip the quiz' });
	if (quiz === CLOSED) return null;
	if (quiz === SKIPPED) return { result: 'skipped', reason: 'you' };
	if (!quiz) return { result: 'skipped', reason: 'claude' };
	const title = `#${thread.id} ${thread.title}`;
	const form = (input: QuizFormInput) => progress.edit(JSON.stringify(input), QUIZ_FORM);
	const answered = await form({ mode: 'answer', title, quiz });
	if (answered === CLOSED) return null;
	const reply = parseAnswerReply(answered, quiz);
	if (reply === 'skipped') return { result: 'skipped', reason: 'you' };
	if (!reply) return null;
	const { answers } = reply;
	const written = (answers[2] as string).trim();
	const graded = written
		? await progress.cancellable('claude is grading your answer', signal => gradeAnswer(cwd, quiz[2], written, signal), { accept: false })
		: { correct: false, note: '' };
	if (graded === CLOSED) return null;
	// Not held against you when claude can't grade it.
	const grades = [...gradeChoices(quiz, answers), graded ?? { correct: true, note: "claude couldn't grade this one; check it against the answer." }];
	const results = await form({ mode: 'results', title, quiz, answers, grades });
	if (results === CLOSED) return null;
	const passed = grades.every(g => g.correct);
	const open = parseResultsReply(results);
	// Cancelling a quiz you passed cancels the PR, as q does anywhere else in the popup.
	if (passed && !open) return null;
	const result = passed ? 'passed' : open ? 'overridden' : 'failed';
	const record: QuizRecord = { questions: quiz, answers, grades, result, score: score(grades), at: new Date().toISOString() };
	return { result, score: record.score, record };
}
