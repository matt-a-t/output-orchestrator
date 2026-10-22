import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { popup, shellQuote } from './tmux.js';

const EDITOR = process.env.VISUAL || process.env.EDITOR || 'vim';

/** Edit `text` in $EDITOR in a popup; returns its lines minus those starting with `# `. */
async function editLines(text: string, title: string): Promise<string[]> {
	const dir = mkdtempSync(join(tmpdir(), 'oo-'));
	const file = join(dir, 'edit.md');
	writeFileSync(file, text);
	try {
		await popup(`${EDITOR} ${shellQuote(file)}`, { title });
		return readFileSync(file, 'utf8')
			.split('\n')
			.filter(l => !l.startsWith('# '));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Edit a thread's plan in $EDITOR. */
export async function editPlan(plan: string, thread: string): Promise<string> {
	const lines = await editLines([plan, '', `# The plan for ${thread}. Lines starting with "# " are ignored.`, ''].join('\n'), ' plan ');
	return lines.join('\n').trim();
}

export type PrDraft = { title: string; body: string };

/** Edit a PR's title (first line) and body (the rest). Returns null if the title is left empty. */
export async function editPr(draft: PrDraft, branch: string): Promise<PrDraft | null> {
	const lines = await editLines(
		[
			draft.title,
			'',
			draft.body,
			'',
			`# Line 1: PR title. Everything after: body. The branch ${branch} is pushed on save.`,
			'# Leave the title empty to cancel.',
			'',
		].join('\n'),
		' pull request ',
	);
	const title = lines.shift()?.trim() ?? '';
	if (!title) return null;
	return { title, body: lines.join('\n').trim() };
}
