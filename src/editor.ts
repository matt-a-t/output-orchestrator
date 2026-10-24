import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMMIT_FORM, commitFormText, parseCommitForm, type CommitForm } from './commitForm.js';
import { popup, shellQuote } from './tmux.js';

export const EDITOR = process.env.VISUAL || process.env.EDITOR || 'vim';

/** The lines of `text` minus those starting with `# `, which are notes for whoever's editing it. */
function uncommented(text: string): string[] {
	return text.split('\n').filter(l => !l.startsWith('# '));
}

/** Run `editor` on a file holding `text` in a popup; returns what the file holds once it exits. */
async function editInPopup(text: string, editor: string, title: string): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), 'oo-'));
	const file = join(dir, 'edit.md');
	writeFileSync(file, text);
	try {
		await popup(`${editor} ${shellQuote(file)}`, { title });
		return readFileSync(file, 'utf8');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Edit `text` in $EDITOR in a popup; returns its lines minus those starting with `# `. */
async function editLines(text: string, title: string): Promise<string[]> {
	return uncommented(await editInPopup(text, EDITOR, title));
}

/** Edit a thread's plan in $EDITOR. */
export async function editPlan(plan: string, thread: string): Promise<string> {
	const lines = await editLines([plan, '', `# The plan for ${thread}. Lines starting with "# " are ignored.`, ''].join('\n'), ' plan ');
	return lines.join('\n').trim();
}

/** Edit a drafted commit message and comments for claude in the commit form; null if cancelled. */
export async function editCommitForm(draft: string, note?: string): Promise<CommitForm | null> {
	return parseCommitForm(await editInPopup(commitFormText(draft, note), COMMIT_FORM, ' commit '));
}

export type PrDraft = { title: string; body: string };

/** The text to edit for a PR: its title (first line), its body (the rest), and `# ` notes such as `note`. */
export function prText(draft: PrDraft, branch: string, note?: string): string {
	return [
		draft.title,
		'',
		draft.body,
		'',
		...(note ? [`# ${note}`] : []),
		`# Line 1: PR title. Everything after: body. The branch ${branch} is pushed on save.`,
		'# Leave the title empty to cancel.',
		'',
	].join('\n');
}

/** Read back prText once edited. Returns null if the title is left empty. */
export function parsePr(text: string): PrDraft | null {
	const lines = uncommented(text);
	const title = lines.shift()?.trim() ?? '';
	if (!title) return null;
	return { title, body: lines.join('\n').trim() };
}
