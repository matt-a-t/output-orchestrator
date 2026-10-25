import { unwatchFile, watchFile } from 'node:fs';
import { useEffect } from 'react';
import { RequestReader, requestsFile, respond, type Request, type Response } from '../requests.js';
import { draftPr, withTicket } from '../github.js';
import { applyRequest, moveProblem } from '../threads.js';
import type { Board, Outcome } from './board.js';
import { enterLocal, leaveLocal, localProblem } from './local.js';
import { messageRequest } from './messages.js';
import { openPr } from './pr.js';

/** Like t, except that it waits for the thread's claude instead of refusing: it's often the one asking. */
async function localRequest(board: Board, { id, thread: threadId, local }: Extract<Request, { op: 'local' }>): Promise<Response> {
	const thread = board.state().threads.find(t => t.id === threadId);
	if (!thread) return { id, ok: false, message: `No thread #${threadId}` };
	const answer = (outcome: Outcome): Response => ({ id, ...outcome, thread: thread.id });
	const entering = local === 'toggle' ? !thread.local : local;
	if (entering === !!thread.local) return answer({ ok: true, message: `#${thread.id} is already ${entering ? 'in' : 'out of'} Local` });
	const problem = await localProblem(board, thread, entering);
	if (problem) return answer({ ok: false, message: problem });
	if (!thread.cwd && board.statuses()[thread.id] === 'working') {
		board.pendingLocal.set(thread.id, entering);
		const where = entering ? 'goes into Local' : 'comes out of Local, back to its worktree,';
		return answer({ ok: true, message: `#${thread.id} ${where} when its claude's turn ends` });
	}
	board.setBusy(entering ? 'checking out for Local' : 'leaving Local');
	try {
		return answer(await (entering ? enterLocal : leaveLocal)(board, thread));
	} finally {
		board.setBusy(null);
	}
}

/** Like moving to PR on the board, except the description is given (or claude's draft, unedited) and there's no popup. */
async function prRequest(board: Board, { id, thread: threadId, title, body }: Extract<Request, { op: 'pr' }>): Promise<Response> {
	const state = board.state();
	const thread = state.threads.find(t => t.id === threadId);
	if (!thread) return { id, ok: false, message: `No thread #${threadId}` };
	const answer = (outcome: Outcome): Response => ({ id, ...outcome, thread: thread.id });
	const problem = moveProblem(state, thread, 'pr');
	if (problem) return answer({ ok: false, message: problem });
	try {
		return answer(
			await openPr(board, thread, {
				status: text => board.setBusy(text),
				describe: async (cwd, thread, base) => {
					const draft =
						body !== undefined
							? { title: title ?? thread.title, body }
							: await draftPr(cwd, thread, base).then(written => written && { ...written, ...(title !== undefined && { title }) });
					return withTicket(draft ?? { title: title ?? thread.title, body: thread.plan }, thread.ticket);
				},
				close: async () => {},
			}),
		);
	} finally {
		board.setBusy(null);
	}
}

/** Apply `oo thread …` requests (see requests.ts), one at a time. */
export function useRequests(board: Board) {
	useEffect(() => {
		const reader = new RequestReader();
		let queue = Promise.resolve();
		const poll = () => {
			for (const request of reader.read()) {
				queue = queue.then(async () => {
					const handled =
						request.op === 'local'
							? localRequest(board, request)
							: request.op === 'pr'
								? prRequest(board, request)
								: request.op === 'send'
									? messageRequest(board, request)
									: applyRequest(board.store, request);
					const response = await handled.catch(err => ({
						id: request.id,
						ok: false,
						message: err instanceof Error ? err.message : String(err),
					}));
					respond(response);
					board.setMessage(`${response.ok ? '' : '✗ '}oo thread: ${response.message.replaceAll('\n', ' · ')}`);
					await board.refreshWindows();
				});
			}
		};
		poll();
		watchFile(requestsFile(), { interval: 500 }, poll);
		return () => unwatchFile(requestsFile(), poll);
	}, []);
}
