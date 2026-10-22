import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { askClaude, truncateDiff } from './claude.js';
import { diffArgs, hunkLocations, type DiffKind } from './git.js';
import type { Thread } from './state.js';
import { confirmPopup, popup, shellQuote } from './tmux.js';

// less quits with the first character of the extra string as its status: 'A' is 65.
const APPROVE_KEYS = '#command\na quit A\n';
const APPROVE_STATUS = 65;
// What delta's --navigate labels files and hunks with.
const NAVIGATE_PATTERN = '^(Δ|•|added:|removed:|renamed:)';

/**
 * Show a diff of the worktree in a popup, with n/N jumping between files and hunks. Step diffs
 * can be approved from there with `a` (and a confirm). delta's paging would swallow less's exit
 * status, so it's piped into less here instead.
 */
export async function showDiff(cwd: string, kind: DiffKind, thread: Thread): Promise<'empty' | 'closed' | 'approved'> {
	const args = await diffArgs(cwd, kind, thread);
	if (!args) return 'empty';
	const approvable = kind === 'step';
	const less = ['less', '-R', `--pattern=${NAVIGATE_PATTERN}`];
	if (approvable) {
		const keys = join(tmpdir(), 'oo-approve.lesskey');
		writeFileSync(keys, APPROVE_KEYS);
		less.push(`--lesskey-src=${keys}`);
	}
	const label = kind === 'step' ? 'step diff' : `thread diff vs ${args.at(-1)}`;
	const title = ` ${label} — n/N next/prev hunk  ${approvable ? 'a approve  ' : ''}q close `;
	const command = `git ${args.map(shellQuote).join(' ')} | delta --paging=never --navigate | ${less.map(shellQuote).join(' ')}`;
	for (;;) {
		if ((await popup(command, { cwd, title })) !== APPROVE_STATUS) return 'closed';
		// Anything but y goes back to the diff.
		if (await confirmPopup(`Approve #${thread.id}'s step?`)) return 'approved';
	}
}

/**
 * Open vim on the changed hunks, as a quickfix list (`:cn`/`:cp` to move, `:copen` to list):
 * the step's changes, or the whole thread's if the step has none. Returns false if there are none.
 */
