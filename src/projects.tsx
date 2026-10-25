import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { hasWorktree, worktreePath } from './git.js';
import { EDITING_HELP, FIELD_HELP, FieldText, formHelp } from './fieldText.js';
import { choiceStep, fieldKey, fieldStep, isBack, isSubmit, loop, nextField, type Edit } from './input.js';
import { COLORS, DEFAULT_WAKE_PROMPT, HOOK_EVENTS, HOOK_LABELS, isHome, projectProblem, TRACKERS, type Project, type ProjectHook, type State } from './state.js';

const FIELDS = ['name', 'abbrev', 'color', 'path', 'worktrees', 'wakePrompt', 'tracker', 'jiraSite', 'jiraProject', ...HOOK_EVENTS] as const;
type Field = (typeof FIELDS)[number];
const FIELD_LABELS: Record<Field, string> = {
	name: 'name',
	abbrev: 'abbrev',
	color: 'colour',
	path: 'path',
	worktrees: 'worktrees',
	wakePrompt: 'wake prompt',
	tracker: 'tickets',
	jiraSite: 'jira site',
	jiraProject: 'jira project',
	...HOOK_LABELS,
};
// Changed with ←/→ through a fixed list rather than typed.
type Choice = 'color' | 'worktrees' | 'tracker';
const CHOICES: { [F in Choice]: readonly Project[F][] } = { color: COLORS, worktrees: [true, false], tracker: TRACKERS };
const choiceLabel = (value: Project[Choice]) => (value === true ? 'on' : value === false ? 'off' : value);
const isChoice = (field: Field): field is Choice => field in CHOICES;
// Where each hook runs, for its hint.
const HOOK_WHERE: Record<ProjectHook, string> = {
	newThread: "as a thread is added, in its worktree if it's been made yet (it has with an initial prompt), else the project checkout",
	worktreeCreated: "in a thread's worktree each time it's made (first opened, reopened from Done, back from Local)",
	enterLocal: 'in the project checkout',
	leaveLocal: 'in the project checkout',
	enterPolish: "in the thread's worktree",
	leavePolish: "in the thread's worktree",
};
// Shown at the bottom while the field is selected.
const FIELD_HINTS: Partial<Record<Field, string>> = {
	worktrees: 'off: threads run in the project directory itself, several at once, with no branch, diffs or PR; changing it affects new threads only  ',
	wakePrompt: 'pasted into claude by w / W on the board; empty uses the default  ',
	tracker: 'where new threads get tickets: github issues (via gh) or jira  ',
	jiraSite: 'e.g. yourco.atlassian.net; JIRA_EMAIL and JIRA_API_TOKEN come from the environment  ',
	jiraProject: 'key prefix, e.g. AV: 123 becomes AV-123, and recent tickets come from this project  ',
	...Object.fromEntries(HOOK_EVENTS.map(e => [e, `shell command run ${HOOK_WHERE[e]} (OO_THREAD_ID, OO_THREAD_TITLE, OO_PROJECT, OO_BRANCH set${e === 'newThread' ? ', and OO_PROMPT' : ''})  `])),
};
const LABEL_WIDTH = Math.max(...FIELDS.map(f => FIELD_LABELS[f].length)) + 2;

const isHook = (field: Field): field is ProjectHook => (HOOK_EVENTS as readonly string[]).includes(field);
const fieldValue = (project: Project, field: Exclude<Field, Choice>) => (isHook(field) ? (project.hooks[field] ?? '') : project[field]);
const withField = (project: Project, field: Exclude<Field, Choice>, value: string): Project =>
	isHook(field) ? { ...project, hooks: { ...project.hooks, [field]: value } } : { ...project, [field]: value };

/** `original` is the name of the project being edited; undefined when adding one. `edit` is the focused text field's (see fieldKey). */
type Form = { original?: string; project: Project; field: number; edit: Edit };

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
			if (!isChoice(field)) {
				const next = fieldKey(fieldValue(form.project, field), form.edit, input, key);
				if (next) return setForm({ ...form, project: withField(form.project, field, next.value), edit: next.edit });
			}
			if (isBack(input, key, form.edit)) return setForm(null);
			if (isSubmit(input, key, form.edit)) return save(form);
			if (key.return) {
				const next = nextField(form.field, FIELDS.length, i => {
					const f = FIELDS[i]!;
					return isChoice(f) ? undefined : fieldValue(form.project, f).length;
				});
				return setForm({ ...form, ...next });
			}
			const moved = { ...form, edit: null };
			const step = fieldStep(input, key);
			if (step) return setForm({ ...moved, field: loop(form.field, step, FIELDS.length) });
			if (isChoice(field)) {
				const delta = choiceStep(input, key);
				if (!delta) return;
				const choices = CHOICES[field] as readonly Project[Choice][];
				const value = choices[loop(choices.indexOf(form.project[field]), delta, choices.length)];
				return setForm({ ...moved, project: { ...form.project, [field]: value } });
			}
			if (form.edit !== null) setForm(moved);
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
			return setForm({ project: { name: '', abbrev: '', color, path: '', worktrees: true, wakePrompt: '', hooks: {}, tracker: 'none', jiraSite: '', jiraProject: '' }, field: 0, edit: null });
		}
		if (!current) return;
		if (input === 'e' || key.return) return setForm({ original: current.name, project: current, field: 0, edit: null });
		if (input === 'x') {
			if (isHome(current)) return setMessage(`✗ ${current.name} is the built-in home project and can't be removed`);
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
			{state.projects.map((p, i) => (
				<Text key={p.name} wrap="truncate" inverse={!form && i === row}>
					{'  '}
					<Text color={p.color}>{pad(p.name, nameWidth)}</Text>
					{pad(p.abbrev, abbrevWidth)}
					<Text color={p.color}>{pad(p.color, 9)}</Text>
					{p.path}
					{p.worktrees ? null : <Text dimColor>  (no worktrees)</Text>}
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
										{active ? `‹ ${choiceLabel(form.project[field])} ›` : choiceLabel(form.project[field])}
									</Text>
								) : (
									<Text>
										<FieldText value={fieldValue(form.project, field)} edit={active ? form.edit : null} />
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
					? typeof form.edit === 'number'
						? `${FIELD_HINTS[FIELDS[form.field]!] ?? ''}${EDITING_HELP}`
						: `${FIELD_HINTS[FIELDS[form.field]!] ?? ''}${isChoice(FIELDS[form.field]!) ? 'h/l change' : FIELD_HELP}  ${formHelp('save')}`
					: 'j/k move  e/⏎ edit  n new  x remove  esc/q back to board'}
			</Text>
		</Box>
	);
}
