import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startHub, tick } from './helpers';

test('edits, new files, and deletions reach every device and the hub folder', async (t) => {
  const hub = await startHub();
  t.after(hub.close);
  const laptop = await hub.client('Laptop');
  const phone = await hub.client('Phone');

  await laptop.vault.edit('Notes/Plan.md', 'first\n');
  await laptop.sync();
  await phone.sync();
  assert.equal(await phone.vault.text('Notes/Plan.md'), 'first\n');
  assert.equal(await hub.hubVault.text('Notes/Plan.md'), 'first\n');

  await phone.vault.edit('Notes/Plan.md', 'second\n');
  await phone.sync();
  await laptop.sync();
  assert.equal(await laptop.vault.text('Notes/Plan.md'), 'second\n');

  await laptop.vault.delete('Notes/Plan.md');
  await laptop.sync();
  await phone.sync();
  assert.equal(await phone.vault.text('Notes/Plan.md'), null);
  assert.equal(await hub.hubVault.text('Notes/Plan.md'), null);

  const history = await hub.hub.history('Notes/Plan.md');
  assert.deepEqual(
    history.map((h) => [h.kind, h.device]),
    [
      ['delete', 'Laptop'],
      ['edit', 'Phone'],
      ['edit', 'Laptop'],
    ],
  );
  assert.deepEqual(
    hub.hub.deleted().map((d) => d.path),
    ['Notes/Plan.md'],
  );
});

test('edits to different parts of a note made offline on two devices are combined', async (t) => {
  const hub = await startHub();
  t.after(hub.close);
  const a = await hub.client('A');
  const b = await hub.client('B');
  await a.vault.edit('n.md', 'one\ntwo\nthree\nfour\nfive\n');
  await a.sync();
  await b.sync();

  await a.vault.edit('n.md', 'ONE\ntwo\nthree\nfour\nfive\n');
  await b.vault.edit('n.md', 'one\ntwo\nthree\nfour\nFIVE\n');
  await a.sync();
  await b.sync();
  await a.sync();

  const merged = 'ONE\ntwo\nthree\nfour\nFIVE\n';
  assert.equal(await a.vault.text('n.md'), merged);
  assert.equal(await b.vault.text('n.md'), merged);
  assert.equal(await hub.hubVault.text('n.md'), merged);
  assert.deepEqual([...a.replaced, ...b.replaced], []);
});

test('when both devices change the same line, the later edit wins even if it syncs first', async (t) => {
  const hub = await startHub();
  t.after(hub.close);
  const phone = await hub.client('Phone');
  const desktop = await hub.client('Desktop');
  await phone.vault.edit('n.md', 'title\nbody\nend\n');
  await phone.sync();
  await desktop.sync();

  // The phone edits first while offline; the desktop edits later and syncs first.
  await phone.vault.edit('n.md', 'title\nphone body\nend\n');
  await tick();
  await desktop.vault.edit('n.md', 'title\ndesktop body\nend\n');
  await desktop.sync();
  await phone.sync();
  await desktop.sync();

  const expected = 'title\ndesktop body\nend\n';
  assert.equal(await phone.vault.text('n.md'), expected);
  assert.equal(await desktop.vault.text('n.md'), expected);
  assert.deepEqual(phone.replaced, [{ path: 'n.md', by: 'Desktop' }]);

  const history = await hub.hub.history('n.md');
  const replaced = history.find((h) => h.kind === 'replaced');
  assert.equal(replaced?.device, 'Phone');
  assert.equal(
    (await hub.hub.repo.readBlob(replaced!.blob!))?.toString(),
    'title\nphone body\nend\n',
  );
});

test('a device whose earlier edit is later replaced is told on its next sync', async (t) => {
  const hub = await startHub();
  t.after(hub.close);
  const phone = await hub.client('Phone');
  const desktop = await hub.client('Desktop');
  await phone.vault.edit('n.md', 'title\nbody\n');
  await phone.sync();
  await desktop.sync();

  // The phone edits and syncs right away. The desktop, offline, edits the same line later.
  await phone.vault.edit('n.md', 'title\nphone body\n');
  await phone.sync();
  await tick();
  await desktop.vault.edit('n.md', 'title\ndesktop body\n');
  await desktop.sync();
  assert.deepEqual(desktop.replaced, []);

  await phone.sync();
  assert.equal(await phone.vault.text('n.md'), 'title\ndesktop body\n');
  assert.deepEqual(phone.replaced, [{ path: 'n.md', by: 'Desktop' }]);
  await phone.sync();
  assert.equal(phone.replaced.length, 1);
});

test('a device with a fast clock does not win an edit it made earlier', async (t) => {
  const hub = await startHub();
  t.after(hub.close);
  const fast = await hub.client('Fast', { skew: 60 * 60_000 });
  const normal = await hub.client('Normal');
  await normal.vault.edit('n.md', 'a\n');
  await normal.sync();
  await fast.sync();
  // Let the fast device learn its offset from a quick request.
  await fast.api.health();

  await fast.vault.edit('n.md', 'fast\n');
  await tick();
  await normal.vault.edit('n.md', 'normal\n');
  await normal.sync();
  await fast.sync();

  assert.equal(await fast.vault.text('n.md'), 'normal\n');
  assert.deepEqual(fast.replaced, [{ path: 'n.md', by: 'Normal' }]);
});

