// Session objects on the explicit recovery protocol, over as many attempts as
// an invocation takes, with the core's fake runtime as Restate (`side.ts`):
// what the runtime observes of real handlers. A commit with its send, a call
// that outlives its attempt, restarts, a SIGTERM, a signal that wakes a
// suspended invocation, invocation state, cancellation and spans. The fake
// checks every message against the protocol: `settle` fails on a violation.
import { describe, expect, it } from 'vitest';
import * as restate from '@restatedev/sessions';
import {
  attach,
  flush,
  invocationState,
  readSignal,
  rideCommit,
  sendSignal,
  span,
} from '@restatedev/sessions/internal';
import { goAway, serveSession } from '../src/handler.ts';
import { HEAD_KEY } from '../src/object.ts';
import { FakeRuntime } from './fake.ts';
import { output, outcome, pause, restateSide, run, type SideOptions, TYPE } from './side.ts';
import { ACTION, members, num, RECORD, str } from './wire.ts';

const attemptOf = (ctx: restate.SessionContext) => (ctx.request as { attempt?: number }).attempt;
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (value: Uint8Array | null) => (value === null ? null : new TextDecoder().decode(value));

/** Lets a handler that works outside Restate go on, once a test says so. */
let goOn: (() => void) | undefined;

const ledger = restate.sessionObject({
  name: 'Ledger',
  schema: ['CREATE TABLE entries (id INTEGER PRIMARY KEY, body TEXT NOT NULL)'],
  handlers: {
    /** A row and, in the same commit, a send. */
    add: async (ctx: restate.SessionContext, body: string) => {
      await ctx.db.transaction(async (tx) => {
        await tx.execute('INSERT INTO entries (body) VALUES (?)', [body]);
        tx.send({ service: 'Mailer', key: ctx.key, handler: 'notify', input: body });
      });
      return attemptOf(ctx);
    },
    /** A transaction that only sends: its commit writes nothing. */
    onlySends: async (ctx: restate.SessionContext) => {
      await ctx.db.transaction(async (tx) => {
        tx.send({ service: 'Mailer', key: ctx.key, handler: 'notify', input: 'bare' });
      });
      return 'sent';
    },
    /** A rider, then a transaction that commits a row and a send: one group. */
    rides: async (ctx: restate.SessionContext) => {
      rideCommit(ctx.db, 'note', async (tx) => {
        await tx.execute("INSERT INTO entries (body) VALUES ('rider')");
      });
      await ctx.db.transaction(async (tx) => {
        await tx.execute("INSERT INTO entries (body) VALUES ('row')");
        tx.send({ service: 'Mailer', key: ctx.key, handler: 'notify', input: 'row' });
      });
      return 'rode';
    },
    /** A call with an idempotency key, so a later attempt reaches the same invocation. */
    charge: async (ctx: restate.SessionContext) => {
      const answer = await ctx.rpc<string>({
        service: 'Payments',
        key: ctx.key,
        handler: 'charge',
        input: 'card',
        idempotencyKey: `${ctx.request.id}/charge`,
      });
      return `${answer} on attempt ${attemptOf(ctx)}`;
    },
    /** Commits a row once, whichever attempt it is on, and works outside Restate until let go. */
    once: async (ctx: restate.SessionContext) => {
      const done = await ctx.db.get('SELECT 1 FROM entries WHERE body = ?', ['once']);
      if (done === undefined) await ctx.db.execute("INSERT INTO entries (body) VALUES ('once')");
      if (attemptOf(ctx) === 1) await new Promise<void>((resolve) => (goOn = resolve));
      return attemptOf(ctx);
    },
    /** Waits for the signal `approval`, then commits what it carried. */
    approve: async (ctx: restate.SessionContext) => {
      const approval = text(await readSignal(ctx, 'approval'));
      await ctx.db.execute('INSERT INTO entries (body) VALUES (?)', [`approval:${approval}`]);
      return `${approval} on attempt ${attemptOf(ctx)}`;
    },
    /** Signals another invocation, and waits until Restate applied it. */
    notify: async (ctx: restate.SessionContext, target: string) => {
      sendSignal(ctx, target, 'done', bytes('"shipped"'));
      await flush(ctx);
      return 'notified';
    },
    /**
     * Cancels, signals and attaches to each malformed id, catching what each
     * throws; then cancels and signals `other` for real.
     */
    malformedIds: async (ctx: restate.SessionContext, other: string) => {
      const caught: string[] = [];
      const note = (error: unknown) => {
        if (!(error instanceof restate.TerminalError)) throw error;
        caught.push(`${error.code} ${error.message}`);
      };
      for (const malformed of MALFORMED_IDS) {
        try {
          ctx.cancel(malformed);
        } catch (error) {
          note(error);
        }
        try {
          sendSignal(ctx, malformed, 'done', bytes('"x"'));
        } catch (error) {
          note(error);
        }
        await attach(ctx, malformed).catch(note);
      }
      ctx.cancel(other);
      sendSignal(ctx, other, 'done', bytes('"shipped"'));
      await ctx.db.transaction(async (tx) => {
        // In a transaction too: the error is the handler's, which goes on with it.
        try {
          ctx.cancel('inv_garbage');
        } catch (error) {
          if (error instanceof restate.TerminalError) caught.push('in the transaction');
        }
        await tx.execute("INSERT INTO entries (body) VALUES ('after')");
      });
      await flush(ctx);
      return caught;
    },
    /** A transaction whose send Restate would refuse (an empty idempotency key), with a row or not; then a row. */
    refusedSend: async (ctx: restate.SessionContext, withRow: boolean) => {
      const caught: string[] = [];
      try {
        await ctx.db.transaction(async (tx) => {
          if (withRow) await tx.execute("INSERT INTO entries (body) VALUES ('rolled back')");
          tx.send({ service: 'Mailer', key: ctx.key, handler: 'notify', input: 'x', idempotencyKey: '' });
        });
      } catch (error) {
        if (!(error instanceof restate.TerminalError)) throw error;
        caught.push(`${error.code} ${error.message}`);
      }
      await ctx.db.execute("INSERT INTO entries (body) VALUES ('after')");
      return caught;
    },
    /** Invocation state: attempt 1 notes its step, flushes, then waits on nothing. */
    progress: async (ctx: restate.SessionContext) => {
      const state = invocationState(ctx);
      if ((await state.get('step')) === null) {
        state.set('step', bytes('reserved'));
        await flush(ctx);
        await new Promise(() => {});
      }
      return `${text(await state.get('step'))} on attempt ${attemptOf(ctx)}`;
    },
    /** A call held by the test: a cancellation lands while it is under way. */
    held: async (ctx: restate.SessionContext) =>
      ctx.rpc({ service: 'Payments', key: ctx.key, handler: 'slow', input: 'x' }),
    /** A span with a call inside, and a transaction (a span itself) with its commit inside. */
    spans: async (ctx: restate.SessionContext) => {
      const answer = await span(ctx, 'asking', () =>
        ctx.rpc<string>({ service: 'Oracle', key: 'k1', handler: 'answer', input: 'q' }),
      );
      await ctx.db.transaction(async (tx) => {
        await tx.execute('INSERT INTO entries (body) VALUES (?)', [answer]);
      });
      return answer;
    },
  },
  views: {
    entries: async (ctx: restate.ViewContext) =>
      (await ctx.db.query<{ body: string }>('SELECT body FROM entries ORDER BY id')).map((r) => r.body),
  },
});

