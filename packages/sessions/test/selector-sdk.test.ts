// The selector hooked into the SDK's own parts (`hookSelector`), as an
// invocation has them: its input pump, its progress channel, its promises
// executor and its promises, loaded from the pinned SDK's files. Only the VM
// and the input are a test's: a VM with the shared core's rules for
// do_progress, and an input whose chunks and whose end come when a test says.
//
// What this covers that selector.test.ts cannot: the real order of events
// between the SDK noting that the input closed and the loop's next check. A
// check on the cancellation alone, made with the input closed, suspends the
// invocation on it: the selector must never make one, however the end of the
// input falls among the loop's steps.
import { failpoints, hookSelector, type DoProgressResult, type UnresolvedFuture } from '@restatedev/sessions/internal';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { setImmediate, setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// The SDK's internals, by file: its package exports none of them.
const dist = dirname(createRequire(import.meta.url).resolve('@restatedev/restate-sdk'));
const load = (file: string) => import(pathToFileURL(join(dist, file)).href) as Promise<Record<string, unknown>>;
type Class<T> = new (...args: never[]) => T;
const { InputPump, OutputPump } = (await load('io.js')) as {
  InputPump: Class<{ runDone: Promise<unknown>; stop(): Promise<unknown> }>;
  OutputPump: Class<object>;
};
const { PromisesExecutor, SingleRestatePromise } = (await load('promises.js')) as {
  PromisesExecutor: Class<object>;
  SingleRestatePromise: Class<PromiseLike<unknown>>;
};
const { ExternalProgressChannel } = (await load('utils/external_progress_channel.js')) as {
  ExternalProgressChannel: Class<{ signal(): void }>;
};

const CANCELLATION = 1;

const leaves = (f: UnresolvedFuture): number[] => ('Single' in f ? [f.Single] : Object.values(f)[0]!.flatMap(leaves));
const resolved = (f: UnresolvedFuture, ready: Set<number>): boolean =>
  'Single' in f
    ? ready.has(f.Single)
    : 'AllCompleted' in f || 'AllSucceededOrFirstFailed' in f
      ? Object.values(f)[0]!.every((c) => resolved(c, ready))
      : Object.values(f)[0]!.some((c) => resolved(c, ready));

/** The VM, as the SDK's parts and the selector call it, with the shared core's rules (see selector.test.ts). */
class Vm {
  readonly ready = new Set<number>();
  readonly arrived: number[] = [];
  inputClosed = false;
  suspendedOn?: UnresolvedFuture;
  readonly asked: UnresolvedFuture[] = [];
  readonly askedForCancellationAloneOnClosedInput: UnresolvedFuture[] = [];

  // The input pump's.
  notify_input(handles: number[]) {
    this.arrived.push(...handles);
  }
  notify_input_closed() {
    this.inputClosed = true;
  }
  // The output pump's.
  take_output() {
    return new Uint8Array();
  }
  // A promise's.
  take_notification(handle: number) {
    return this.ready.delete(handle) ? 'Empty' : 'NotReady';
  }
  // The selector's.
  do_progress(f: UnresolvedFuture): DoProgressResult {
    if (this.suspendedOn) throw new Error('closed');
    this.asked.push(f);
    if (this.inputClosed && leaves(f).every((h) => h === CANCELLATION)) {
      this.askedForCancellationAloneOnClosedInput.push(f);
    }
    while (!resolved(f, this.ready)) {
      const next = this.arrived.shift();
      if (next === undefined) break;
      this.ready.add(next);
    }
    if (resolved(f, this.ready)) return 'AnyCompleted';
    if (this.inputClosed) {
      this.suspendedOn = f;
      throw new Error('suspended');
    }
    return 'WaitExternalProgress';
  }
}

/** An input stream's reader: what was pushed is read back to back, as chunks a stream has buffered are. */
class Input {
  private readonly buffered: IteratorResult<number[]>[] = [];
  private reader?: (result: IteratorResult<number[]>) => void;
  private push(result: IteratorResult<number[]>) {
    if (this.reader) {
      const read = this.reader;
      this.reader = undefined;
      read(result);
    } else this.buffered.push(result);
  }
  /** Notifications come in, for these handles. */
  deliver(...handles: number[]) {
    this.push({ done: false, value: handles });
  }
  /** The input ends: Restate closed it. */
  end() {
    this.push({ done: true, value: undefined });
  }
  next(): Promise<IteratorResult<number[]>> {
    const next = this.buffered.shift();
    if (next) return Promise.resolve(next);
    return new Promise((resolve) => {
      this.reader = resolve;
    });
  }
}

/** How a promise of the SDK's takes its result: as the cancellation's does, with no value. */
const complete = async (_value: unknown, promise: { resolve(v: unknown): void }) => promise.resolve(undefined);

/** An invocation's parts, as the SDK's context makes them, with the selector hooked in. */
function invocation({ before = () => {} }: { before?: (input: Input) => void } = {}) {
  const vm = new Vm();
  const input = new Input();
  before(input); // what the input holds as the context is made
  const errors: unknown[] = [];
  const onError = (e: unknown) => errors.push(e);
  const channel = new ExternalProgressChannel();
  const tracker = { executeRun() {} };
  const ctx = {
    coreVm: vm,
    inputPump: new InputPump(...([vm, input, channel, onError] as never[])),
    promisesExecutor: new PromisesExecutor(
      ...([
        vm,
        new OutputPump(...([vm, { write: async () => {} }] as never[])),
        tracker,
        tracker,
        channel,
        onError,
      ] as never[]),
    ),
  };
  const unhook = hookSelector(ctx);
  /** A promise of the SDK's for `handle`, awaited: `settled` says whether it resolved. */
  const awaited = (handle: number) => {
    const state = { settled: false };
    const promise = new SingleRestatePromise(...([ctx, handle, complete] as never[]));
    void (async () => {
      await promise;
      state.settled = true;
    })().catch(() => {});
    return state;
  };
  return {
    vm,
    input,
    errors,
    awaited,
    /** The invocation's cancellation, awaited as `cancelled(ctx)` does. */
    cancellation: () => awaited(CANCELLATION),
    /** The attempt ends: the selector is unhooked, and the pump stops at the end of its input. */
    async end() {
      unhook();
      input.end();
      await ctx.inputPump.stop();
    },
  };
}

const settle = async (turns = 20) => {
  for (let i = 0; i < turns; i++) await setImmediate();
};

/** Past any gap a failpoint holds the loop for. */
const quiesce = async () => {
  await sleep(5);
  await settle();
};

afterEach(() => failpoints.clear());

describe("the selector over the SDK's own parts, with the cancellation awaited alone", () => {
  it('settles it when the cancel signal comes in', async () => {
    const i = invocation();
    const cancelled = i.cancellation();
    await settle();
    expect(i.vm.asked).toEqual([{ Single: CANCELLATION }]);
    i.input.deliver(CANCELLATION);
    await settle();
    expect(cancelled.settled).toBe(true);
    await i.end();
  });

  it('does not suspend when the input ends', async () => {
    const i = invocation();
    i.cancellation();
    await settle();
    i.input.end();
    await settle();
    expect(i.vm.inputClosed).toBe(true);
    expect(i.vm.askedForCancellationAloneOnClosedInput).toEqual([]);
    expect(i.vm.suspendedOn).toBeUndefined();
    expect(i.errors).toEqual([]);
    await i.end();
  });

  it('does not suspend when the input ended before the handler started: a request-response invocation', async () => {
    const i = invocation({ before: (input) => input.end() });
    i.cancellation(); // in the turn the context was made in
    await settle();
    expect(i.vm.inputClosed).toBe(true);
    expect(i.vm.asked).toEqual([]);
    expect(i.vm.suspendedOn).toBeUndefined();
    await i.end();
  });

  it('does not suspend when the input ends right behind a notification, in one read after the other', async () => {
    const i = invocation();
    i.cancellation();
    await settle();
    i.input.deliver(40); // of something nobody awaits
    i.input.end();
    await settle();
    expect(i.vm.askedForCancellationAloneOnClosedInput).toEqual([]);
    expect(i.vm.suspendedOn).toBeUndefined();
    await i.end();
  });

  it('finds a cancel signal the input ended right behind, once something else is awaited', async () => {
    const i = invocation();
    const cancelled = i.cancellation();
    await settle();
    i.input.deliver(CANCELLATION);
    i.input.end();
    await settle();
    expect(i.vm.suspendedOn).toBeUndefined();
    expect(cancelled.settled).toBe(false); // no check saw it, and none may be made for it alone
    i.awaited(40);
    await settle();
    expect(cancelled.settled).toBe(true);
    // And then the handler, which goes on waiting here, is suspended on what it waits for.
    expect(i.vm.suspendedOn).toEqual({ Single: 40 });
    await i.end();
  });

  it('suspends on what is awaited with it, once the input ended', async () => {
    const i = invocation();
    i.cancellation();
    i.awaited(40);
    await settle();
    i.input.end();
    await settle();
    expect(i.vm.suspendedOn).toEqual({ FirstCompleted: [{ Single: CANCELLATION }, { Single: 40 }] });
    expect(i.errors).toHaveLength(1);
    await i.end();
  });

  // The end of the input, at every distance from the loop's steps: in the turn of a
  // notification, a microtask or more later, a turn later, a timer later; with the loop
  // held at its failpoints or not; with the cancellation awaited before or after.
  it('never asks for it alone on an input that ended, however the end falls among its steps', async () => {
    let seed = 3;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const pick = (n: number) => Math.floor(random() * n);
    const gaps = [
      async () => {},
      async () => Promise.resolve(),
      async () => {
        for (let k = pick(8); k > 0; k--) await Promise.resolve();
      },
      async () => setImmediate(),
      async () => sleep(0),
    ];
    const gap = () => gaps[pick(gaps.length)]!();
    let closedWhileWatching = 0;
    for (let round = 0; round < 300; round++) {
      const endsFirst = round % 10 === 0;
      const i = invocation({ before: (input) => endsFirst && input.end() });
      if (round % 4 === 1) failpoints.set('pass', () => (random() < 0.5 ? gap() : undefined));
      if (round % 4 === 2) failpoints.set('wait', () => (random() < 0.5 ? gap() : undefined));
      await gap();
      const cancelled = i.cancellation();
      for (let step = pick(6); step > 0; step--) {
        await gap();
        // Notifications of things nobody awaits (a call's invocation id, say), or the cancel signal.
        if (!endsFirst) i.input.deliver(random() < 0.15 ? CANCELLATION : 40 + step);
      }
      await gap();
      if (!endsFirst) i.input.end();
      await quiesce();
      expect(i.vm.inputClosed).toBe(true);
      expect(i.vm.askedForCancellationAloneOnClosedInput).toEqual([]);
      expect(i.vm.suspendedOn).toBeUndefined();
      expect(i.errors).toEqual([]);
      if (!cancelled.settled) closedWhileWatching++;
      // What the handler awaits next: the cancel signal is found if it came (then, or before), and the handler,
      // which goes on waiting here, suspends on what is left; or the invocation suspends on both.
      const came = cancelled.settled || i.vm.arrived.includes(CANCELLATION) || i.vm.ready.has(CANCELLATION);
      i.awaited(90);
      await quiesce();
      expect(cancelled.settled).toBe(came);
      expect(i.vm.suspendedOn).toEqual(
        came ? { Single: 90 } : { FirstCompleted: [{ Single: CANCELLATION }, { Single: 90 }] },
      );
      failpoints.clear();
      await i.end();
    }
    expect(closedWhileWatching).toBeGreaterThan(100);
  }, 60_000);
});
