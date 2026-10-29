// `oo view`: the diff viewer d / D open in a popup, in three tabs: what goes with the diff (claude's
// last response), its files, and the diff a file at a time, through delta.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { execa } from 'execa';
import { Box, measureElement, render, Text, useApp, useInput, useWindowSize, type DOMElement, type Key } from 'ink';
import { mouse, mouseStdin, reportMouse } from './mouse.js';
import { OO_COMMAND } from './status.js';
import { shellQuote } from './tmux.js';
import {
	clampScroll,
	contextLabel,
	CONTEXT_STEPS,
	fileLabel,
	findMatches,
	fitTabs,
	hunkRows,
	nextMatch,
	nextRow,
	plainLines,
	splitPatch,
	stepContext,
	TAB_FRAME,
	type FilePatch,
	type Match,
} from './viewerModel.js';

/** A key that closes the viewer with `status`, for the caller to act on (approve, restyle…). */
export type ViewKey = { key: string; status: number; hint: string };

/** What `oo view` shows, written by the caller to spec.json in the viewer's directory. */
export type ViewSpec = {
	cwd: string;
	// The diff: `git diff` and its revisions (as diffArgs gives them), or a patch file, e.g. a PR's.
	args?: string[];
	patch?: string;
	// For a patch, the `git fetch` arguments that get what it's a diff of and the `git diff` ones for it then, so +/- can re-run it.
	fetch?: { args: string[]; diff: string[] };
	// More delta options (the PR viewer's magenta headers) and the colour of the tab bar's current tab.
	delta?: string[];
	accent?: string;
	// Tab 1: its name in the tab bar and its text.
	intro: { label: string; text: string };
	keys: ViewKey[];
};

/** Where the viewer was, saved in its directory on the way out so it comes back there (e.g. after S). */
type Place = { tab: number; file: number; tops: number[]; fileTops: [number, number][]; contexts: [number, number][] };

/** A shell command running the viewer on `spec`, from the directory `dir` it keeps its files in. */
export function viewerShellCommand(dir: string, spec: ViewSpec): string {
	writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec));
	return [...OO_COMMAND, 'view', dir].map(shellQuote).join(' ');
}

const DEFAULT_CONTEXT = CONTEXT_STEPS[0];
const TAB_COUNT = 3;
const STATUS_LETTERS: Record<FilePatch['status'], [string, string]> = {
	modified: ['M', 'blue'],
	added: ['A', 'green'],
	deleted: ['D', 'red'],
	renamed: ['R', 'yellow'],
};
// Rows of context kept above a search match or hunk jumped to.
const LEAD = 3;
const WHEEL_ROWS = 3;

/** One file's diff through delta, `width` columns wide, as lines; the diff as it is if delta isn't installed. */
async function deltaLines(text: string, width: number, options: string[] = []): Promise<string[]> {
	const delta = await execa('delta', ['--paging=never', '--navigate', `--width=${width}`, ...options], { input: text, reject: false });
	const out = delta.exitCode === 0 ? delta.stdout : text;
	return out.replace(/\n$/, '').split('\n');
}

let fetched: Promise<string[] | undefined> | undefined;

