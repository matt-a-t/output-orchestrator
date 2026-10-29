import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { askClaude, truncateDiff } from './claude.js';
import { diffArgs, diffRevs, hunkLocations, type DiffKind } from './git.js';
import { checksLabel, mergeLabel, openPrInBrowser, prDetails, prDiff, viewerLogin, type PrDetails, type ReviewComment, type ReviewEvent } from './github.js';
import type { Thread } from './state.js';
import { OO_COMMAND } from './status.js';
import { commitFormText, parseCommitForm, type CommitForm } from './commitForm.js';
import { lastAssistantText } from './transcripts.js';
import { viewerShellCommand, type ViewKey } from './viewer.js';
import { clientWidth, CLOSED, confirmPopup, popup, shellQuote, type PopupOptions, type ProgressPopup } from './tmux.js';

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
// The PR viewer's o opens the browser ('O' is 79; b and w stay less's page back). On your own PR m
// merges ('M' is 77); on someone else's a approves, x requests changes ('X' is 88) and c comments ('C' is 67).
const PR_KEYS = `${DIFF_KEYS}o quit O\n`;
const OWN_PR_KEYS = `${PR_KEYS}m quit M\n`;
const REVIEW_PR_KEYS = `${PR_KEYS}a quit A\nx quit X\nc quit C\n`;
const MERGE_STATUS = 77;
const BROWSER_STATUS = 79;
const REVIEW_STATUSES: Record<number, [ReviewEvent, string]> = {
	[APPROVE_STATUS]: ['approve', 'approving'],
	88: ['request-changes', 'requesting changes on'],
	67: ['comment', 'on'],
};
// `oo delta`, then a pause so its answer stays up until you're back in the diff.
const OO_DELTA = `${[...OO_COMMAND, 'delta'].map(shellQuote).join(' ')}; read -rsn1 -p ${shellQuote('Any key goes back to the diff')}`;
// What delta's --navigate labels files and hunks with (delta.ts warns when your config changes them).
const NAVIGATE_PATTERN = '^(Δ|•|added:|removed:|renamed:).*';
// The PR viewer and the popups it opens are framed and coloured magenta so they can't be mistaken for
// the worktree's diffs: a heavy border, a banner on top, a prompt at the bottom and magenta file headers.
const PR_FRAME: PopupOptions = { border: 'heavy', borderStyle: 'fg=magenta' };
const PR_DELTA = "--file-style='bold magenta' --file-decoration-style='magenta ul ol' --hunk-header-decoration-style='magenta box'";
// vim for files holding other people's text (diffs, PRs), with modelines off so none of it can set options.
const VIM = "vim --cmd 'set nomodeline'";

/**
 * Show a diff of the worktree in the viewer (`oo view`): claude's last response, the changed files and
 * the diff a file at a time. Step diffs can be approved from there with `a`, and `S` sets up delta's
 * styles, coming back to where you were.
 */
