// An agent's companion (`<agent>.agentprebuilt.restate`, keyed as the agent):
// the turn it keeps from `start` to `close`, which `status` reads (and the
// `stop` view, through `status`), and watches (`awaitTurn`). Its handlers run
// on a fake context, which keeps the state and records what they send to the
// companion itself. And what makes one: each agent its own, served with it.
import * as restate from '@restatedev/restate-sdk';
import { chatHandler, COMPANION_SUFFIX, companionOf, served, sessionObject } from '@restatedev/agents';
import { companionFor, STEERS } from '../src/companion.ts';
import { invoke } from '@restatedev/sessions/internal';
import { fakeContext, type Made } from '@restatedev/sessions/test/support';
import { describe, expect, it, vi } from 'vitest';

// The fake context's promises are plain ones: race them as such.
vi.spyOn(restate.RestatePromise, 'race').mockImplementation(
  (promises) => Promise.race(promises) as unknown as restate.RestatePromise<never>,
);

const A = 'inv_1a';
const B = 'inv_1b';

/**
 * A promise as the SDK gives one, as far as the companion uses it: `map`,
 * which gets its value or its failure; but a cancellation (of the invocation
 * that awaits it) rejects it, as the SDK's does, before `map`.
 */
const restatePromise = <T>(
  promise: Promise<T>,
): Promise<T> & { map: (f: (value?: T, failure?: Error) => unknown) => unknown } =>
  Object.assign(promise, {
    map: <U>(f: (value?: T, failure?: Error) => U) =>
      restatePromise(
        promise.then(
          (value) => f(value),
          (failure: Error) => {
            if (failure instanceof restate.CancelledError) throw failure;
            return f(undefined, failure);
          },
        ),
      ),
  });

const never = () => new Promise<never>(() => {});

/**
 * A companion's state, a run of its handlers, what they sent to the
 * companion itself, and the awakeables they rejected. `ends` says how each
 * turn ends, for `awaitTurn`: by default, it never does; with `watched`, its
 * watch is over at once.
 */
function companion(ends: Record<string, Promise<unknown>> = {}, { watched = false } = {}) {
  const state = new Map<string, unknown>();
  const own: { method: string; input: unknown }[] = [];
  const rejected: string[] = [];
  /** The state it cleared, by name, in order. */
  const cleared: string[] = [];
  /** What it sent to others (an agent's `settle`, or `steered`). */
  const sent: { service: string; method: string; key?: string; parameter: unknown; idempotencyKey?: string }[] = [];
  const ctx = {
    key: 'alice',
    get: async (name: string) => structuredClone(state.get(name)),
    set: (name: string, value: unknown) => void state.set(name, structuredClone(value)),
    clear: (name: string) => {
      cleared.push(name);
      state.delete(name);
    },
    resolveAwakeable: () => {},
    rejectAwakeable: (awakeable: string) => void rejected.push(awakeable),
    objectSendClient: () =>
      new Proxy({}, { get: (_, method: string) => (input: unknown) => void own.push({ method, input }) }),
    invocation: (id: string) => ({ attach: () => restatePromise(ends[id] ?? never()) }),
    sleep: () => restatePromise(watched ? Promise.resolve() : never()),
    date: { now: async () => Date.parse('2026-11-09T00:00:00.000Z') },
    genericSend: ({
      service,
      method,
      key,
      parameter,
      idempotencyKey,
    }: {
      service: string;
      method: string;
      key?: string;
      parameter: unknown;
      idempotencyKey?: string;
    }) => void sent.push({ service, method, key, parameter, idempotencyKey }),
  };
  // The companion of agent `assistant`, at its key `alice`.
  const handlers = (
    companionFor('assistant') as unknown as { object: Record<string, (ctx: unknown, input?: unknown) => unknown> }
  ).object;
  const run = <T>(name: string, input?: unknown) => handlers[name]!(ctx, input) as Promise<T>;
  return { run, own, rejected, sent, state, cleared };
}

const wait = (id: string, awakeable: string) => ({ id, name: 'approval', since: '', awakeable });
const revision = async (c: ReturnType<typeof companion>) =>
  (await c.run<{ revision: number }>('notifications')).revision;

