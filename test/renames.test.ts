import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { startHub } from './helpers';

test('a rename moves the file on every device and its history follows it', async (t) => {
  const hub = await startHub();
  t.after(hub.close);
  const a = await hub.client('A');
  const b = await hub.client('B');
  await a.vault.edit('Draft.md', 'v1\n');
  await a.sync();
  await b.sync();
  await b.vault.edit('Draft.md', 'v2\n');
  await b.sync();
  await a.sync();

  await a.move('Draft.md', 'Notes/Final.md');
  await a.sync();
  await b.sync();

  assert.equal(await b.vault.text('Draft.md'), null);
  assert.equal(await b.vault.text('Notes/Final.md'), 'v2\n');
  assert.equal(await hub.hubVault.text('Notes/Final.md'), 'v2\n');
  assert.equal(await hub.hubVault.text('Draft.md'), null);

  const history = await hub.hub.history('Notes/Final.md');
  assert.deepEqual(
    history.map((h) => [h.kind, h.device, h.from ?? null]),
    [
      ['rename', 'A', 'Draft.md'],
      ['edit', 'B', null],
      ['edit', 'A', null],
    ],
  );
  assert.deepEqual(hub.hub.deleted(), []);
});

test('an edit made under the old name on another device lands in the renamed file', async (t) => {
  const hub = await startHub();
  t.after(hub.close);
  const a = await hub.client('A');
  const b = await hub.client('B');
  await a.vault.edit('n.md', 'one\ntwo\nthree\n');
  await a.sync();
  await b.sync();

  await a.move('n.md', 'renamed.md');
  await a.vault.edit('renamed.md', 'ONE\ntwo\nthree\n');
  await b.vault.edit('n.md', 'one\ntwo\nTHREE\n');
  await a.sync();
  await b.sync();
  await a.sync();

  const merged = 'ONE\ntwo\nTHREE\n';
  assert.equal(await b.vault.text('n.md'), null);
  assert.equal(await b.vault.text('renamed.md'), merged);
  assert.equal(await a.vault.text('renamed.md'), merged);
  assert.equal(await hub.hubVault.text('n.md'), null);
});

test('renaming a folder moves each file inside it', async (t) => {
  const hub = await startHub();
  t.after(hub.close);
  const a = await hub.client('A');
  const b = await hub.client('B');
  await a.vault.edit('Old/x.md', 'x\n');
  await a.vault.edit('Old/y.md', 'y\n');
  await a.sync();
  await b.sync();

  await mkdir(join(a.vault.root, 'New'));
  await rename(join(a.vault.root, 'Old/x.md'), join(a.vault.root, 'New/x.md'));
  await rename(join(a.vault.root, 'Old/y.md'), join(a.vault.root, 'New/y.md'));
  a.engine.noteRename('Old/x.md', 'New/x.md');
  a.engine.noteRename('Old/y.md', 'New/y.md');
  await a.sync();
  await b.sync();

  assert.equal(await b.vault.text('New/x.md'), 'x\n');
  assert.equal(await b.vault.text('New/y.md'), 'y\n');
  assert.equal(await b.vault.text('Old/x.md'), null);
  assert.equal((await hub.hub.history('New/y.md')).length, 2);
});

test('a file renamed twice before syncing is sent as one rename', async (t) => {
  const hub = await startHub();
  t.after(hub.close);
  const a = await hub.client('A');
  await a.vault.edit('first.md', 'text\n');
  await a.sync();
  await a.move('first.md', 'second.md');
  await a.move('second.md', 'third.md');
  await a.sync();
  const history = await hub.hub.history('third.md');
  assert.deepEqual(
    history.map((h) => [h.kind, h.from ?? null]),
    [
      ['rename', 'first.md'],
      ['edit', null],
    ],
  );
});

test('a file moved in the hub folder is renamed on devices', async (t) => {
  const hub = await startHub();
  t.after(hub.close);
  const a = await hub.client('A');
  await a.vault.edit('Inbox/idea.md', 'idea\n');
  await a.sync();

  await mkdir(join(hub.hubVault.root, 'Projects'));
  await rename(
    join(hub.hubVault.root, 'Inbox/idea.md'),
    join(hub.hubVault.root, 'Projects/idea.md'),
  );
  await hub.hub.scan();
  await a.sync();

  assert.equal(await a.vault.text('Projects/idea.md'), 'idea\n');
  assert.equal(await a.vault.text('Inbox/idea.md'), null);
  const history = await hub.hub.history('Projects/idea.md');
  assert.equal(history.length, 2);
  assert.deepEqual(hub.hub.deleted(), []);
});
