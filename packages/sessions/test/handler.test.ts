// A session object's handler served on the explicit recovery VM
// (`src/handler.ts`), with Restate's side played by wire bytes: no SDK
// endpoint, and a real `ctx.db` over the object's state.
//
// The assertions name what only this path does — the state read and written
// in the addon, a commit whose head write carries its own sync, and no run in
// the journal.
import { describe, expect, it } from 'vitest';
import * as restate from '@restatedev/sessions';
import { database, HEAD_KEY, start } from '@restatedev/sessions/internal';
import { CancelledError } from '@restatedev/restate-sdk';
import { serveSession, servedHere, type Stream } from '../src/handler.ts';
import { bytes, decode, field, frame, uint } from './wire.ts';
import { messages, REQUESTED_ACK, TYPE as BASE, V8, value } from './vm-support.ts';

const TYPE = {
  ...BASE,
  getStateKeys: 0x0406,
  getStateKeysCompletion: 0x8006,
  run: 0x0411,
  oneWayCall: 0x040e,
} as const;

const text = (b: Uint8Array | undefined) => (b === undefined ? undefined : Buffer.from(b).toString());

/**
 * Restate's side: it holds the object's state, answers the reads, applies the
 * writes, and acks the commands that asked to be acked.
 */
function restateSide(state = new Map<string, Uint8Array>(), { cancelOnCommit = false, cancelAtStart = false } = {}) {
  const chunks: Uint8Array[] = [];
  let resolveChunk: (() => void) | undefined;
  let closed = false;
  /**
   * The journal index of the last command seen. Restate numbers *every*
   * command, so an ack must count the calls too, not only the writes.
   */
  let index = 0; // the input is the journal's first command, at index 0

  const inbound: Uint8Array[] = [];
  const toSdk = {
    push(chunk: Uint8Array) {
      inbound.push(chunk);
      resolveChunk?.();
      resolveChunk = undefined;
    },
    close() {
      closed = true;
      resolveChunk?.();
      resolveChunk = undefined;
    },
  };

  const body: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (inbound.length > 0) yield inbound.shift()!;
        if (closed) return;
        await new Promise<void>((resolve) => (resolveChunk = resolve));
      }
    },
  };

  let head: { status: number; headers: Record<string, string> } | undefined;
  let ended = false;
  /** How many of the attempt's messages have been answered. */
  let answered = 0;
  /** Whether the one cancel signal has been sent (`cancelOnCommit`). */
  let signalled = false;
  const stream: Stream = {
    headers: { 'content-type': V8 },
    body,
    writeHead: (status, headers) => void (head = { status, headers }),
    write: (chunk) => void chunks.push(chunk),
    close: () => void (ended = true),
  };

  return {
    stream,
    get head() {
      return head;
    },
    get ended() {
      return ended;
    },
    /** Everything the attempt wrote, as messages. */
    sent: () => messages(Buffer.concat(chunks)),
    /** Start the invocation for `key` with `input`. */
    start(key: string, input: unknown) {
      toSdk.push(
        frame(TYPE.start, [
          ...bytes(1, [1, 2, 3, 4]),
          ...bytes(2, 'inv_test'),
          ...uint(3, 1),
          ...[...state].flatMap(([k, v]) => field(4, 2, [...bytes(1, k), ...bytes(2, [...v])])),
          ...bytes(6, key),
        ]),
      );
      toSdk.push(frame(TYPE.input, bytes(14, value(JSON.stringify(input)))));
      // A retry of a cancelled invocation: the signal is among the entries of
      // the earlier attempts, so the VM knows before the handler starts.
      if (cancelAtStart) toSdk.push(frame(TYPE.signal, [...uint(2, 1), ...bytes(4, [])]));
    },
    /**
     * Restate cancels the invocation now. Called while the handler works
     * outside Restate, nothing of the attempt is waiting and the
     * cancellation is carried to its next wait.
     */
    cancel() {
      toSdk.push(frame(TYPE.signal, [...uint(2, 1), ...bytes(4, [])]));
    },
    /**
     * Answer what the attempt asks for until it ends, then close the request
     * body. Closing it earlier is what Restate's inactivity timeout does, and
     * would shut the attempt down.
     */
    async settle({ ms = 20_000 } = {}) {
      const deadline = Date.now() + ms;
      for (;;) {
        if (ended || Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 1));
        const sent = messages(Buffer.concat(chunks));
        for (const message of sent.slice(answered)) {
          answered++;
          // Commands are journaled and numbered; ephemeral commands (0x02xx)
          // and notifications (0x8xxx) are not.
          if (message.type >= 0x0400 && message.type < 0x8000) {
            index++;
            // Restate acks a stored command; the VM waits for the ack of the
            // sync's clear, and ignores the rest.
            // Restate acks a command only if it asked to be acked, and the
            // ack of one covers every command before it. Acking the rest
            // would answer a commit that is still waiting.
            if ((message.flags & REQUESTED_ACK) !== 0) {
              // Cancelling instead of acking is a cancellation that lands
              // with the database waiting on Restate.
              // Restate signals a cancellation once, not on every commit:
              // what follows it is acked as usual, so the handler can see
              // its first call fail and carry on, as it does on the
              // selector's path.
              const signalNow = cancelOnCommit && !signalled;
              signalled ||= signalNow;
              toSdk.push(
                signalNow
                  ? frame(TYPE.signal, [...uint(2, 1), ...bytes(4, [])])
                  : frame(TYPE.commandAck, uint(1, index)),
              );
            }
          }
          if (message.type === TYPE.getStateEphemeral) {
            const key = text(message.fields.get(2)?.[0] as Uint8Array)!;
            const id = message.fields.get(1)![0] as number;
            const held = state.get(key);
            toSdk.push(
              frame(TYPE.getStateEphemeralNotification, [
                ...uint(1, id),
                ...(held === undefined ? field(4, 2, []) : field(5, 2, value(held))),
              ]),
            );
          } else if (message.type === TYPE.setState) {
            const key = text(message.fields.get(1)?.[0] as Uint8Array)!;
            const wrapped = decode(message.fields.get(3)![0] as Uint8Array);
            state.set(key, wrapped.get(1)![0] as Uint8Array);
          } else if (message.type === TYPE.clearState) {
            state.delete(text(message.fields.get(1)?.[0] as Uint8Array)!);
          } else if (message.type === TYPE.call) {
            const id = message.fields.get(10)![0] as number;
            toSdk.push(frame(TYPE.callInvocationIdCompletion, [...uint(1, id), ...bytes(16, 'inv_started')]));
            // A call to key `k` is never answered: that is what a `start()`ed
            // call, whose result nobody holds, looks like to the handler.
            if (text(message.fields.get(5)?.[0] as Uint8Array) !== 'k') {
              const result = message.fields.get(11)![0] as number;
              const echoed = text(message.fields.get(3)![0] as Uint8Array)!;
              toSdk.push(frame(TYPE.callCompletion, [...uint(1, result), ...field(5, 2, value(echoed))]));
            }
          } else if (message.type === TYPE.getStateKeys) {
            const id = message.fields.get(11)![0] as number;
            toSdk.push(
              frame(TYPE.getStateKeysCompletion, [
                ...uint(1, id),
                ...field(
                  5,
                  2,
                  [...state.keys()].flatMap((k) => bytes(1, k)),
                ),
              ]),
            );
          }
        }
        // The attempt is over once it has said so; nothing more will come.
        if (sent.some((m) => m.type === TYPE.end || m.type === TYPE.error)) break;
      }
      if (!ended && !messages(Buffer.concat(chunks)).some((m) => m.type === TYPE.end || m.type === TYPE.error)) {
        // Closing the body here is what Restate's inactivity timeout does, and
        // the attempt would report a shutdown — which reads as a puzzling
        // assertion failure rather than as the hang it is.
        throw new Error(`the attempt did not end within ${ms}ms`);
      }
      toSdk.close();
    },
    state,
  };
}