const turn = (invocationId: string) => ({ invocationId, since: '2026-10-31T00:00:00.000Z' });
const answering = async (c: ReturnType<typeof companion>) =>
  (await c.run<{ answering: { invocationId: string } | null }>('status')).answering?.invocationId ?? null;

describe("an agent's companion", () => {
  it('knows the turn from its start to its close; a retried start keeps it', async () => {
    const c = companion();
    expect(await answering(c)).toBeNull();
    await c.run('start', turn(A));
    await c.run('start', { ...turn(A), since: 'later' });
    expect((await c.run<{ answering: { since: string } }>('status')).answering.since).toBe(turn(A).since);
    await c.run('close', A);
    expect(await answering(c)).toBeNull();
  });

  it('takes the next turn after one that never closed (a killed invocation), whose close changes nothing', async () => {
    const c = companion();
    await c.run('start', turn(A));
    await c.run('start', turn(B));
    expect(await answering(c)).toBe(B);
    await c.run('close', A);
    expect(await answering(c)).toBe(B);
  });
  it('watches each turn it starts, once: a retried start watches nothing more', async () => {
    const c = companion();
    await c.run('start', turn(A));
    await c.run('start', turn(A));
    expect(c.own).toEqual([{ method: 'awaitTurn', input: A }]);
  });

  it('ends a turn that fails (a killed one), and nothing for one that ends as it should', async () => {
    const killed = Promise.reject(new restate.TerminalError('killed', { errorCode: 409 }));
    killed.catch(() => {});
    const c = companion({ [A]: killed, [B]: Promise.resolve('answered') });
    await c.run('awaitTurn', A);
    await c.run('awaitTurn', B);
    expect(c.own).toEqual([{ method: 'ended', input: A }]);
  });

  it('has a turn whose invocation is gone settled by its agent, if the agent said it settles', async () => {
    const c = companion();
    // An agent that does not say it settles its turns (none on the conversation of turns): it is sent nothing.
    await c.run('start', turn(A));
    await c.run('ended', A);
    expect(await answering(c)).toBeNull();
    expect(c.sent).toEqual([]);
    // The status shows the turn without what only the companion reads.
    await c.run('start', { ...turn(B), settles: true });
    expect((await c.run<{ answering: object }>('status')).answering).toEqual(turn(B));
    await c.run('ended', B);
    expect(await answering(c)).toBeNull();
    expect(c.sent).toEqual([{ service: 'assistant', method: 'settle', key: 'alice', parameter: B }]);
    // Ended again, or closed by the turn itself first: nothing more.
    await c.run('ended', B);
    expect(c.sent).toHaveLength(1);
  });

  it('has a turn that closed itself settled by no one', async () => {
    const c = companion();
    await c.run('start', { ...turn(A), settles: true });
    await c.run('close', A);
    await c.run('ended', A);
    expect(c.sent).toEqual([]);
  });

  it('has a gone turn the next start closes settled by its agent', async () => {
    const c = companion();
    await c.run('start', { ...turn(A), settles: true });
    await c.run('start', { ...turn(B), settles: true });
    expect(c.sent).toEqual([{ service: 'assistant', method: 'settle', key: 'alice', parameter: A }]);
  });

  it('hands a turn still answered after its watch to a new watch, and stops watching a closed one', async () => {
    const c = companion({}, { watched: true });
    await c.run('start', turn(A));
    c.own.length = 0;
    await c.run('awaitTurn', A);
    expect(c.own).toEqual([{ method: 'awaitTurn', input: A }]);
    await c.run('close', A);
    await c.run('awaitTurn', A);
    expect(c.own).toHaveLength(1);
  });

  it('closes nothing when it is cancelled itself: the turn may still run', async () => {
    const cancelled = Promise.reject(new restate.CancelledError());
    cancelled.catch(() => {});
    const c = companion({ [A]: cancelled });
    await expect(c.run('awaitTurn', A)).rejects.toBeInstanceOf(restate.CancelledError);
    expect(c.own).toEqual([]);
  });

  it('publishes a close that changes the status, once', async () => {
    const c = companion();
    await c.run('start', turn(A));
    const before = await revision(c);
    await c.run('close', A);
    await c.run('close', A);
    expect(await revision(c)).toBe(before + 1);
    expect(await answering(c)).toBeNull();
  });

  it("forgets a closed turn's waits (a killed turn leaves them), and ends them; not another's", async () => {
    const c = companion();
    await c.run('start', turn(A));
    await c.run('listen', wait(`${A}:call_1`, 'awk_a'));
    await c.run('listen', wait(`${B}:call_1`, 'awk_b'));
    await c.run('close', A);
    expect((await c.run<{ id: string }[]>('pending')).map((w) => w.id)).toEqual([`${B}:call_1`]);
    expect(c.rejected).toEqual(['awk_a']);
  });

  it('forgets the waits of a turn that never closed as the next starts', async () => {
    const c = companion();
    await c.run('start', turn(A));
    await c.run('listen', wait(`${A}:call_1`, 'awk_a'));
    await c.run('start', turn(B));
    expect(await c.run('pending')).toEqual([]);
    expect(c.rejected).toEqual(['awk_a']);
  });
});

