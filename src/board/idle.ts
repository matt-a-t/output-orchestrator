// Closing claude windows that have sat quiet a while: w or ⏎ resumes them, and a closed claude costs nothing.
// A large conversation whose cache is still warm is compacted first, so resuming it later sends the summary.

import { useEffect } from 'react';
import { compactedSince, quietThreads, worthCompacting } from '../idle.js';
import { claudeShellRunning, pasteInto, processList, threadWindowName, windowInfo } from '../tmux.js';
import { contextUse, formatTokens } from '../transcripts.js';
import type { Thread } from '../state.js';
import type { Board } from './board.js';
import { closeClaude } from './claude.js';
import { threadRunning } from '../commands.js';
import { containerName, containerProcesses, containerProject, stopContainer } from '../container.js';

const CHECK_EVERY = 60_000;
// A compaction that hasn't shown up in the transcript by now has failed; close the window anyway.
const COMPACT_TIMEOUT = 10 * 60_000;

/**
 * Every minute, close the windows of threads quietThreads picks whose claude has no shell still running,
 * compacting the ones worthCompacting picks first and closing them once that's done.
 */
export function useIdleClose(board: Board) {
	useEffect(() => {
		let checking = false;
		// Threads told to /compact before closing: thread id → when.
		const compacting = new Map<string, number>();
		// The turns already compacted (or tried): thread id → that turn's time, so a failed compaction isn't sent again.
		const tried = new Map<string, number>();
		const check = async () => {
			if (checking) return;
			checking = true;
			try {
				const windows = await windowInfo();
				const now = Date.now();
				/** Which of `threads` are quiet, with `since` for when each went quiet. */
				const quietAmong = (threads: Thread[], since = board.statusSince) =>
					quietThreads(threads, board.state().projects, board.statuses(), since, windows, board.pendingLocal, Date.now());
				// Each window to close, and a check that it's still quiet, made again just before closing it.
				const candidates: { thread: Thread; stillQuiet: () => boolean }[] = [];
				// Compacting restarts claude's session, which resets its quiet clock: close it once it's done
				// (or given up on) if it's still left alone, as though it had stayed quiet throughout.
				for (const [id, sentAt] of compacting) {
					const thread = board.state().threads.find(t => t.id === id);
					const use = thread?.transcriptPath ? contextUse(thread.transcriptPath, { fresh: true }) : undefined;
					// A turn since means someone took it up again: leave it to the usual quiet clock.
					const usedSince = !!use && !use.compacted && use.at > sentAt;
					if (thread && !usedSince && !compactedSince(use, sentAt) && now - sentAt < COMPACT_TIMEOUT) continue;
					compacting.delete(id);
					if (usedSince) continue;
					const stillQuiet = () => !!thread && quietAmong([thread], new Map([[id, 0]])).length > 0;
					if (thread && stillQuiet()) candidates.push({ thread, stillQuiet });
				}
				for (const thread of quietAmong(board.state().threads)) {
					if (compacting.has(thread.id) || candidates.some(c => c.thread.id === thread.id)) continue;
					const use = thread.transcriptPath ? contextUse(thread.transcriptPath, { fresh: true }) : undefined;
					if (use && worthCompacting(thread, use, now) && tried.get(thread.id) !== use.at) {
						tried.set(thread.id, use.at);
						await compact(board, thread, use.tokens);
						compacting.set(thread.id, now);
						continue;
					}
					candidates.push({ thread, stillQuiet: () => quietAmong([thread]).length > 0 });
				}
				if (candidates.length === 0) return;
				const ps = await processList();
				const closed: string[] = [];
				const stopping: Promise<void>[] = [];
				for (const { thread, stillQuiet } of candidates) {
					const window = windows.find(w => w.name === threadWindowName(thread.id))!;
					const project = containerProject(board.project(thread.project));
					// In a container, claude's shells aren't under its window's process but the container's (pid 0's tree there).
					const shellRunning = project ? claudeShellRunning(await containerProcesses(containerName(thread)), 0) : claudeShellRunning(ps, window.pid);
					// Checked again just before, in case claude was told something since.
					if (shellRunning || !stillQuiet()) continue;
					if (!(await closeClaude(board, thread))) continue;
					closed.push(`#${thread.id}`);
					// Its dev servers and databases stop using memory too, unless one of its commands or Local is using them.
					if (project && !thread.local && !threadRunning(board.runs(), project, thread)) stopping.push(stopContainer(containerName(thread)));
				}
				await Promise.all(stopping);
				if (closed.length) board.setMessage(`Closed idle claude for ${closed.join(', ')} · w or ⏎ resumes it`);
			} catch {
				// Not in tmux, or a window went as it was looked at: try again next time.
			} finally {
				checking = false;
			}
		};
		const timer = setInterval(() => void check(), CHECK_EVERY);
		return () => clearInterval(timer);
	}, []);
}

/** Tell the thread's claude to /compact; it's at its prompt with nothing to do, as quietThreads checked. */
async function compact(board: Board, thread: Thread, tokens: number) {
	await pasteInto(threadWindowName(thread.id), '/compact');
	board.setMessage(`Compacting #${thread.id}'s idle claude (${formatTokens(tokens)} tokens) while its cache is warm, then closing it`);
}
