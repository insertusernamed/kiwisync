// Hidden files and folders (.obsidian, .trash, .git) stay on each device.
export function isSyncPath(path: string): boolean {
  if (!path || path.length > 1024 || /^[/"]/.test(path) || path.includes('\\')) return false;
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  return path.split('/').every((part) => part !== '' && !part.startsWith('.'));
}

// iOS and macOS treat paths that differ only in case or Unicode form as the same file.
export function pathKey(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

// Line merging is only safe for prose. Excalidraw notes embed compressed JSON split across
// lines, and canvas files are JSON, so those are replaced whole instead.
export function isMergeable(path: string, text: string): boolean {
  const lower = path.toLowerCase();
  if (!lower.endsWith('.md') && !lower.endsWith('.txt')) return false;
  return !lower.endsWith('.excalidraw.md') && !/^---\r?\n[\s\S]*?excalidraw-plugin:/.test(text);
}
