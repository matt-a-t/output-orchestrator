// Every key oo adds, for the board's `?` screen. KEYS.md says the same for reading outside the board.

export type KeySection = { title: string; keys: [key: string, what: string][] };

export const KEY_SECTIONS: KeySection[] = [
	{
		title: 'Board',
		keys: [
			['h/l j/k', 'move (arrows too)'],
			['H/L', 'move the thread a column'],
			['J/K', 'reorder within its column'],
			['⏎', 'open (or resume) its claude'],
			['w / W', 'wake it / every thread closed mid-work ("keep going")'],
			['u', 'rebase on origin/main (pushes a PR; conflicts go to claude)'],
			['n', 'new thread (form)'],
			['e', 'edit the thread'],
			['t', 'into / out of Local'],
			['F', 'straight to Done'],
			['x', 'archive'],
			['C', 'cycle its colour'],
			['p / esc', 'filter by project / clear it'],
			['i', 'import a thread started outside oo'],
			['P', 'projects (their hooks and wake prompt)'],
			['?', 'these keys'],
			['q', 'quit'],
		],
	},
	{
		title: 'New thread form',
		keys: [
			['tab / ↑/↓', 'next / previous field'],
			['←/→', 'change project / pick a recent ticket'],
			['⏎', 'create; starts claude on the initial prompt'],
			['esc', 'cancel'],
			['ctrl-u / ctrl-w', 'clear field / delete word'],
		],
	},
	{
		title: 'Reviewing',
		keys: [
			['d / D', 'step / whole thread diff'],
			['s / M-d', 'claude + a shell / live diff beside it'],
			['c', 'comment on the diff in vim'],
			['o', 'changed hunks as a vim quickfix list'],
			['v', 'view the PR (m merges it)'],
			['b', 'open the PR in your browser'],
		],
	},
	{
		title: 'In a diff',
		keys: [
			['n/N', 'next / previous file or hunk (the stat is on top)'],
			['a', 'approve the step (d) / commit (beside claude)'],
			['t', 'uncommitted / whole thread (beside claude)'],
			['r', 'refresh (beside claude)'],
			['m', 'merge the PR (v)'],
			['o', 'open the PR in your browser (v)'],
			['S', "delta's header styles (oo delta)"],
			['q', 'close'],
			['>> note', 'in c: a comment on the line above'],
			[':cq', 'in c: send nothing'],
		],
	},
	{
		title: 'In a form (e, P, commit)',
		keys: [
			['j/k ↑/↓ tab', 'move between fields'],
			['i / ⏎', 'edit, cursor at the end'],
			['I', 'edit, cursor at the start'],
			['dd', 'clear the field and edit'],
			['←/→ C-a/C-e', 'editing: move / start, end'],
			['C-u / C-w', 'editing: delete line / word'],
			['esc', 'stop editing; again: cancel'],
			['⏎ (editing)', 'save (on a choice too)'],
		],
	},
	{
		title: "In a thread's window",
		keys: [
			['M-h / M-l', 'claude / the pane beside it'],
			['M-j / M-k', 'next / previous thread'],
			['M-s / M-d', 'shell / live diff beside claude'],
			['M-u', 'scroll up (tmux copy mode, q leaves)'],
			['M-z', 'zoom the pane'],
			['M-q / M-b', 'back to the board'],
			['prefix b', 'back to the board, from anywhere'],
		],
	},
	{
		title: 'Claude',
		keys: [['/vim', "vim editing in claude's prompt (global)"]],
	},
];
