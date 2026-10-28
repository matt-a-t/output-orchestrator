// Closing claude windows that have sat quiet a while: w or ⏎ resumes them, and a closed claude costs nothing.

import { useEffect } from 'react';
import { quietThreads } from '../idle.js';
import { claudeShellRunning, processList, threadWindowName, windowInfo } from '../tmux.js';
import type { Board } from './board.js';
import { closeClaude } from './claude.js';

const CHECK_EVERY = 60_000;

/** Every minute, close the windows of threads quietThreads picks whose claude has no shell still running. */
export function useIdleClose(board: Board) {
	useEffect(() => {
		let checking = false;
		const check = async () => {
			if (checking) return;
			checking = true;
			try {
				const windows = await windowInfo();
				const quiet = () =>
					quietThreads(board.state().threads, board.state().projects, board.statuses(), board.statusSince, windows, board.pendingLocal, Date.now());
				const candidates = quiet();
				if (candidates.length === 0) return;
				const ps = await processList();
				const closed: string[] = [];
				for (const thread of candidates) {
					const window = windows.find(w => w.name === threadWindowName(thread.id))!;
					// Checked again just before, in case claude was told something since.
					if (claudeShellRunning(ps, window.pid) || !quiet().some(t => t.id === thread.id)) continue;
					if (await closeClaude(board, thread)) closed.push(`#${thread.id}`);
				}
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
