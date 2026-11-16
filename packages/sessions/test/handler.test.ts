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
import { serveSession, servedHere, type Stream } from '../src/handler.ts';
import { bytes, decode, field, frame, uint } from './wire.ts';
import { messages, TYPE as BASE, V8, value } from './vm-support.ts';

const TYPE = {
  ...BASE,
  getStateKeys: 0x0406,
  getStateKeysCompletion: 0x8006,
  run: 0x0411,
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
  /** Commands seen, to number the acks as Restate does. */
  let commands = 1; // the input is the first

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
            commands++;
            const key = text(message.fields.get(1)?.[0] as Uint8Array)!;
            const wrapped = decode(message.fields.get(3)![0] as Uint8Array);
            state.set(key, wrapped.get(1)![0] as Uint8Array);
            toSdk.push(frame(TYPE.commandAck, uint(1, commands)));
          } else if (message.type === TYPE.clearState) {
            commands++;
            state.delete(text(message.fields.get(1)?.[0] as Uint8Array)!);
            toSdk.push(frame(TYPE.commandAck, uint(1, commands)));
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
    both: async (ctx: restate.SessionContext) => {
      // Two reads of Restate awaited at once: the selector's reason to exist.
      const [a, b] = await Promise.all([
        ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM notes'),
        ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM notes'),
      ]);
      return (a?.n ?? -1) + (b?.n ?? -1);
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

  it('awaits two reads of Restate at once, which the selector existed to allow', async () => {
    const r = restateSide();
    const serving = serveSession(notes, 'both', r.stream);
    r.start('k2', null);
    await r.settle();
    await serving;
    const output = r.sent().find((m) => m.type === TYPE.output);
    const answered = decode(output!.fields.get(14)![0] as Uint8Array);
    expect(text(answered.get(1)![0] as Uint8Array)).toBe('0');
  });
});