/** The `git diff` arguments +/- re-run: the spec's, or a patch's once what it's a diff of is fetched; undefined if that fails. */
function contextArgs(spec: ViewSpec): Promise<string[] | undefined> {
	if (spec.args || !spec.fetch) return Promise.resolve(spec.args);
	const { args, diff } = spec.fetch;
	return (fetched ??= execa('git', ['-C', spec.cwd, 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', ...args]).then(
		() => diff,
		() => undefined,
	));
}

/** A file's diff with `context` lines of context: the one already read at the default (or if git can't make another), else git's. */
async function fileDiff(spec: ViewSpec, file: FilePatch, context: number): Promise<string> {
	const args = context === DEFAULT_CONTEXT ? undefined : await contextArgs(spec);
	if (!args) return file.text;
	const paths = file.oldPath === file.path ? [file.path] : [file.oldPath, file.path];
	const { stdout } = await execa('git', ['-C', spec.cwd, ...gitDiff(args, context), '--', ...paths]);
	// Empty once the PR has merged, for one.
	return stdout ? stdout + '\n' : file.text;
}

function gitDiff(args: string[], context: number): string[] {
	return ['-c', 'core.quotePath=false', args[0]!, '--no-color', '--no-ext-diff', `-U${context}`, ...args.slice(1)];
}

type Rendered = { lines: string[]; plain: string[]; hunks: number[] };

function Viewer({ spec, files, place, onExit }: { spec: ViewSpec; files: FilePatch[]; place?: Place; onExit: (status: number, place: Place) => void }) {
	const { exit } = useApp();
	const { columns, rows } = useWindowSize();
	// Less the tabs' two rows and the footer.
	const height = Math.max(1, rows - 3);
	const [tab, setTab] = useState(place?.tab ?? (files.length ? 2 : 0));
	const [file, setFile] = useState(Math.min(place?.file ?? 0, Math.max(0, files.length - 1)));
	// Scroll of tab 1 and tab 2; tab 3's is per file.
	const [tops, setTops] = useState(place?.tops ?? [0, 0]);
	const [fileTops, setFileTops] = useState(new Map(place?.fileTops));
	const [contexts, setContexts] = useState(new Map(place?.contexts));
	const [rendered, setRendered] = useState(new Map<string, Rendered>());
	const [search, setSearch] = useState<string | null>(null);
	const [query, setQuery] = useState('');
	const [matches, setMatches] = useState<Match[] | undefined>();
	const [match, setMatch] = useState<Match | undefined>();
	const [message, setMessage] = useState('');
	const [introRows, setIntroRows] = useState(0);
	const intro = useRef<DOMElement>(null);
	// The delta width goes in the key, so a resize re-renders.
	const cacheKey = (i: number, context = contexts.get(i) ?? DEFAULT_CONTEXT) => `${i}:${context}:${columns}`;
	const context = contexts.get(file) ?? DEFAULT_CONTEXT;
	const current = rendered.get(cacheKey(file));

	const renderFile = async (i: number, ctx = contexts.get(i) ?? DEFAULT_CONTEXT): Promise<Rendered> => {
		const key = cacheKey(i, ctx);
		const cached = rendered.get(key);
		if (cached) return cached;
		const lines = await deltaLines(await fileDiff(spec, files[i]!, ctx), columns, spec.delta);
		const plain = plainLines(lines);
		const result = { lines, plain, hunks: hunkRows(plain) };
		setRendered(map => new Map(map).set(key, result));
		return result;
	};

	useEffect(() => {
		if (files.length && !current) renderFile(file).catch(err => setMessage(`✗ ${err instanceof Error ? err.message : String(err)}`));
	}, [file, context, columns, current]);

	useEffect(() => {
		if (tab === 0 && intro.current) setIntroRows(measureElement(intro.current).height);
	});

	const totals = [introRows, files.length + 2, current?.lines.length ?? 0];
	const top = tab === 2 ? (fileTops.get(file) ?? 0) : tops[tab]!;
	const setTop = (value: number, onTab = tab, onFile = file, total = totals[onTab]!) => {
		const clamped = clampScroll(value, total, height);
		if (onTab === 2) setFileTops(map => new Map(map).set(onFile, clamped));
		else setTops(t => t.map((v, i) => (i === onTab ? clamped : v)));
	};
	const currentPlace = (): Place => ({ tab, file, tops, fileTops: [...fileTops], contexts: [...contexts] });
	const close = (status: number) => {
		onExit(status, currentPlace());
		exit();
	};

	// The file list follows the file you're on, keeping it in view.
	const pickFile = (i: number) => {
		const next = Math.max(0, Math.min(files.length - 1, i));
		setFile(next);
		const row = next + 2;
		if (row < tops[1]!) setTop(row, 1);
		else if (row >= tops[1]! + height) setTop(row - height + 1, 1);
	};

	const goToMatch = (m: Match, rows: number) => {
		setMatch(m);
		setTab(2);
		pickFile(m.file);
		setTop(m.row - LEAD, 2, m.file, rows);
	};

	const runSearch = async (text: string, dir: 1 | -1, from?: Match) => {
		setMessage('searching…');
		const all = await Promise.all(files.map((_, i) => renderFile(i)));
		const found = findMatches(all.map(r => r.plain), text);
		setMatches(found);
		// From the match you're on, else from just above the top of the file.
		const at = from ?? { file, row: tab === 2 ? top + LEAD - 1 : -1 };
		const next = nextMatch(found, at.file, at.row, dir);
		if (!next) return setMessage(`Not found: ${text}`);
		setMessage(`${found.indexOf(next) + 1}/${found.length} ${text}`);
		goToMatch(next, all[next.file]!.lines.length);
	};

	// The next / previous hunk, going on into the next / previous file past the last / first.
	// From the hunk last jumped to while it's still on screen, since near the end the scroll can't put it at the top.
	const lastHunk = useRef<Match | undefined>(undefined);
	const jumpHunk = async (dir: 1 | -1) => {
		const here = await renderFile(file);
		const last = lastHunk.current;
		const from = last && last.file === file && last.row >= top && last.row < top + height ? last.row : top + LEAD;
		const row = nextRow(here.hunks, from, dir);
		if (row !== undefined) {
			lastHunk.current = { file, row };
			return setTop(row - LEAD, 2, file, here.lines.length);
		}
		const to = file + dir;
		if (to < 0 || to >= files.length) return setMessage(dir === 1 ? 'Last hunk' : 'First hunk');
		const there = await renderFile(to);
		pickFile(to);
		const first = dir === 1 ? there.hunks[0] : there.hunks.at(-1);
		lastHunk.current = first === undefined ? undefined : { file: to, row: first };
		setTop(first === undefined ? 0 : first - LEAD, 2, to, there.lines.length);
	};

	const scroll = (by: number) => {
		if (tab === 1) return pickFile(file + by);
		setTop(top + by);
	};

	useEffect(() => {
		const listener = ({ button }: { button: string }) => {
			if (button === 'wheelUp') scroll(-WHEEL_ROWS);
			if (button === 'wheelDown') scroll(WHEEL_ROWS);
		};
		mouse.on('press', listener);
		return () => void mouse.off('press', listener);
	});

	const searchKey = (input: string, key: Key) => {
		if (key.escape) return setSearch(null);
		if (key.return) {
			setSearch(null);
			if (!search) return;
			setQuery(search);
			return void runSearch(search, 1);
		}
		if (key.backspace || key.delete) return setSearch(search!.slice(0, -1));
		if (input && !key.ctrl && !key.meta) setSearch(search + input);
	};

	useInput((input, key) => {
		if (search !== null) return searchKey(input, key);
		setMessage('');
		const action = spec.keys.find(k => k.key === input);
		if (action) return close(action.status);
		// esc ends a search first, giving n/N back to hunks.
		if (key.escape && query) {
			setQuery('');
			setMatches(undefined);
			setMatch(undefined);
			return;
		}
		if (input === 'q' || key.escape) return close(0);
		if (input === 'h' || key.leftArrow) return setTab((tab + TAB_COUNT - 1) % TAB_COUNT);
		if (input === 'l' || key.rightArrow || (tab === 1 && key.return)) return setTab((tab + 1) % TAB_COUNT);
		if (['1', '2', '3'].includes(input)) return setTab(Number(input) - 1);
		if (input === 'j' || key.downArrow) return scroll(1);
		if (input === 'k' || key.upArrow) return scroll(-1);
		if (key.ctrl && input === 'd') return scroll(Math.ceil(height / 2));
		if (key.ctrl && input === 'u') return scroll(-Math.ceil(height / 2));
		if ((key.ctrl && input === 'f') || key.pageDown || input === ' ') return scroll(height);
		if ((key.ctrl && input === 'b') || key.pageUp) return scroll(-height);
		if (input === 'g' || key.home) return tab === 1 ? pickFile(0) : setTop(0);
		if (input === 'G' || key.end) return tab === 1 ? pickFile(files.length - 1) : setTop(Infinity);
		if (input === '/') return setSearch('');
		// n/N go between search matches while there's a search, else between hunks like }/{.
		if ((input === 'n' || input === 'N') && query) {
			const dir = input === 'n' ? 1 : -1;
			if (!matches) return void runSearch(query, dir, match);
			const next = match ? nextMatch(matches, match.file, match.row, dir) : nextMatch(matches, file, top + LEAD - 1, dir);
			if (!next) return setMessage(`Not found: ${query}`);
			setMessage(`${matches.indexOf(next) + 1}/${matches.length} ${query}`);
			return goToMatch(next, rendered.get(cacheKey(next.file))?.lines.length ?? Infinity);
		}
		if (!files.length) return;
		if (input === ']' || input === 'J') return pickFile(file + 1);
		if (input === '[' || input === 'K') return pickFile(file - 1);
		if (tab !== 2) return;
		if (['}', '{', 'n', 'N'].includes(input)) return void jumpHunk(input === '}' || input === 'n' ? 1 : -1);
		if (input === '+' || input === '=' || input === '-') {
			const next = stepContext(context, input === '-' ? -1 : 1);
			if (next === context) return setMessage(input === '-' ? 'Least context' : 'Already the whole file');
			if (!spec.args) setMessage('fetching the PR…');
			const on = file;
			return void contextArgs(spec).then(args => {
				if (!args) return setMessage("✗ Couldn't fetch the PR, so there's no more context");
				setMessage('');
				// Rows move with the context, so matches found before are stale.
				setMatches(undefined);
				setMatch(undefined);
				setContexts(map => new Map(map).set(on, next));
				setFileTops(map => new Map(map).set(on, 0));
			});
		}
	});

	// What goes with the diff, how many files it changes, and the one you're on.
	const fileStat = (f: FilePatch) => (
		<>
			{f.binary ? <Text dimColor> binary</Text> : null}
			{f.added ? <Text color="green">{` +${f.added}`}</Text> : null}
			{f.removed ? <Text color="red">{` −${f.removed}`}</Text> : null}
		</>
	);

	let body;
	if (tab === 0) {
		body = (
			<Box height={height} overflow="hidden" flexDirection="column">
				<Box ref={intro} marginTop={-top} flexDirection="column" flexShrink={0}>
					<Text>{spec.intro.text}</Text>
				</Box>
			</Box>
		);
	} else if (tab === 1) {
		const added = files.reduce((n, f) => n + f.added, 0);
		const removed = files.reduce((n, f) => n + f.removed, 0);
		const listRows = [
			<Text key="total" bold>
				{`${files.length} file${files.length === 1 ? '' : 's'} changed`}
				<Text color="green">{` +${added}`}</Text>
				<Text color="red">{` −${removed}`}</Text>
			</Text>,
			<Text key="gap"> </Text>,
			...files.map((f, i) => {
				const [letter, color] = STATUS_LETTERS[f.status];
				return (
					<Text key={i} wrap="truncate" inverse={i === file}>
						<Text color={color}>{` ${letter} `}</Text>
						{fileLabel(f)}
						{fileStat(f)}
					</Text>
				);
			}),
		];
		body = <Box flexDirection="column">{listRows.slice(top, top + height)}</Box>;
	} else if (!files.length) {
		body = <Text dimColor>No changes</Text>;
	} else if (!current) {
		body = <Text dimColor>rendering {files[file]!.path}…</Text>;
	} else {
		body = (
			<Box flexDirection="column">
				{current.lines.slice(top, top + height).map((line, i) => {
					const row = top + i;
					const hit = match && match.file === file && match.row === row;
					return (
						<Text key={row} wrap="truncate" inverse={hit}>
							{hit ? current.plain[row] || ' ' : line || ' '}
						</Text>
					);
				})}
			</Box>
		);
	}

	const hints = ['j/k scroll', 'j/k file  ⏎ open', `j/k scroll  ]/[ file  ${query ? '}/{' : 'n/N'} hunk  +/- context`][tab];
	const searchHint = query ? 'n/N match  esc end search' : '/ search';
	const actions = spec.keys.map(k => `${k.key} ${k.hint}`).join('  ');
	// The file tab ends with the file's stat, which keeps its colours and its room.
	const shown = files[file];
	const statWidth = shown ? `${shown.binary ? ' binary' : ''}${shown.added ? ` +${shown.added}` : ''}${shown.removed ? ` −${shown.removed}` : ''}`.length : 0;
	const tabLabels = fitTabs(
		[spec.intro.label, `${files.length} file${files.length === 1 ? '' : 's'} changed`, shown ? `${file + 1}/${files.length} ${fileLabel(shown)}` : 'diff'],
		columns - statWidth,
	);
	const extra = (i: number) => (i === 2 ? statWidth : 0);
	// Framed on top and at the sides, the current one in colour and the others dim.
	const tabRow = (draw: (label: string, i: number) => ReactNode) => (
		<Text wrap="truncate">
			{tabLabels.map((label, i) => (
				<Text key={i} color={i === tab ? (spec.accent ?? 'cyan') : undefined} dimColor={i !== tab} bold={i === tab}>
					{draw(label, i)}
				</Text>
			))}
		</Text>
	);
	const tabBar = (
		<>
			{tabRow((label, i) => `╭${'─'.repeat(label.length + extra(i) + TAB_FRAME - 2)}╮`)}
			{tabRow((label, i) => (
				<>
					{`│ ${label}`}
					{i === 2 && shown ? fileStat(shown) : null}
					{' │'}
				</>
			))}
		</>
	);

	const where = tab === 2 && files.length ? <Text dimColor>{`${contextLabel(context)} · `}</Text> : null;
	const footer =
		search !== null ? (
			<Text>/{search}█</Text>
		) : (
			<Text wrap="truncate">
				{where}
				{message ? <Text color="yellow">{message} · </Text> : null}
				<Text dimColor>{[hints, searchHint, actions, 'q close'].filter(Boolean).join('  ')}</Text>
			</Text>
		);

	return (
		<Box flexDirection="column" height={rows}>
			{tabBar}
			<Box height={height} flexDirection="column" overflow="hidden">
				{body}
			</Box>
			{footer}
		</Box>
	);
}

/** `oo view <dir>`: the viewer on `<dir>/spec.json`, exiting with the status of the key that closed it (0 for q). */
export async function viewCommand([dir]: string[]): Promise<number> {
	if (!dir) {
		console.error('usage: oo view <dir>');
		return 1;
	}
	const spec = JSON.parse(readFileSync(join(dir, 'spec.json'), 'utf8')) as ViewSpec;
	const placeFile = join(dir, 'place.json');
	const place = existsSync(placeFile) ? (JSON.parse(readFileSync(placeFile, 'utf8')) as Place) : undefined;
	const diff = spec.args ? (await execa('git', ['-C', spec.cwd, ...gitDiff(spec.args, DEFAULT_CONTEXT)])).stdout : readFileSync(spec.patch!, 'utf8');
	const files = splitPatch(diff);
	let status = 0;
	const app = render(
		<Viewer
			spec={spec}
			files={files}
			place={place}
			onExit={(s, p) => {
				status = s;
				writeFileSync(placeFile, JSON.stringify(p));
			}}
		/>,
		{ stdin: mouseStdin(), alternateScreen: true },
	);
	reportMouse();
	await app.waitUntilExit();
	return status;
}
