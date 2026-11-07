// The same id git gives a file's contents, so any version a device names can be found in the
// server's repository.
export async function blobId(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(header.length + bytes.length);
  all.set(header);
  all.set(bytes, header.length);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', all));
  return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function isBlobId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}
