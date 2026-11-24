// A transaction's sends (`tx.send`), without a Restate server: each attempt
// has `ctx.db` over the object's state in memory, and records the sends it
// makes. A crash is an attempt whose later writes and
// sends are lost: what it stored before stays.
import * as restate from '@restatedev/sessions';
import { HEAD_KEY, open } from '@restatedev/sessions/internal';
import { describe, expect, it } from 'vitest';
import { memoryStore, sqlAttempt } from './support.ts';

type Send = restate.GenericSend<Uint8Array>;

/** The database's head: the commit point of a flush, and the key a session object preloads. */
const HEAD = HEAD_KEY;
let namespaces = 0;

const store = restate.object({
  name: 'Store',
  handlers: {
    reserve: async (_ctx: restate.ObjectContext, _item: string) => {},
    deposit: async (_ctx: restate.ObjectContext, _amount: number) => {},
  },
});

/** An object's state, and attempts over it that record their sends. */
function object() {
  const map = new Map<string, Uint8Array>();
  return {
    map,
    /** An attempt; with `crash`, its writes and sends are lost from the first send on. */
    attempt({ crash = false } = {}) {
      const sent: Send[] = [];
      const fence = { closed: false };
      const send = (s: Send) => {
        if (crash) {
          fence.closed = true;
          throw new Error('crashed');
        }
        sent.push(s);
      };
      return { ...sqlAttempt({ map, fence, send }), sent, fence };
    },
    /** The keys of the sends in an outbox record, which this version no longer keeps: always none. */
    async outbox() {
      const db = await open(`outbox-${namespaces++}`, memoryStore(map));
      const record = await db.record('outbox');
      await db.close();
      if (record.length === 0) return [];
      const outbox = JSON.parse(new TextDecoder().decode(record)) as { id: string; sends: unknown[] }[];
      return outbox.flatMap(({ id, sends }) => sends.map((_, i) => `transaction/${id}/${i}`));
    },
  };
}

const decode = (s: Send) => JSON.parse(new TextDecoder().decode(s.parameter)) as unknown;

/** A transfer with two sends, as one transaction. */
const transfer = (a: ReturnType<ReturnType<typeof object>['attempt']>) =>
  a.db.transaction(async (tx) => {
    const before = a.sent.length;
    await tx.execute('CREATE TABLE IF NOT EXISTS balance (v INTEGER)');
    await tx.execute('INSERT INTO balance VALUES (5)');
    tx.send(store, 'a').reserve('book');
    tx.send(store, 'b').deposit(5);
    // Nothing is sent before the commit.
    expect(a.sent).toHaveLength(before);
  });

/**
 * An attempt whose transaction's commit Restate cancels as it waits for its
 * sync: the commit is stored, but the transaction's await rejects, and the
 * handler does `onCancelled` with the error. Once: the core delivers the
 * cancel signal once, and a handler goes on after it.
 */
function cancelledCommit(map: Map<string, Uint8Array>, sent: Send[], onCancelled: (e: unknown) => unknown) {
  let cancel = false;
  const onSync = async () => {
    if (!cancel) return;
    cancel = false;
    throw new restate.CancelledError();
  };
  const a = sqlAttempt({ map, onSync, send: (s: Send) => void sent.push(s) });
  return a.end(async () => {
    await a.db.execute('CREATE TABLE balance (v INTEGER)');
    cancel = true;
    try {
      await a.db.transaction(async (tx) => {
        await tx.execute('INSERT INTO balance VALUES (5)');
        tx.send(store, 'a').reserve('book');
      });
    } catch (e) {
      return onCancelled(e);
    }
    return 'not cancelled';
  });
}

/** The send was made with the commit, once: the key's next invocation finds the commit and nothing to send. */
async function expectMadeOnce(map: Map<string, Uint8Array>, sent: Send[]) {
  expect(sent.map(decode)).toEqual(['book']);
  const next = sqlAttempt({ map, send: (s: Send) => void sent.push(s), id: 'next' });
  expect(await next.end(() => next.db.values('SELECT v FROM balance'))).toEqual([[5]]);
  expect(sent).toHaveLength(1);
}