export async function showDiff(cwd: string, kind: DiffKind, thread: Thread): Promise<'empty' | 'closed' | 'approved'> {
	const args = await diffArgs(cwd, kind, thread);
	if (!args) return 'empty';
	const approvable = kind === 'step';
	const label = kind === 'step' ? 'step diff' : `thread diff vs ${args.at(-1)}`;
	const keys: ViewKey[] = [...(approvable ? [{ key: 'a', status: APPROVE_STATUS, hint: 'approve' }] : []), { key: 'S', status: DELTA_STATUS, hint: 'styling' }];
	const response = thread.transcriptPath && lastAssistantText(thread.transcriptPath);
	const dir = mkdtempSync(join(tmpdir(), 'oo-view-'));
	const command = viewerShellCommand(dir, { cwd, args, intro: { label: 'claude', text: response || "No response from claude yet." }, keys });
	try {
		for (;;) {
			const status = await popup(command, { cwd, title: ` ${label} ` });
			if (status !== DELTA_STATUS) return status === APPROVE_STATUS ? 'approved' : 'closed';
			// Back to the diff, restyled if you added them.
			await popup(`bash -c ${shellQuote(OO_DELTA)}`, { cwd, title: ' delta styling ' });
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export type PrAction = { action: 'merge' } | { action: 'review'; event: ReviewEvent; body: string; comments: ReviewComment[] };

/**
 * Show a PR as GitHub has it: its title, state, checks, reviews and description, then its diff, with
 * n/N jumping between files and hunks like `showDiff`. `o` opens it in the browser and `S` sets up
 * delta's styles. Your own PR can be merged with `m`; someone else's approved (`a`), sent back with
 * changes requested (`x`) or commented on (`c`), the last two written in vim (see `writeReview`).
 */
export async function showPr(cwd: string, number: number): Promise<'closed' | PrAction> {
	const [details, diff, me] = await Promise.all([prDetails(cwd, number), prDiff(cwd, number), viewerLogin(cwd)]);
	const own = details.author.login === me;
	const dir = mkdtempSync(join(tmpdir(), 'oo-'));
	const header = join(dir, 'header');
	const patch = join(dir, 'pr.diff');
	// The popup is 90% of the client, less its border.
	writeFileSync(header, prHeader(details, Math.floor((await clientWidth()) * 0.9) - 2));
	writeFileSync(patch, diff + '\n');
	const stat = diff ? `git apply --stat --summary ${shellQuote(patch)}; echo; delta --paging=never --navigate ${PR_DELTA} < ${shellQuote(patch)}` : "echo 'No changes'";
	const keys = own ? lesskey('own-pr', OWN_PR_KEYS) : lesskey('review-pr', REVIEW_PR_KEYS);
	const hints = `n/N hunk  ${own ? 'm merge' : 'a approve  x request changes  c comment'}  o browser  S styling  q close`;
	const command = `{ cat ${shellQuote(header)}; ${stat}; } | ${lessCommand(keys, [lessPrompt(`PR #${number} — ${hints}`), '--use-color', '--color=PWm'])}`;
	const title = ` PR #${number} — ${hints} `;
	try {
		for (;;) {
			const status = await popup(command, { cwd, title, ...PR_FRAME });
			if (status === DELTA_STATUS) {
				await popup(`bash -c ${shellQuote(OO_DELTA)}`, { cwd, title: ' delta styling ', ...PR_FRAME });
				continue;
			}
			if (status === BROWSER_STATUS) {
				await openPrInBrowser(details);
				continue;
			}
			const review = own ? undefined : REVIEW_STATUSES[status];
			if (review) {
				const [event, verb] = review;
				// Anything but y, or an empty comment, goes back to the PR.
				if (event === 'approve') {
					if (await confirmPopup(`Approve PR #${number}?`)) return { action: 'review', event, body: '', comments: [] };
					continue;
				}
				const written = await writeReview(cwd, number, diff, event, verb);
				if (written) return { action: 'review', event, ...written };
				continue;
			}
			if (!own || status !== MERGE_STATUS) return 'closed';
			// Say what's in the way, since GitHub may still let you merge past it.
			const [label] = mergeLabel(details) ?? [];
			const warning = label && label !== 'ready to merge' ? ` (${label})` : '';
			if (await confirmPopup(`Merge PR #${number}${warning}?`)) return { action: 'merge' };
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Write a review of a PR in vim, on its diff: the main comment above the diff and `>>` notes under
 * the lines they're about, which become comments on those lines. Requesting changes needs a main
 * comment, so vim comes back with a reminder until it has one. Returns null if nothing was written
 * (or vim quit with :cq).
 */
async function writeReview(cwd: string, number: number, diff: string, event: ReviewEvent, verb: string): Promise<{ body: string; comments: ReviewComment[] } | null> {
	const dir = mkdtempSync(join(tmpdir(), 'oo-'));
	const file = join(dir, 'review.diff');
	writeFileSync(
		file,
		[
			`# Your review ${verb} PR #${number}. Write the main comment here, above the diff, and notes on`,
			`# lines starting ${COMMENT} under the diff line they're about. Save and quit to send; :cq goes back.`,
			'',
			'',
			diff,
			'',
		].join('\n'),
	);
	try {
		for (;;) {
			// :cq deletes the file, which means cancel.
			await popup(`${VIM} ${shellQuote(file)} || rm -f ${shellQuote(file)}`, { cwd, title: ` review PR #${number} — ${COMMENT} note `, ...PR_FRAME });
			if (!existsSync(file)) return null;
			const text = readFileSync(file, 'utf8');
			const review = parsePrReview(text);
			if (!review.body && review.comments.length === 0) return null;
			if (review.body || event !== 'request-changes') return review;
			writeFileSync(file, `# Requesting changes needs a main comment above the diff.\n${text}`);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Read back a review written by `writeReview`: everything above the diff (minus `# ` lines) is the
 * main comment, and `>>` notes on diff lines are comments on them. Notes GitHub can't pin to a line
 * (on a file or hunk header) are added to the main comment with where they were.
 */
export function parsePrReview(text: string): { body: string; comments: ReviewComment[] } {
	const start = text.search(/^diff --git /m);
	const top = start < 0 ? text : text.slice(0, start);
	const notes = start < 0 ? [] : parseComments(text.slice(start));
	const body = top
		.split('\n')
		.filter(l => !l.startsWith('# '))
		.join('\n')
		.trim();
	const loose = notes.filter(n => !n.target).map(n => `- \`${n.location}\`: ${n.note.replaceAll('\n', '\n  ')}`);
	return {
		body: [body, loose.join('\n')].filter(Boolean).join('\n\n'),
		comments: notes.flatMap(n => (n.target ? [{ ...n.target, body: n.note }] : [])),
	};
}

const ANSI: Record<string, string> = { red: '31', green: '32', yellow: '33', magenta: '35', bold: '1', dim: '2', banner: '1;97;45' };
const paint = (color: string, text: string) => `\x1b[${ANSI[color]}m${text}\x1b[0m`;

const REVIEW_WORDS: Record<string, [string, string]> = {
	APPROVED: ['approved', 'green'],
	CHANGES_REQUESTED: ['requested changes', 'red'],
	COMMENTED: ['commented', 'dim'],
	DISMISSED: ['dismissed', 'dim'],
};

/**
 * The top of the PR viewer: a banner `width` columns wide with its number and title, then who wants to
 * merge what, where it stands, the reviews so far and the description.
 */
export function prHeader(pr: PrDetails, width = 80): string {
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
	const banner = ` PULL REQUEST #${pr.number} · ${pr.title} `;
	return [
		paint('banner', banner.length > width ? `${banner.slice(0, width - 1)}…` : banner.padEnd(width)),
		`${pr.author.login} wants to merge ${pr.headRefName} into ${pr.baseRefName}  ${paint('green', `+${pr.additions}`)} ${paint('red', `−${pr.deletions}`)}`,
		status.join(' · '),
		reviews.length ? `reviews: ${reviews.join(', ')}` : '',
		'',
		// Sanitized by prDetails, CRLFs from the browser and escapes (OSC 8 links among them) alike.
		pr.body.trim() || paint('dim', 'No description.'),
		'',
		paint('magenta', '─'.repeat(width)),
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
	const show = (fn: string, label: string, other: string) =>
		`${statThenDiff(fn)} | ${lessCommand(keys, [lessPrompt(`${label} — n/N hunk  ${keysHint(other)}`)])}`;
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

/** less over delta's output, with n/N jumping between files and hunks, and any `extra` options. */
function lessCommand(keys?: string, extra: string[] = []): string {
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
		...extra,
	];
	return less.map(shellQuote).join(' ');
}

/** A label for less's (short, the s) prompt, so it stays in view; these characters are special there. */
function lessPrompt(label: string): string {
	return `--prompt=s${label.replace(/[?:.%\\]/g, '\\$&')}`;
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
		await popup(`${VIM} -q ${shellQuote(file)}`, { cwd, title: ' changes — :cn/:cp next/prev  :copen list ' });
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
		await popup(`${VIM} ${shellQuote(file)} || rm -f ${shellQuote(file)}`, { cwd, title: ` review — ${COMMENT} note ` });
		if (!existsSync(file)) return '';
		return formatComments(parseComments(readFileSync(file, 'utf8')));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Where a note points, as GitHub's review comments want it: LEFT is the old side of the diff, RIGHT the new. */
export type LineTarget = { path: string; line: number; side: 'LEFT' | 'RIGHT' };
// `target` is unset for notes not under a diff line: general ones, or on a file or hunk header.
type Comment = { location: string; note: string; target?: LineTarget };

/** Pull `>>` notes out of an annotated unified diff, each pinned to the diff line above it. */
export function parseComments(text: string): Comment[] {
	const comments: Comment[] = [];
	let file: string | undefined;
	let oldLine = 0;
	let newLine = 0;
	let inHunk = false;
	let location: string | undefined; // where a note written here would point
	let target: LineTarget | undefined; // the same, for GitHub
	let last: Comment | undefined; // the note being continued by consecutive `>>` lines
	for (const line of text.split('\n')) {
		if (line.startsWith(COMMENT)) {
			const note = line.slice(COMMENT.length).trim();
			if (!note) continue;
			if (last) last.note += `\n${note}`;
			else comments.push((last = { location: location ?? 'general', note, ...(target && { target }) }));
			continue;
		}
		last = undefined;
		target = undefined;
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
			target = { path: file!, line: oldLine, side: 'LEFT' };
			oldLine++;
		} else if (inHunk && line.startsWith('+')) {
			location = `${file}:${newLine}`;
			target = { path: file!, line: newLine, side: 'RIGHT' };
			newLine++;
		} else if (inHunk && line.startsWith(' ')) {
			location = `${file}:${newLine}`;
			target = { path: file!, line: newLine, side: 'RIGHT' };
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
 * or take it as it is if a was pressed while claude wrote it. The thread's saved draft (`oo thread draft
 * commit`) skips the wait and goes straight to the form. null if cancelled.
 */
export async function writeCommit(progress: ProgressPopup, cwd: string, thread: Thread): Promise<CommitForm | null> {
	const saved = thread.drafts?.commit;
	if (saved) {
		const edited = await progress.edit(commitFormText(saved));
		return edited === CLOSED ? null : parseCommitForm(edited);
	}
	const drafted = await progress.cancellable('claude is writing the commit message', signal => draftCommit(cwd, thread, signal));
	if (drafted === CLOSED) return null;
	if (drafted && progress.accepted()) return { message: drafted, notes: '' };
	const edited = await progress.edit(drafted ? commitFormText(drafted) : commitFormText('', "claude couldn't write a commit message; write one."));
	return edited === CLOSED ? null : parseCommitForm(edited);
}
