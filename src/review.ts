import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffArgs, head, hunkLocations, stageAll, type DiffKind } from './git.js';
import type { Thread } from './state.js';
import { popup, shellQuote } from './tmux.js';

/** Show a diff of the worktree through delta in a popup. Returns false if it's empty. */
export async function showDiff(cwd: string, kind: DiffKind, thread: Thread): Promise<boolean> {
	const args = await diffArgs(cwd, kind, thread);
	if (!args) return false;
	const title = kind === 'step' ? ' step diff ' : ` thread diff vs ${thread.base ?? 'HEAD'} `;
	await popup(`git ${args.map(shellQuote).join(' ')} | delta --paging=always`, { cwd, title });
	return true;
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

/** Accept the step: stage everything and commit, with git opening the editor for the message. */
export async function commitStep(cwd: string): Promise<'nothing' | 'committed' | 'aborted'> {
	if (!(await stageAll(cwd))) return 'nothing';
	const before = await head(cwd);
	// Keep the popup open on failure (e.g. a hook rejected it) so the error can be read.
	await popup(`git commit -v || { echo; echo 'Press Enter to close'; read -r _; }`, { cwd, title: ' accept step ' });
	return (await head(cwd)) === before ? 'aborted' : 'committed';
}