/** Invocation ids Restate would refuse: user code that passes one gets a TerminalError (D65). */
const MALFORMED_IDS = ['inv_garbage', 'inv_1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '', 'order-7'];

/** The rows of key `key` in `state`, read by a view. */
async function entries(state: Map<string, Uint8Array>, key: string): Promise<string[]> {
  const ended = await run(ledger, 'entries', state, key);
  if (ended === undefined || !('value' in ended)) throw new Error(`entries ended with ${JSON.stringify(ended)}`);
  return JSON.parse(ended.value) as string[];
}

/** An invocation of `handler` over its attempts: each `attempt()` is a side of its own on one runtime. */
function invocation(
  handler: string,
  key: string,
  input: unknown,
  options: SideOptions & { preload?: 'all' | 'lazy' } = {},
) {
  const state = new Map<string, Uint8Array>();
  const rt = new FakeRuntime({
    invocationId: 'inv_test',
    service: 'Ledger',
    handler,
    key,
    input: bytes(JSON.stringify(input)),
    objectPreload: options.preload === 'lazy' ? [HEAD_KEY] : 'all',
  });
  return {
    rt,
    state,
    /**
     * The next attempt: started, its handler served. `done` once its response
     * ended: a handler Restate shut down at work of its own runs on, until
     * `served`. A test lets it end before the next attempt opens the same
     * database in this process: an attempt that opens it while the one before
     * still flushes there fails with "reopen" (retryable), which is the
     * storage's business, not this file's.
     */
    attempt() {
      const r = restateSide(state, { ...options, runtime: rt });
      const serving = serveSession(ledger, handler, r.stream);
      r.start(key, input);
      return { r, done: r.settle(), served: serving.catch(() => {}) };
    },
  };
}

describe('session objects on the explicit recovery protocol, across attempts', () => {
  it("a commit and its send are one atomic group, the database's writes recorded as nothing", async () => {
    const i = invocation('add', 'a', 'first');
    const { r, done } = i.attempt();
    await done;
    expect(output(r.sent())).toBe('1');
    const groups = r.sent().filter((m) => m.type === TYPE.atomicGroup);
    // The schema's commit as the session opens, then the transaction's.
    const commit = groups.at(-1)!;
    expect(str(commit, ACTION.name)).toBe('commit');
    expect(num(commit, ACTION.resultId)).toBeGreaterThan(0);
    const inside = members(commit);
    const send = inside.findIndex((m) => m.type === TYPE.call);
    expect(send).toBeGreaterThan(0);
    // The writes first, the send after them; each write recorded as nothing, wanting no result.
    expect(inside.slice(0, send).every((m) => m.type === TYPE.setState || m.type === TYPE.clearState)).toBe(true);
    expect(inside.slice(0, send).every((m) => num(m, ACTION.record) === RECORD.none)).toBe(true);
    expect(inside.slice(0, send).some((m) => str(m, 2) === HEAD_KEY)).toBe(true);
    // The send: no result wanted, no idempotency key of the SDK's making, named after its target.
    expect(num(inside[send]!, ACTION.resultId)).toBe(0);
    expect(str(inside[send]!, 6)).toBeUndefined();
    expect(str(inside[send]!, ACTION.name)).toBe('Mailer/notify');
    expect(i.rt.calls().map((c) => `${c.service}/${c.key}/${c.handler} ${c.parameter.toString()}`)).toEqual([
      'Mailer/a/notify "first"',
    ]);
    expect(await entries(i.state, 'a')).toEqual(['first']);
  }, 30_000);

  it('a transaction that writes nothing makes its sends in a group of their own', async () => {
    const i = invocation('onlySends', 'b', null);
    const { r, done } = i.attempt();
    await done;
    expect(output(r.sent())).toBe('"sent"');
    const sending = r.sent().filter((m) => m.type === TYPE.atomicGroup && members(m).some((a) => a.type === TYPE.call));
    expect(sending).toHaveLength(1);
    expect(members(sending[0]!).map((m) => m.type)).toEqual([TYPE.call]);
    expect(num(sending[0]!, ACTION.resultId)).toBeGreaterThan(0);
    expect(i.rt.calls()).toHaveLength(1);
  }, 30_000);

  it('a rider rides the commit, its rows and the send in one group', async () => {
    const i = invocation('rides', 'c', null);
    const { r, done } = i.attempt();
    await done;
    expect(output(r.sent())).toBe('"rode"');
    const sending = r.sent().filter((m) => m.type === TYPE.atomicGroup && members(m).some((a) => a.type === TYPE.call));
    expect(sending).toHaveLength(1);
    // The schema's commit and the transaction's: the rider cost no commit of its own.
    expect(r.sent().filter((m) => m.type === TYPE.atomicGroup)).toHaveLength(2);
    expect(await entries(i.state, 'c')).toEqual(['row', 'rider']);
  }, 30_000);

  it('a call that outlives its attempt is answered to the next one, by its idempotency key', async () => {
    const i = invocation('charge', 'd', null, { hold: ['Payments/charge'] });
    const first = i.attempt();
    await first.r.until(() => i.rt.calls().length === 1, 'the call');
    // Silent with the call outstanding: shut down for inactivity, and suspended.
    first.r.shutDown('inactivity');
    await first.done;
    expect(first.r.sent().at(-1)?.type).toBe(TYPE.shutdown);
    expect(i.rt.outcomes()).toEqual([{ kind: 'suspended' }]);
    expect(i.rt.status().status).toBe('suspended');
    // The callee answers: the invocation wakes.
    i.rt.completeCall(i.rt.calls()[0]!.invocationId, { bytes: bytes('"charged"') });
    expect(i.rt.status().status).toBe('ready');
    await first.served;
    const second = i.attempt();
    await second.done;
    expect(output(second.r.sent())).toBe('"charged on attempt 2"');
    // One callee invocation: the second call reached the first's.
    expect(i.rt.calls()).toHaveLength(1);
  }, 30_000);

  it('a restarted attempt runs the handler again from what is stored', async () => {
    goOn = undefined;
    const i = invocation('once', 'e', null);
    const first = i.attempt();
    await first.r.until(() => goOn !== undefined, 'the handler working outside Restate');
    // Shut down for a reason of the runtime's own: restarted at once (rule 1).
    first.r.shutDown('own');
    await first.done;
    goOn!();
    await first.served;
    expect(i.rt.outcomes()).toEqual([{ kind: 'restarted', rule: 1 }]);
    const second = i.attempt();
    await second.done;
    expect(output(second.r.sent())).toBe('2');
    expect(await entries(i.state, 'e')).toEqual(['once']);
  }, 30_000);

  it('a SIGTERM ends the attempt with an unasked shutdown, and Restate restarts it', async () => {
    goOn = undefined;
    const i = invocation('once', 'f', null);
    const first = i.attempt();
    await first.r.until(() => goOn !== undefined, 'the handler working outside Restate');
    // What `endpoint.ts` does for every attempt it serves on a SIGTERM.
    expect(goAway()).toBe(1);
    await first.done;
    goOn!();
    await first.served;
    expect(first.r.sent().at(-1)?.type).toBe(TYPE.shutdown);
    expect(i.rt.outcomes().map((o) => o.kind)).toEqual(['restarted']);
    const second = i.attempt();
    await second.done;
    expect(output(second.r.sent())).toBe('2');
  }, 30_000);

  it('a signal read suspends the invocation, and the signal wakes it', async () => {
    const i = invocation('approve', 'g', null);
    const first = i.attempt();
    await first.r.until(() => first.r.asks.includes('signal approval'), 'the read');
    first.r.shutDown('inactivity');
    await first.done;
    expect(i.rt.outcomes()).toEqual([{ kind: 'suspended' }]);
    i.rt.sendSignal('approval', { bytes: bytes('"yes"') });
    expect(i.rt.status().status).toBe('ready');
    await first.served;
    const second = i.attempt();
    await second.done;
    expect(output(second.r.sent())).toBe('"\\"yes\\" on attempt 2"');
    expect(await entries(i.state, 'g')).toEqual(['approval:"yes"']);
  }, 30_000);

  it('a signal that carries a failure fails the read, and the invocation with it', async () => {
    const i = invocation('approve', 'h', null);
    i.rt.sendSignal('approval', { failure: { code: 403, message: 'rejected', metadata: [] } });
    const { r, done } = i.attempt();
    await done;
    expect(outcome(r.sent())).toEqual({ code: 403, message: 'rejected' });
  }, 30_000);

  it('a signal sent to another invocation', async () => {
    const other = FakeRuntime.invocationId(9);
    const i = invocation('notify', 'i', other);
    const { r, done } = i.attempt();
    await done;
    expect(output(r.sent())).toBe('"notified"');
    expect(
      i.rt.signalsSent().map((s) => [s.targetInvocationId, s.name, s.value.bytes?.toString() ?? s.value.kind]),
    ).toEqual([[other, 'done', '"shipped"']]);
  }, 30_000);

  it('a malformed invocation id is a terminal error the handler catches, and the attempt goes on', async () => {
    const other = FakeRuntime.invocationId(9);
    const i = invocation('malformedIds', 'mal', other);
    const { r, done } = i.attempt();
    await done;
    const caught = JSON.parse(output(r.sent()) ?? 'null') as string[];
    expect(caught).toHaveLength(3 * MALFORMED_IDS.length + 1);
    for (const one of caught.slice(0, -1)) expect(one).toMatch(/^400 .*is not an invocation id/);
    expect(caught[0]).toContain("'inv_garbage' is not an invocation id");
    expect(caught.at(-1)).toBe('in the transaction');
    // Nothing malformed reached Restate: one attempt, no violation, only the good cancel and signal.
    expect(i.rt.violations()).toEqual([]);
    expect(i.rt.outcomes().map((o) => o.kind)).toEqual(['completed']);
    expect(i.rt.cancelsSent()).toEqual([other]);
    expect(i.rt.signalsSent().map((s) => s.targetInvocationId)).toEqual([other]);
    expect(r.sent().some((m) => m.type === TYPE.attach)).toBe(false);
    expect(await entries(i.state, 'mal')).toEqual(['after']);
  }, 30_000);

  for (const withRow of [true, false]) {
    it(`a send Restate would refuse fails its commit with a TerminalError, and the attempt goes on (rows: ${withRow})`, async () => {
      const key = `refused-${withRow}`;
      const i = invocation('refusedSend', key, withRow);
      const { r, done } = i.attempt();
      await done;
      expect(JSON.parse(output(r.sent()) ?? 'null')).toEqual(['400 the idempotency key is empty']);
      // The commit's group was dropped, its row with it; nothing was sent.
      expect(i.rt.violations()).toEqual([]);
      expect(i.rt.outcomes().map((o) => o.kind)).toEqual(['completed']);
      expect(i.rt.calls()).toEqual([]);
      expect(await entries(i.state, key)).toEqual(['after']);
    }, 30_000);
  }

  it('invocation state carries progress across attempts, apart from the object', async () => {
    const i = invocation('progress', 'j', null);
    const first = i.attempt();
    await first.r.until(() => first.r.asks.includes('flush'), 'the flush');
    await pause(20);
    // Silent, with nothing outstanding: restarted.
    first.r.shutDown('inactivity');
    await first.done;
    expect(i.rt.outcomes().map((o) => o.kind)).toEqual(['restarted']);
    expect(i.rt.invocationState().map(({ key, value }) => [key, value.toString()])).toEqual([['step', 'reserved']]);
    expect(i.rt.objectState().some(({ key }) => key === 'step')).toBe(false);
    const second = i.attempt();
    await second.done;
    expect(output(second.r.sent())).toBe('"reserved on attempt 2"');
  }, 30_000);

  it('a cancellation cancels the call under way and fails its await', async () => {
    const i = invocation('held', 'k', null, { hold: ['Payments/slow'] });
    const { r, done } = i.attempt();
    await r.until(() => i.rt.calls().length === 1, 'the call');
    r.cancel();
    await done;
    expect(outcome(r.sent())).toEqual({ code: 409, message: 'Cancelled' });
    expect(i.rt.cancelsSent()).toEqual([i.rt.calls()[0]!.invocationId]);
  }, 30_000);

  it('a suspended invocation wakes on its cancellation, and the next attempt knows it from the start', async () => {
    const i = invocation('approve', 'l', null);
    const first = i.attempt();
    await first.r.until(() => first.r.asks.includes('signal approval'), 'the read');
    first.r.shutDown('inactivity');
    await first.done;
    expect(i.rt.status().status).toBe('suspended');
    i.rt.cancel();
    expect(i.rt.status().status).toBe('ready');
    await first.served;
    const second = i.attempt();
    await second.done;
    expect(outcome(second.r.sent())).toEqual({ code: 409, message: 'Cancelled' });
    expect(await entries(i.state, 'l')).toEqual([]);
  }, 30_000);

  it('spans nest what is done inside them: a call in a span, a commit in a transaction', async () => {
    const i = invocation('spans', 'm', null);
    i.rt.scriptCallee('Oracle', 'answer', 'returns', { bytes: bytes('"42"') });
    const { r, done } = i.attempt();
    await done;
    expect(output(r.sent())).toBe('"42"');
    const sent = r.sent();
    const starts = sent.filter((m) => m.type === TYPE.spanStart);
    expect(starts.map((m) => str(m, ACTION.name))).toEqual(['asking', 'transaction']);
    const [asking, transaction] = starts.map((m) => num(m, 1));
    const call = sent.find((m) => m.type === TYPE.call)!;
    expect(str(call, ACTION.name)).toBe('Oracle/answer');
    expect(num(call, ACTION.parentSpan)).toBe(asking);
    const commit = sent.findLast((m) => m.type === TYPE.atomicGroup)!;
    expect(num(commit, ACTION.parentSpan)).toBe(transaction);
    expect(sent.filter((m) => m.type === TYPE.spanEnd).map((m) => num(m, 1))).toEqual([asking, transaction]);
  }, 30_000);
});
