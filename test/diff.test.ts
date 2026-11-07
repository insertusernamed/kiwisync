import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, withContext } from '../src/shared/diff';

const marks = (before: string, after: string) =>
  diffLines(before, after)!.map(
    (l) => `${{ same: ' ', added: '+', removed: '-' }[l.kind]}${l.text}`,
  );

test('a changed line shows as removed then added, with the rest unchanged', () => {
  assert.deepEqual(marks('a\nb\nc', 'a\nB\nc'), [' a', '-b', '+B', ' c']);
});

test('added and removed lines in different places', () => {
  assert.deepEqual(marks('one\ntwo\nthree\nfour', 'zero\none\nthree\nfour\nfive'), [
    '+zero',
    ' one',
    '-two',
    ' three',
    ' four',
    '+five',
  ]);
});

test('identical texts, empty texts, and Windows line endings', () => {
  assert.deepEqual(marks('x\ny', 'x\ny'), [' x', ' y']);
  assert.deepEqual(marks('', 'new'), ['-', '+new']);
  assert.deepEqual(marks('a\r\nb', 'a\nb'), [' a', ' b']);
});

test('unchanged stretches are folded, keeping lines around each change', () => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
  const after = before.replace('line 10', 'changed');
  const rows = withContext(diffLines(before, after)!, 2);
  assert.deepEqual(rows[0], { kind: 'skipped', count: 8 });
  assert.deepEqual(
    rows.slice(1, -1).map((r) => ('text' in r ? r.text : r.count)),
    ['line 8', 'line 9', 'line 10', 'changed', 'line 11', 'line 12'],
  );
  assert.deepEqual(rows.at(-1), { kind: 'skipped', count: 7 });
});

test('a single unchanged line between changes is shown, not folded', () => {
  const rows = withContext(diffLines('a\nx1\nkeep\nx2\nb', 'A\nx1\nkeep\nx2\nB')!, 1);
  assert.ok(rows.every((r) => r.kind !== 'skipped'));
  assert.ok(rows.some((r) => 'text' in r && r.text === 'keep'));
});

test('very large, very different files are not compared', () => {
  const big = (seed: string) => Array.from({ length: 3000 }, (_, i) => `${seed}${i}`).join('\n');
  assert.equal(diffLines(big('a'), big('b')), null);
});
