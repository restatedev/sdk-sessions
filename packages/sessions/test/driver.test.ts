// One attempt on the explicit recovery protocol (`src/driver.ts`), with
// Restate's side played by the core's fake runtime (`vm-support.ts`). What the
// selector had to fake — several promises awaited at once, each waiting on
// Restate — falls out of the VM here: an action returns a handle, and the
// tick settles the promise of that handle.
import { describe, expect, it, vi } from 'vitest';
import { AttemptDriver, AttemptShutDown } from '../src/driver.ts';
import { drain, messages, startedVm, TYPE, types } from './vm-support.ts';

/** An attempt over a started VM, with the bytes it writes, and the fake runtime behind it. */
function attempt(
  options: {
    lazy?: boolean;
    state?: Record<string, string>;
    shared?: boolean;
    explicitCancellation?: boolean;
  } = {},
) {
  const written: Uint8Array[] = [];
  /** Everything ever written, which clearing `written` for an assertion keeps. */
  const all: Uint8Array[] = [];
  /** How much of `all` the runtime received. */
  let received = 0;
  const { vm, rt } = startedVm('hello', { lazy: options.lazy, state: options.state, shared: options.shared });
  const a = new AttemptDriver(vm, (chunk: Uint8Array) => void (written.push(chunk), all.push(chunk)), {
    service: 'Probe',
    handler: 'run',
    shared: options.shared,
    explicitCancellation: options.explicitCancellation,
  });
  /** What the attempt wrote, to the runtime; what the runtime wrote, to the attempt. */
  const exchange = () => {
    for (; received < all.length; received++) rt.receive(all[received]!);
    const output = rt.takeOutput();
    if (output.length > 0) a.notifyInput(output);
  };
  return {
    attempt: a,
    vm,
    rt,
    written,
    exchange,
    /** Everything written so far, as messages. */
    sent: () => messages(Buffer.concat(written)),
    /** A call of the attempt's, which waits on Restate as a `ctx.rpc` does. */
    makeCall(handler = 'reserve') {
      return a.call({ service: 'Store', handler, input: Buffer.from('"x"') });
    },
    /** Restate gives the calls made so far their invocation ids. */
    giveIds() {
      exchange();
    },
    /** The `nth` call (0-based) returns `result`: the runtime received it, and answers. */
    answerCall(nth: number, result: string) {
      exchange();
      rt.completeCall(rt.calls()[nth]!.invocationId, { bytes: Buffer.from(result) });
      exchange();
    },
    /** Restate cancels the invocation. */
    cancel() {
      exchange();
      rt.cancel();
      exchange();
    },
  };
}