/** What `publish` answers a turn: the revision, and the messages steered to it that it has not taken yet. */
const published = (c: ReturnType<typeof companion>) =>
  c.run<{ revision: number; steering?: { id: string; text: string }[] }>('publish');

/** The ids of what `status` lists as steered to the turn being answered, not taken yet. */
const steering = async (c: ReturnType<typeof companion>) =>
  ((await c.run<{ steering?: { id: string }[] }>('status')).steering ?? []).map((m) => m.id);

describe("an agent's companion, steering", () => {
  it('queues each steered message as a turn of its own, and holds it for a turn that takes steered messages', async () => {
    const c = companion();
    await c.run('start', { ...turn(A), steers: true });
    expect(await c.run('steer', { id: 's1', text: 'use Celsius' })).toEqual({ id: 's1', turn: A });
    // Queued at once, keyed by its id: it keeps its place in the key's queue, and is sent once.
    expect(c.sent).toEqual([
      {
        service: 'assistant',
        method: 'steered',
        key: 'alice',
        parameter: { id: 's1', text: 'use Celsius' },
        idempotencyKey: 'steer:s1',
      },
    ]);
    // The turn learns of it from its next publish; a client, from the status.
    expect((await published(c)).steering).toEqual([{ id: 's1', text: 'use Celsius' }]);
    expect(await steering(c)).toEqual(['s1']);
    // Sent again (a retried request): the same message, held once.
    expect(await c.run('steer', { id: 's1', text: 'use Celsius' })).toEqual({ id: 's1', turn: A });
    expect((await published(c)).steering).toHaveLength(1);
  });

  it('holds nothing for a turn that takes no steered messages, nor with no turn: each is a turn of its own', async () => {
    const c = companion();
    expect(await c.run('steer', { id: 's1', text: 'hi' })).toEqual({ id: 's1', turn: null });
    // Of a framework that takes none: it does not say it steers.
    await c.run('start', turn(A));
    expect(await c.run('steer', { id: 's2', text: 'hi' })).toEqual({ id: 's2', turn: null });
    expect((await published(c)).steering).toBeUndefined();
    expect((await c.run<object>('status')).hasOwnProperty('steering')).toBe(false);
    expect(c.sent.map((m) => m.idempotencyKey)).toEqual(['steer:s1', 'steer:s2']);
  });

  it('marks a taken message, which the turn no longer finds, once, and publishes the change', async () => {
    const c = companion();
    await c.run('start', { ...turn(A), steers: true });
    await c.run('steer', { id: 's1', text: 'one' });
    await c.run('steer', { id: 's2', text: 'two' });
    const before = await revision(c);
    await c.run('taken', ['s1']);
    expect(await revision(c)).toBe(before + 1);
    expect((await published(c)).steering).toEqual([{ id: 's2', text: 'two' }]);
    expect(await steering(c)).toEqual(['s2']);
    // Taken again (the outbox's send made again): nothing changes, and nothing is published.
    const now = await revision(c);
    await c.run('taken', ['s1']);
    expect(await revision(c)).toBe(now);
  });

  it("forgets a closed turn's messages, taken or not: those it did not take are answered as turns of their own", async () => {
    const c = companion();
    await c.run('start', { ...turn(A), steers: true });
    await c.run('steer', { id: 's1', text: 'one' });
    await c.run('taken', ['s1']);
    await c.run('steer', { id: 's2', text: 'two' });
    await c.run('close', A);
    // Nothing is kept of them: s2 was queued as a turn of its own as it was sent.
    expect(c.state.has('inbox')).toBe(false);
    await c.run('start', { ...turn(B), steers: true });
    expect((await published(c)).steering).toBeUndefined();
    expect(await steering(c)).toEqual([]);
    // A turn that never closed (killed) loses them as the next starts.
    await c.run('steer', { id: 's3', text: 'three' });
    await c.run('start', { ...turn(A + 'x'), steers: true });
    expect(await steering(c)).toEqual([]);
    expect(c.state.has('inbox')).toBe(false);
  });

  it("forgets only the closed turn's messages", async () => {
    const c = companion();
    await c.run('start', { ...turn(A), steers: true });
    await c.run('steer', { id: 's1', text: 'one' });
    await c.run('taken', ['s1']);
    // The turn closed already (a close after its own): its messages go, which publishes.
    await c.run('close', A);
    await c.run('start', { ...turn(B), steers: true });
    await c.run('steer', { id: 's2', text: 'two' });
    await c.run('ended', A);
    expect(await steering(c)).toEqual(['s2']);
  });

  it('holds at most STEERS messages for a turn, taken or not: past them, each is a turn of its own', async () => {
    const c = companion();
    await c.run('start', { ...turn(A), steers: true });
    for (let i = 0; i < STEERS; i++) {
      expect(await c.run('steer', { id: `s${i}`, text: `${i}` })).toEqual({ id: `s${i}`, turn: A });
      if (i % 2 === 0) await c.run('taken', [`s${i}`]);
    }
    expect(await c.run('steer', { id: 'over', text: 'one more' })).toEqual({ id: 'over', turn: null });
    // Queued still, as every steered message is.
    expect(c.sent.at(-1)?.idempotencyKey).toBe('steer:over');
    expect(await steering(c)).toHaveLength(STEERS / 2);
  });

  it('forgets every steered message on a reset (`clear`)', async () => {
    const c = companion();
    await c.run('start', { ...turn(A), steers: true });
    await c.run('steer', { id: 's1', text: 'one' });
    await c.run('reset');
    expect(await steering(c)).toEqual([]);
    expect((await published(c)).steering).toBeUndefined();
  });

  it("shows the turn's status without a field of steering's own while nothing waits", async () => {
    const c = companion();
    await c.run('start', { ...turn(A), steers: true });
    expect(await c.run('status')).toEqual({ answering: turn(A), waiting: [] });
  });
});

