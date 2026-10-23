import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { hasWorktree, worktreePath } from './git.js';
import { editText, loop } from './input.js';
import { COLORS, DEFAULT_WAKE_PROMPT, HOOK_EVENTS, HOOK_LABELS, projectProblem, TRACKERS, type Project, type ProjectHook, type State } from './state.js';

const FIELDS = ['name', 'abbrev', 'color', 'path', 'wakePrompt', 'tracker', 'jiraSite', 'jiraProject', ...HOOK_EVENTS] as const;
type Field = (typeof FIELDS)[number];
const FIELD_LABELS: Record<Field, string> = {
	name: 'name',
	abbrev: 'abbrev',
	color: 'colour',
	path: 'path',
	wakePrompt: 'wake prompt',
	tracker: 'tickets',
	jiraSite: 'jira site',
	jiraProject: 'jira project',
	...HOOK_LABELS,
};
// Changed with ←/→ through a fixed list rather than typed.
type Choice = 'color' | 'tracker';
const CHOICES: { [F in Choice]: readonly Project[F][] } = { color: COLORS, tracker: TRACKERS };
const isChoice = (field: Field): field is Choice => field in CHOICES;
// Shown at the bottom while the field is selected.
const FIELD_HINTS: Partial<Record<Field, string>> = {
	wakePrompt: 'pasted into claude by w / W on the board; empty uses the default  ',
	tracker: 'where new threads get tickets: github issues (via gh) or jira  ',
	jiraSite: 'e.g. yourco.atlassian.net; JIRA_EMAIL and JIRA_API_TOKEN come from the environment  ',
	jiraProject: 'key prefix, e.g. AV: 123 becomes AV-123, and recent tickets come from this project  ',
	...Object.fromEntries(HOOK_EVENTS.map(e => [e, 'shell command run in the project checkout (OO_THREAD_ID, OO_PROJECT, OO_BRANCH set)  '])),
};
const LABEL_WIDTH = Math.max(...FIELDS.map(f => FIELD_LABELS[f].length)) + 2;

const isHook = (field: Field): field is ProjectHook => (HOOK_EVENTS as readonly string[]).includes(field);
const fieldValue = (project: Project, field: Exclude<Field, Choice>) => (isHook(field) ? (project.hooks[field] ?? '') : project[field]);
const withField = (project: Project, field: Exclude<Field, Choice>, value: string): Project =>
	isHook(field) ? { ...project, hooks: { ...project.hooks, [field]: value } } : { ...project, [field]: value };

/** `original` is the name of the project being edited; undefined when adding one. */
type Form = { original?: string; project: Project; field: number };

type Props = {
	state: State;
	setState: (update: (s: State) => State) => void;
	onClose: () => void;
};

function expandPath(path: string): string {
	return resolve(path.replace(/^~(?=$|\/)/, homedir()));
}

