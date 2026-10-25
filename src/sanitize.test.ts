import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseUntrusted, sanitize } from './sanitize.js';

test('sanitize keeps text, newlines and tabs', () => {
	assert.equal(sanitize('Fix the — bug\n\tin café 🚀'), 'Fix the — bug\n\tin café 🚀');
});

test('sanitize drops control characters, DEL, C1 and carriage returns', () => {
	assert.equal(sanitize('a\x00b\x07c\x08d\x7fe\x9bf\x85g'), 'abcdefg');
	assert.equal(sanitize('line one\r\nline two\r\n'), 'line one\nline two\n');
});

test('sanitize drops escape sequences whole, keeping the text between them', () => {
	assert.equal(sanitize('\x1b[31mred\x1b[0m and \x1b[2Jclear'), 'red and clear');
	assert.equal(sanitize('see \x1b]8;;https://evil.example\x1b\\the docs\x1b]8;;\x1b\\ now'), 'see the docs now');
	assert.equal(sanitize('\x1b]0;new title\x07title'), 'title');
	assert.equal(sanitize('\x1bcreset'), 'reset');
	assert.equal(sanitize('trailing \x1b'), 'trailing ');
});

test('parseUntrusted sanitizes every string, nested too, and leaves other values', () => {
	const parsed = parseUntrusted<unknown>(JSON.stringify({ title: 'a\x1b[1mb', n: 3, draft: false, none: null, reviews: [{ body: 'x\x07y' }] }));
	assert.deepEqual(parsed, { title: 'ab', n: 3, draft: false, none: null, reviews: [{ body: 'xy' }] });
});
