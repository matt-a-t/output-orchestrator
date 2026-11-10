// A pop quiz on a thread's changes before its PR opens, to check they were read and not just approved.

import { execa } from 'execa';
import { askClaude, truncateDiff } from './claude.js';
import type { Thread } from './state.js';
import { CLOSED, type ProgressPopup } from './tmux.js';

export type ChoiceQuestion = { kind: 'choice'; question: string; choices: string[]; answer: number; why: string };
export type TextQuestion = { kind: 'text'; question: string; answer: string };
export type Quiz = [ChoiceQuestion, ChoiceQuestion, TextQuestion];
/** Per question: the index of the one choice ticked (null: none, or more than one), or the written answer. */
export type Answers = (number | null | string)[];
export type Grade = { correct: boolean; note: string };

const OVERRIDE = 'open the PR anyway?';

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

/** The quiz to answer in the editor: an x in one box per choice question, and the written answer under the last. */
export function quizText(quiz: Quiz, thread: Thread): string {
	const lines = [
		`# Pop quiz on #${thread.id} ${thread.title}, before its PR opens.`,
		'# Put an x in the box of one answer to each of 1 and 2, and write your answer to 3 under it.',
		'# Lines starting "# " are ignored. Save and quit when you\'re done; q in the popup cancels the PR.',
		'',
	];
	quiz.forEach((q, i) => {
		lines.push(`${i + 1}. ${q.question}`);
		if (q.kind === 'choice') lines.push(...q.choices.map(c => `   [ ] ${c}`));
		lines.push('');
	});
	return lines.join('\n');
}

/** Read back quizText once answered. */
export function parseAnswers(text: string, quiz: Quiz): Answers {
	const lines = text.split('\n').filter(l => !l.startsWith('# '));
	// Each question's lines run from its number to the next one's; the last one's to the end.
	const starts: number[] = [];
	for (let i = 0, from = 0; i < quiz.length; i++) {
		const at = lines.findIndex((l, n) => n >= from && l.startsWith(`${i + 1}. `));
		starts.push(at);
		if (at !== -1) from = at + 1;
	}
	return quiz.map((q, i) => {
		const start = starts[i]!;
		if (start === -1) return q.kind === 'choice' ? null : '';
		const end = starts.slice(i + 1).find(s => s !== -1) ?? lines.length;
		const section = lines.slice(start + 1, end);
		if (q.kind === 'text') return section.join('\n').trim();
		const boxes = section.filter(l => /^\s*\[.?\]/.test(l));
		const ticked = boxes.flatMap((l, n) => (/^\s*\[\s?\]/.test(l) ? [] : [n]));
		return ticked.length === 1 ? ticked[0]! : null;
	});
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

export const score = (grades: Grade[]) => `${grades.filter(g => g.correct).length}/${grades.length}`;

/** What you got right and wrong, and (if anything's wrong) the line that opens the PR anyway. */
export function resultsText(quiz: Quiz, answers: Answers, grades: Grade[]): string {
	const passed = grades.every(g => g.correct);
	const lines = [
		`# Pop quiz: ${score(grades)}.`,
		passed ? '# Save and quit to go on to the PR description.' : `# Change the n below to y to open the PR anyway; anything else cancels it.`,
		'',
		...(passed ? [] : [`${OVERRIDE} n`, '']),
	];
	quiz.forEach((q, i) => {
		const grade = grades[i]!;
		const answer = answers[i];
		lines.push(`${i + 1}. ${grade.correct ? '✓' : '✗'} ${q.question}`);
		if (q.kind === 'choice') {
			lines.push(`   you: ${typeof answer === 'number' ? q.choices[answer] : '(no answer)'}`);
			if (!grade.correct) lines.push(`   answer: ${q.choices[q.answer]}`);
		} else {
			lines.push(`   you: ${typeof answer === 'string' && answer ? answer.replace(/\s+/g, ' ') : '(no answer)'}`);
			lines.push(`   answer: ${q.answer}`);
		}
		if (grade.note) lines.push(`   ${grade.note}`);
		lines.push('');
	});
	return lines.join('\n');
}

/** Whether resultsText was changed to open the PR anyway. */
export function parseOverride(text: string): boolean {
	const line = text.split('\n').find(l => l.startsWith(OVERRIDE));
	return line?.slice(OVERRIDE.length).trim().toLowerCase() === 'y';
}

export type QuizOutcome = { result: 'passed' | 'overridden' | 'failed'; score: string } | { result: 'skipped' };

/**
 * In `progress`, have claude write a quiz on the thread's changes since `base`, take your answers in the
 * editor, grade them and show how you did. null if cancelled; skipped if claude couldn't write one.
 */
export async function popQuiz(progress: ProgressPopup, cwd: string, thread: Thread, base: string): Promise<QuizOutcome | null> {
	const quiz = await progress.cancellable('claude is writing your pop quiz', signal => draftQuiz(cwd, thread, base, signal), { accept: false });
	if (quiz === CLOSED) return null;
	if (!quiz) return { result: 'skipped' };
	const answered = await progress.edit(quizText(quiz, thread));
	if (answered === CLOSED) return null;
	const answers = parseAnswers(answered, quiz);
	const written = answers[2] as string;
	const graded = written
		? await progress.cancellable('claude is grading your answer', signal => gradeAnswer(cwd, quiz[2], written, signal), { accept: false })
		: { correct: false, note: '' };
	if (graded === CLOSED) return null;
	// Not held against you when claude can't grade it.
	const grades = [...gradeChoices(quiz, answers), graded ?? { correct: true, note: "claude couldn't grade this one; check it against the answer." }];
	const results = await progress.edit(resultsText(quiz, answers, grades));
	if (results === CLOSED) return null;
	const result = grades.every(g => g.correct) ? 'passed' : parseOverride(results) ? 'overridden' : 'failed';
	return { result, score: score(grades) };
}
