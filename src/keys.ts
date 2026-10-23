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
			['n', 'new thread'],
			['e', 'edit the thread'],
			['t', 'into / out of Local'],
			['F', 'straight to Done'],
			['x', 'archive'],
			['C', 'cycle its colour'],
			['p / esc', 'filter by project / clear it'],
			['i', 'import a thread started outside oo'],
			['P', 'projects (and their hooks)'],
			['?', 'these keys'],
			['q', 'quit'],
		],
	},
	{
		title: 'Reviewing',
		keys: [
			['d / D', 'step / whole thread diff'],
			['s / M-d', 'claude + a shell / live diff beside it'],
			['c', 'comment on the diff in vim'],
			['o', 'changed hunks as a vim quickfix list'],
			['b', 'open the PR in your browser'],
		],
	},
	{
		title: 'In a diff',
		keys: [
			['n/N', 'next / previous file or hunk'],
			['a', 'approve the step (d) / commit (beside claude)'],
			['t', 'uncommitted / whole thread (beside claude)'],
			['r', 'refresh (beside claude)'],
			['q', 'close'],
			['>> note', 'in c: a comment on the line above'],
			[':cq', 'in c: send nothing'],
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
