// Messages from one thread's claude to another's (`oo thread send`), put to the receiving claude by the board.

import { useEffect, useRef } from 'react';
import type { Request, Response } from '../requests.js';
import { USER_SENDER, type Message, type State, type Thread } from '../state.js';
import type { Status } from '../status.js';
import { applyRequest, markDelivered, messagesPrompt, senderLabel, undelivered } from '../threads.js';
import { pasteInto, threadWindowName, windowNames } from '../tmux.js';
import type { Board } from './board.js';
import { wakeThread } from './claude.js';

/**
 * Like any other request, except that --wake resumes a closed claude to hear the message now. That's
 * after answering, so the SessionStart hook isn't held up behind it; an open claude hears it once its turn ends, as without --wake.
 */
export async function messageRequest(board: Board, request: Extract<Request, { op: 'send' }>): Promise<Response> {
	// Anything with a shell can write requests.jsonl; only the board itself sends as the user.
	if (request.from === USER_SENDER) return { id: request.id, ok: false, message: 'Only the board sends as the user' };
	const response = await applyRequest(board.store, request);
	const thread = board.state().threads.find(t => t.id === request.thread);
	if (!response.ok || !request.wake || !thread || !(await wakeToHear(board, thread))) return response;
	return { ...response, message: `Sent to #${thread.id}; waking its claude to hear it` };
}

/**
 * Resume the thread's claude if it's closed, to hear its waiting messages now; returns whether it's waking.
 * An open one hears them once its turn ends (see useMessageDelivery).
 */
export async function wakeToHear(board: Board, thread: Thread): Promise<boolean> {
	if ((await windowNames()).includes(threadWindowName(thread.id))) return false;
	// Delivered by the prompt, so its claude's start doesn't brief it with them too; back to waiting if it doesn't wake.
	const sent = undelivered(thread.inbox);
	const isSent = (m: Message) => sent.some(s => s.ts === m.ts && s.text === m.text);
	const setDelivered = (delivered: boolean) =>
		board.store.update(s => ({
			...s,
			threads: s.threads.map(t => (t.id === thread.id ? { ...t, inbox: t.inbox?.map(m => (isSent(m) ? { ...m, delivered } : m)) } : t)),
		}));
	setDelivered(true);
	void wakeThread(board, thread, messagesPrompt(board.state(), sent)).then(woke => woke || setDelivered(false));
	return true;
}

/**
 * Messages are pasted in once the claude's turn ends: not while it's waiting on a question, where the paste
 * would land as the answer, nor as it starts, when the SessionStart briefing has them.
 */
export function useMessageDelivery(board: Board, state: State, statuses: Record<string, Status>) {
	// Threads whose messages are being pasted in right now, so they're only pasted once.
	const delivering = useRef(new Set<string>());
	useEffect(() => {
		for (const thread of state.threads) {
			const messages = undelivered(thread.inbox);
			const window = threadWindowName(thread.id);
			if (!messages.length || statuses[thread.id] !== 'stopped' || !board.liveWindows().has(window) || delivering.current.has(thread.id)) continue;
			delivering.current.add(thread.id);
			void (async () => {
				try {
					if (board.statuses()[thread.id] !== 'stopped' || !(await windowNames()).includes(window)) return;
					await pasteInto(window, messagesPrompt(board.state(), messages));
					const inbox = board.state().threads.find(t => t.id === thread.id)?.inbox ?? [];
					board.updateThread(thread.id, { inbox: markDelivered(inbox, messages.length) });
					const from = [...new Set(messages.map(m => senderLabel(m.from)))].join(', ');
					board.setMessage(`Told #${thread.id} · ${messages.length === 1 ? 'message' : `${messages.length} messages`} from ${from}`);
				} catch (err) {
					board.setMessage(`✗ Couldn't tell #${thread.id} its messages: ${err instanceof Error ? err.message : String(err)}`);
				} finally {
					delivering.current.delete(thread.id);
				}
			})();
		}
	}, [state, statuses]);
}