/** Full-screen list of projects: add, edit (name, abbreviation, colour, path, tickets, hooks) and remove. */
export function ProjectsView({ state, setState, onClose }: Props) {
	const [index, setIndex] = useState(0);
	const [form, setForm] = useState<Form | null>(null);
	const [confirmRemove, setConfirmRemove] = useState(false);
	const [message, setMessage] = useState('');
	const row = Math.min(index, Math.max(0, state.projects.length - 1));
	const current: Project | undefined = state.projects[row];

	const save = (form: Form) => {
		// Hooks left empty aren't kept.
		const hooks = Object.fromEntries(Object.entries(form.project.hooks).map(([k, v]) => [k, v?.trim()]).filter(([, v]) => v));
		const project = {
			...form.project,
			name: form.project.name.trim(),
			abbrev: form.project.abbrev.trim(),
			wakePrompt: form.project.wakePrompt.trim(),
			path: expandPath(form.project.path.trim()),
			jiraSite: form.project.jiraSite.trim().replace(/^https?:\/\//, '').replace(/\/+$/, ''),
			jiraProject: form.project.jiraProject.trim().toUpperCase(),
			hooks,
		};
		const problem = projectProblem(state, project, form.original);
		if (problem) return setMessage(`✗ ${problem}`);
		const old = state.projects.find(p => p.name === form.original);
		const local = state.threads.find(t => t.project === form.original && t.local);
		// The checkout is holding that thread's branch.
		if (old && local && old.path !== project.path) {
			return setMessage(`✗ Bring #${local.id} back from Local before changing the path`);
		}
		setState(s => ({
			...s,
			projects: old ? s.projects.map(p => (p === old ? project : p)) : [...s.projects, project],
			threads: s.threads.map(t =>
				// Existing worktrees stay where they are, under the old name.
				old && t.project === old.name
					? { ...t, project: project.name, worktree: hasWorktree(t) ? worktreePath(t) : t.worktree }
					: t,
			),
		}));
		setForm(null);
		if (!old) setIndex(state.projects.length);
		setMessage(old ? `Saved ${project.name}` : `Added ${project.name}`);
	};

	useInput((input, key) => {
		setMessage('');
		if (form) {
			const field = FIELDS[form.field]!;
			if (key.escape) return setForm(null);
			if (key.return) return save(form);
			if (key.upArrow || (key.tab && key.shift)) return setForm({ ...form, field: (form.field + FIELDS.length - 1) % FIELDS.length });
			if (key.downArrow || key.tab) return setForm({ ...form, field: (form.field + 1) % FIELDS.length });
			if (isChoice(field)) {
				const delta = key.leftArrow ? -1 : key.rightArrow || input === ' ' ? 1 : 0;
				if (!delta) return;
				const choices = CHOICES[field] as readonly string[];
				const value = choices[(choices.indexOf(form.project[field]) + delta + choices.length) % choices.length];
				return setForm({ ...form, project: { ...form.project, [field]: value } });
			}
			const value = editText(fieldValue(form.project, field), input, key);
			if (value !== undefined) setForm({ ...form, project: withField(form.project, field, value) });
			return;
		}
		if (confirmRemove) {
			setConfirmRemove(false);
			if (input !== 'y' || !current) return setMessage('Cancelled');
			setState(s => ({ ...s, projects: s.projects.filter(p => p.name !== current.name) }));
			return setMessage(`Removed ${current.name}`);
		}
		if (key.escape || input === 'q' || input === 'P') return onClose();
		if (input === 'j' || key.downArrow) return setIndex(loop(row, 1, state.projects.length));
		if (input === 'k' || key.upArrow) return setIndex(loop(row, -1, state.projects.length));
		if (input === 'n') {
			const color = COLORS[state.projects.length % COLORS.length]!;
			return setForm({ project: { name: '', abbrev: '', color, path: '', wakePrompt: '', hooks: {}, tracker: 'none', jiraSite: '', jiraProject: '' }, field: 0 });
		}
		if (!current) return;
		if (input === 'e' || key.return) return setForm({ original: current.name, project: current, field: 0 });
		if (input === 'x') {
			if (state.threads.some(t => t.project === current.name && t.column !== 'archived')) {
				return setMessage(`✗ ${current.name} still has unarchived threads`);
			}
			setConfirmRemove(true);
			return setMessage(`Remove ${current.name}? y to confirm`);
		}
	});

	const nameWidth = Math.max(8, ...state.projects.map(p => p.name.length)) + 2;
	const abbrevWidth = Math.max(6, ...state.projects.map(p => p.abbrev.length)) + 2;
	const pad = (s: string, n: number) => s.padEnd(n);

	return (
		<Box flexDirection="column" flexGrow={1}>
			<Text bold>Projects</Text>
			<Text dimColor>
				{'  '}
				{pad('name', nameWidth)}
				{pad('abbrev', abbrevWidth)}
				{pad('colour', 9)}path
			</Text>
			{state.projects.length === 0 ? <Text dimColor>  No projects yet — n to add one</Text> : null}
			{state.projects.map((p, i) => (
				<Text key={p.name} wrap="truncate" inverse={!form && i === row}>
					{'  '}
					<Text color={p.color}>{pad(p.name, nameWidth)}</Text>
					{pad(p.abbrev, abbrevWidth)}
					<Text color={p.color}>{pad(p.color, 9)}</Text>
					{p.path}
				</Text>
			))}
			{form ? (
				<Box flexDirection="column" marginTop={1}>
					<Text bold>{form.original ? `Edit ${form.original}` : 'New project'}</Text>
					{FIELDS.map((field, i) => {
						const active = i === form.field;
						return (
							<Text key={field}>
								<Text dimColor={!active}>
									{active ? '› ' : '  '}
									{pad(`${FIELD_LABELS[field]}:`, LABEL_WIDTH)}
								</Text>
								{isChoice(field) ? (
									<Text color={field === 'color' ? form.project.color : undefined}>
										{active ? `‹ ${form.project[field]} ›` : form.project[field]}
									</Text>
								) : (
									<Text>
										{fieldValue(form.project, field)}
										{active ? <Text inverse> </Text> : null}
										{field === 'wakePrompt' && !form.project.wakePrompt ? <Text dimColor>{DEFAULT_WAKE_PROMPT}</Text> : null}
									</Text>
								)}
							</Text>
						);
					})}
				</Box>
			) : null}
			<Box flexGrow={1} />
			<Text color={message.startsWith('✗') ? 'red' : confirmRemove ? 'yellow' : 'green'}>{message}</Text>
			<Text dimColor>
				{form
					? `${FIELD_HINTS[FIELDS[form.field]!] ?? ''}↑/↓ or tab field  ${isChoice(FIELDS[form.field]!) ? '←/→ change  ' : ''}⏎ save  esc cancel`
					: 'j/k move  e/⏎ edit  n new  x remove  esc/q back to board'}
			</Text>
		</Box>
	);
}
