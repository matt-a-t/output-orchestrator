#!/usr/bin/env node
// Claude hook, run after claude's task tools (TaskCreate, TaskUpdate, TodoWrite): copy claude's task
// list onto its thread, for the board to show (see tasksChanged). Must never fail or block claude.
import { readFileSync } from 'node:fs';
import { defaultContext, tasksChanged } from './threadCommand.js';

try {
	await tasksChanged(JSON.parse(readFileSync(0, 'utf8')), defaultContext());
} catch {}