// Without the VM (a test's store in memory) a transaction's sends are made
// right after its commit's writes, before its sync. On Restate they are in
// the commit's atomic group, stored with its rows or not at all
// (`protocol.test.ts`, `transaction-cancel.test.ts`, `commit-group.test.ts`):
// there is no outbox to remember them across a crash, here or there.
describe('the sends of a transaction', () => {
  it('sends once the transaction commits, with no key of its own making, and keeps no table or record of them', async () => {
    const o = object();
    const a = o.attempt();
    await a.end(() => transfer(a));
    expect(a.sent.map((s) => [s.service, s.key, s.method, decode(s), s.idempotencyKey])).toEqual([
      ['Store', 'a', 'reserve', 'book', undefined],
      ['Store', 'b', 'deposit', 5, undefined],
    ]);
    expect(await o.outbox()).toEqual([]);
    const b = o.attempt();
    expect(await b.end(() => b.db.values("SELECT name FROM sqlite_master WHERE name LIKE '_restate%'"))).toEqual([]);
  });

  it('sends nothing for a transaction rolled back', async () => {
    const o = object();
    const a = o.attempt();
    const failed = await a
      .end(() =>
        a.db.transaction(async (tx) => {
          await tx.execute('CREATE TABLE t (v INTEGER)');
          tx.send(store, 'a').reserve('book');
          throw new Error('no');
        }),
      )
      .catch((e: unknown) => e);
    expect((failed as Error).message).toBe('no');
    expect(a.sent).toEqual([]);
  });

  it('sends nothing for a COMMIT that is refused', async () => {
    const o = object();
    const a = o.attempt();
    await a.end(async () => {
      await a.db.execute('PRAGMA foreign_keys=ON');
      await a.db.execute('CREATE TABLE p (id INTEGER PRIMARY KEY)');
      await a.db.execute('CREATE TABLE c (pid INTEGER REFERENCES p(id) DEFERRABLE INITIALLY DEFERRED)');
      // The deferred constraint fails at COMMIT, after the sends wait.
      const refused = await a.db
        .transaction(async (tx) => {
          await tx.execute('INSERT INTO c VALUES (7)');
          tx.send(store, 'a').reserve('book');
        })
        .catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(restate.TerminalError);
    });
    expect(a.sent).toEqual([]);
  });

  it('makes the sends of a commit that a cancellation interrupted, as the handler ends with the CancelledError', async () => {
    const map = new Map<string, Uint8Array>();
    const sent: Send[] = [];
    await expect(cancelledCommit(map, sent, (e) => Promise.reject(e))).rejects.toBeInstanceOf(restate.CancelledError);
    await expectMadeOnce(map, sent);
  });

  it('makes them too when the handler catches the CancelledError and returns', async () => {
    const map = new Map<string, Uint8Array>();
    const sent: Send[] = [];
    expect(await cancelledCommit(map, sent, () => 'stopped')).toBe('stopped');
    await expectMadeOnce(map, sent);
  });

  it('keeps the sends of concurrent transactions apart', async () => {
    const o = object();
    const a = o.attempt();
    await a.end(() => Promise.all([transfer(a), transfer(a), transfer(a)]));
    expect(a.sent.map(decode)).toEqual(['book', 5, 'book', 5, 'book', 5]);
  });

  it('writes one head for a transaction without sends, after its tail entry', async () => {
    const o = object();
    const a = o.attempt();
    const sets: string[] = [];
    const set = o.map.set.bind(o.map);
    o.map.set = (key, value) => (sets.push(key), set(key, value));
    await a.end(() => a.db.transaction((tx) => tx.execute('CREATE TABLE t (v INTEGER)')));
    expect(sets.filter((key) => key === HEAD)).toEqual([HEAD]);
    expect(sets.at(-1)).toBe(HEAD);
  });

  it('makes them once: an attempt that resumes after them makes them no more', async () => {
    const o = object();
    const a = o.attempt();
    // A suspension after the transaction: the attempt ends there.
    await transfer(a);
    a.abort();
    expect(a.sent).toHaveLength(2);
    const next = o.attempt();
    await next.end(() => next.db.values('SELECT 1'));
    expect(next.sent).toEqual([]);
  });

  it('keeps the sends of transactions that commit one after another', async () => {
    const o = object();
    const a = o.attempt();
    const sending = (item: string) =>
      a.db.transaction(async (tx) => {
        await tx.execute('CREATE TABLE IF NOT EXISTS log (v TEXT)');
        await tx.execute('INSERT INTO log VALUES (?)', [item]);
        tx.send(store, 'a').reserve(item);
      });
    await Promise.all(['book', 'pen', 'ink', 'cup'].map(sending));
    a.abort();
    expect(a.sent.map(decode).toSorted((x, y) => String(x).localeCompare(String(y)))).toEqual([
      'book',
      'cup',
      'ink',
      'pen',
    ]);
  });

  it("keeps a send's delay and its own idempotency key", async () => {
    const o = object();
    const a = o.attempt();
    await a.end(() =>
      a.db.transaction(async (tx) => {
        tx.send(store, 'a', { delay: { seconds: 2 }, idempotencyKey: 'mine' }).reserve('book');
      }),
    );
    expect(a.sent.map((s) => [s.delay, s.idempotencyKey])).toEqual([[2000, 'mine']]);
  });

  it('refuses a send after the body', async () => {
    const o = object();
    const a = o.attempt();
    let late: restate.Transaction | undefined;
    await a.end(() =>
      a.db.transaction(async (tx) => {
        late = tx;
        tx.send(store, 'a').reserve('book');
      }),
    );
    expect(() => late!.send(store, 'a').reserve('pen')).toThrow(restate.TerminalError);
    expect(a.sent.map(decode)).toEqual(['book']);
  });
});

describe('a transaction that learns of a call waiting for it', () => {
  it('commits when its body returns on `queued`, and the call then sees it', async () => {
    const a = object().attempt();
    const events: string[] = [];
    await a.end(async () => {
      await a.db.execute('CREATE TABLE t (v INTEGER)');
      let release!: () => void;
      const held = a.db.transaction(async (tx) => {
        await tx.execute('INSERT INTO t VALUES (1)');
        await new Promise<void>((resolve) => (release = resolve));
        await tx.queued;
        events.push('returned');
      });
      await new Promise((r) => setTimeout(r, 10));
      const read = a.db.values('SELECT v FROM t').then((rows) => {
        events.push('read');
        return rows;
      });
      release();
      await held;
      expect(await read).toEqual([[1]]);
    });
    expect(events).toEqual(['returned', 'read']);
  });
});