describe("an agent's companion, publishing a turn's start", () => {
  it('publishes a turn that says so as it starts it, and returns what `publish` returns', async () => {
    const c = companion();
    const before = await revision(c);
    const started = await c.run<{ revision: number }>('start', { ...turn(A), publishes: true });
    expect(started).toEqual({ revision: before + 1 });
    expect(await revision(c)).toBe(before + 1);
    // A retried start (the same invocation) publishes again: the attempt's first publish.
    expect(await c.run('start', { ...turn(A), publishes: true })).toEqual({ revision: before + 2 });
  });

  it('returns the messages steered to the turn that it has not taken, as `publish` does', async () => {
    const c = companion();
    await c.run('start', { ...turn(A), steers: true, publishes: true });
    await c.run('steer', { id: 's1', text: 'use Celsius' });
    // The retried attempt's start finds it.
    const started = await c.run<{ steering?: unknown[] }>('start', { ...turn(A), steers: true, publishes: true });
    expect(started.steering).toEqual([{ id: 's1', text: 'use Celsius' }]);
  });

  it('publishes nothing for a turn that does not say so (in the background), and returns nothing', async () => {
    const c = companion();
    const before = await revision(c);
    expect(await c.run('start', turn(A))).toBeUndefined();
    expect(await revision(c)).toBe(before);
  });

  it('clears the watches only when one waits', async () => {
    const c = companion();
    await published(c);
    expect(c.cleared).not.toContain('watching');
    await c.run('subscribe', { revision: 5, awakeable: 'awk_w' });
    await published(c);
    expect(c.cleared.filter((name) => name === 'watching')).toHaveLength(1);
    await published(c);
    expect(c.cleared.filter((name) => name === 'watching')).toHaveLength(1);
  });
});

/** The services an endpoint of `services` serves, by name (as `serve` and `served` give them). */
const names = (services: { name: string }[], only?: string) => served(services, only).map((s) => s.name);

