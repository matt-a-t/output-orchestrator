import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { popup, shellQuote } from './tmux.js';

const EDITOR = process.env.VISUAL || process.env.EDITOR || 'vim';

export type ThreadDraft = { project: string; title: string; plan: string };

/**
 * Edit a thread in $EDITOR. Format:
 *   project: <name>
 *   <title line>
 *   <blank>
 *   <plan...>
 * Lines starting with `# ` are ignored. Returns null if the title is left empty.
 */
export async function editThread(draft: ThreadDraft, projectNames: string[]): Promise<ThreadDraft | null> {
	const dir = mkdtempSync(join(tmpdir(), 'oo-'));
	const file = join(dir, 'thread.md');
	writeFileSync(
		file,
		[
			`project: ${draft.project}`,
			draft.title,
			'',
			draft.plan,
			'',
			'# Line 1: project. Line 2: title. Everything after: plan.',
			`# Projects: ${projectNames.join(', ')}`,
			'# Leave the title empty to cancel.',
			'',
		].join('\n'),
	);
	try {
		await popup(`${EDITOR} ${shellQuote(file)}`, { title: ' thread ' });
		const lines = readFileSync(file, 'utf8')
			.split('\n')
			.filter(l => !l.startsWith('# '));
		const project = lines.shift()?.replace(/^project:\s*/, '').trim() ?? '';
		const title = lines.shift()?.trim() ?? '';
		if (!title) return null;
		const plan = lines.join('\n').trim();
		return { project, title, plan };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
