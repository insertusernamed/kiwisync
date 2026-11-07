import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HistoryKind } from '../shared/protocol';

export interface Author {
  name: string;
  email: string;
  time: number;
}

export interface FileChange {
  path: string;
  blob: string | null;
}

export interface LogEntry {
  commit: string;
  blob: string | null;
  time: number;
  deviceId: string;
  author: string;
  kind: HistoryKind;
}

interface RunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

const NO_OBJECT = '0'.repeat(40);
export const REPLACED_BRANCH = 'replaced';

// Wraps git plumbing so commits can be made without touching the working tree. The vault on
// disk is written by the hub itself; git only records what was written.
export class Repo {
  private constructor(readonly dir: string) {}

  static async open(dir: string): Promise<Repo> {
    const repo = new Repo(dir);
    if (!existsSync(join(dir, '.git'))) {
      await repo.git(['init', '-q', '-b', 'main']);
      await repo.git(['config', 'kiwisync.hub', 'true']);
      await writeFile(join(dir, '.git', 'info', 'exclude'), '.*\n');
    } else if (
      (await repo.run(['config', '--get', 'kiwisync.hub'])).stdout.toString().trim() !== 'true'
    ) {
      throw new Error(`${dir} is a git repository KiwiSync did not create. Choose another folder.`);
    }
    await repo.git(['config', 'core.quotepath', 'false']);
    await repo.git(['config', 'core.autocrlf', 'false']);
    return repo;
  }

  run(
    args: string[],
    input?: Uint8Array | string,
    env: Record<string, string> = {},
  ): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', args, {
        cwd: this.dir,
        env: { ...process.env, GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0', ...env },
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (d: Buffer) => out.push(d));
      child.stderr.on('data', (d: Buffer) => err.push(d));
      child.on('error', reject);
      child.on('close', (code) =>
        resolve({
          code: code ?? -1,
          stdout: Buffer.concat(out),
          stderr: Buffer.concat(err).toString(),
        }),
      );
      child.stdin.end(input);
    });
  }

  async git(
    args: string[],
    input?: Uint8Array | string,
    env?: Record<string, string>,
  ): Promise<Buffer> {
    const result = await this.run(args, input, env);
    if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
    return result.stdout;
  }

  async writeBlob(bytes: Uint8Array): Promise<string> {
    return text(await this.git(['hash-object', '-w', '--no-filters', '--stdin'], bytes));
  }

  async readBlob(blob: string): Promise<Buffer | null> {
    const result = await this.run(['cat-file', 'blob', blob]);
    return result.code === 0 ? result.stdout : null;
  }

  async hasBlob(blob: string): Promise<boolean> {
    return (await this.run(['cat-file', '-e', `${blob}^{blob}`])).code === 0;
  }

  async head(ref = 'HEAD'): Promise<string | null> {
    const result = await this.run(['rev-parse', '-q', '--verify', `${ref}^{commit}`]);
    return result.code === 0 ? text(result.stdout) : null;
  }

  async files(): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    if (!(await this.head())) return files;
    const out = (await this.git(['ls-tree', '-r', '-z', 'HEAD'])).toString();
    for (const entry of out.split('\0')) {
      const match = /^\d+ blob ([0-9a-f]{40})\t(.*)$/s.exec(entry);
      if (match) files.set(match[2]!, match[1]!);
    }
    return files;
  }

  // Commits to the main branch through the regular index, or to another branch through its
  // own index file so the main index is never disturbed. With `replace`, a commit still at the
  // tip is swapped for this one, folding a run of small edits into a single history entry.
  async commit(
    changes: FileChange[],
    author: Author,
    kind: HistoryKind,
    subject: string,
    branch?: { ref: string; index: string; fresh?: boolean },
    replace?: string,
  ): Promise<string> {
    const env: Record<string, string> = branch ? { GIT_INDEX_FILE: branch.index } : {};
    if (branch?.fresh) await rm(branch.index, { force: true });
    const info = changes
      .map((c) => (c.blob ? `100644 ${c.blob}\t${c.path}` : `0 ${NO_OBJECT}\t${c.path}`))
      .join('\n');
    await this.git(['update-index', '--index-info'], info + '\n', env);
    const tree = text(await this.git(['write-tree'], undefined, env));
    const ref = branch?.ref ?? 'HEAD';
    const tip = branch?.fresh ? null : await this.head(ref);
    const parent = replace && tip === replace ? await this.head(`${replace}^`) : tip;
    if (parent && text(await this.git(['rev-parse', `${parent}^{tree}`])) === tree) {
      if (parent !== tip) await this.git(['update-ref', ref, parent, tip!]);
      return parent;
    }
    const commit = text(
      await this.git(
        ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-F', '-'],
        `${subject}\n\nKiwiSync-Kind: ${kind}\n`,
        {
          GIT_AUTHOR_NAME: author.name,
          GIT_AUTHOR_EMAIL: author.email,
          GIT_AUTHOR_DATE: gitDate(author.time),
          GIT_COMMITTER_NAME: 'KiwiSync',
          GIT_COMMITTER_EMAIL: 'kiwisync@localhost',
        },
      ),
    );
    await this.git(['update-ref', ref, commit, tip ?? NO_OBJECT]);
    return commit;
  }

  // Three-way merge of stored versions. Returns the merged blob and how many sections both
  // sides changed. With `favor`, those sections are resolved to one side instead of markers.
  async merge(
    base: string,
    ours: string,
    theirs: string,
    favor?: 'ours' | 'theirs',
  ): Promise<{ blob: string; conflicts: number }> {
    const args = [
      'merge-file',
      '--object-id',
      ...(favor ? [`--${favor}`] : []),
      ours,
      base,
      theirs,
    ];
    const result = await this.run(args);
    if (result.code < 0 || result.code > 127)
      throw new Error(`git merge-file failed: ${result.stderr.trim()}`);
    return { blob: text(result.stdout), conflicts: result.code };
  }

  async log(path: string, ref: string, limit: number): Promise<LogEntry[]> {
    if (!(await this.head(ref))) return [];
    const out = await this.git([
      'log',
      ref,
      `-n${limit}`,
      '--no-renames',
      '--raw',
      '--no-abbrev',
      '--format=%x1e%H%x1f%ae%x1f%an%x1f%at%x1f%(trailers:key=KiwiSync-Kind,valueonly,separator=)',
      '--',
      path,
    ]);
    const entries: LogEntry[] = [];
    for (const record of out.toString().split('\x1e').slice(1)) {
      const [header = '', ...rest] = record.split('\n');
      const [commit, email, author, seconds, kind] = header.split('\x1f');
      const raw = /^:\d+ \d+ [0-9a-f]{40} ([0-9a-f]{40}) /m.exec(rest.join('\n'));
      if (!commit || !raw) continue;
      entries.push({
        commit,
        blob: raw[1] === NO_OBJECT ? null : raw[1]!,
        time: Number(seconds) * 1000,
        deviceId: email?.replace(/@kiwisync$/, '') ?? '',
        author: author ?? '',
        kind: (kind?.trim() || 'edit') as HistoryKind,
      });
    }
    return entries;
  }
}

function text(out: Buffer): string {
  return out.toString().trim();
}

// Git dates carry a timezone. Using the hub's local zone makes `git log` read naturally there.
function gitDate(time: number): string {
  const offset = -new Date(time).getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  const zone = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`;
  return `@${Math.floor(time / 1000)} ${zone}`;
}
