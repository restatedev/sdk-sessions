// A session object's handler served on the explicit recovery VM
// (`src/handler.ts`), with Restate's side played by wire bytes: no SDK
// endpoint, no selector, and a real `ctx.db` over the object's state.
//
// This is what proves the new path ran. Both paths coexist while `connect`
// waits for the SDK, so a fallback would be silent: the assertions name what
// only this path does — an acked clear of `v22/sync`, and no `sync` or `work`
// run in the journal.
import { describe, expect, it } from 'vitest';
import * as restate from '@restatedev/sessions';
import { start } from '@restatedev/sessions/internal';
import { serveSession, servedHere, type Stream } from '../src/handler.ts';
import { bytes, decode, field, frame, uint } from './wire.ts';
import { messages, TYPE as BASE, V8, value } from './vm-support.ts';

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
function restateSide(state = new Map<string, Uint8Array>()) {
  const chunks: Uint8Array[] = [];
  let resolveChunk: (() => void) | undefined;
  let closed = false;
  /**
   * The journal index of the last command seen. Restate numbers *every*
   * command, so an ack must count the calls too, not only the writes.
   */
  let index = 1; // the input is the first

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
    },
    /**
     * Answer what the attempt asks for until it ends, then close the request
     * body. Closing it earlier is what Restate's inactivity timeout does, and
     * would shut the attempt down.
     */
    async settle({ ms = 5000 } = {}) {
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
            if (message.type === TYPE.setState || message.type === TYPE.clearState) {
              toSdk.push(frame(TYPE.commandAck, uint(1, index)));
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
});

describe('a session object served on the explicit recovery VM', () => {
  it('serves only the protocol versions the VM accepts', () => {
    expect(servedHere({ 'content-type': V8 })).toBe(true);
    expect(servedHere({ 'content-type': 'application/vnd.restate.invocation.v7' })).toBe(true);
    expect(servedHere({ 'content-type': 'application/vnd.restate.invocation.v6' })).toBe(false);
    expect(servedHere({})).toBe(false);
  });

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

    // What only this path does: the commit syncs with an acked clear of
    // `v22/sync`, and nothing is journaled as a run.
    const cleared = sent.filter((m) => m.type === TYPE.clearState).map((m) => text(m.fields.get(1)![0] as Uint8Array));
    expect(cleared).toContain('v22/sync');
    expect(sent.some((m) => m.type === TYPE.run)).toBe(false);

    // The database landed in the object's state.
    expect([...r.state.keys()].some((k) => k.startsWith('v22/'))).toBe(true);
  });

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
  });

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
  });

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
  });
});