/** An agent named `name`, whose `chat` answers `ok`. */
const agentNamed = (name: string) =>
  sessionObject({ name, handlers: { chat: chatHandler(async () => 'ok') }, views: {} });

/** What a companion answers each call of its agent, plainly. */
const answer = (call: Made) =>
  call.method === 'status'
    ? { answering: null, waiting: [] }
    : call.method === 'steer'
      ? { id: 'inv_view', turn: null }
      : call.method === 'resolve'
        ? { resolved: null }
        : call.method === 'pending'
          ? []
          : { revision: 1 };

describe('the companion of each agent', () => {
  const one = agentNamed('one');
  const two = agentNamed('two');

  it('is its own, named `<agent>.agentprebuilt.restate`, and served with it: an endpoint serves no `signals`', () => {
    expect(COMPANION_SUFFIX).toBe('.agentprebuilt.restate');
    expect(companionOf(one).name).toBe('one.agentprebuilt.restate');
    expect(companionOf(two).name).toBe('two.agentprebuilt.restate');
    expect(companionOf(one)).not.toBe(companionOf(two));
    expect(names([one, two])).toEqual(['one', 'one.agentprebuilt.restate', 'two', 'two.agentprebuilt.restate']);
    expect(names([one, two])).not.toContain('signals');
    // The name of the agent as it is, whatever it is.
    expect(companionOf(agentNamed('Billing_v2')).name).toBe('Billing_v2.agentprebuilt.restate');
    expect(() => companionOf({ name: 'plain' })).toThrow('plain is not an agent of @restatedev/agents');
  });

  it('is served with its agent when RESTATE_SERVE_ONLY names the agent alone', () => {
    expect(names([one, two], 'two')).toEqual(['two', 'two.agentprebuilt.restate']);
  });

  it("has every handler private to the ingress: clients reach it through the agent's views", () => {
    const handlers = (companionOf(one) as unknown as { object: Record<string, object> }).object;
    expect(Object.keys(handlers).length).toBeGreaterThan(10);
    for (const [name, handler] of Object.entries(handlers)) {
      const symbol = Object.getOwnPropertySymbols(handler).find((s) => s.description === 'Handler')!;
      const options = (handler as Record<symbol, { options?: { ingressPrivate?: boolean } }>)[symbol]?.options;
      expect([name, options?.ingressPrivate]).toEqual([name, true]);
    }
  });

  it("is called by its agent's turn and views at the agent's own key; a turn of one touches nothing of the other's", async () => {
    /** The calls and sends of agent `agent` at key `alice`, with a companion that answers each handler plainly. */
    const runOf = (agent: typeof one, name: string) => {
      const map = new Map<string, Uint8Array>();
      const made: Made[] = [];
      const run = (handler: string, input?: unknown, id = 'inv') =>
        invoke(
          agent,
          handler,
          fakeContext({ map, service: name, key: 'alice', id, calls: made, sends: made, answer }),
          input,
        );
      return { run, made };
    };
    const a = runOf(one, 'one');
    const b = runOf(two, 'two');
    expect(await a.run('chat', 'hi', 'inv_turn')).toBe('ok');
    await a.run('status');
    await a.run('pending');
    await a.run('signal', { name: 'approval', value: 'yes' }, 'inv_signal');
    await a.run('stop', undefined, 'inv_stop');
    await a.run('notifications');
    const companions = a.made.filter((m) => m.service.endsWith(COMPANION_SUFFIX));
    expect(companions.map((m) => m.method)).toEqual([
      'start',
      'close',
      'status',
      'pending',
      'resolve',
      'status',
      'notifications',
    ]);
    expect(new Set(companions.map((m) => `${m.service}/${m.key}`))).toEqual(
      new Set(['one.agentprebuilt.restate/alice']),
    );
    expect(a.made.some((m) => m.service.startsWith('two'))).toBe(false);
    // The other agent's turn, at the same key: its own companion, which the first one's turn never called.
    expect(b.made).toEqual([]);
    expect(await b.run('chat', 'hi', 'inv_other')).toBe('ok');
    expect(new Set(b.made.map((m) => `${m.service}/${m.key}`))).toEqual(new Set(['two.agentprebuilt.restate/alice']));
  });
});
