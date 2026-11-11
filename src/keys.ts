// Every key oo adds, for the board's `?` screen. KEYS.md says the same for reading outside the board.
// The keys that act on a thread come from their bindings (BINDINGS); the board's own and the rest are here.

import { BINDINGS, type BindingHelp } from './board/bindings.js';

export type KeySection = { title: string; keys: [key: string, what: string][] };

/** The rows for the thread keys bound in `section`, in BINDINGS order. */
export function bindingRows(section: BindingHelp['section']): [key: string, what: string][] {
	return BINDINGS.flatMap(b => (b.help?.section === section ? [[b.help.keys ?? b.key, b.help.what] as [string, string]] : []));
}

export const KEY_SECTIONS: KeySection[] = [
	{
		title: 'Board',
		keys: [
			['h/l j/k', 'move (arrows too)'],
			...bindingRows('Board'),
			['J/K', 'reorder within its column (among threads of its priority)'],
			['n', 'new thread (form)'],
			['N', 'import a thread started outside oo'],
			['e', 'edit the thread'],
			['t', 'every todo on the thread (j/k scroll)'],
			['B', 'blocked by another thread (move to it, ⏎ picks)'],
			['!', 'cycle its priority (normal, high, low); high sorts to the top of its column, low to the bottom'],
			['p', 'filter by project'],
			['/', 'search (⏎ keeps it, esc drops it)'],
			['esc', 'clear the search, then the project'],
			['I', 'show / hide the IDEAS column (threads shelved from Planned)'],
			['A', 'show / hide archived threads'],
			['r', "run one of the project's commands (dev server, tests…) in the thread's worktree, in a new terminal window"],
			['P', 'projects (their hooks, commands, wake prompt and when idle claudes close)'],
			['?', 'these keys'],
			['q', 'quit, leaving thread windows open'],
			['Q', 'quit, closing every thread window and stopping every run (r)'],
		],
	},
	{
		title: 'Running commands (r)',
		keys: [
			['j/k', 'move'],
			['⏎ / 1-9', 'run it in a new window (again, if it finished); running: open another window on it'],
			['R', 'restart it, in the windows already on it'],
			['X', 'stop it'],
			['esc / q / r', 'close'],
		],
	},
	{
		title: 'Reviewing',
		keys: [
			...bindingRows('Reviewing'),
			['R', 'PRs waiting for your review (⏎/v view, b browser, r refresh)'],
		],
	},
	{
		title: 'In a diff',
		keys: [
			['h/l 1 2 3', "tabs: claude's response (v: the PR) / files / diff"],
			['j/k C-d/C-u g/G', 'scroll (files tab: pick a file, ⏎ opens it)'],
			[']/[ n/N }/{', 'next / previous file, hunk'],
			['+/-', 'more / less context, up to the whole file'],
			['/', 'search every file (n/N: matches, esc ends it)'],
			['a', 'approve the step (d)'],
			['m', 'merge your PR (v)'],
			['a / x / c', "approve / request changes / comment (v, someone else's PR)"],
			['b', 'open the PR in your browser (v)'],
			['S', "delta's header styles (oo delta)"],
			['q / d D v', 'close (d, D, v: the key that opened it)'],
			['>> note', 'in c (and x/c in v): a comment on the line above'],
			[':cq', 'in c: send nothing'],
		],
	},
	{
		title: 'In a form (n, e, P, commit)',
		keys: [
			['j/k ↑/↓ tab', 'move between fields'],
			['h/l ←/→ space', 'change a choice (project, colour, priority, recent ticket…)'],
			['i / I', 'edit, cursor at the end / start'],
			['dd', 'clear the field and edit'],
			['⏎', 'edit the field; editing: save it and edit the next'],
			['a / shift-⏎', 'create / save / commit (shift-⏎ while editing too)'],
			['q / esc', 'cancel (esc while editing: stop editing)'],
			['←/→ C-a/C-e', 'editing: move / start, end'],
			['C-u / C-w', 'editing: delete line / word'],
		],
	},
	{
		title: 'Projects (P)',
		keys: [
			['j/k', 'move'],
			['e / ⏎', 'edit the project (the form above)'],
			['n', 'add a project'],
			['x', 'remove it (y confirms)'],
			['q / esc / P', 'back to the board'],
		],
	},
	{
		title: "In a thread's window",
		keys: [
			['M-h / M-l', 'claude / the pane beside it'],
			['M-j / M-k', 'next / previous thread'],
			['M-s', 'shell beside claude'],
			['M-u', 'scroll up (tmux copy mode, q leaves)'],
			['M-z', 'zoom the pane'],
			['M-q', 'back to the board'],
			['prefix b', 'back to the board, from anywhere'],
		],
	},
	{
		title: 'Claude',
		keys: [['/vim', "vim editing in claude's prompt (global)"]],
	},
];
