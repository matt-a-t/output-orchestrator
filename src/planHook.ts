#!/usr/bin/env node
// Claude hook, run after ExitPlanMode: once you approve the plan of a thread in Planned, save it
// and move the thread to Active (see planApproved). Must never fail or block claude.
import { readFileSync } from 'node:fs';
import { defaultContext, planApproved } from './threadCommand.js';

try {
	const message = await planApproved(JSON.parse(readFileSync(0, 'utf8')), defaultContext());
	if (message) {
		// Tell claude its thread is Active now, so it knows it can start changing code.
		console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `oo board: ${message}` } }));
	}
} catch {}
