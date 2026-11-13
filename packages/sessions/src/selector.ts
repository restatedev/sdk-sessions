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
   * Restate what the handler waits for; and once the input closed, it
   * suspends the invocation on it (a throw), unless a run of the future is
   * executing.
   */
  doProgress(future: UnresolvedFuture): DoProgressResult;
  /** Writes out what the VM has buffered. */
  flushOutput(): Promise<void>;
  /** Resolves on the next signal of external progress (input, a finished run, a registration). */
  awaitExternalProgress(): Promise<void>;
  /** Signals external progress. */
  wake(): void;
  /** Whether the input closed: nothing more comes from Restate in this attempt. */
  inputClosed(): boolean;
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
 * comes). At `wait`, it gets what the check asked for. Empty otherwise, and
 * the loop then awaits nothing there.
 */
export const failpoints = new Map<Failpoint, (asked?: UnresolvedFuture) => unknown>();

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
 * To ask is to say that the handler waits: the VM reports what for, and
 * suspends the invocation on it once the input closed (Restate's inactivity
 * timeout). That holds for every promise but one. A handler with explicit
 * cancellation awaits its cancellation (`cancelled(ctx)`) to stop work it
 * does outside Restate, a model's request, say: it watches for it, and does
 * not wait for it. Suspended on the cancellation alone, the invocation would
 * end its attempt in the middle of that work, with a cancellation as the only
 * thing to resume it. So the loop asks for the cancellation alone only while
 * the input is open, which is when a cancel signal can come, and not once it
 * closed: see `awaited`.
 */
export class PromiseSelector {
  private readonly pending = new Set<Selectable>();
  private running = false;
  private closed = false;
  // Between a check that found nothing and the next external progress.
  private waiting = false;

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
   * What to ask the VM for: the first of the pending promises to complete.
   * Undefined when there is nothing to ask for: nothing is pending, or
   * only the invocation's cancellation, with the input closed. That one
   * stays pending, and is asked for again with whatever is awaited next,
   * which also finds a cancel signal that came as the input closed.
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
    if (futures.length === 0) return undefined;
    if (watching && this.driver.inputClosed()) return undefined;
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
        // A turn of the event loop, before every check. What was settled
        // runs, and registers what it awaits next, so that one check covers
        // that too (a combinator also flags itself completed in a .finally,
        // a tick late). And the SDK has said so if the input closed: it does
        // within microtasks of signalling the progress that woke this loop.
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
          if (failpoints.size > 0) await failpoints.get('wait')?.(future);
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
  coreVm: { do_progress(future: UnresolvedFuture): DoProgressResult };
  outputPump: { awaitNextProgress(): Promise<void> };
  externalProgressChannel: { awaitNext(): Promise<void>; signal(): void };
  runClosuresTracker: { executeRun(handle: number): void };
  errorCallback: (e: unknown) => void;
}

/** The SDK's input pump, as far as the hook needs it: `runDone` resolves when the input ends, or the attempt. */
interface InputPump {
  runDone: PromiseLike<unknown>;
}

const FIELDS = ['coreVm', 'outputPump', 'externalProgressChannel', 'runClosuresTracker', 'errorCallback'] as const;

/**
 * Drive every promise that the invocation of `ctx` (the SDK's context, not a
 * proxy of it) awaits from here on with one selector. The returned function
 * stops it, at the end of the attempt, and gives the invocation back its
 * own loops.
 */
export function hookSelector(ctx: object): () => void {
  const { promisesExecutor: executor, inputPump } = ctx as { promisesExecutor?: Executor; inputPump?: InputPump };
  const missing: string[] = executor ? FIELDS.filter((field) => executor[field] === undefined) : ['promisesExecutor'];
  if (typeof inputPump?.runDone?.then !== 'function') missing.push('inputPump.runDone');
  if (missing.length > 0 || typeof executor?.coreVm.do_progress !== 'function') {
    throw new Error(
      `@restatedev/sessions drives a handler's promises through the SDK's internals, which this SDK version does not have ` +
        `(${missing.join(', ') || 'coreVm.do_progress'}): use the @restatedev/restate-sdk that @restatedev/sessions pins`,
    );
  }
  const { coreVm, outputPump, externalProgressChannel, runClosuresTracker } = executor;
  let inputClosed = false;
  void (async () => {
    await inputPump!.runDone;
    inputClosed = true;
  })();
  const selector = new PromiseSelector({
    doProgress: (future) => coreVm.do_progress(future),
    flushOutput: () => outputPump.awaitNextProgress(),
    awaitExternalProgress: () => externalProgressChannel.awaitNext(),
    wake: () => externalProgressChannel.signal(),
    inputClosed: () => inputClosed,
    executeRun: (handle) => runClosuresTracker.executeRun(handle),
    onError: (e) => executor.errorCallback(e),
  });
  // An own property, over the class's method: removing it gives the method back.
  executor.doProgress = async (promise) => selector.register(promise);
  return () => {
    selector.close();
    delete (executor as Partial<Executor>).doProgress;
  };
}
