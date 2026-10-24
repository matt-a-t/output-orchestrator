// The PRs waiting for your review (`R`), across projects, in place of the columns.

import { existsSync } from 'node:fs';
import { useEffect, useRef, useState } from 'react';
import { Box, Text, measureElement, useInput, useWindowSize, type DOMElement } from 'ink';
import { openPrInBrowser, reviewRequests, type ReviewRequest } from '../github.js';
import { loop } from '../input.js';
import { mouse, type MouseEvent } from '../mouse.js';
import type { Project } from '../state.js';
import { timeAgo } from '../transcripts.js';
import type { Board } from './board.js';
import { LIST_TOP } from './card.js';
import { useDoubleClick } from './doubleClick.js';
import { viewPr } from './pr.js';

/** A PR asking you for a review, and the project it's in. */
export type Review = ReviewRequest & { project: Project };

/**
 * The open PRs asking you for a review, across projects (those with a repo), most recently
 * updated first. Projects gh can't ask about are named in the message.
 */
export async function fetchReviews(board: Board): Promise<Review[]> {
	const projects = board.state().projects.filter(p => p.worktrees && existsSync(p.path));
	const failed: string[] = [];
	const found = await Promise.all(
		projects.map(project =>
			reviewRequests(project.path).then(
				requests => requests.map(r => ({ ...r, project })),
				() => (failed.push(project.name), []),
			),
		),
	);
	if (failed.length) board.setMessage(`⚠ gh couldn't list PRs in ${failed.join(', ')}`);
	return found.flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

type Props = {
	board: Board;
	// As first fetched; the list refetches them itself after that.
	requests: Review[];
	// Whether it takes keys and clicks (not while the board is busy).
	active: boolean;
	onClose: () => void;
};

export function ReviewList({ board, requests: fetched, active, onClose }: Props) {
	const { columns: width } = useWindowSize();
	const [requests, setRequests] = useState(fetched);
	const [row, setRow] = useState(0);

	const refresh = async () => {
		const latest = await fetchReviews(board);
		setRequests(latest);
		setRow(r => Math.min(r, Math.max(0, latest.length - 1)));
	};

	/** View a review request's PR, then refresh the list, since one you've reviewed drops off it. */
	const viewReview = (review: Review) =>
		board.run(async () => {
			if (await viewPr(board, review.project.path, review.number)) await refresh();
		}, `loading PR #${review.number}`);

	useInput(
		(input, key) => {
			board.setMessage('');
			const count = requests.length;
			const review = requests[row];
			if (input === 'q' || input === 'R' || key.escape) return onClose();
			if (input === 'j' || key.downArrow) return setRow(loop(row, 1, count));
			if (input === 'k' || key.upArrow) return setRow(loop(row, -1, count));
			if (input === 'r') return board.run(refresh, 'looking for review requests');
			if (!review) return;
			if (key.return || input === 'v') return viewReview(review);
			if (input === 'b') return board.run(() => openPrInBrowser(review), 'opening PR in the browser');
		},
		{ isActive: active },
	);

	// Requests are a line each; the list shows what fits in the space measured after each render, from `top`.
	const list = useRef<DOMElement>(null);
	const [lines, setLines] = useState(0);
	useEffect(() => {
		if (!list.current) return;
		const measured = measureElement(list.current).height;
		if (measured !== lines) setLines(measured);
	});
	const top = useRef(0);
	top.current = Math.min(top.current, row);
	top.current = Math.max(top.current, row - Math.max(1, lines) + 1);

	const isDoubleClick = useDoubleClick();
	// The wheel stops at the ends rather than looping.
	const onMouse = ({ button, y }: MouseEvent) => {
		if (!active) return;
		board.setMessage('');
		const last = requests.length - 1;
		const wheel = button === 'wheelDown' ? 1 : button === 'wheelUp' ? -1 : 0;
		if (wheel) return setRow(r => Math.max(0, Math.min(last, r + wheel)));
		const r = top.current + y - LIST_TOP;
		if (button !== 'left' || y < LIST_TOP || r > last || r >= top.current + lines) return;
		setRow(r);
		if (isDoubleClick(requests[r]!.url)) viewReview(requests[r]!);
	};
	const onMouseRef = useRef(onMouse);
	onMouseRef.current = onMouse;
	useEffect(() => {
		const listener = (event: MouseEvent) => onMouseRef.current(event);
		mouse.on('press', listener);
		return () => void mouse.off('press', listener);
	}, []);

	return (
		<Box flexGrow={1} overflow="hidden" flexDirection="column">
			<Text bold>
				PRs waiting for your review <Text dimColor>(j/k move  ⏎/v view  b browser  r refresh  esc/q/R close, or click, double-click, scroll)</Text>
			</Text>
			<Text dimColor>
				{'─'.repeat(Math.max(0, width - 13))} {String(row + 1).padStart(4)} of {String(requests.length).padEnd(3)}
			</Text>
			<Box ref={list} flexGrow={1} flexBasis={0} flexDirection="column" overflow="hidden">
				{requests.slice(top.current, top.current + Math.max(1, lines)).map((r, i) => (
					<Text key={r.url} wrap="truncate" inverse={top.current + i === row}>
						<Text dimColor>{timeAgo(new Date(r.updatedAt)).padEnd(9)}</Text>
						<Text color={r.project.color}>{(r.project.abbrev || r.project.name).padEnd(6)} </Text>
						<Text color="cyan">#{r.number} </Text>
						{r.isDraft ? <Text dimColor>draft </Text> : null}
						{r.title} <Text dimColor>— {r.author.login}</Text>
					</Text>
				))}
			</Box>
		</Box>
	);
}
