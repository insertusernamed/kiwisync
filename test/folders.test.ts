import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { startHub } from './helpers';

test('an empty folder reaches other devices, and deleting it removes it everywhere', async (t) => {
  const hub = await startHub();
  t.after(hub.close);
  const ipad = await hub.client('iPad');
  const phone = await hub.client('Phone');

  await ipad.vault.createFolder('Projects/Ideas/');
  await ipad.sync();
  await phone.sync();
  assert.equal(await phone.vault.exists('Projects/Ideas'), true);
  assert.equal(await hub.hubVault.exists('Projects/Ideas'), true);

  await rm(join(ipad.vault.root, 'Projects'), { recursive: true });
  await ipad.sync();
  await phone.sync();
  assert.equal(await phone.vault.exists('Projects'), false);
  assert.equal(await hub.hubVault.exists('Projects'), false);
});

test('deleting a folder with notes in it removes the folder and notes everywhere', async (t) => {
  const hub = await startHub();
  t.after(hub.close);
  const ipad = await hub.client('iPad');
  const phone = await hub.client('Phone');
  await ipad.vault.edit('Book/Ch1/a.md', 'a\n');
  await ipad.vault.edit('Book/b.md', 'b\n');
  await ipad.vault.edit('Keep/c.md', 'c\n');
  await ipad.sync();
  await phone.sync();

  await rm(join(ipad.vault.root, 'Book'), { recursive: true });
  await ipad.sync();
  await phone.sync();

  for (const [vault, label] of [
    [phone.vault, 'phone'],
    [hub.hubVault, 'hub'],
  ] as const) {
    assert.equal(await vault.exists('Book'), false, label);
    assert.equal(await vault.text('Keep/c.md'), 'c\n', label);
  }
  assert.deepEqual(
    hub.hub
      .deleted()
      .map((d) => d.path)
      .sort(),
    ['Book/Ch1/a.md', 'Book/b.md'],
  );
});

test('a folder emptied by a move stays if the device that moved the file kept it', async (t) => {
  const hub = await startHub();
  t.after(hub.close);
  const ipad = await hub.client('iPad');
  const phone = await hub.client('Phone');
  await ipad.vault.edit('Inbox/note.md', 'n\n');
  await ipad.sync();
  await phone.sync();

  await ipad.move('Inbox/note.md', 'Archive/note.md');
  await ipad.sync();
  await phone.sync();
  assert.equal(await phone.vault.exists('Inbox'), true);
  assert.equal(await phone.vault.text('Archive/note.md'), 'n\n');
});

test('a folder deleted on one device is kept where another device added a note to it', async (t) => {
  const hub = await startHub();
  t.after(hub.close);
  const ipad = await hub.client('iPad');
  const phone = await hub.client('Phone');
  await ipad.vault.edit('Shared/old.md', 'old\n');
  await ipad.sync();
  await phone.sync();

  await rm(join(ipad.vault.root, 'Shared'), { recursive: true });
  await phone.vault.edit('Shared/new.md', 'written offline\n');
  await ipad.sync();
  await phone.sync();
  await ipad.sync();

  for (const [vault, label] of [
    [phone.vault, 'phone'],
    [ipad.vault, 'ipad'],
    [hub.hubVault, 'hub'],
  ] as const) {
    assert.equal(await vault.text('Shared/new.md'), 'written offline\n', label);
    assert.equal(await vault.text('Shared/old.md'), null, label);
  }
});

test('renaming a folder moves its notes and empty subfolders', async (t) => {
  const hub = await startHub();
  t.after(hub.close);
  const ipad = await hub.client('iPad');
  const phone = await hub.client('Phone');
  await ipad.vault.edit('Old/note.md', 'n\n');
  await ipad.vault.createFolder('Old/Empty/');
  await ipad.sync();
  await phone.sync();

  await rename(join(ipad.vault.root, 'Old'), join(ipad.vault.root, 'New'));
  ipad.engine.noteRename('Old/note.md', 'New/note.md');
  await ipad.sync();
  await phone.sync();

  assert.equal(await phone.vault.text('New/note.md'), 'n\n');
  assert.equal(await phone.vault.exists('New/Empty'), true);
  assert.equal(await phone.vault.exists('Old'), false);
  assert.equal(await hub.hubVault.exists('Old'), false);
  assert.equal((await hub.hub.history('New/note.md'))[0]!.kind, 'rename');
});

test('folders made or removed directly in the hub folder reach devices', async (t) => {
  const hub = await startHub();
  t.after(hub.close);
  const phone = await hub.client('Phone');
  await mkdir(join(hub.hubVault.root, 'From hub/Inner'), { recursive: true });
  await hub.hub.scan();
  await phone.sync();
  assert.equal(await phone.vault.exists('From hub/Inner'), true);

  await rm(join(hub.hubVault.root, 'From hub'), { recursive: true });
  await hub.hub.scan();
  await phone.sync();
  assert.equal(await phone.vault.exists('From hub'), false);
});
