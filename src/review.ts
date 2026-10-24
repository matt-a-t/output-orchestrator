import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { askClaude, truncateDiff } from './claude.js';
import { diffArgs, diffRevs, hunkLocations, type DiffKind } from './git.js';
import { checksLabel, mergeLabel, openPrInBrowser, prDetails, prDiff, type PrDetails } from './github.js';
import type { Thread } from './state.js';
import { OO_COMMAND } from './status.js';
import { commitFormText, parseCommitForm, type CommitForm } from './commitForm.js';
import { CLOSED, confirmPopup, popup, shellQuote, type ProgressPopup } from './tmux.js';

// less quits with the first character of the extra string as its status: 'A' is 65, and S ('S' is
// 83) sets up delta's styles (`oo delta`) and comes back to the diff.
const DIFF_KEYS = '#command\nS quit S\n';
const APPROVE_KEYS = `${DIFF_KEYS}a quit A\n`;
const APPROVE_STATUS = 65;
const DELTA_STATUS = 83;
// The same trick gives the diff beside claude r to refresh it ('R' is 82), t to switch between the
// step and thread diffs ('T' is 84) and a to commit.
const PANE_KEYS = `${APPROVE_KEYS}r quit R\nt quit T\n`;
const REFRESH_STATUS = 82;
const TOGGLE_STATUS = 84;
// The PR viewer's m merges ('M' is 77) and o opens the browser ('O' is 79); b and w stay less's page back.
const PR_KEYS = `${DIFF_KEYS}m quit M\no quit O\n`;
const MERGE_STATUS = 77;
const BROWSER_STATUS = 79;
// `oo delta`, then a pause so its answer stays up until you're back in the diff.
const OO_DELTA = `${[...OO_COMMAND, 'delta'].map(shellQuote).join(' ')}; read -rsn1 -p ${shellQuote('Any key goes back to the diff')}`;
// What delta's --navigate labels files and hunks with (delta.ts warns when your config changes them).
const NAVIGATE_PATTERN = '^(Δ|•|added:|removed:|renamed:).*';

/**
 * Show a diff of the worktree in a popup, with n/N jumping between files and hunks. Step diffs
 * can be approved from there with `a`, and `S` sets up delta's styles. delta's paging would swallow less's exit
 * status, so it's piped into less here instead.
 */
export async function showDiff(cwd: string, kind: DiffKind, thread: Thread): Promise<'empty' | 'closed' | 'approved'> {
	const args = await diffArgs(cwd, kind, thread);
	if (!args) return 'empty';
	const approvable = kind === 'step';
	const label = kind === 'step' ? 'step diff' : `thread diff vs ${args.at(-1)}`;
	const title = ` ${label} — n/N next/prev hunk  ${approvable ? 'a approve  ' : ''}S styling  q close `;
	const command = `${statThenDiff(gitCommand(args))} | ${lessCommand(approvable ? lesskey('approve', APPROVE_KEYS) : lesskey('diff', DIFF_KEYS))}`;
	for (;;) {
		const status = await popup(command, { cwd, title });
		if (status !== DELTA_STATUS) return status === APPROVE_STATUS ? 'approved' : 'closed';
		// Back to the diff, restyled if you added them.
		await popup(`bash -c ${shellQuote(OO_DELTA)}`, { cwd, title: ' delta styling ' });
	}
}

/**
 * Show a PR as GitHub has it: its title, state, checks, reviews and description, then its diff, with
 * n/N jumping between files and hunks like `showDiff`. `m` merges (after a confirm), `o` opens it in
 * the browser and `S` sets up delta's styles.
 */
