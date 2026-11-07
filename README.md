# KiwiSync

KiwiSync syncs an Obsidian vault between your devices through a computer you own. That computer, the hub, holds the vault as ordinary files and records every change in git. Phones and laptops send their edits to the hub and copy whatever it has.

It is for one person (or a household) with a machine that stays on, such as a mini PC or home server, reachable over HTTPS.

## How syncing works

There is one copy that counts: the folder on the hub. Every change a device uploads is written there and committed, so the folder is always the latest version of the vault and `git log` is its complete history.

When two devices edit the same note before syncing, the hub combines the edits. If they changed different parts of the note, both changes are kept. If they changed the same lines, the edit made later wins, judged by when each edit was made rather than when it reached the hub. The losing version is not thrown away. It is committed to a `replaced` branch, the device that lost gets a notice, and the version can be restored from the note's history.

Each device's clock is checked against the hub's on every request, so a phone whose clock is a few minutes off does not win or lose because of it.

Drawings (Excalidraw), canvases, PDFs, images, and other files that cannot be combined line by line are kept whole: the newer version wins and the other goes to the `replaced` branch. An edit and a deletion of the same file follow the same rule.

There are no conflict files or branches of the vault for you to sort out.

Renaming or moving a file moves it on every device, and its history follows it to the new name. An edit made on another device under the old name, before it heard about the rename, ends up in the renamed file.

Hidden files and folders, such as `.trash`, stay on each device. The `.obsidian` settings folder is synced only as described under Plugins and settings.

## Setting up the hub

The hub needs Node 22.18 or newer, git 2.43 or newer, and a reverse proxy that serves it over HTTPS.

```sh
git clone https://github.com/insertusernamed/kiwisync.git
cd kiwisync
npm ci
npm run build
cp .env.example .env    # then edit it
```

`KIWISYNC_VAULT` is the folder the hub owns. It can be an existing vault: on first start the hub commits what is there. If the folder is already a git repository that KiwiSync did not create, it refuses to use it.

`scripts/kiwisync.service` is a systemd unit and `scripts/nginx-location.conf` an nginx route that serves the hub at `/kiwisync/`. Adjust the paths in both for your machine.

Anything you change in the vault folder on the hub itself, with Obsidian or any other program, is noticed within a few seconds and synced like an edit from a device.

## Adding devices

Create a code on any connected device under Settings, KiwiSync, Add a device. On the hub itself you can run:

```sh
npm run kiwisync -- invite
```

This prints a QR code in the terminal. Codes work once and expire after 15 minutes.

**iPhone, iPad, and Android.** Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin from Obsidian's community plugins, add `insertusernamed/kiwisync` as a beta plugin, and enable KiwiSync. Then scan the QR code with the phone's camera; it opens Obsidian and fills in the connection details. Keep the vault in On My iPhone rather than iCloud, so iCloud is not syncing the same files.

**Linux desktops.** With Obsidian closed, run:

```sh
curl -fsSL https://your-server/kiwisync/install.sh | bash
```

It finds your vaults, installs the plugin into the one you pick, and turns it on. Then open Settings, KiwiSync, Connect, and enter the server address and code.

**Other desktops.** Copy `main.js`, `manifest.json`, and `styles.css` from the latest release into `<vault>/.obsidian/plugins/kiwisync/` and enable the plugin.

If the vault on the new device already has notes, KiwiSync asks what to do with them. Using the hub's copy saves the device's files on a `backup/<device>-<date>` branch on the hub and then makes the device match the hub. Merging adds files that only exist on the device and keeps the newer version of files that exist on both.

KiwiSync will not run while Self-hosted LiveSync or Remotely Save is enabled in the same vault, and offers to turn them off.

After the first install, devices update the plugin themselves from the hub when it has a newer build.

## Daily use

An edit reaches the hub about a second after you stop typing, and other devices with Obsidian open show it a moment later. Syncing also happens when Obsidian comes back to the foreground. There is nothing to press. The status bar on desktop shows the state; on phones it is at the top of KiwiSync's settings.

Right-click a file and choose Version history to see every version, which device made it, and to restore one. Quick successive edits to a note from one device are kept as one version, as long as they are less than two minutes apart and span under ten minutes. Restoring makes that version current on every device and keeps the history intact. Settings, Deleted files lists files deleted from any device.

The device list in settings shows each device's name, when it last synced, and whether it has changes waiting to upload. Names can be changed from any device, and history shows the new name for past edits too. Removing a device stops it syncing immediately.

## Plugins and settings

Each device chooses whether to sync three groups, under Settings, KiwiSync, Plugins and settings. All three are off at first.

- Plugins: which community plugins are enabled, and each plugin's `main.js`, `manifest.json`, `styles.css`, and `data.json`.
- Themes and snippets: `appearance.json`, installed themes, and CSS snippets.
- Other settings: the remaining files directly in `.obsidian`, such as hotkeys, editor options, and core plugin settings.

Turning a group on makes the device use the hub's version of any file the hub already has, after saving the device's own copies on a `backup/` branch. Files the hub does not have yet are uploaded. For the list of enabled plugins, the device's list and the hub's list are combined, so a plugin enabled on only one of them stays enabled.

Some files never sync: the window layout (`workspace.json`, `workspace-mobile.json`), anything else inside a plugin's folder such as caches, KiwiSync's own folder, which holds the device's connection, and Self-hosted LiveSync and Remotely Save. The hub also removes those two from the shared list of enabled plugins.

Obsidian reads plugins and settings when it starts, so KiwiSync asks you to reload after changes arrive. Changes made on this device are picked up within a minute, or sooner when a note syncs or Obsidian returns to the foreground. If a plugin saves its options before you reload, it can write back its old options; reloading promptly avoids that.

## On the hub

```sh
npm run kiwisync -- devices
npm run kiwisync -- rename "iPhone" "Work iPhone"
npm run kiwisync -- remove "Old laptop"
npm run kiwisync -- snapshot ~/old-notes "Notes from old laptop"
```

`snapshot` stores a folder on its own branch without changing the vault, which is a safe place for an old copy you may want to dig through later.

The history is a normal git repository in the vault folder. `git log -- "Some note.md"` shows a note's history, `git log replaced` shows edits that lost to newer ones, and `git branch` lists device backups. Avoid committing or checking out in that repository by hand while the hub is running.

## Backups

The hub's history protects against mistakes on your devices, not against losing the hub's disk. Keep a copy of the vault folder, including `.git`, somewhere else. `git clone --mirror` to another machine, or any file backup tool, works.

## Limits

The vault is not encrypted on the hub; anyone with access to that machine can read it. Traffic is protected by HTTPS.

Files are limited to 200 MB by default (`KIWISYNC_MAX_FILE_MB`). Two files whose names differ only in capitalization cannot coexist, because iPhones treat them as the same file.

Mobile operating systems pause apps in the background, so a phone syncs when Obsidian is open.

## Development

```sh
npm test
npm run check
npm run build
```

The tests run a real hub with a git repository and several simulated devices over HTTP, including one with a wrong clock.
