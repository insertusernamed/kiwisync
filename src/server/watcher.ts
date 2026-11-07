import { watch, type FSWatcher } from 'node:fs';

// Watches a set of folders, each with its own watcher. Node's recursive mode on Linux misses
// changes inside subfolders, so the hub hands over every folder it walked after each scan.
export class FolderWatcher {
  private watchers = new Map<string, FSWatcher>();

  constructor(private onChange: () => void) {}

  update(folders: Iterable<string>): void {
    const wanted = new Set(folders);
    for (const [folder, watcher] of this.watchers)
      if (!wanted.has(folder)) {
        watcher.close();
        this.watchers.delete(folder);
      }
    for (const folder of wanted) {
      if (this.watchers.has(folder)) continue;
      try {
        const watcher = watch(folder, (_event, name) => {
          // Hidden names include the hub's own temporary files and the .git folder.
          if (name && !name.startsWith('.')) this.onChange();
        });
        // A folder removed between the scan and now; the next scan drops it.
        watcher.on('error', () => this.drop(folder));
        this.watchers.set(folder, watcher);
      } catch {
        // Removed before it could be watched. The next scan sees that.
      }
    }
  }

  close(): void {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  private drop(folder: string): void {
    this.watchers.get(folder)?.close();
    this.watchers.delete(folder);
  }
}
