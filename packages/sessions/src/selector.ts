// Concurrent awaits in a handler with SQL: one loop, the selector, drives
// every promise the handler awaits.
//
// The published SDK drives each awaited RestatePromise with a loop of its own,
// and only one of them may wait for progress from the server at a time
// (`ExternalProgressChannel.awaitNext`): two promises awaited at once that
// both need the server, such as two state reads with lazy state, fail the
// attempt with "awaitNext already pending". With journal replay, that order of
// awaits is part of what a replay must match; with explicit recovery nothing
// is replayed, so a handler with SQL hands every awaited promise to one loop,
// which asks the VM about all of them at once (`hookSelector`). The hook
// replaces the invocation's `promisesExecutor.doProgress`: it relies on the
// SDK's internals, as of the version this package pins (1.18.2).
//
// TODO: drop the selector, and the pin, once an SDK release lets a handler
// with explicit recovery await concurrently.
import { setImmediate } from 'node:timers/promises';

/** A future of the VM, as `do_progress` takes it. */
export type UnresolvedFuture =
  | { Single: number }
  | { FirstCompleted: UnresolvedFuture[] }
  | { AllCompleted: UnresolvedFuture[] }
  | { FirstSucceededOrAllFailed: UnresolvedFuture[] }
  | { AllSucceededOrFirstFailed: UnresolvedFuture[] }
  | { Unknown: UnresolvedFuture[] };

/** What `do_progress` returns. */
export type DoProgressResult =
  | 'AnyCompleted'
  | 'WaitExternalProgress'
  | { ExecuteRun: number }
  | 'CancelSignalReceived'
  | { EphemeralNotificationReady: number };

/** The handle of the invocation's cancel signal: the VM's, and what `ctx.cancellation()` awaits. */
const CANCELLATION = 1;

/** Whether `future` waits for the invocation's cancellation, and nothing else. */
const cancellationAlone = (future: UnresolvedFuture): boolean =>
  'Single' in future ? future.Single === CANCELLATION : Object.values(future)[0]!.every(cancellationAlone);

/** What the selector needs of a promise: the shape of InternalRestatePromise. */
export interface Selectable {
  /** Takes the result if it is ready, and settles the promise with it. */
  tryComplete(): Promise<void>;
  /** What it still waits for, or null once settled. */
  unresolvedFuture(): UnresolvedFuture | null;
  /** Rejects it with a CancelledError. */
  tryCancel(): void;
}

/** What the selector needs of the invocation. */
export interface SelectorDriver {
  /**
   * Asks the VM for progress on `future`. With nothing ready, the VM tells
   * Restate what the handler waits for, unless a run is executing; and once
   * the input closed, it suspends the invocation on it (a throw), unless a
   * run of the future is executing.
   */
  doProgress(future: UnresolvedFuture): DoProgressResult;
  /** Writes out what the VM has buffered. */
  flushOutput(): Promise<void>;
  /** Resolves on the next signal of external progress (input, a finished run, a registration). */
  awaitExternalProgress(): Promise<void>;
  /** Signals external progress. */
  wake(): void;
  /**
   * The handle of the attempt's working run, made at the first call: a run
   * that the VM hands out like any other (`ExecuteRun`) and that never ends
   * while the attempt lasts. It stands for the handler's work outside Restate.
   */
  work(): number;
  executeRun(handle: number): void;
  /** The attempt cannot go on: suspension, or an error. */
  onError(e: unknown): void;
}

/**
 * The points of the loop where a test steps in: `pass`, as a pass starts,
 * and `wait`, between a check that found nothing and the wait for progress.
 */
export type Failpoint = 'pass' | 'wait';

/**
 * For tests: what every selector's loop awaits at each of its failpoints, to
 * hold it there while something else happens (the input closes, a signal
 * comes). At `wait`, it gets what the check asked for, and whether that was
 * the invocation's cancellation alone (with the working run). Empty
 * otherwise, and the loop then awaits nothing there.
 */
export const failpoints = new Map<Failpoint, (asked?: UnresolvedFuture, watching?: boolean) => unknown>();

