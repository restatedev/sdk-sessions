// A database past L0 (4 MiB compressed): its checkpoints promote to the
// object store RESTATE_SQL_OBJECT_STORE names, here a directory, and read
// back from it. The variable is read at the process's first open, so it is
// set before any; the page cache is off, so every session reads cold.
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, test } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'sessions-l1-'));
process.env.RESTATE_SQL_OBJECT_STORE = `file://${dir}/packs`;
process.env.RESTATE_SQL_CACHE = 'off';
const { open } = await import('@restatedev/sessions/internal');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Stored values, every write synced at once. */
function memory() {
  const stored = new Map<string, Uint8Array>();
  return {
    stored,
    store: {
      get: async (key: string) => stored.get(key),
      set: (key: string, value: Uint8Array) => void stored.set(key, Uint8Array.from(value)),
      clear: (key: string) => void stored.delete(key),
      sync: async () => {},
      keys: async () => [...stored.keys()],
    },
  };
}

/** Every file under `path`, relative to it. */
function files(path: string): string[] {
  try {
    return readdirSync(path, { recursive: true, encoding: 'utf8' }).filter((f) => statSync(join(path, f)).isFile());
  } catch {
    return [];
  }
}

test('a database past L0 promotes its packs to the object store, and reads them back', async () => {
  const { store, stored } = memory();
  // Its directory: the namespace, escaped to one segment.
  const namespace = 'Ledger/a%20b';
  const packs = join(dir, 'packs', '_4cedger_2fa_2520b');

  const hash = createHash('sha256');
  const db = await open(namespace, store);
  await db.execute('CREATE TABLE blobs (id INTEGER PRIMARY KEY, data BLOB NOT NULL)');
  // 12 MiB that does not compress, 256 KiB a commit.
  for (let i = 0; i < 48; i++) {
    const data = randomBytes(256 << 10);
    hash.update(data);
    await db.execute('INSERT INTO blobs VALUES (?, ?)', [i, data]);
  }
  await db.save();

  const promoted = files(packs);
  assert.ok(promoted.length > 0, 'a pack in the object store');
  assert.ok(
    promoted.every((f) => f.startsWith('l1/')),
    `only L1's packs: ${promoted.join(', ')}`,
  );
  // Restate keeps no more than L0's few MiB, and the head, tail and manifests.
  const inRestate = [...stored.values()].reduce((n, v) => n + v.length, 0);
  assert.ok(inRestate < 8 << 20, `${inRestate} bytes in Restate`);

  // A cold session reads every row, from both tiers.
  const again = await open(namespace, store);
  const read = createHash('sha256');
  for (const [data] of await again.values('SELECT data FROM blobs ORDER BY id')) read.update(data as Uint8Array);
  assert.equal(read.digest('hex'), hash.digest('hex'));
  // So does a reader beside it.
  const reader = await open(namespace, store, { reader: true });
  assert.deepEqual(await reader.values('SELECT count(*) FROM blobs'), [[48]]);
  await reader.close();

  // Rewriting it all promotes again; the packs no checkpoint needs go.
  for (let i = 0; i < 48; i++) {
    await again.execute('UPDATE blobs SET data = ? WHERE id = ?', [randomBytes(256 << 10), i]);
  }
  await again.save();
  const bytes = files(packs).reduce((n, f) => n + statSync(join(packs, f)).size, 0);
  assert.ok(bytes < 40 << 20, `${bytes} bytes in the object store for a 12 MiB database`);
});