/** Let the queued microtasks run. */
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('an attempt on the explicit recovery protocol', () => {
  it('settles two calls awaited at once, which is what the selector existed to do', async () => {
    const r = attempt();
    // Both issued in the same turn, both waiting on Restate. On the SDK's own
    // loop this is "awaitNext already pending".
    const both = Promise.all([r.makeCall('one').result, r.makeCall('two').result]);
    await turn();
    expect(types(Buffer.concat(r.written))).toEqual([TYPE.call, TYPE.call]);
    r.answerCall(0, '"1"');
    r.answerCall(1, '"2"');
    await turn();
    expect((await both).map((v: Uint8Array | null) => (v === null ? null : Buffer.from(v).toString()))).toEqual([
      '"1"',
      '"2"',
    ]);
  });

  it('batches the output of the actions issued in one turn into a single write', async () => {
    const r = attempt();
    void r.makeCall('one').result;
    void r.makeCall('two').result;
    void r.attempt.send({ service: 'Store', handler: 'note', input: Buffer.from('"x"') });
    expect(r.written).toHaveLength(0); // nothing is written before the tick
    await turn();
    expect(r.written).toHaveLength(1);
    // A send is a call that wants no result.
    expect(types(r.written[0]!)).toEqual([TYPE.call, TYPE.call, TYPE.call]);
  });

  it('a call gives its invocation id and its result, each from its own notification', async () => {
    const r = attempt();
    const call = r.attempt.call({ service: 'Store', handler: 'reserve', key: 'k', input: Buffer.from('"x"') });
    await turn();
    const sent = r.sent();
    expect(sent.map((m) => m.type)).toEqual([TYPE.call]);
    // Restate answers the id once it applied the call, then the result.
    r.giveIds();
    await turn();
    expect(await call.invocationId).toBe(r.rt.calls()[0]!.invocationId);
    r.answerCall(0, '"done"');
    await turn();
    expect(Buffer.from((await call.result)!).toString()).toBe('"done"');
  });

  it('the attempt Restate shuts down rejects everything still waiting', async () => {
    const r = attempt();
    const first = r.makeCall('one').result;
    const second = r.makeCall('two').result;
    await turn();
    r.attempt.notifyInputClosed();
    await turn();
    await expect(first).rejects.toBeInstanceOf(AttemptShutDown);
    await expect(second).rejects.toBeInstanceOf(AttemptShutDown);
    expect(r.attempt.over).toBeInstanceOf(AttemptShutDown);
    // An action after the end rejects rather than hanging.
    await expect(r.makeCall('three').result).rejects.toBeInstanceOf(AttemptShutDown);
  });

  it('tells its listeners once when the attempt ends', async () => {
    const r = attempt({ lazy: true });
    let ended = 0;
    r.attempt.whenEnded(() => ended++);
    const unregister = r.attempt.whenEnded(() => ended++);
    unregister();
    r.attempt.notifyInputClosed();
    await turn();
    expect(ended).toBe(1);
    // A listener registered after the end is told at once.
    r.attempt.whenEnded(() => ended++);
    expect(ended).toBe(2);
  });

  it('resolves cancelled() when the cancel signal arrives, and nothing suspends on it', async () => {
    const r = attempt();
    let cancelled = false;
    void r.attempt.cancellation().then(() => (cancelled = true));
    await turn();
    expect(cancelled).toBe(false);
    expect(r.attempt.isCancelled()).toBe(false);
    // The signal is a notification on the reserved handle, which the tick takes.
    r.cancel();
    await turn();
    expect(cancelled).toBe(true);
    expect(r.attempt.isCancelled()).toBe(true);
    // Nothing was sent for it, and nothing is left to take.
    expect(r.written).toEqual([]);
    expect(drain(r.vm)).toEqual([]);
  });

  it('cancels the calls it made, by the ids Restate gave them', async () => {
    const r = attempt();
    const call = r.attempt.call({ service: 'Store', handler: 'reserve', input: Buffer.from('"x"') });
    await turn();
    r.giveIds();
    await turn();
    const id = await call.invocationId;
    r.written.length = 0;
    expect(await r.attempt.cancelPreviousCalls()).toEqual([id]);
    await turn();
    expect(types(Buffer.concat(r.written))).toEqual([TYPE.cancelInvocation]);
    r.exchange();
    expect(r.rt.cancelsSent()).toEqual([id]);
  });

  it('an implicit cancellation fails what waits on Restate, and cancels the calls in flight', async () => {
    const r = attempt({ lazy: true });
    const call = r.attempt.call({ service: 'Store', handler: 'reserve', input: Buffer.from('"x"') });
    await turn();
    r.giveIds();
    await turn();
    await call.invocationId;
    const waiting = r.makeCall('one').result;
    await turn();
    r.cancel();
    r.written.length = 0;
    await turn();
    // The await fails as a cancelled invocation's do...
    const failed = await waiting.then(
      () => undefined,
      (e: unknown) => e as Error & { code?: number },
    );
    // The class everything downstream classifies on: `cancellation.test.ts`
    // asserts it, and @restatedev/agents branches on it in a dozen places.
    expect(failed?.name).toBe('CancelledError');
    // ...and the call in flight was cancelled.
    await r.attempt.cancellingCalls;
    await turn();
    expect(types(Buffer.concat(r.written))).toContain(TYPE.cancelInvocation);
  });

  it('an explicit cancellation only resolves cancelled(), leaving the handler to stop its own work', async () => {
    const r = attempt({ explicitCancellation: true });
    let cancelled = false;
    void r.attempt.cancellation().then(() => (cancelled = true));
    const waiting = r.makeCall('one').result;
    let settled = false;
    void waiting.then(
      () => (settled = true),
      () => (settled = true),
    );
    await turn();
    r.giveIds();
    r.written.length = 0;
    r.cancel();
    await turn();
    expect(cancelled).toBe(true);
    // The call is left alone: the handler decides what to stop.
    expect(settled).toBe(false);
    expect(types(Buffer.concat(r.written))).toEqual([]);
    r.answerCall(0, '"1"');
    await turn();
    expect(Buffer.from((await waiting)!).toString()).toBe('"1"');
  });

  it('does not cancel a call that already answered', async () => {
    const r = attempt();
    const call = r.attempt.call({ service: 'Store', handler: 'reserve', input: Buffer.from('"x"') });
    await turn();
    r.answerCall(0, '"done"');
    await turn();
    await call.result;
    r.written.length = 0;
    // It is over: cancelling it would cancel an invocation that already ended.
    expect(await r.attempt.cancelPreviousCalls()).toEqual([]);
    await turn();
    expect(types(Buffer.concat(r.written))).toEqual([]);
  });

  it('cancels a call whose invocation id arrives only after the cancellation', async () => {
    const r = attempt();
    const call = r.attempt.call({ service: 'Store', handler: 'reserve', input: Buffer.from('"x"') });
    call.result.catch(() => {});
    await turn();
    // The cancellation lands while the id is still outstanding: the runtime
    // has not applied the call yet.
    r.rt.setAutoApply(false);
    r.cancel();
    await turn();
    r.written.length = 0;
    r.rt.applyPending(100);
    r.exchange();
    await turn();
    await r.attempt.cancellingCalls;
    await turn();
    expect(types(Buffer.concat(r.written))).toContain(TYPE.cancelInvocation); // the cancellation went out
  });

  it('the request names its target, and its signal aborts when the attempt ends', async () => {
    const r = attempt();
    const request = r.attempt.request(
      new Map([['content-type', 'application/vnd.restate.invocation.explicitrecovery.v1']]),
    );
    expect(request.target.service).toBe('Probe');
    expect(String(request.target)).toBe('Probe/thekey/run');
    expect(request.id).toBe('inv_test');
    expect((request as { attempt?: number }).attempt).toBe(1);
    expect(request.attemptHeaders.get('content-type')).toContain('explicitrecovery.v1');
    expect(request.attemptCompletedSignal.aborted).toBe(false);
    r.attempt.notifyInputClosed();
    await turn();
    expect(request.attemptCompletedSignal.aborted).toBe(true);
  });

  it('heartbeats only inside working, whatever the attempt waits for', async () => {
    const r = attempt();
    const beats = () => types(Buffer.concat(r.written)).filter((t) => t === TYPE.heartbeat).length;
    // Outside working the attempt is silent, waiting or not: Restate may shut it down.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(beats()).toBe(0);
    // Inside, it heartbeats on the interval, with a call outstanding too; at
    // once if it has been silent for an interval already.
    const waiting = r.makeCall('one').result;
    await turn();
    r.written.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const release = Promise.withResolvers<void>();
    const working = r.attempt.working(() => release.promise.then(() => 'done'), 5);
    await turn();
    expect(beats()).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(beats()).toBeGreaterThan(1);
    // Two scopes open: the attempt is kept alive until the last closes.
    const inner = Promise.withResolvers<void>();
    const nested = r.attempt.working(() => inner.promise, 5);
    release.resolve();
    expect(await working).toBe('done');
    const during = beats();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(beats()).toBeGreaterThan(during);
    inner.resolve();
    await nested;
    await turn();
    const after = beats();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(beats()).toBe(after);
    r.answerCall(0, '"1"');
    await waiting;
  });

  it('beats a run of scopes at its own interval, though an earlier run left the timer armed', async () => {
    // Fake timers: the margins are exact, whatever else the machine is doing.
    vi.useFakeTimers();
    try {
      const r = attempt();
      const beats = () => types(Buffer.concat(r.written)).filter((t) => t === TYPE.heartbeat).length;
      // A short run arms the timer for 100 ms from now, and ends.
      await r.attempt.working(async () => {}, 100);
      await vi.advanceTimersByTimeAsync(60);
      // A longer run opens 60 ms in: its first beat is due 100 ms after it opened, not when the timer fires.
      const release = Promise.withResolvers<void>();
      const working = r.attempt.working(() => release.promise, 100);
      await vi.advanceTimersByTimeAsync(80);
      expect(beats()).toBe(0);
      await vi.advanceTimersByTimeAsync(120);
      expect(beats()).toBeGreaterThan(0);
      release.resolve();
      await working;
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads the heartbeat interval once, when the attempt first needs it', async () => {
    const before = process.env.RESTATE_SESSIONS_HEARTBEAT;
    try {
      process.env.RESTATE_SESSIONS_HEARTBEAT = '20';
      const r = attempt();
      const beats = () => types(Buffer.concat(r.written)).filter((t) => t === TYPE.heartbeat).length;
      await r.attempt.working(async () => {});
      // The environment changes: the attempt keeps the interval it read.
      process.env.RESTATE_SESSIONS_HEARTBEAT = '100000';
      const release = Promise.withResolvers<void>();
      const working = r.attempt.working(() => release.promise);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(beats()).toBeGreaterThan(0);
      release.resolve();
      await working;
    } finally {
      if (before === undefined) delete process.env.RESTATE_SESSIONS_HEARTBEAT;
      else process.env.RESTATE_SESSIONS_HEARTBEAT = before;
    }
  });

  it('opens a working scope right after writing without a heartbeat of its own', async () => {
    const r = attempt();
    // Something written just now restarted Restate's timer: the scope's
    // first heartbeat waits for the interval (the database opens one per call).
    void r.makeCall('one').result;
    await turn();
    r.written.length = 0;
    await r.attempt.working(async () => {
      await turn();
    }, 1_000);
    await turn();
    expect(types(Buffer.concat(r.written))).not.toContain(TYPE.heartbeat);
  });

  it('closes a working scope whose work throws', async () => {
    const r = attempt();
    await expect(
      r.attempt.working(() => {
        throw new Error('boom');
      }, 5),
    ).rejects.toThrow('boom');
    await turn();
    r.written.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(types(Buffer.concat(r.written))).not.toContain(TYPE.heartbeat);
  });

  it('ends the handler with its output, and writes it', async () => {
    const r = attempt();
    r.attempt.endSuccess(Buffer.from('"done"'));
    await turn();
    expect(types(Buffer.concat(r.written))).toEqual([TYPE.end]);
  });

  it('after its last message the response waits for Restate to close first (D35)', async () => {
    const r = attempt();
    let closable = false;
    r.attempt.whenClosable(() => (closable = true));
    r.attempt.endSuccess(Buffer.from('"done"'));
    await turn();
    expect(types(Buffer.concat(r.written))).toEqual([TYPE.end]);
    expect(closable).toBe(false);
    // The runtime takes the end and closes its side: then the response may close.
    r.exchange();
    expect(r.rt.isClosed()).toBe(true);
    r.attempt.notifyInputClosed();
    await turn();
    expect(closable).toBe(true);
    r.rt.sdkClosed();
    expect(r.rt.violations()).toEqual([]);
  });

  it('a process going away ends the attempt with an unasked shutdown, at once', async () => {
    const r = attempt();
    const waiting = r.makeCall('one').result;
    await turn();
    r.written.length = 0;
    let closable = false;
    r.attempt.whenClosable(() => (closable = true));
    r.attempt.goAway();
    expect(types(Buffer.concat(r.written))).toEqual([TYPE.shutdown]);
    await expect(waiting).rejects.toBeInstanceOf(AttemptShutDown);
    // Not closable by the VM's rule (Restate has not closed): the caller closes.
    expect(closable).toBe(false);
    r.exchange();
    r.rt.sdkClosed();
    expect(r.rt.outcomes().map((o) => o.kind)).toEqual(['restarted']);
  });

  it('a failed attempt writes an error and ends no invocation', async () => {
    const r = attempt();
    r.attempt.fail('the model is down', 'at model.ts:1');
    await turn();
    expect(types(Buffer.concat(r.written))).toEqual([TYPE.error]);
    // Taking notifications now raises the error that closed the attempt.
    expect(r.attempt.over?.name).toBe('AttemptFailed');
  });
});