/**
 * One loop that drives every pending promise of an invocation, so that the
 * invocation has a single await point however many promises user code awaits
 * at once, with its own combinators or none.
 *
 * A promise is registered once and stays until it settles. Each pass of the
 * loop settles what is ready, then asks the VM for progress on the first of
 * all the pending promises to complete: so a suspension waits for any of
 * them, a pending run starts whichever promise is awaited first, and a
 * cancellation reaches all of them. Registering wakes the loop, so a promise
 * registered while it waits is part of the next pass. The loop runs while
 * there is something to ask the VM for, and is the only one waiting for
 * external progress.
 *
 * To ask is to say that the handler waits: the VM tells Restate what for,
 * and suspends the invocation on it once the input closed (Restate's
 * inactivity timeout). That holds for every promise but one. A handler with
 * explicit cancellation awaits its cancellation (`cancelled(ctx)`) to stop
 * work it does outside Restate, a model's request, say: it watches for it,
 * and does not wait for it. Reported as awaited, the cancel signal would be
 * all Restate believes the handler waits for; and suspended on it, the
 * invocation would end its attempt in the middle of that work, with a
 * cancellation as the only thing to resume it.
 *
 * So with only the cancellation pending, the loop asks for it together with
 * the attempt's working run (`SelectorDriver.work`), which says what is true:
 * the handler is at work on something of its own, as inside `ctx.run`. While
 * a run executes, the VM reports no await, and does not suspend on a future
 * the run is part of, whether the input is open or closed; and it still
 * finds the cancel signal when it comes. See `awaited`.
 */
export class PromiseSelector {
  private readonly pending = new Set<Selectable>();
  private running = false;
  private closed = false;
  // Between a check that found nothing and the next external progress.
  private waiting = false;
  // Whether the last check asked for the cancellation alone, with the working run.
  private watching = false;

  private readonly driver: SelectorDriver;

  constructor(driver: SelectorDriver) {
    this.driver = driver;
  }

  register(promise: Selectable): void {
    if (this.closed || this.pending.has(promise)) return;
    this.pending.add(promise);
    if (this.running) {
      this.wake();
    } else {
      this.running = true;
      void this.loop();
    }
  }

  /** Stops the loop (it finds nothing pending), at the end of the attempt. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pending.clear();
    if (this.running) this.wake();
  }

  // Only a waiting loop needs waking, once: any other picks up the change on
  // its next pass. (Waking it otherwise would buffer a signal per promise, and
  // as many needless passes, each of which tells Restate what is awaited.)
  private wake(): void {
    if (!this.waiting) return;
    this.waiting = false;
    this.driver.wake();
  }

  /** The promises still pending, for tests. */
  get size(): number {
    return this.pending.size;
  }

  /**
   * What to ask the VM for: the first of the pending promises to complete,
   * or undefined with nothing pending. With only the invocation's
   * cancellation pending, the handler watches and waits for nothing: the
   * working run goes with it (see the class).
   */
  private awaited(): UnresolvedFuture | undefined {
    const futures: UnresolvedFuture[] = [];
    let watching = true; // for the cancellation, and waiting for nothing
    for (const promise of this.pending) {
      const future = promise.unresolvedFuture();
      if (future === null) {
        this.pending.delete(promise);
      } else {
        futures.push(future);
        watching &&= cancellationAlone(future);
      }
    }
    this.watching = watching && futures.length > 0;
    if (futures.length === 0) return undefined;
    if (watching) futures.push({ Single: this.driver.work() });
    return futures.length === 1 ? futures[0] : { FirstCompleted: futures };
  }

  private async loop(): Promise<void> {
    try {
      await this.driver.flushOutput();
      for (;;) {
        if (failpoints.size > 0) await failpoints.get('pass')?.();
        // Settle what is ready.
        for (const promise of this.pending) {
          await promise.tryComplete();
        }
        // A turn of the event loop: what was settled runs, and registers
        // what it awaits next, so that one check covers that too (a
        // combinator also flags itself completed in a .finally, a tick late).
        // An optimization: what is registered later wakes the loop anyway.
        await setImmediate();
        // From here to the end of the pass, or to `waiting`, in one turn:
        // what is registered after the check finds the loop gone, and starts
        // another, or finds it waiting, and wakes it.
        const future = this.awaited();
        if (future === undefined) return;
        const result = this.driver.doProgress(future);
        if (result === 'AnyCompleted') {
          continue;
        } else if (result === 'WaitExternalProgress') {
          this.waiting = true;
          if (failpoints.size > 0) await failpoints.get('wait')?.(future, this.watching);
          await this.driver.flushOutput();
          await this.driver.awaitExternalProgress();
          this.waiting = false;
        } else if (result === 'CancelSignalReceived') {
          // Reaches every pending promise; what is awaited after it is not cancelled.
          for (const promise of this.pending) promise.tryCancel();
          this.pending.clear();
        } else if ('ExecuteRun' in result) {
          // It starts in the turn the next pass takes before its check.
          this.driver.executeRun(result.ExecuteRun);
        } else {
          // An ephemeral command's notification: a handler with SQL makes none.
          throw new Error(`@restatedev/sessions: unexpected progress from the VM: ${JSON.stringify(result)}`);
        }
      }
    } catch (e) {
      this.close();
      this.driver.onError(e);
    } finally {
      this.running = false;
    }
  }
}

