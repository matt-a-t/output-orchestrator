// The diff viewer's (viewer.tsx) workings that don't need a terminal: splitting a diff into files,
// finding hunks and search matches in delta's output, and the context steps.

import { sanitize } from './sanitize.js';

/** One file's part of a unified diff. `oldPath` differs from `path` only for renames. */
export type FilePatch = {
	path: string;
	oldPath: string;
	status: 'modified' | 'added' | 'deleted' | 'renamed';
	binary: boolean;
	added: number;
	removed: number;
	text: string;
};

/** A path from a diff header, unquoted if git quoted it, without the a/ or b/ and the tab git adds after paths with spaces. */
function headerPath(raw: string): string {
	let path = raw.replace(/\t$/, '');
	if (path.startsWith('"') && path.endsWith('"')) {
		try {
			path = JSON.parse(path) as string;
		} catch {
			path = path.slice(1, -1);
		}
	}
	return path.replace(/^[ab]\//, '');
}

/** Split a unified diff (`git diff`, a PR's patch) into its files, with how many lines each adds and removes. */
export function splitPatch(diff: string): FilePatch[] {
	const files: FilePatch[] = [];
	let file: FilePatch | undefined;
	let lines: string[] = [];
	let inHunk = false;
	const finish = () => {
		if (file) files.push({ ...file, text: lines.join('\n') + '\n' });
	};
	for (const line of diff.split('\n')) {
		if (line.startsWith('diff --git ')) {
			finish();
			// Until the --- / +++ or rename lines say otherwise (a mode-only change has neither).
			const path = headerPath(/ (?:"b\/.*"|b\/.*)$/.exec(line)?.[0].slice(1) ?? '');
			file = { path, oldPath: path, status: 'modified', binary: false, added: 0, removed: 0, text: '' };
			lines = [line];
			inHunk = false;
			continue;
		}
		if (!file) continue;
		lines.push(line);
		if (line.startsWith('@@')) inHunk = true;
		else if (inHunk && line.startsWith('+')) file.added++;
		else if (inHunk && line.startsWith('-')) file.removed++;
		else if (inHunk) continue;
		else if (line.startsWith('new file mode')) file.status = 'added';
		else if (line.startsWith('deleted file mode')) file.status = 'deleted';
		else if (line.startsWith('rename from ')) [file.status, file.oldPath] = ['renamed', headerPath(line.slice('rename from '.length))];
		else if (line.startsWith('rename to ')) file.path = headerPath(line.slice('rename to '.length));
		else if (line.startsWith('Binary files ')) file.binary = true;
		else if (line.startsWith('--- ') && line !== '--- /dev/null') file.oldPath = headerPath(line.slice(4));
		else if (line.startsWith('+++ ') && line !== '+++ /dev/null') file.path = headerPath(line.slice(4));
	}
	// The last line of a diff ends in a newline, which split leaves as an empty line.
	if (lines.at(-1) === '') lines.pop();
	finish();
	return files;
}

/** How a file shows in the stat tab: what happened to it and its path (`old → new` for renames). */
export function fileLabel(file: FilePatch): string {
	return file.status === 'renamed' ? `${file.oldPath} → ${file.path}` : file.path;
}

/** Lines of context to show around changes, from least to most; the last one shows the whole file. */
export const CONTEXT_STEPS = [3, 10, 25, 99_999] as const;

/** The context step after `context` in direction `dir` (1 more, -1 less), staying within the steps. */
export function stepContext(context: number, dir: 1 | -1): number {
	const at = CONTEXT_STEPS.findIndex(step => step >= context);
	const index = Math.min(CONTEXT_STEPS.length - 1, Math.max(0, (at === -1 ? CONTEXT_STEPS.length - 1 : at) + dir));
	return CONTEXT_STEPS[index]!;
}

export function contextLabel(context: number): string {
	return context >= CONTEXT_STEPS.at(-1)! ? 'whole file' : `${context} lines of context`;
}

// What delta's --navigate labels hunks with (delta.ts warns when your config changes it).
const HUNK_LABEL = /^•/;

/** Lines of delta's output as plain text, for finding things in. */
export function plainLines(lines: string[]): string[] {
	return lines.map(sanitize);
}

/** The rows of delta's output (as plain text) that start a hunk. */
export function hunkRows(plain: string[]): number[] {
	return plain.flatMap((line, row) => (HUNK_LABEL.test(line) ? [row] : []));
}

/** The first row in `rows` after `top` (dir 1), or the last before it (dir -1); undefined if there's none. */
export function nextRow(rows: number[], top: number, dir: 1 | -1): number | undefined {
	return dir === 1 ? rows.find(row => row > top) : rows.findLast(row => row < top);
}

/** Where a search matched: the file's index and the row in its delta output. */
export type Match = { file: number; row: number };

/** Every row of every file (as plain lines) containing `query`, ignoring case, in order. */
export function findMatches(files: string[][], query: string): Match[] {
	const needle = query.toLowerCase();
	if (!needle) return [];
	return files.flatMap((lines, file) => lines.flatMap((line, row) => (line.toLowerCase().includes(needle) ? [{ file, row }] : [])));
}

/** The match after (dir 1) or before (dir -1) row `row` of file `file`, wrapping around; undefined if there are none. */
export function nextMatch(matches: Match[], file: number, row: number, dir: 1 | -1): Match | undefined {
	const after = (m: Match) => m.file > file || (m.file === file && m.row > row);
	const before = (m: Match) => m.file < file || (m.file === file && m.row < row);
	return dir === 1 ? (matches.find(after) ?? matches[0]) : (matches.findLast(before) ?? matches.at(-1));
}

/** A scroll position that keeps the last screenful full and doesn't go above the top. */
export function clampScroll(top: number, total: number, height: number): number {
	return Math.max(0, Math.min(top, total - height));
}
