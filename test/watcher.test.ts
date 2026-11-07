import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FolderWatcher } from '../src/server/watcher';
import { tick } from './helpers';

test('the folder watcher notices changes deep inside subfolders', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'kiwisync-watch-'));
  const deep = join(root, 'Drawings', 'CH2');
  await mkdir(deep, { recursive: true });
  let changes = 0;
  const watcher = new FolderWatcher(() => changes++);
  t.after(async () => {
    watcher.close();
    await rm(root, { recursive: true, force: true });
  });
  watcher.update([root, join(root, 'Drawings'), deep]);

  await writeFile(join(deep, 'Trial Balance.md'), 'v1');
  await tick(200);
  assert.ok(changes > 0, 'a change two folders down');

  changes = 0;
  await writeFile(join(deep, '.kiwisync-temp'), 'x');
  await tick(200);
  assert.equal(changes, 0, 'hidden files are ignored');

  await rm(join(root, 'Drawings'), { recursive: true });
  watcher.update([root]);
  await writeFile(join(root, 'note.md'), 'n');
  await tick(200);
  assert.ok(changes > 0, 'still watching after a folder disappears');
});
