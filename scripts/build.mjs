import { build } from 'esbuild';
import { copyFile, mkdir, readFile } from 'node:fs/promises';

await mkdir('dist/plugin', { recursive: true });
await build({
  entryPoints: ['src/server/main.ts', 'src/server/cli.ts'],
  outdir: 'dist/server',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
});
const plugin = await build({
  entryPoints: ['src/plugin/main.ts'],
  outfile: 'dist/plugin/main.js',
  banner: { js: `/*!\n${await readFile('THIRD_PARTY_NOTICES', 'utf8')}*/` },
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2020',
  external: ['obsidian'],
  metafile: true,
});
// The plugin runs on phones, where Node built-ins do not exist.
const imports = Object.values(plugin.metafile.outputs).flatMap((o) => o.imports);
const unexpected = imports.filter((i) => i.path !== 'obsidian');
if (unexpected.length)
  throw new Error(`Plugin imports ${unexpected.map((i) => i.path).join(', ')}`);
await copyFile('manifest.json', 'dist/plugin/manifest.json');
await copyFile('src/plugin/styles.css', 'dist/plugin/styles.css');