export async function openChanges(cwd: string, thread: Thread): Promise<boolean> {
	const args = (await diffArgs(cwd, 'step', thread)) ?? (await diffArgs(cwd, 'thread', thread));
	const locations = args ? await hunkLocations(cwd, args) : [];
	if (locations.length === 0) return false;
	const dir = mkdtempSync(join(tmpdir(), 'oo-'));
	const file = join(dir, 'changes.qf');
	writeFileSync(file, locations.join('\n') + '\n');
	try {
		await popup(`vim -q ${shellQuote(file)}`, { cwd, title: ' changes — :cn/:cp next/prev  :copen list ' });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	return true;
}

const COMMENT = '>>';

/**
 * Open the diff (the step's, else the thread's) in vim for review. Lines starting `>>` under a
 * diff line are notes on it; consecutive ones join into one note. Returns the notes formatted as
 * feedback for Claude, null if there's no diff, or '' if nothing was written (or vim quit with :cq).
 */
export async function reviewDiff(cwd: string, thread: Thread): Promise<string | null> {
	const args = (await diffArgs(cwd, 'step', thread)) ?? (await diffArgs(cwd, 'thread', thread));
	if (!args) return null;
	const { stdout } = await execa('git', ['-C', cwd, args[0]!, '--no-color', '--no-ext-diff', ...args.slice(1)]);
	const dir = mkdtempSync(join(tmpdir(), 'oo-'));
	const file = join(dir, 'review.diff');
	writeFileSync(
		file,
		[
			`# Add notes on lines starting ${COMMENT} under the diff line they're about.`,
			'# They are sent to Claude when you save and quit; :cq cancels.',
			'',
			stdout,
			'',
		].join('\n'),
	);
	try {
		// :cq deletes the file, which means cancel.
		await popup(`vim ${shellQuote(file)} || rm -f ${shellQuote(file)}`, { cwd, title: ` review — ${COMMENT} note ` });
		if (!existsSync(file)) return '';
		return formatComments(parseComments(readFileSync(file, 'utf8')));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

type Comment = { location: string; note: string };

/** Pull `>>` notes out of an annotated unified diff, each pinned to the diff line above it. */
export function parseComments(text: string): Comment[] {
	const comments: Comment[] = [];
	let file: string | undefined;
	let oldLine = 0;
	let newLine = 0;
	let inHunk = false;
	let location: string | undefined; // where a note written here would point
	let last: Comment | undefined; // the note being continued by consecutive `>>` lines
	for (const line of text.split('\n')) {
		if (line.startsWith(COMMENT)) {
			const note = line.slice(COMMENT.length).trim();
			if (!note) continue;
			if (last) last.note += `\n${note}`;
			else comments.push((last = { location: location ?? 'general', note }));
			continue;
		}
		last = undefined;
		if (line.startsWith('diff --git ')) {
			inHunk = false;
			// Until `+++` says otherwise (e.g. a mode-only change has no `+++`).
			file = / b\/(.*)$/.exec(line)?.[1];
			location = file;
		} else if (!inHunk && line.startsWith('--- ')) {
			// The old path; only matters for deleted files, which have `+++ /dev/null`.
			if (line !== '--- /dev/null') file = line.slice('--- a/'.length);
		} else if (!inHunk && line.startsWith('+++ ')) {
			if (line !== '+++ /dev/null') file = line.slice('+++ b/'.length);
			location = file;
		} else if (line.startsWith('@@')) {
			const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
			if (!m) continue;
			inHunk = true;
			oldLine = Number(m[1]);
			newLine = Number(m[2]);
			location = `${file}:${Math.max(1, newLine)}`;
		} else if (inHunk && line.startsWith('-')) {
			location = `${file}:${Math.max(1, newLine)} (removed line ${oldLine}: \`${line.slice(1).trim()}\`)`;
			oldLine++;
		} else if (inHunk && line.startsWith('+')) {
			location = `${file}:${newLine}`;
			newLine++;
		} else if (inHunk && line.startsWith(' ')) {
			location = `${file}:${newLine}`;
			oldLine++;
			newLine++;
		}
	}
	return comments;
}

function formatComments(comments: Comment[]): string {
	if (comments.length === 0) return '';
	const items = comments.map(c => `- ${c.location} — ${c.note.replaceAll('\n', '\n  ')}`);
	return ['Review comments on your changes:', '', ...items].join('\n');
}

/**
 * Have claude draft a commit message for the staged changes, in the style of the branch's recent
 * commits. Returns undefined if claude fails or says nothing.
 */
export async function draftCommit(cwd: string, thread: Thread): Promise<string | undefined> {
	const git = async (args: string[]) => (await execa('git', ['-C', cwd, ...args])).stdout;
	const log = await git(['log', '-5', '--format=%B---']).catch(() => '');
	const stat = await git(['diff', '--cached', '--stat']);
	const diff = truncateDiff(await git(['diff', '--cached']));
	const prompt = [
		'Write a git commit message for the staged changes below.',
		'Reply with only the message: a short imperative subject line, a blank line, then a body',
		'saying what changed and why, unless the change is trivial. Match the style of the recent',
		'commits. No preamble and no trailers.',
		'',
		`Thread title: ${thread.title}`,
		thread.plan ? `Thread plan:\n${thread.plan}` : '',
		'',
		'Recent commits (each ends with ---):',
		log,
		'',
		'Diff stat:',
		stat,
		'',
		'Diff:',
		diff,
	].join('\n');
	return (await askClaude(cwd, prompt)) || undefined;
}
