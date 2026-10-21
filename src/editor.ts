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

export type ThreadDraft = { project: string; title: string; plan: string };

/**
 * Edit a thread in $EDITOR. Format:
 *   project: <name>
 *   <title line>
 *   <blank>
 *   <plan...>
 * Lines starting with `# ` are ignored. Returns null if the title is left empty.
 */
export async function editThread(draft: ThreadDraft, projectNames: string[], note?: string): Promise<ThreadDraft | null> {
	const lines = await editLines(
		[
			`project: ${draft.project}`,
			draft.title,
			'',
			draft.plan,
			'',
			'# Line 1: project. Line 2: title. Everything after: plan.',
			`# Projects: ${projectNames.join(', ')}`,
			...(note ? [`# ${note}`] : []),
			'# Leave the title empty to cancel.',
			'',
		].join('\n'),
		' thread ',
	);
	const project = lines.shift()?.replace(/^project:\s*/, '').trim() ?? '';
	const title = lines.shift()?.trim() ?? '';
	if (!title) return null;
	const plan = lines.join('\n').trim();
	return { project, title, plan };
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