test('drawings and other files that cannot be merged are replaced whole by the newer edit', async (t) => {
  const hub = await startHub();
  t.after(hub.close);
  const a = await hub.client('A');
  const b = await hub.client('B');
  const drawing = (first: string, last: string) =>
    `---\nexcalidraw-plugin: parsed\n---\n${first}\nmiddle\n${last}\n`;
  await a.vault.edit('d.excalidraw.md', drawing('first', 'last'));
  await a.sync();
  await b.sync();

  // Separate line edits would be combined in a note. A drawing keeps only the newer version.
  await a.vault.edit('d.excalidraw.md', drawing('A', 'last'));
  await tick();
  await b.vault.edit('d.excalidraw.md', drawing('first', 'B'));
  await a.sync();
  await b.sync();
  await a.sync();

  assert.equal(await a.vault.text('d.excalidraw.md'), drawing('first', 'B'));
  assert.equal(await b.vault.text('d.excalidraw.md'), drawing('first', 'B'));
});

test('an edit and a deletion of the same file: the later one wins', async (t) => {
  const hub = await startHub();
  t.after(hub.close);
  const a = await hub.client('A');
  const b = await hub.client('B');
  await a.vault.edit('x.md', 'x\n');
  await a.vault.edit('y.md', 'y\n');
  await a.sync();
  await b.sync();

  await a.remove('x.md');
  await tick();
  await b.vault.edit('x.md', 'edited after delete\n');
  await b.vault.edit('y.md', 'edited before delete\n');
  await tick();
  await a.remove('y.md');
  await a.sync();
  await b.sync();
  await a.sync();

  assert.equal(await a.vault.text('x.md'), 'edited after delete\n');
  assert.equal(await b.vault.text('y.md'), null);
  assert.deepEqual(b.replaced, [{ path: 'y.md', by: 'A' }]);
});

test('files changed directly in the hub folder sync to devices, and device edits land there', async (t) => {
  const hub = await startHub();
  t.after(hub.close);
  const phone = await hub.client('Phone');
  await hub.hubVault.edit('From hub.md', 'written on the mini pc\n');
  assert.equal(await hub.hub.scan(), 1);
  await phone.sync();
  assert.equal(await phone.vault.text('From hub.md'), 'written on the mini pc\n');

  await phone.vault.edit('From hub.md', 'edited on the phone\n');
  await phone.sync();
  assert.equal(await hub.hubVault.text('From hub.md'), 'edited on the phone\n');
  assert.equal(await hub.hub.scan(), 0);
  const history = await hub.hub.history('From hub.md');
  assert.deepEqual(
    history.map((h) => h.device),
    ['Phone', 'Mini PC'],
  );
});

test('a hub edit not yet scanned is merged with an upload instead of overwritten', async (t) => {
  const hub = await startHub();
  t.after(hub.close);
  const phone = await hub.client('Phone');
  await phone.vault.edit('n.md', 'a\nb\nc\nd\n');
  await phone.sync();
  await hub.hubVault.edit('n.md', 'A\nb\nc\nd\n');
  await phone.vault.edit('n.md', 'a\nb\nc\nD\n');
  await phone.sync();
  assert.equal(await hub.hubVault.text('n.md'), 'A\nb\nc\nD\n');
  assert.equal(await phone.vault.text('n.md'), 'A\nb\nc\nD\n');
});

test('restoring an old version makes it current everywhere', async (t) => {
  const hub = await startHub();
  t.after(hub.close);
  const a = await hub.client('A');
  await a.vault.edit('n.md', 'v1\n');
  await a.sync();
  await a.vault.edit('n.md', 'v2\n');
  await a.sync();
  const v1 = (await hub.hub.history('n.md')).at(-1)!;
  await a.api.restore('n.md', v1.blob!);
  await a.sync();
  assert.equal(await a.vault.text('n.md'), 'v1\n');
  assert.equal((await hub.hub.history('n.md'))[0]!.kind, 'restore');
});

test('a file whose name differs only in capitalization is refused without blocking others', async (t) => {
  const hub = await startHub();
  t.after(hub.close);
  const a = await hub.client('A');
  const b = await hub.client('B');
  await a.vault.edit('Ideas.md', 'a\n');
  await a.sync();
  await b.vault.edit('ideas.md', 'b\n');
  await b.vault.edit('other.md', 'fine\n');
  await b.sync();
  assert.match(b.engine.errors.get('ideas.md') ?? '', /already exists/);
  await a.sync();
  assert.equal(await a.vault.text('other.md'), 'fine\n');
});

test('files over the size limit are reported and skipped', async (t) => {
  const hub = await startHub();
  t.after(hub.close);
  const a = await hub.client('A');
  await writeFile(join(a.vault.root, 'big.pdf'), Buffer.alloc(2 * 1024 * 1024));
  await a.vault.edit('small.md', 'ok\n');
  await a.sync();
  assert.ok(a.engine.errors.has('big.pdf'));
  assert.equal(await hub.hubVault.text('small.md'), 'ok\n');
});
