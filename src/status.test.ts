import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeSettings, fromThreadDir, nextStatus, ooWrapper, SKILL, skillPrompt, threadStatus, type HookEvent } from './status.js';

const dir = '/home/matt/.local/share/output-orchestrator/worktrees/output-orchestrator/15';
const event = (cwd?: string): HookEvent => ({ thread: '15', event: 'SessionStart', cwd, ts: '' });

test('keeps events from the thread directory', () => {
	assert.ok(fromThreadDir(event(dir), dir));
	assert.ok(fromThreadDir(event(dir + '/'), dir));
});

test('keeps events from a subfolder of the thread directory', () => {
	assert.ok(fromThreadDir(event(dir + '/src'), dir));
});

test('drops events from another directory', () => {
	assert.ok(!fromThreadDir(event('/home/matt/.local/share/output-orchestrator/worktrees/rensim-data/17'), dir));
	assert.ok(!fromThreadDir(event('/home/matt'), dir));
});

test('drops events from a sibling sharing the directory as a prefix', () => {
	assert.ok(!fromThreadDir(event(dir + '0'), dir));
});

test('keeps events it cannot check', () => {
	assert.ok(fromThreadDir(event(), dir));
	assert.ok(fromThreadDir(event(dir), undefined));
});

const named = (name: string): HookEvent => ({ thread: '15', event: name, ts: '' });

test('a session ending mid-work is interrupted', () => {
	assert.equal(nextStatus('working', named('SessionEnd')), 'interrupted');
	assert.equal(nextStatus('stopped', named('SessionEnd')), 'ended');
	assert.equal(nextStatus('interrupted', named('SessionStart')), 'idle');
});

test("a thread's status folds all of its events from its directory", () => {
	const file = join(mkdtempSync(join(tmpdir(), 'oo-events-')), 'events.jsonl');
	const line = (thread: string, event: string, cwd = dir) => JSON.stringify({ thread, event, cwd, ts: '' });
	writeFileSync(file, [line('15', 'SessionStart'), line('15', 'UserPromptSubmit'), line('15', 'Stop'), line('16', 'UserPromptSubmit'), line('15', 'UserPromptSubmit', '/elsewhere')].join('\n') + '\n');
	assert.equal(threadStatus('15', dir, file), 'stopped');
	assert.equal(threadStatus('16', undefined, file), 'working');
	assert.equal(threadStatus('17', undefined, file), undefined);
});

test("a container's claude runs the same hooks with the image's node", () => {
	const host = JSON.stringify(claudeSettings(process.execPath));
	const container = JSON.stringify(claudeSettings('node'));
	assert.ok(!container.includes(process.execPath));
	assert.equal(container, host.replaceAll(`'${process.execPath}'`, `'node'`));
	assert.deepEqual(Object.keys(claudeSettings('node').hooks), ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd']);
});

test("a container's oo runs this cli with the image's node", () => {
	const wrapper = ooWrapper();
	assert.match(wrapper, /^#!\/bin\/sh\nexec node --no-warnings .*cli\.tsx?' "\$@"\n$/);
	assert.ok(!wrapper.includes(process.execPath));
});

test('the skill prompt is the skill without its frontmatter', () => {
	const prompt = skillPrompt();
	assert.ok(!prompt.startsWith('---'));
	assert.ok(!prompt.includes('description: Read and change'));
	assert.ok(SKILL.endsWith(prompt));
	assert.equal(skillPrompt('---\nname: x\n---\n\n# Body\n'), '# Body\n');
});