const notes = restate.sessionObject({
  name: 'Notes',
  schema: ['CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)'],
  handlers: {
    add: async (ctx: restate.SessionContext, body: string) => {
      await ctx.db.execute('INSERT INTO notes (body) VALUES (?)', [body]);
      const row = await ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM notes');
      return row!.n;
    },
    /** Starts a call and returns without awaiting its result, as `start` does. */
    starts: async (ctx: restate.SessionContext) => {
      return await start(ctx, { service: 'Callee', key: 'k', handler: 'echo', input: 'x' });
    },
    /** Commits, and says what its failure was if it did not. */
    commits: async (ctx: restate.SessionContext) => {
      try {
        await ctx.db.execute('INSERT INTO notes (body) VALUES (?)', ['x']);
        return 'committed';
      } catch (error) {
        return error instanceof CancelledError ? 'CancelledError' : (error as Error).name;
      }
    },
    /** Two commits, each reporting whether it failed and how. */
    twice: async (ctx: restate.SessionContext) => {
      const once = async () => {
        try {
          await ctx.db.execute('INSERT INTO notes (body) VALUES (?)', ['x']);
          return 'ok';
        } catch (error) {
          return error instanceof CancelledError ? 'CancelledError' : (error as Error).name;
        }
      };
      return `${await once()},${await once()}`;
    },
    /**
     * A commit, work outside Restate long enough for a cancellation to land
     * with nothing waiting, then another commit.
     */
    twoCommits: async (ctx: restate.SessionContext) => {
      const commit = async (body: string) => {
        try {
          await ctx.db.execute('INSERT INTO notes (body) VALUES (?)', [body]);
          return 'ok';
        } catch (error) {
          return error instanceof CancelledError ? 'CancelledError' : (error as Error).name;
        }
      };
      const first = await commit('a');
      await new Promise((resolve) => setTimeout(resolve, 300));
      // A transaction, so the commit has sends of its own: they are made in
      // the hook between its head write and the wait for that write's ack.
      try {
        await ctx.db.transaction(async (tx) => {
          await tx.execute('INSERT INTO notes (body) VALUES (?)', ['b']);
          tx.send({ service: 'Shipping', key: 'b', handler: 'ship', input: 'b' });
        });
        return `${first},ok`;
      } catch (error) {
        return `${first},${error instanceof CancelledError ? 'CancelledError' : (error as Error).name}`;
      }
    },
    /**
     * The same, with calls of Restate instead of the database: a carried
     * cancellation has to reach the call's result, which is what a handler
     * awaits, rather than the invocation id it makes first.
     */
    callTwice: async (ctx: restate.SessionContext) => {
      // The signal has to land with nothing in flight, or the first call is
      // rejected where it waits and the carry is never exercised.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const once = async () => {
        try {
          return String(await ctx.rpc({ service: 'Callee', key: 'a', handler: 'echo', input: 'A' }));
        } catch (error) {
          return error instanceof CancelledError ? 'CancelledError' : (error as Error).name;
        }
      };
      return `${await once()},${await once()}`;
    },
    /** A send first, which makes an invocation id and nothing else: it must
     * not swallow the carried cancellation that the call after it is owed. */
    sendThenCall: async (ctx: restate.SessionContext) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      ctx.send({ service: 'Callee', key: 'a', handler: 'echo', input: 'S' });
      try {
        return String(await ctx.rpc({ service: 'Callee', key: 'a', handler: 'echo', input: 'A' }));
      } catch (error) {
        return error instanceof CancelledError ? 'CancelledError' : (error as Error).name;
      }
    },
    /** A database of its own, beside the object's: its keys are named apart. */
    beside: async (ctx: restate.SessionContext) => {
      const own = database(ctx.db, 'notes2');
      await own.execute('CREATE TABLE IF NOT EXISTS n (id INTEGER PRIMARY KEY)');
      await own.execute('INSERT INTO n (id) VALUES (1)');
      const row = await own.get<{ n: number }>('SELECT count(*) AS n FROM n');
      return row!.n;
    },
    /** A send with a delay given as a `Duration`, not milliseconds. */
    sends: async (ctx: restate.SessionContext) => {
      ctx.send({ service: 'Callee', key: 'k', handler: 'echo', input: 'x', delay: { seconds: 30 } });
      return 'sent';
    },
    /**
     * Two calls awaited at once, each waiting on Restate. This is the
     * selector's reason to exist: the SDK's own loop lets one promise wait on
     * the server at a time. Two `ctx.db` reads would not show it — the
     * database runs its calls one at a time, so they never wait together.
     */
    both: async (ctx: restate.SessionContext) => {
      const [a, b] = await Promise.all([
        ctx.rpc({ service: 'Callee', key: 'a', handler: 'echo', input: 'A' }),
        ctx.rpc({ service: 'Callee', key: 'b', handler: 'echo', input: 'B' }),
      ]);
      return `${String(a)}${String(b)}`;
    },
  },
  views: {
    /** A view reads beside the handlers, in its own session, and writes nothing. */
    count: async (ctx: restate.ViewContext) => {
      const row = await ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM notes');
      return row?.n ?? -1;
    },
  },
});