/** The SDK's promises executor, as far as the hook needs it: its fields are private in its types. */
interface Executor {
  doProgress(promise: Selectable): Promise<void>;
  coreVm: {
    do_progress(future: UnresolvedFuture): DoProgressResult;
    sys_run(name: string): { handle: number };
    propose_run_completion_success(handle: number, value: Uint8Array): void;
  };
  outputPump: { awaitNextProgress(): Promise<void> };
  externalProgressChannel: { awaitNext(): Promise<void>; signal(): void };
  runClosuresTracker: {
    executeRun(handle: number): void;
    registerRunClosure(handle: number, run: () => Promise<unknown>): void;
  };
  errorCallback: (e: unknown) => void;
}

const FIELDS = ['coreVm', 'outputPump', 'externalProgressChannel', 'runClosuresTracker', 'errorCallback'] as const;

/**
 * Drive every promise that the invocation of `ctx` (the SDK's context, not a
 * proxy of it) awaits from here on with one selector. The returned function
 * stops it, at the end of the attempt, and gives the invocation back its
 * own loops.
 */
export function hookSelector(ctx: object): () => void {
  const executor = (ctx as { promisesExecutor?: Executor }).promisesExecutor;
  const missing: string[] = executor ? FIELDS.filter((field) => executor[field] === undefined) : ['promisesExecutor'];
  if (missing.length === 0) {
    const { coreVm, runClosuresTracker } = executor!;
    for (const method of ['do_progress', 'sys_run', 'propose_run_completion_success'] as const) {
      if (typeof coreVm[method] !== 'function') missing.push(`coreVm.${method}`);
    }
    if (typeof runClosuresTracker.registerRunClosure !== 'function')
      missing.push('runClosuresTracker.registerRunClosure');
  }
  if (missing.length > 0 || executor === undefined) {
    throw new Error(
      `@restatedev/sessions drives a handler's promises through the SDK's internals, which this SDK version does not have ` +
        `(${missing.join(', ')}): use the @restatedev/restate-sdk that @restatedev/sessions pins`,
    );
  }
  const { coreVm, outputPump, externalProgressChannel, runClosuresTracker } = executor;
  // The working run: journaled as a run named `work`, with no closure of its
  // own to end it. It ends with the attempt.
  let work: number | undefined;
  const selector = new PromiseSelector({
    doProgress: (future) => coreVm.do_progress(future),
    flushOutput: () => outputPump.awaitNextProgress(),
    awaitExternalProgress: () => externalProgressChannel.awaitNext(),
    wake: () => externalProgressChannel.signal(),
    work: () => {
      if (work === undefined) {
        work = coreVm.sys_run('work').handle;
        runClosuresTracker.registerRunClosure(work, () => new Promise(() => {}));
      }
      return work;
    },
    executeRun: (handle) => runClosuresTracker.executeRun(handle),
    onError: (e) => executor.errorCallback(e),
  });
  // An own property, over the class's method: removing it gives the method back.
  executor.doProgress = async (promise) => selector.register(promise);
  return () => {
    selector.close();
    delete (executor as Partial<Executor>).doProgress;
    // The work is over: so is its run, in the journal of an invocation that
    // goes on to answer. (A VM that an error or a suspension closed refuses.)
    if (work !== undefined) {
      try {
        coreVm.propose_run_completion_success(work, new Uint8Array());
      } catch {
        // The attempt ended: the next one, or nothing, ends the run.
      }
      work = undefined;
    }
  };
}
