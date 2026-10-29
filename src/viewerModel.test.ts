import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampScroll, contextLabel, fileLabel, findMatches, hunkRows, nextMatch, nextRow, plainLines, splitPatch, stepContext } from './viewerModel.js';

const DIFF = `diff --git a/src/greet.ts b/src/greet.ts
index 3b18e51..a9c2f4d 100644
--- a/src/greet.ts
+++ b/src/greet.ts
@@ -1,3 +1,3 @@
 export function greet(who: string): string {
-	return 'Hello, ' + who;
+	return \`Hello, \${who}!\`;
--- not a header, a removed line
 }
diff --git a/old name.ts b/new name.ts
similarity index 90%
rename from old name.ts
rename to new name.ts
diff --git a/added.ts b/added.ts
new file mode 100644
index 0000000..c40b9e3
--- /dev/null
+++ b/added.ts
@@ -0,0 +1,2 @@
+one
+two
diff --git a/gone.png b/gone.png
deleted file mode 100644
index 7d1e2a0..0000000
Binary files a/gone.png and /dev/null differ
`;

test('splits a diff into its files, counting what each adds and removes', () => {
	const files = splitPatch(DIFF);
	assert.deepEqual(
		files.map(({ text: _, ...f }) => f),
		[
			{ path: 'src/greet.ts', oldPath: 'src/greet.ts', status: 'modified', binary: false, added: 1, removed: 2 },
			{ path: 'new name.ts', oldPath: 'old name.ts', status: 'renamed', binary: false, added: 0, removed: 0 },
			{ path: 'added.ts', oldPath: 'added.ts', status: 'added', binary: false, added: 2, removed: 0 },
			{ path: 'gone.png', oldPath: 'gone.png', status: 'deleted', binary: true, added: 0, removed: 0 },
		],
	);
	assert.ok(files[0]!.text.startsWith('diff --git a/src/greet.ts'));
	assert.ok(files[0]!.text.endsWith(' }\n'));
	assert.equal(files.map(f => f.text).join(''), DIFF);
	assert.equal(fileLabel(files[1]!), 'old name.ts → new name.ts');
	assert.deepEqual(splitPatch(''), []);
});

test('unquotes paths git quoted', () => {
	const [file] = splitPatch('diff --git "a/tab\\there" "b/tab\\there"\n--- "a/tab\\there"\n+++ "b/tab\\there"\t\n@@ -1 +1 @@\n-a\n+b\n');
	assert.equal(file!.path, 'tab\there');
	assert.equal(file!.oldPath, 'tab\there');
});

test('steps context up and down, ending at the whole file', () => {
	assert.equal(stepContext(3, 1), 10);
	assert.equal(stepContext(10, -1), 3);
	assert.equal(stepContext(3, -1), 3);
	assert.equal(stepContext(25, 1), 99_999);
	assert.equal(stepContext(99_999, 1), 99_999);
	assert.equal(stepContext(7, 1), 25);
	assert.equal(contextLabel(10), '10 lines of context');
	assert.equal(contextLabel(99_999), 'whole file');
});

test("finds delta's hunk labels under its colours", () => {
	const plain = plainLines(['\x1b[1mΔ src/greet.ts\x1b[0m', '\x1b[2m• 1: export function\x1b[0m', 'code', '• 12: other']);
	assert.deepEqual(hunkRows(plain), [1, 3]);
	assert.equal(nextRow([1, 3], 0, 1), 1);
	assert.equal(nextRow([1, 3], 1, 1), 3);
	assert.equal(nextRow([1, 3], 3, 1), undefined);
	assert.equal(nextRow([1, 3], 3, -1), 1);
	assert.equal(nextRow([1, 3], 1, -1), undefined);
});

test('searches every file, moving between matches and wrapping around', () => {
	const matches = findMatches([['Hello there', 'nothing'], [], ['say hello', 'HELLO']], 'hello');
	assert.deepEqual(matches, [{ file: 0, row: 0 }, { file: 2, row: 0 }, { file: 2, row: 1 }]);
	assert.deepEqual(nextMatch(matches, 0, 0, 1), { file: 2, row: 0 });
	assert.deepEqual(nextMatch(matches, 1, 5, 1), { file: 2, row: 0 });
	assert.deepEqual(nextMatch(matches, 2, 1, 1), { file: 0, row: 0 });
	assert.deepEqual(nextMatch(matches, 0, 0, -1), { file: 2, row: 1 });
	assert.deepEqual(nextMatch(matches, 2, 0, -1), { file: 0, row: 0 });
	assert.equal(nextMatch([], 0, 0, 1), undefined);
	assert.deepEqual(findMatches([['a']], ''), []);
});

test('keeps the scroll within the text', () => {
	assert.equal(clampScroll(-3, 100, 20), 0);
	assert.equal(clampScroll(50, 100, 20), 50);
	assert.equal(clampScroll(95, 100, 20), 80);
	assert.equal(clampScroll(5, 10, 20), 0);
});
