// The PRs waiting for your review (`R`), across projects, in place of the columns.

import { existsSync } from 'node:fs';
import { useState } from 'react';
import { Text } from 'ink';
import { openPrInBrowser, reviewRequests, type ReviewRequest } from '../github.js';
import type { Project } from '../state.js';
import { timeAgo } from '../transcripts.js';
import type { Board } from './board.js';
import { viewPr } from './pr.js';
import { ScrollList } from './scrollList.js';

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

	return (
		<ScrollList
			board={board}
			items={requests}
			itemKey={r => r.url}
			title={
				<>
					PRs waiting for your review <Text dimColor>(j/k move  ⏎/v view  b browser  r refresh  esc/q/R close, or click, double-click, scroll)</Text>
				</>
			}
			row={row}
			setRow={setRow}
			active={active}
			onActivate={viewReview}
			onInput={(input, key, review) => {
				if (input === 'q' || input === 'R' || key.escape) return onClose();
				if (input === 'r') return board.run(refresh, 'looking for review requests');
				if (!review) return;
				if (input === 'v') return viewReview(review);
				if (input === 'b') return board.run(() => openPrInBrowser(review), 'opening PR in the browser');
			}}
			renderItem={(r, selected) => (
				<Text wrap="truncate" inverse={selected}>
					<Text dimColor>{timeAgo(new Date(r.updatedAt)).padEnd(9)}</Text>
					<Text color={r.project.color}>{(r.project.abbrev || r.project.name).padEnd(6)} </Text>
					<Text color="cyan">#{r.number} </Text>
					{r.isDraft ? <Text dimColor>draft </Text> : null}
					{r.title} <Text dimColor>— {r.author.login}</Text>
				</Text>
			)}
		/>
	);
}
