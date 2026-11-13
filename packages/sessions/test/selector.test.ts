// The selector of @restatedev/sessions (packages/sessions/src/selector.ts), against a fake VM
// with the shared core's rules, and the SDK's single-waiter progress channel.
import { afterEach, describe, expect, it } from 'vitest';
import { setImmediate } from 'node:timers/promises';
import {
  type DoProgressResult,
  failpoints,
  PromiseSelector,
  type Selectable,
  type UnresolvedFuture,
} from '@restatedev/sessions/internal';

// The SDK's progress channel (`ExternalProgressChannel`), as it is: signals
// with no one waiting are buffered, and a second waiter rejects.
class ExternalProgressChannel {
  pending = 0;
  waiter: (() => void) | undefined;
  signal() {
    if (this.waiter !== undefined) {
      const w = this.waiter;
      this.waiter = undefined;
      w();
    } else this.pending++;
  }
  awaitNext(): Promise<void> {
    if (this.waiter !== undefined) return Promise.reject(new Error('awaitNext already pending'));
    if (this.pending > 0) {
      this.pending--;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

// A VM with the shared core's rules for do_progress, as far as the selector sees them
// (sdk-shared-core 8.2.0, src/vm/transitions/async_results.rs and async_results_state.rs).
// A notification that came in is not to be taken until a check processed it: a check
// takes them in one at a time, until its future resolves (AnyCompleted). Else a run
// the future awaits and nobody started is handed out (ExecuteRun); else, with the
// input closed and no run of the future executing, the invocation suspends on the
// future; else it waits. Results stay until taken; a cancellation (a handler's
// without explicit cancellation) is reported once.

type Result = { ok: unknown } | { fail: Error };

/** The handle of the cancel signal. */
const CANCELLATION = 1;
/** The handle the fake VM gives the working run. */
const WORK = 9999;
/** A check for the cancellation alone: with the working run, which stands for the handler's work. */
const WATCHING: UnresolvedFuture = { FirstCompleted: [{ Single: CANCELLATION }, { Single: WORK }] };

function leaves(f: UnresolvedFuture): number[] {
  if ('Single' in f) return [f.Single];
  return Object.values(f)[0]!.flatMap(leaves);
}

function resolved(f: UnresolvedFuture, ready: Map<number, Result>): boolean {
  if ('Single' in f) return ready.has(f.Single);
  if ('AllCompleted' in f || 'AllSucceededOrFirstFailed' in f) {
    return Object.values(f)[0]!.every((c) => resolved(c, ready));
  }
  return Object.values(f)[0]!.some((c) => resolved(c, ready));
}

class FakeVm {
  readonly ready = new Map<number, Result>();
  // What came in and no check processed yet, in order.
  readonly arrived: [handle: number, result: Result][] = [];
  readonly runs = new Set<number>();
  readonly executing = new Set<number>();
  inputClosed = false;
  cancelled = false;
  suspendedOn?: UnresolvedFuture;
  readonly progress: UnresolvedFuture[] = [];
  // The checks on the cancellation alone: each tells Restate that the handler awaits it, and suspends on it
  // once the input closed.
  readonly askedForCancellationAlone: UnresolvedFuture[] = [];
  // The attempt's working run, once the selector made it: handed out like any run, and never done.
  work?: number;
  failWith?: Error;

  doProgress(f: UnresolvedFuture): DoProgressResult {
    if (this.suspendedOn) throw new Error('closed');
    if (this.failWith) throw this.failWith;
    this.progress.push(f);
    if (leaves(f).every((h) => h === CANCELLATION)) this.askedForCancellationAlone.push(f);
    if (this.cancelled) {
      this.cancelled = false;
      return 'CancelSignalReceived';
    }
    while (!resolved(f, this.ready)) {
      const next = this.arrived.shift();
      if (next === undefined) break;
      this.ready.set(next[0], next[1]);
    }
    if (resolved(f, this.ready)) return 'AnyCompleted';
    const run = leaves(f).find((h) => this.runs.has(h));
    if (run !== undefined) {
      this.runs.delete(run);
      this.executing.add(run);
      return { ExecuteRun: run };
    }
    if (this.inputClosed && !leaves(f).some((h) => this.executing.has(h))) {
      this.suspendedOn = f;
      throw new Error('suspended');
    }
    return 'WaitExternalProgress';
  }

  take(handle: number): Result | undefined {
    const r = this.ready.get(handle);
    this.ready.delete(handle);
    return r;
  }
}

// Shaped like SingleRestatePromise: takes its result once, and is cancelled through a race.
class FakePromise<T = unknown> implements Selectable {
  private done = false;
  private readonly result = Promise.withResolvers<unknown>();
  private readonly cancel = Promise.withResolvers<never>();
  readonly user = Promise.race([this.cancel.promise, this.result.promise]) as Promise<T>;
  private readonly vm: FakeVm;
  readonly handle: number;

  constructor(vm: FakeVm, handle: number) {
    this.vm = vm;
    this.handle = handle;
    this.user.catch(() => {});
  }

  isDone() {
    return this.done;
  }

  tryComplete(): Promise<void> {
    if (this.done) return Promise.resolve();
    const r = this.vm.take(this.handle);
    if (r === undefined) return Promise.resolve();
    this.done = true;
    if ('ok' in r) this.result.resolve(r.ok);
    else this.result.reject(r.fail);
    return Promise.resolve();
  }

  unresolvedFuture(): UnresolvedFuture | null {
    return this.done ? null : { Single: this.handle };
  }

  tryCancel() {
    this.cancel.reject(new Error('cancelled'));
  }
}

// Shaped like CombinatorRestatePromise: flags itself completed in a .finally, a tick late.
class FakeRace implements Selectable {
  private done = false;
  readonly user: Promise<unknown>;

  readonly children: FakePromise[];

  constructor(children: FakePromise[]) {
    this.children = children;
    this.user = Promise.race(children.map((c) => c.user)).finally(() => {
      this.done = true;
    });
    this.user.catch(() => {});
  }

  async tryComplete() {
    await Promise.allSettled(this.children.map((c) => c.tryComplete()));
  }

  unresolvedFuture(): UnresolvedFuture | null {
    if (this.done) return null;
    const futures = this.children.map((c) => c.unresolvedFuture()).filter((f): f is UnresolvedFuture => f !== null);
    return futures.length === 0 ? null : { FirstCompleted: futures };
  }

  tryCancel() {
    this.children.forEach((c) => c.tryCancel());
  }
}

function setup(opts: { onFlush?: () => void } = {}) {
  const fake = new FakeVm();
  const channel = new ExternalProgressChannel(); // upstream's: one waiter, else it rejects
  const errors: unknown[] = [];
  const started: number[] = [];
  let flushes = 0;
  const selector = new PromiseSelector({
    doProgress: (f) => fake.doProgress(f),
    flushOutput: () => {
      flushes++;
      opts.onFlush?.();
      return Promise.resolve();
    },
    awaitExternalProgress: () => channel.awaitNext(),
    wake: () => channel.signal(),
    work: () => {
      if (fake.work === undefined) {
        fake.work = WORK;
        fake.runs.add(WORK);
      }
      return WORK;
    },
    executeRun: (h) => started.push(h),
    onError: (e) => errors.push(e),
  });
  let next = 17; // as the VM's handles: those below are its own signals', the cancellation's (1) among them
  const t = {
    fake,
    channel,
    selector,
    errors,
    started,
    flushes: () => flushes,
    promise<T = unknown>() {
      const p = new FakePromise<T>(fake, next++);
      selector.register(p);
      return p;
    },
    /** The invocation's cancellation, as a handler with explicit cancellation awaits it. */
    cancellation() {
      const p = new FakePromise<void>(fake, CANCELLATION);
      selector.register(p);
      return p;
    },
    run<T = unknown>() {
      const p = new FakePromise<T>(fake, next++);
      fake.runs.add(p.handle);
      selector.register(p);
      return p;
    },
    /** The result of `p` comes in (a notification; for a run, its acknowledged result). */
    complete(p: FakePromise, value: unknown) {
      fake.arrived.push([p.handle, { ok: value }]);
      fake.executing.delete(p.handle);
      channel.signal();
    },
    fail(p: FakePromise, error: Error) {
      fake.arrived.push([p.handle, { fail: error }]);
      fake.executing.delete(p.handle);
      channel.signal();
    },
    closeInput() {
      fake.inputClosed = true;
      channel.signal();
    },
    cancel() {
      fake.cancelled = true;
      channel.signal();
    },
  };
  return t;
}

async function until(cond: () => boolean, turns = 200) {
  for (let i = 0; i < turns; i++) {
    if (cond()) return;
    await setImmediate();
  }
  throw new Error('condition not reached');
}

async function settle(turns = 20) {
  for (let i = 0; i < turns; i++) await setImmediate();
}

afterEach(() => failpoints.clear());

/** Holds every selector's loop at `point`, from its next arrival there until released. */
function hold(point: 'pass' | 'wait') {
  const gate = Promise.withResolvers<void>();
  const arrived = Promise.withResolvers<void>();
  failpoints.set(point, () => {
    arrived.resolve();
    return gate.promise;
  });
  return {
    /** Resolves once a loop is held. */
    arrived: arrived.promise,
    release() {
      failpoints.delete(point);
      gate.resolve();
    },
  };
}

describe('PromiseSelector', () => {
  it('settles a promise when its result arrives', async () => {
    const t = setup();
    const p = t.promise<string>();
    await settle();
    expect(p.isDone()).toBe(false);
    t.complete(p, 'a');
    await expect(p.user).resolves.toBe('a');
    expect(t.errors).toEqual([]);
  });

  it('drives several awaits at once, under native combinators', async () => {
    const t = setup();
    const a = t.promise<string>();
    const b = t.promise<string>();
    const c = t.promise<string>();
    const all = Promise.all([a.user, b.user, c.user]);
    const race = Promise.race([a.user, b.user, c.user]);
    await settle();
    t.complete(c, 'c');
    await expect(race).resolves.toBe('c');
    t.complete(a, 'a');
    t.complete(b, 'b');
    await expect(all).resolves.toEqual(['a', 'b', 'c']);
    expect(t.errors).toEqual([]); // the channel never had two waiters
  });

  it('asks the VM about every pending promise at once', async () => {
    const t = setup();
    const a = t.promise();
    const b = t.promise();
    await until(() => t.fake.progress.length > 0);
    expect(t.fake.progress.at(-1)).toEqual({
      FirstCompleted: [{ Single: a.handle }, { Single: b.handle }],
    });
  });

  it('delivers failures to their own promise only', async () => {
    const t = setup();
    const a = t.promise();
    const b = t.promise<number>();
    t.fail(a, new Error('boom'));
    await expect(a.user).rejects.toThrow('boom');
    t.complete(b, 2);
    await expect(b.user).resolves.toBe(2);
  });

  it('drives a promise registered while it waits, even if older ones never complete', async () => {
    const t = setup();
    t.promise(); // never completes
    await until(() => t.fake.progress.length > 0);
    await settle();
    const r = t.run<number>();
    await until(() => t.started.includes(r.handle));
    t.complete(r, 42);
    await expect(r.user).resolves.toBe(42);
  });

  it('suspends on every pending promise', async () => {
    const t = setup();
    const a = t.promise();
    const b = t.promise();
    await settle();
    t.closeInput();
    await until(() => t.errors.length > 0);
    expect(t.fake.suspendedOn).toEqual({
      FirstCompleted: [{ Single: a.handle }, { Single: b.handle }],
    });
    expect(t.selector.size).toBe(0);
  });

  it('does not suspend while a run it awaits is executing', async () => {
    const t = setup();
    const sleep = t.promise();
    const r = t.run<string>();
    await until(() => t.started.includes(r.handle));
    t.closeInput();
    await settle();
    expect(t.errors).toEqual([]);
    t.complete(r, 'done');
    await expect(r.user).resolves.toBe('done');
    await until(() => t.errors.length > 0);
    expect(t.fake.suspendedOn).toEqual({ Single: sleep.handle });
  });

  it('starts a run as soon as it is registered, without an await', async () => {
    const t = setup();
    const r = t.run();
    await until(() => t.started.includes(r.handle));
    expect(t.started).toContain(r.handle);
  });

  it('reaches every pending promise with a cancellation, and only those', async () => {
    const t = setup();
    const a = t.promise();
    const b = t.promise();
    await settle();
    t.cancel();
    await expect(a.user).rejects.toThrow('cancelled');
    await expect(b.user).rejects.toThrow('cancelled');
    const c = t.promise<string>();
    t.complete(c, 'after');
    await expect(c.user).resolves.toBe('after');
    expect(t.errors).toEqual([]);
  });

  describe('with the cancellation awaited alone, as a handler that works outside Restate does', () => {
    it('asks for it with the working run, and settles it when the cancel signal comes', async () => {
      const t = setup();
      const cancelled = t.cancellation();
      await until(() => t.fake.progress.length > 1);
      // The first check starts the working run, the second waits: never for the cancellation alone.
      expect(t.fake.progress).toEqual([WATCHING, WATCHING]);
      expect(t.started).toEqual([WORK]);
      expect(t.fake.askedForCancellationAlone).toEqual([]);
      t.complete(cancelled, undefined);
      await expect(cancelled.user).resolves.toBeUndefined();
      expect(t.errors).toEqual([]);
    });

    it('does not suspend once the input closed', async () => {
      const t = setup();
      const cancelled = t.cancellation();
      await until(() => t.fake.progress.length > 1);
      t.closeInput();
      await settle();
      expect(t.fake.suspendedOn).toBeUndefined();
      expect(t.errors).toEqual([]);
      expect(t.fake.askedForCancellationAlone).toEqual([]);
      expect(cancelled.isDone()).toBe(false);
    });

    it('does not suspend if the input closed before it was awaited', async () => {
      const t = setup();
      t.fake.inputClosed = true;
      t.cancellation();
      await settle();
      expect(t.fake.suspendedOn).toBeUndefined();
      expect(t.started).toEqual([WORK]);
      expect(t.fake.askedForCancellationAlone).toEqual([]);
      expect(t.errors).toEqual([]);
    });

    it('suspends on it and on what is awaited after the input closed, without the working run', async () => {
      const t = setup();
      t.cancellation();
      await until(() => t.fake.progress.length > 1);
      t.closeInput();
      await settle();
      const p = t.promise();
      await until(() => t.errors.length > 0);
      expect((t.errors[0] as Error).message).toBe('suspended');
      expect(t.fake.suspendedOn).toEqual({ FirstCompleted: [{ Single: 1 }, { Single: p.handle }] });
    });

    it('settles what is awaited after the input closed, in the same attempt', async () => {
      const t = setup();
      const cancelled = t.cancellation();
      await until(() => t.fake.progress.length > 1);
      t.closeInput();
      await settle();
      const run = t.run<string>();
      await until(() => t.started.includes(run.handle));
      t.complete(run, 'ran');
      await expect(run.user).resolves.toBe('ran');
      await settle();
      expect(t.fake.suspendedOn).toBeUndefined();
      expect(t.errors).toEqual([]);
      expect(cancelled.isDone()).toBe(false);
    });

    it('settles it with a cancel signal that came as the input closed', async () => {
      const t = setup();
      const cancelled = t.cancellation();
      await until(() => t.fake.progress.length > 1);
      t.fake.arrived.push([CANCELLATION, { ok: undefined }]);
      t.fake.inputClosed = true;
      t.channel.signal();
      await expect(cancelled.user).resolves.toBeUndefined();
      expect(t.fake.suspendedOn).toBeUndefined();
      expect(t.errors).toEqual([]);
    });

    it('suspends on a combinator over it and something else', async () => {
      const t = setup();
      const a = new FakePromise(t.fake, 1);
      const b = new FakePromise(t.fake, 40);
      t.selector.register(new FakeRace([a, b]));
      await until(() => t.fake.progress.length > 0);
      t.closeInput();
      await until(() => t.errors.length > 0);
      expect(t.fake.suspendedOn).toEqual({ FirstCompleted: [{ Single: 1 }, { Single: 40 }] });
    });

    it('does not suspend if the input closes while a pass is held before its check', async () => {
      const t = setup();
      t.cancellation();
      await until(() => t.fake.progress.length > 0);
      const held = hold('pass');
      t.channel.signal(); // some input: the loop starts a pass, and is held
      await held.arrived;
      t.closeInput();
      await settle();
      held.release();
      await settle();
      expect(t.fake.askedForCancellationAlone).toEqual([]);
      expect(t.fake.suspendedOn).toBeUndefined();
      expect(t.errors).toEqual([]);
    });

    it('does not suspend if the input closes between its check and its wait', async () => {
      const t = setup();
      const held = hold('wait');
      t.cancellation();
      await held.arrived; // checked, with the input open: about to wait
      t.closeInput();
      await settle();
      held.release();
      await settle();
      expect(t.fake.askedForCancellationAlone).toEqual([]);
      expect(t.fake.suspendedOn).toBeUndefined();
      expect(t.errors).toEqual([]);
    });

    it('finds a cancel signal that came while a pass was held, with the input still open', async () => {
      const t = setup();
      const cancelled = t.cancellation();
      await until(() => t.fake.progress.length > 0);
      const held = hold('pass');
      t.complete(cancelled, undefined);
      await held.arrived;
      held.release();
      await expect(cancelled.user).resolves.toBeUndefined();
    });

    it('never asks for it alone, whatever else comes and goes', async () => {
      let seed = 11;
      const random = () => {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        return seed / 2 ** 31;
      };
      let suspended = 0;
      let worked = 0;
      for (let round = 0; round < 200; round++) {
        const t = setup();
        const open: FakePromise[] = [];
        const closeAt = Math.floor(random() * 120);
        const watchAt = Math.floor(random() * 60);
        // Some rounds hold the loop at random, to stretch the windows between its steps.
        const stretch = round % 3 === 0;
        if (stretch) {
          failpoints.set('pass', () => (random() < 0.3 ? setImmediate() : undefined));
          failpoints.set('wait', () => (random() < 0.3 ? setImmediate() : undefined));
        }
        for (let step = 0; step < 120 && t.fake.suspendedOn === undefined; step++) {
          if (step === watchAt) t.cancellation();
          if (step === closeAt) t.closeInput();
          const x = random();
          if (x < 0.25) {
            // Every other round, the handler awaits runs only: with the input closed, anything else suspends it.
            open.push(round % 2 === 0 || random() < 0.5 ? t.run() : t.promise());
          } else if (x < 0.6 && open.length > 0) {
            const i = Math.floor(random() * open.length);
            const p = open[i]!;
            // Once the input closed, only a run that executes has a result to come.
            if (!t.fake.inputClosed || t.fake.executing.has(p.handle)) {
              open.splice(i, 1);
              t.complete(p, p.handle);
            }
          } else if (x < 0.7) {
            t.channel.signal();
          }
          if (random() < 0.6) await setImmediate();
        }
        // Until every result that came in was taken in, or the invocation suspended.
        const quiet = async () => {
          await until(() => t.fake.arrived.length === 0 || t.fake.suspendedOn !== undefined, 2000);
          await settle(40);
        };
        await quiet();
        // The runs that execute finish, whether the input closed or not.
        for (const p of open.filter((r) => t.fake.executing.has(r.handle))) t.complete(p, p.handle);
        await quiet();
        failpoints.clear();
        expect(t.fake.askedForCancellationAlone).toEqual([]);
        // It suspended only on something else that the handler waits for; and it did suspend if the handler
        // waits for something else with the input closed, unless a run still executes (the VM waits for it).
        const on = t.fake.suspendedOn;
        const atWork = [...t.fake.executing].filter((h) => h !== WORK);
        const idle = on === undefined && t.fake.inputClosed && atWork.length === 0;
        expect(on === undefined || leaves(on).some((h) => h !== CANCELLATION)).toBe(true);
        expect(idle ? open.filter((p) => !p.isDone()).map((p) => p.handle) : []).toEqual([]);
        if (on !== undefined) suspended++;
        if (idle) worked++;
      }
      // Both outcomes came up.
      expect(suspended).toBeGreaterThan(10);
      expect(worked).toBeGreaterThan(10);
    });
  });

  it('stops when nothing is pending, and starts again on a registration', async () => {
    const t = setup();
    const a = t.promise<number>();
    t.complete(a, 1);
    await expect(a.user).resolves.toBe(1);
    await settle();
    const calls = t.fake.progress.length;
    t.channel.signal(); // input arriving with nothing pending
    t.channel.signal();
    await settle();
    expect(t.fake.progress.length).toBe(calls);
    const b = t.promise<number>();
    t.complete(b, 2);
    await expect(b.user).resolves.toBe(2);
    expect(t.errors).toEqual([]);
  });

  it('loses no wake-up that comes between the check and the wait', async () => {
    let t: ReturnType<typeof setup> | undefined = undefined;
    let p: FakePromise<string> | undefined = undefined;
    let armed = true;
    t = setup({
      // The flush before waiting: the result arrives in between.
      onFlush: () => {
        if (armed && p && t!.fake.progress.length > 0) {
          armed = false;
          t!.complete(p, 'late');
        }
      },
    });
    p = t.promise<string>();
    await expect(p.user).resolves.toBe('late');
  });

  it('joins a run registered between the check and the wait to the next check', async () => {
    let r: FakePromise | undefined;
    const t: ReturnType<typeof setup> = setup({
      // The flush before waiting: a run is made in between.
      onFlush: () => {
        if (!r && t.fake.progress.length > 0) r = t.run();
      },
    });
    t.promise(); // never completes
    await until(() => r !== undefined && t.started.includes(r.handle));
    expect(t.started).toContain(r!.handle);
  });

  it("does not keep waiting on a race's loser once the race settled", async () => {
    const t = setup();
    const a = new FakePromise(t.fake, 100);
    const b = new FakePromise(t.fake, 101);
    const race = new FakeRace([a, b]);
    t.selector.register(race);
    t.complete(a, 'a');
    await expect(race.user).resolves.toBe('a');
    await until(() => t.selector.size === 0);
  });

  it('settles both a promise and a combinator over it', async () => {
    const t = setup();
    const a = t.promise<string>();
    const b = new FakePromise(t.fake, 200);
    const race = new FakeRace([a, b]);
    t.selector.register(race);
    t.complete(a, 'a');
    await expect(a.user).resolves.toBe('a');
    await expect(race.user).resolves.toBe('a');
  });

  it('stops on close', async () => {
    const t = setup();
    const a = t.promise();
    await until(() => t.fake.progress.length > 0);
    t.selector.close();
    await settle();
    const calls = t.fake.progress.length;
    t.complete(a, 1);
    t.promise();
    await settle();
    expect(t.fake.progress.length).toBe(calls);
    expect(a.isDone()).toBe(false);
  });

  it('reports a VM error once, and stops', async () => {
    const t = setup();
    t.fake.failWith = new Error('protocol violation');
    const a = t.promise();
    await until(() => t.errors.length > 0);
    await settle();
    expect(t.errors).toHaveLength(1);
    t.promise();
    await settle();
    expect(t.errors).toHaveLength(1);
    expect(a.isDone()).toBe(false);
  });

  it('flushes output before its first check and before every wait', async () => {
    const t = setup();
    t.promise();
    await until(() => t.fake.progress.length > 0);
    await settle();
    expect(t.flushes()).toBeGreaterThanOrEqual(2);
  });

  it('settles everything under random registrations, completions and signals', async () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let round = 0; round < 20; round++) {
      const t = setup();
      const promises: { p: FakePromise; expect: Result }[] = [];
      const open: FakePromise[] = [];
      for (let step = 0; step < 300; step++) {
        const x = random();
        if (x < 0.3 || open.length === 0) {
          const p = random() < 0.2 ? t.run() : t.promise();
          open.push(p);
        } else if (x < 0.75) {
          const i = Math.floor(random() * open.length);
          const p = open.splice(i, 1)[0]!;
          const result: Result = random() < 0.2 ? { fail: new Error(`f${p.handle}`) } : { ok: p.handle };
          promises.push({ p, expect: result });
          if ('ok' in result) t.complete(p, result.ok);
          else t.fail(p, result.fail);
        } else if (x < 0.85) {
          t.channel.signal();
        }
        if (random() < 0.5) await setImmediate();
      }
      for (const p of open) {
        t.complete(p, p.handle);
        promises.push({ p, expect: { ok: p.handle } });
      }
      for (const { p, expect: r } of promises) {
        const outcome = await p.user.then(
          (ok: unknown) => ({ ok }),
          (fail: unknown) => ({ fail }),
        );
        expect(outcome).toEqual(r);
      }
      await until(() => t.selector.size === 0);
      expect(t.errors).toEqual([]);
    }
  });

  it('checks a batch of promises made at once together, not once per promise', async () => {
    const t = setup();
    const ps = Array.from({ length: 100 }, () => t.promise());
    await settle(50);
    expect(t.fake.progress.length).toBeLessThanOrEqual(2);
    expect(t.selector.size).toBe(100);
    ps.forEach((p, i) => t.complete(p, i));
    await expect(Promise.all(ps.map((p) => p.user))).resolves.toHaveLength(100);
    expect(t.errors).toEqual([]);
  });
});
