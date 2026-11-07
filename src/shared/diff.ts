export interface DiffLine {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

export type DiffRow = DiffLine | { kind: 'skipped'; count: number };

// Comparing two large, very different files would take too long on a phone.
const MAX_CELLS = 4_000_000;

// Line by line differences between two texts, or null if they are too large to compare.
export function diffLines(before: string, after: string): DiffLine[] | null {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const rows = endA - start;
  const cols = endB - start;
  if (rows * cols > MAX_CELLS) return null;

  // Longest common subsequence of the differing middle, filled from the end so the walk
  // below can go forwards.
  const lengths = new Uint32Array((rows + 1) * (cols + 1));
  const at = (i: number, j: number) => i * (cols + 1) + j;
  for (let i = rows - 1; i >= 0; i--)
    for (let j = cols - 1; j >= 0; j--)
      lengths[at(i, j)] =
        a[start + i] === b[start + j]
          ? lengths[at(i + 1, j + 1)]! + 1
          : Math.max(lengths[at(i + 1, j)]!, lengths[at(i, j + 1)]!);

  const result: DiffLine[] = a.slice(0, start).map((text) => ({ kind: 'same', text }));
  let i = 0;
  let j = 0;
  while (i < rows || j < cols) {
    if (i < rows && j < cols && a[start + i] === b[start + j]) {
      result.push({ kind: 'same', text: a[start + i]! });
      i++;
      j++;
    } else if (i < rows && (j === cols || lengths[at(i + 1, j)]! >= lengths[at(i, j + 1)]!)) {
      result.push({ kind: 'removed', text: a[start + i]! });
      i++;
    } else {
      result.push({ kind: 'added', text: b[start + j]! });
      j++;
    }
  }
  for (const text of a.slice(endA)) result.push({ kind: 'same', text });
  return result;
}

// Keeps a few unchanged lines around each change and folds the rest into a count. A single
// unchanged line is shown rather than folded, since the count would take the same space.
export function withContext(lines: DiffLine[], context = 3): DiffRow[] {
  const near = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.kind === 'same') return;
    for (
      let k = Math.max(0, index - context);
      k <= Math.min(lines.length - 1, index + context);
      k++
    )
      near[k] = true;
  });
  const rows: DiffRow[] = [];
  let skipped = 0;
  const flush = (index: number) => {
    if (skipped === 1) rows.push(lines[index - 1]!);
    else if (skipped) rows.push({ kind: 'skipped', count: skipped });
    skipped = 0;
  };
  lines.forEach((line, index) => {
    if (!near[index]) skipped++;
    else {
      flush(index);
      rows.push(line);
    }
  });
  flush(lines.length);
  return rows;
}
