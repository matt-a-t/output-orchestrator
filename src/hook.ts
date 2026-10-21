#!/usr/bin/env node
// Claude Code hook: appends one line per event to the board's events file.
// Kept free of dependencies (and runnable via Node's type stripping) so it starts fast.
// Must never fail or block the claude session, so all errors are swallowed.
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const thread = process.env.OO_THREAD_ID;
const dataDir = join(homedir(), '.local', 'share', 'output-orchestrator');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => (input += chunk));
process.stdin.on('end', () => {
	if (!thread) return;
	try {
		const data = JSON.parse(input);
		const line = JSON.stringify({
			thread,
			event: data.hook_event_name,
			session: data.session_id,
			transcript: data.transcript_path,
			type: data.notification_type,
			ts: new Date().toISOString(),
		});
		mkdirSync(dataDir, { recursive: true });
		appendFileSync(join(dataDir, 'events.jsonl'), line + '\n');
	} catch {}
});
