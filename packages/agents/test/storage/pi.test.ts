// pi-durable's storage conformance suite on @restatedev/agents/pi/storage, over an SQL
// database in memory: `pnpm --filter @restatedev/agents test pi`.
import { registerStorageConformance } from '@earendil-works/pi-durable/testing';
import { asDatabase, open } from '@restatedev/sessions/internal';
import { describe, expect, it } from 'vitest';
import { memoryStore } from '@restatedev/sessions/test/support';
import { openSqlKvStorage, SqlKvDatabase } from '@restatedev/agents/pi/storage';

let n = 0;

describe('runCounted', () => {
  it('resolves with the rows a statement changed, in a transaction and outside one', async () => {
    const db = await open(`counted-${process.pid}-${n++}`, memoryStore());
    try {
      const facade = new SqlKvDatabase(asDatabase(db));
      await facade.exec('CREATE TABLE t (n INTEGER)');
      expect(await facade.runCounted('INSERT INTO t VALUES (?), (?), (?)', 1, 2, 3)).toBe(3);
      expect(await facade.runCounted('UPDATE t SET n = n + 10 WHERE n > ?', 1)).toBe(2);
      expect(await facade.runCounted('DELETE FROM t WHERE n > ?', 100)).toBe(0);
      const inside = await facade.transaction(async (tx) => [
        await tx.runCounted('DELETE FROM t WHERE n = ?', 1),
        await tx.runCounted('UPDATE t SET n = 0'),
      ]);
      expect(inside).toEqual([1, 2]);
      expect(await facade.all('SELECT n FROM t')).toEqual([{ n: 0 }, { n: 0 }]);
    } finally {
      await db.close();
    }
  });
});

registerStorageConformance({ describe, expect, it }, '@restatedev/sessions', async (use) => {
  const db = await open(`conformance-${process.pid}-${n++}`, memoryStore());
  try {
    await use(await openSqlKvStorage(asDatabase(db)));
  } finally {
    await db.close();
  }
});