export async function showPr(cwd: string, number: number): Promise<'closed' | 'merge'> {
	const [details, diff] = await Promise.all([prDetails(cwd, number), prDiff(cwd, number)]);
	const dir = mkdtempSync(join(tmpdir(), 'oo-'));
	const header = join(dir, 'header');
	const patch = join(dir, 'pr.diff');
	writeFileSync(header, prHeader(details));
	writeFileSync(patch, diff + '\n');
	const stat = diff ? `git apply --stat --summary ${shellQuote(patch)}; echo; delta --paging=never --navigate < ${shellQuote(patch)}` : "echo 'No changes'";
	const command = `{ cat ${shellQuote(header)}; ${stat}; } | ${lessCommand(lesskey('pr', PR_KEYS))}`;
	const title = ` PR #${number} — n/N next/prev hunk  m merge  o browser  S styling  q close `;
	try {
		for (;;) {
			const status = await popup(command, { cwd, title });
			if (status === DELTA_STATUS) {
				await popup(`bash -c ${shellQuote(OO_DELTA)}`, { cwd, title: ' delta styling ' });
				continue;
			}
			if (status === BROWSER_STATUS) {
				await openPrInBrowser(details);
				continue;
			}
			if (status !== MERGE_STATUS) return 'closed';
			// Say what's in the way, since GitHub may still let you merge past it.
			const [label] = mergeLabel(details) ?? [];
			const warning = label && label !== 'ready to merge' ? ` (${label})` : '';
			if (await confirmPopup(`Merge PR #${number}${warning}?`)) return 'merge';
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const ANSI: Record<string, string> = { red: '31', green: '32', yellow: '33', magenta: '35', bold: '1', dim: '2' };
const paint = (color: string, text: string) => `\x1b[${ANSI[color]}m${text}\x1b[0m`;

const REVIEW_WORDS: Record<string, [string, string]> = {
	APPROVED: ['approved', 'green'],
	CHANGES_REQUESTED: ['requested changes', 'red'],
	COMMENTED: ['commented', 'dim'],
	DISMISSED: ['dismissed', 'dim'],
};

/** The top of the PR viewer: who wants to merge what, where it stands, the reviews so far and the description. */
export function prHeader(pr: PrDetails): string {
	const state = pr.state === 'OPEN' ? (pr.isDraft ? ['draft', 'dim'] : undefined) : [pr.state.toLowerCase(), 'magenta'];
	const decision = REVIEW_WORDS[pr.reviewDecision] ?? (pr.reviewDecision === 'REVIEW_REQUIRED' ? ['review required', 'yellow'] : undefined);
	const status = [state, pr.state === 'OPEN' ? mergeLabel(pr) : undefined, checksLabel(pr.statusCheckRollup), decision]
		.filter((s): s is [string, string] => !!s)
		.map(([text, color]) => paint(color, text));
	// Each reviewer's latest say, skipping bare comments once they've approved or asked for changes.
	const latest = new Map<string, string>();
	for (const review of pr.reviews) {
		if (review.state === 'PENDING') continue;
		if (review.state === 'COMMENTED' && latest.has(review.author.login)) continue;
		latest.set(review.author.login, review.state);
	}
	const reviews = [...latest].map(([login, state]) => {
		const [word, color] = REVIEW_WORDS[state] ?? [state.toLowerCase(), 'dim'];
		return `${login} ${paint(color, word)}`;
	});
	return [
		paint('bold', `#${pr.number} ${pr.title}`),
		`${pr.author.login} wants to merge ${pr.headRefName} into ${pr.baseRefName}  ${paint('green', `+${pr.additions}`)} ${paint('red', `−${pr.deletions}`)}`,
		status.join(' · '),
		reviews.length ? `reviews: ${reviews.join(', ')}` : '',
		'',
		// GitHub keeps bodies written in the browser with CRLFs, which less would show as ^M.
		pr.body.replaceAll('\r', '').trim() || paint('dim', 'No description.'),
		'',
		paint('dim', '─'.repeat(40)),
		'',
	]
		.filter((line, i) => line || i > 3)
		.join('\n');
}

/**
 * A shell command for the diff beside claude: the step's, or the thread's if the step has none.
 * `t` switches between the two, `r` re-runs it to keep up with claude's edits, and `a` commits
 * everything uncommitted (`oo commit`: claude drafts the message, you edit it).
 */
export async function diffPaneCommand(cwd: string, thread: Thread): Promise<string[]> {
	const step = ['diff', ...(await diffRevs(cwd, 'step', thread))];
	const whole = ['diff', ...(await diffRevs(cwd, 'thread', thread))];
	const keys = lesskey('pane', PANE_KEYS);
	const keysHint = (other: string) => `t ${other}  a commit  r refresh  S styling  q close`;
	// The label goes in less's (short, the s) prompt so it stays in view; these characters are special there.
	const prompt = (label: string, other: string) => `--prompt=s${`${label} — n/N hunk  ${keysHint(other)}`.replace(/[?:.%\\]/g, '\\$&')}`;
	const show = (fn: string, label: string, other: string) =>
		`${statThenDiff(fn)} | ${lessCommand(keys)} ${shellQuote(prompt(label, other))}`;
	const ooCommit = [...OO_COMMAND, 'commit', thread.id].map(shellQuote).join(' ');
	const script = [
		`step() { ${gitCommand(step)} "$@"; }`,
		`thread() { ${gitCommand(whole)} "$@"; }`,
		'git add --all --intent-to-add',
		'mode=step; step --quiet && mode=thread',
		'while :; do',
		'git add --all --intent-to-add',
		`if ! $mode --quiet; then`,
		`  if [ $mode = step ]; then ${show('step', 'uncommitted', 'whole thread')}; else ${show('thread', `thread vs ${whole.at(-1)}`, 'uncommitted')}; fi`,
		'  status=$?',
		'else',
		`  clear; [ $mode = step ] && printf %s ${shellQuote(`No uncommitted changes — ${keysHint('whole thread')}`)} || printf %s ${shellQuote(`No changes in the thread — ${keysHint('uncommitted')}`)}`,
		'  read -rsn1 key; clear',
		`  case $key in t) status=${TOGGLE_STATUS};; a) status=${APPROVE_STATUS};; r) status=${REFRESH_STATUS};; S) status=${DELTA_STATUS};; *) status=0;; esac`,
		'fi',
		'case $status in',
		`  ${TOGGLE_STATUS}) [ $mode = step ] && mode=thread || mode=step;;`,
		// oo commit has its own popups.
		`  ${APPROVE_STATUS}) out=$(${ooCommit} 2>&1); [ -n "$out" ] && tmux display-message "$out";;`,
		`  ${REFRESH_STATUS}) ;;`,
		`  ${DELTA_STATUS}) clear; ${OO_DELTA}; clear;;`,
		'  *) break;;',
		'esac',
		'done',
	].join('\n');
	return ['bash', '-c', script];
}

/**
 * The diff's stat (each changed file and how much it changed, sized to the terminal), then the
 * diff through delta. The stat stays out of delta so it isn't restyled; n/N skip it.
 */
function statThenDiff(git: string): string {
	// Header styles come from the user's [delta] git config (`oo delta` sets up the README's recommended one).
	return `{ ${git} --stat="$(tput cols)" --compact-summary --color=always; echo; ${git} | delta --paging=never --navigate; }`;
}

function gitCommand(args: string[]): string {
	return `git ${args.map(shellQuote).join(' ')}`;
}

/** less over delta's output, with n/N jumping between files and hunks. */
function lessCommand(keys?: string): string {
	// --pattern also starts at the first file, past the stat; +g (only after it) goes back to the top.
	// Matches aren't highlighted (-G) so delta's header styles show through, and -j4 lands a jump on
	// the 4th row so the end of the hunk before shows above it.
	const less = [
		'less',
		'-R',
		'-G',
		'-j4',
		`--pattern=${NAVIGATE_PATTERN}`,
		'+g',
		...(keys ? [`--lesskey-src=${keys}`] : []),
	];
	return less.map(shellQuote).join(' ');
}

function lesskey(name: string, keys: string): string {
	const file = join(tmpdir(), `oo-${name}.lesskey`);
	writeFileSync(file, keys);
	return file;
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
 * Have claude draft a one-line commit message for the staged changes, in the style of the branch's
 * recent subjects. Returns undefined if claude fails or says nothing.
 */
export async function draftCommit(cwd: string, thread: Thread, signal?: AbortSignal): Promise<string | undefined> {
	const git = async (args: string[]) => (await execa('git', ['-C', cwd, ...args])).stdout;
	// Subjects only: full messages as examples make each draft longer than the last.
	const log = await git(['log', '-5', '--format=%s']).catch(() => '');
	const stat = await git(['diff', '--cached', '--stat']);
	const diff = truncateDiff(await git(['diff', '--cached']));
	const prompt = [
		'Write a one-line git commit message for the staged changes below.',
		'Reply with only the message: a short imperative subject under 60 characters, with no body,',
		'no trailing period and no preamble. Match the style of the recent commits.',
		'',
		`Thread title: ${thread.title}`,
		'',
		'Recent commits:',
		log,
		'',
		'Diff stat:',
		stat,
		'',
		'Diff:',
		diff,
	].join('\n');
	const reply = await askClaude(cwd, prompt, signal);
	// In case it writes a body anyway.
	return reply?.split('\n').find(l => l.trim())?.trim() || undefined;
}

/**
 * In `progress`, have claude draft the commit message (q cancels), then edit it in the commit form,
 * or take it as it is if a was pressed while claude wrote it. null if cancelled.
 */
export async function writeCommit(progress: ProgressPopup, cwd: string, thread: Thread): Promise<CommitForm | null> {
	const drafted = await progress.cancellable('claude is writing the commit message', signal => draftCommit(cwd, thread, signal));
	if (drafted === CLOSED) return null;
	if (drafted && progress.accepted()) return { message: drafted, notes: '' };
	const edited = await progress.edit(drafted ? commitFormText(drafted) : commitFormText('', "claude couldn't write a commit message; write one."));
	return edited === CLOSED ? null : parseCommitForm(edited);
}