describe('a session object served on the explicit recovery VM', () => {
  it('serves only the protocol versions the VM accepts', () => {
    expect(servedHere({ 'content-type': V8 })).toBe(true);
    expect(servedHere({ 'content-type': 'application/vnd.restate.invocation.v7' })).toBe(true);
    expect(servedHere({ 'content-type': 'application/vnd.restate.invocation.v6' })).toBe(false);
    expect(servedHere({})).toBe(false);
  }, 30_000);

  it('runs a handler, commits its database, and answers', async () => {
    const r = restateSide();
    const serving = serveSession(notes, 'add', r.stream);
    r.start('k1', 'first');
    await r.settle();
    await serving;

    expect(r.head?.status).toBe(200);
    expect(r.ended).toBe(true);
    const sent = r.sent();
    const output = sent.find((m) => m.type === TYPE.output);
    expect(output).toBeDefined();
    const answered = decode(output!.fields.get(14)![0] as Uint8Array);
    expect(text(answered.get(1)![0] as Uint8Array)).toBe('1');
    expect(sent.at(-1)?.type).toBe(TYPE.end);

    // What only this path does: the state never crosses into JavaScript. The
    // addon reads and writes it as the VM's own commands, and a commit is the
    // tail, then the head written *with* its sync — one acked write, and no
    // `v22/sync` clear, which is how a store in JavaScript asks for the same.
    const acked = sent.filter((m) => m.type === TYPE.setState && (m.flags & REQUESTED_ACK) !== 0);
    expect(acked.map((m) => text(m.fields.get(1)![0] as Uint8Array))).toEqual(['v22/head', 'v22/head']);
    expect(sent.some((m) => m.type === TYPE.clearState)).toBe(false);
    expect(sent.some((m) => m.type === TYPE.run)).toBe(false);

    // The database landed in the object's state.
    expect([...r.state.keys()].some((k) => k.startsWith('v22/'))).toBe(true);
  }, 30_000);

  it('a cancellation fails what the database waits for, with the CancelledError', async () => {
    // The state is read and written in the addon now, so the driver cannot
    // reject those waits: the VM fails them and `database.ts` restores the
    // class. On the selector's path the store's own rejection carried it.
    const r = restateSide(new Map(), { cancelOnCommit: true });
    const serving = serveSession(notes, 'commits', r.stream);
    r.start('k5', null);
    await r.settle();
    await serving;
    const output = r.sent().find((m) => m.type === TYPE.output);
    const answered = decode(output!.fields.get(14)![0] as Uint8Array);
    expect(text(answered.get(1)![0] as Uint8Array)).toBe('"CancelledError"');
  }, 30_000);

  it('a view reads, and writes nothing: its sync has nothing to store', async () => {
    const state = new Map<string, Uint8Array>();
    const writer = restateSide(state);
    const writing = serveSession(notes, 'add', writer.stream);
    writer.start('k8', 'first');
    await writer.settle();
    await writing;
    const stored = new Map(state);

    const r = restateSide(state);
    const serving = serveSession(notes, 'count', r.stream);
    r.start('k8', null);
    await r.settle();
    await serving;
    const output = r.sent().find((m) => m.type === TYPE.output);
    const answered = decode(output!.fields.get(14)![0] as Uint8Array);
    expect(text(answered.get(1)![0] as Uint8Array)).toBe('1');
    // `VmStore` refuses a reader's writes and syncs it at once, so the view
    // sends no state command and leaves the object's state as it found it.
    expect(r.sent().some((m) => m.type === TYPE.setState || m.type === TYPE.clearState)).toBe(false);
    expect([...state.keys()].toSorted()).toEqual([...stored.keys()].toSorted());
  }, 30_000);

  it('a retry of a cancelled invocation fails its first call, and works after it', async () => {
    // The cancel signal is among the earlier attempts' entries, so the VM
    // knows before the handler starts and nothing is in flight to reject.
    // The selector's path fails the first call all the same
    // (`cancellation.test.ts`, "a retry of a cancelled invocation"), so a
    // cancellation nothing was waiting for is carried to the next wait.
    const r = restateSide(new Map(), { cancelAtStart: true });
    const serving = serveSession(notes, 'twice', r.stream);
    r.start('k7', null);
    await r.settle();
    await serving;
    const output = r.sent().find((m) => m.type === TYPE.output);
    const answered = decode(output!.fields.get(14)![0] as Uint8Array);
    expect(text(answered.get(1)![0] as Uint8Array)).toBe('"CancelledError,ok"');
  }, 30_000);

  it('a carried cancellation fails the next commit without putting its head write out', async () => {
    // The head is what makes a commit visible, so a commit reported cancelled
    // must not leave one behind: a handler that compensates on
    // `CancelledError` would otherwise be compensating for a write that did
    // happen. Issuing the command and only then failing its waiter left
    // exactly that — the row durable, the `await` rejected.
    const state = new Map<string, Uint8Array>();
    const r = restateSide(state);
    const serving = serveSession(notes, 'twoCommits', r.stream);
    r.start('kc', null);
    // While the handler works outside Restate, between its two commits.
    const landing = setTimeout(() => r.cancel(), 150);
    await r.settle();
    clearTimeout(landing);
    await serving;
    const output = r.sent().find((m) => m.type === TYPE.output);
    const answered = decode(output!.fields.get(14)![0] as Uint8Array);
    expect(text(answered.get(1)![0] as Uint8Array)).toBe('"ok,CancelledError"');
    // The cancelled commit's pages went out — they are written before its
    // head, and are harmless without one — but its head never did, so the
    // commit is invisible, exactly as after a crash mid-commit. Counting
    // commits would count the schema's too, so this asserts the shape: the
    // last state command is a page, with no head after it.
    const written = r
      .sent()
      .filter((m) => m.type === TYPE.setState)
      .map((m) => ({ key: text(m.fields.get(1)![0] as Uint8Array)!, acked: (m.flags & REQUESTED_ACK) !== 0 }));
    expect(written.at(-1)?.key, 'the cancelled commit wrote no page').toMatch(/^v22\/tail\//);
    const lastHead = written.findLastIndex((w) => w.key === HEAD_KEY);
    const lastPage = written.findLastIndex((w) => w.key.startsWith('v22/tail/'));
    expect(lastHead, 'the cancelled commit put its head write out too').toBeLessThan(lastPage);
    // And its sends stayed in. They are made in the hook between the head
    // write and the wait for its ack, so failing the wait after the command
    // had been issued let them out for a commit that never landed: the
    // shipment durable and the row not.
    expect(
      r.sent().some((m) => m.type === TYPE.oneWayCall),
      "the cancelled commit's sends went out",
    ).toBe(false);
    // Every head write asks for its own ack: that ack is the commit's sync.
    expect(written.filter((w) => w.key === HEAD_KEY).every((w) => w.acked)).toBe(true);
  }, 30_000);

  it("a retry's carried cancellation fails the call's result, not the id it makes first", async () => {
    // A call makes the invocation id's promise before the result's. Handing
    // the carry to the id let the call run to completion and the handler see
    // `ok` — the cancellation lost.
    const r = restateSide(new Map(), { cancelAtStart: true });
    const serving = serveSession(notes, 'callTwice', r.stream);
    r.start('k8', null);
    await r.settle();
    await serving;
    const output = r.sent().find((m) => m.type === TYPE.output);
    const answered = decode(output!.fields.get(14)![0] as Uint8Array);
    expect(text(answered.get(1)![0] as Uint8Array)).toBe('"CancelledError,A"');
  }, 30_000);

  it('a send does not swallow the cancellation the call after it is owed', async () => {
    const r = restateSide(new Map(), { cancelAtStart: true });
    const serving = serveSession(notes, 'sendThenCall', r.stream);
    r.start('k9', null);
    await r.settle();
    await serving;
    const output = r.sent().find((m) => m.type === TYPE.output);
    const answered = decode(output!.fields.get(14)![0] as Uint8Array);
    expect(text(answered.get(1)![0] as Uint8Array)).toBe('"CancelledError"');
  }, 30_000);

  it('a database beside the object keeps its keys apart, as the addon names them', async () => {
    const r = restateSide();
    const serving = serveSession(notes, 'beside', r.stream);
    r.start('k6', null);
    await r.settle();
    await serving;
    const output = r.sent().find((m) => m.type === TYPE.output);
    const answered = decode(output!.fields.get(14)![0] as Uint8Array);
    expect(text(answered.get(1)![0] as Uint8Array)).toBe('1');
    // `VmStore::key` reimplements `beside` in Rust; these are the keys the
    // JavaScript store would have written, so the two cannot drift apart.
    // `beside('notes2')` puts the name after the format's prefix, so
    // `v22/head` becomes `v22/db/notes2/head`. The object's own database is
    // open too (it has a schema), and keeps its keys unprefixed.
    const written = [...r.state.keys()].toSorted();
    expect(written).toContain('v22/db/notes2/head');
    expect(written).toContain('v22/head');
    expect(written.every((k) => k.startsWith('v22/'))).toBe(true);
  }, 30_000);

  it('a handler that starts a call and returns leaves no unhandled rejection', async () => {
    // The call's result is never answered and rejects when the attempt ends.
    // Nothing holds it — `start` awaits only the invocation id — so an
    // unhandled rejection here would bring the process down. Vitest fails the
    // run on one, which is the assertion.
    const r = restateSide();
    const serving = serveSession(notes, 'starts', r.stream);
    r.start('k3', null);
    await r.settle();
    await serving;
    const output = r.sent().find((m) => m.type === TYPE.output);
    const answered = decode(output!.fields.get(14)![0] as Uint8Array);
    expect(text(answered.get(1)![0] as Uint8Array)).toBe('"inv_started"');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }, 30_000);

  it('a send takes a Duration delay, not only milliseconds', async () => {
    const r = restateSide();
    const serving = serveSession(notes, 'sends', r.stream);
    r.start('k4', null);
    await r.settle();
    await serving;
    const sent = r.sent().find((m) => m.type === TYPE.oneWayCall);
    expect(sent).toBeDefined();
    // `invoke_time` is absolute: 30 seconds from now, not 0 and not NaN.
    const at = Number(sent!.fields.get(4)![0]);
    expect(at).toBeGreaterThan(Date.now() + 20_000);
    const output = r.sent().find((m) => m.type === TYPE.output);
    expect(output?.fields.get(14)).toBeDefined();
  }, 30_000);

  it('awaits two calls of Restate at once, which the selector existed to allow', async () => {
    const r = restateSide();
    const serving = serveSession(notes, 'both', r.stream);
    r.start('k2', null);
    await r.settle();
    await serving;
    const output = r.sent().find((m) => m.type === TYPE.output);
    const answered = decode(output!.fields.get(14)![0] as Uint8Array);
    // Both answered, in the order the handler put them.
    expect(text(answered.get(1)![0] as Uint8Array)).toBe('"AB"');
  }, 30_000);
});
