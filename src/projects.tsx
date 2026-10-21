import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { hasWorktree, worktreePath } from './git.js';
import { editText } from './input.js';
import { COLORS, projectProblem, type Project, type State } from './state.js';

const FIELDS = ['name', 'abbrev', 'color', 'path'] as const;
type Field = (typeof FIELDS)[number];
const FIELD_LABELS: Record<Field, string> = { name: 'name', abbrev: 'abbrev', color: 'colour', path: 'path' };

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

/** Full-screen list of projects: add, edit (name, abbreviation, colour, path) and remove. */
export function ProjectsView({ state, setState, onClose }: Props) {
	const [index, setIndex] = useState(0);
	const [form, setForm] = useState<Form | null>(null);
	const [confirmRemove, setConfirmRemove] = useState(false);
	const [message, setMessage] = useState('');
	const row = Math.min(index, Math.max(0, state.projects.length - 1));
	const current: Project | undefined = state.projects[row];

	const save = (form: Form) => {
		const project = { ...form.project, name: form.project.name.trim(), abbrev: form.project.abbrev.trim(), path: expandPath(form.project.path.trim()) };
		const problem = projectProblem(state, project, form.original);
		if (problem) return setMessage(`✗ ${problem}`);
		const old = state.projects.find(p => p.name === form.original);
		const testing = state.threads.find(t => t.project === form.original && t.column === 'uitest');
		// The checkout is holding that thread's branch.
		if (old && testing && old.path !== project.path) {
			return setMessage(`✗ Move #${testing.id} out of UI testing before changing the path`);
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
			if (field === 'color') {
				const delta = key.leftArrow ? -1 : key.rightArrow || input === ' ' ? 1 : 0;
				if (!delta) return;
				const color = COLORS[(COLORS.indexOf(form.project.color) + delta + COLORS.length) % COLORS.length]!;
				return setForm({ ...form, project: { ...form.project, color } });
			}
			const value = editText(form.project[field], input, key);
			if (value !== undefined) setForm({ ...form, project: { ...form.project, [field]: value } });
			return;
		}
		if (confirmRemove) {
			setConfirmRemove(false);
			if (input !== 'y' || !current) return setMessage('Cancelled');
			setState(s => ({ ...s, projects: s.projects.filter(p => p.name !== current.name) }));
			return setMessage(`Removed ${current.name}`);
		}
		if (key.escape || input === 'q' || input === 'P') return onClose();
		if (input === 'j' || key.downArrow) return setIndex(Math.min(state.projects.length - 1, row + 1));
		if (input === 'k' || key.upArrow) return setIndex(Math.max(0, row - 1));
		if (input === 'a') {
			const color = COLORS[state.projects.length % COLORS.length]!;
			return setForm({ project: { name: '', abbrev: '', color, path: '' }, field: 0 });
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
			{state.projects.length === 0 ? <Text dimColor>  No projects yet — a to add one</Text> : null}
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
									{pad(`${FIELD_LABELS[field]}:`, 9)}
								</Text>
								{field === 'color' ? (
									<Text color={form.project.color}>{active ? `‹ ${form.project.color} ›` : form.project.color}</Text>
								) : (
									<Text>
										{form.project[field]}
										{active ? <Text inverse> </Text> : null}
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
					? '↑/↓ or tab field  ←/→ colour  ⏎ save  esc cancel'
					: 'j/k move  e/⏎ edit  a add  x remove  esc/q back to board'}
			</Text>
		</Box>
	);
}
