// One attempt of a session object's handler, on the explicit recovery VM
// (`vm.ts`, `native/src/vm.rs`).
//
// The VM never replays a journal: every attempt runs the handler from the
// start, and recovers from the state the earlier attempts stored. An action
// returns a handle, and its result comes back as a notification of that
// handle, which settles the action's promise here. Two things move the attempt
// along:
//
//   - the input pump, the only reader of the request body: it hands the VM
//     each chunk, and the end of the body;
//   - the tick, scheduled after every call into the VM, at most one per turn
//     of the event loop: it writes the VM's output, settles the promises of
//     the actions that completed, and notices the end of the attempt.
//
// Scheduling a tick after every call batches the output of the actions issued
// in the same turn, and flushes it before the event loop can wait on anything.
//
// Restate shuts an attempt down by closing the request body (its inactivity
// timeout). From then on the attempt is over: every action throws, the
// promises still pending reject, and a new attempt runs the handler from the
// start. Work that may outlast the timeout keeps the attempt alive with
// `heartbeat`.
import type * as restate from '@restatedev/restate-sdk';
import { isShutDown, type Vm, type VmFailure, type VmNotification } from './vm.ts';

/** The state key a sync clears with an ack, under the prefix tooling hides. */
const SYNC_KEY = 'v22/sync';

/** The key the keys listing is named with, under the prefix tooling hides. */
const KEYS_NAME = 'v22/keys';

/**
 * Restate shut the attempt down: it is over, and a new attempt runs the
 * handler from the start. The SDK's own suspension error is not reused: this
 * one never leaves @restatedev/sessions.
 */
export class AttemptShutDown extends Error {
  constructor() {
    super('Restate shut the attempt down; a new attempt will run the handler from the start');
    this.name = 'AttemptShutDown';
  }
}

/** The attempt failed, and Restate retries it. */
export class AttemptFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttemptFailed';
  }
}

/** A terminal failure of an action, as a handler sees it. */
function terminal(failure: VmFailure): Error {
  const error = new Error(failure.message) as Error & { code: number };
  error.name = 'TerminalError';
  error.code = failure.code;
  return error;
}

/** What a notification settles its promise with. */
function settled(notification: VmNotification): { value: unknown } | { error: Error } {
  switch (notification.kind) {
    case 'void':
      return { value: undefined };
    case 'success':
      return { value: notification.bytes };
    case 'failure':
      return { error: terminal(notification.failure) };
    case 'stateKeys':
      return { value: notification.keys };
    case 'invocationId':
      return { value: notification.id };
    default:
      // A kind this version does not know: treat it as no value rather than
      // leaving the action's promise pending forever.
      return { value: undefined };
  }
}

/**
 * Keep an unawaited rejection from reaching the process: the attempt's end
 * rejects every promise still waiting, and a handler that stopped awaiting one
 * (a race it lost, say) would otherwise crash the process. Attaching a handler
 * marks the promise handled; the caller still sees the rejection.
 */
function quiet<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  return promise;
}

/** A promise waiting for the notification of a handle. */
interface Waiting {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * Drives one attempt over its VM: the input pump, the tick, and the promises
 * of the actions it issued.
 */
export class Attempt {
  /** Set once the attempt is over, to what ended it. */
  private ended: Error | undefined;
  private readonly waiting = new Map<number, Waiting>();
  private readonly onEnd = new Set<() => void>();
  private queued = false;
  /** The invocation ids of the calls this attempt made, for `cancelPreviousCalls`. */
  private readonly called = new Set<string>();
  private cancelledResolve: (() => void) | undefined;
  private readonly cancelledPromise: Promise<void>;
  private heartbeats: NodeJS.Timeout | undefined;

  private readonly vm: Vm;
  private readonly write: (chunk: Uint8Array) => void;

  constructor(vm: Vm, write: (chunk: Uint8Array) => void) {
    this.vm = vm;
    this.write = write;
    this.cancelledPromise = new Promise<void>((resolve) => {
      this.cancelledResolve = resolve;
    });
  }

  // --- Input and output

  /** A chunk of the request body. */
  notifyInput(chunk: Uint8Array): void {
    this.vm.notifyInput(chunk);
    this.schedule();
  }

  /** The end of the request body: while the handler runs, Restate shut the attempt down. */
  notifyInputClosed(): void {
    this.vm.notifyInputClosed();
    this.schedule();
  }

  isReadyToExecute(): boolean {
    return this.vm.isReadyToExecute();
  }

  /** Schedule a tick, once per turn of the event loop. */
  private schedule(): void {
    if (this.queued || this.ended !== undefined) {
      // A closed attempt still flushes what it last wrote (an error, an end).
      if (this.queued) return;
      this.queued = true;
      queueMicrotask(() => this.flush());
      return;
    }
    this.queued = true;
    queueMicrotask(() => this.tick());
  }

  /** Write what the VM has buffered. */
  private flush(): void {
    this.queued = false;
    const output = this.vm.takeOutput();
    if (output.length > 0) this.write(output);
  }

  /**
   * Write the VM's output, settle the promises of the actions that completed,
   * and notice the end of the attempt.
   */
  private tick(): void {
    this.queued = false;
    const output = this.vm.takeOutput();
    if (output.length > 0) this.write(output);
    if (this.ended !== undefined) return;
    let notification: VmNotification | null;
    try {
      while ((notification = this.vm.takeNotification()) !== null) {
        const waiting = this.waiting.get(notification.handle);
        // A handle this attempt did not issue, or already settled: nothing waits for it.
        if (waiting === undefined) continue;
        this.waiting.delete(notification.handle);
        const result = settled(notification);
        if ('error' in result) waiting.reject(result.error);
        else waiting.resolve(result.value);
      }
    } catch (error) {
      this.end(isShutDown(error) ? new AttemptShutDown() : new AttemptFailed(String(error)));
      return;
    }
    // The VM says whether a cancellation arrived, in this attempt or an
    // earlier one; it has no notification of its own.
    if (this.vm.isCancelled()) this.cancelledResolve?.();
    if (this.vm.state() === 'closed') this.end(new AttemptShutDown());
  }

  /** The attempt ended: fail what still waits, and tell the listeners. */
  private end(reason: Error): void {
    if (this.ended !== undefined) return;
    this.ended = reason;
    const waiting = [...this.waiting.values()];
    this.waiting.clear();
    for (const one of waiting) one.reject(reason);
    if (this.heartbeats !== undefined) clearInterval(this.heartbeats);
    const listeners = [...this.onEnd];
    this.onEnd.clear();
    for (const listener of listeners) listener();
  }

  /** Whether the attempt is over, and with what. */
  get over(): Error | undefined {
    return this.ended;
  }

  /** Call `listener` when the attempt ends; the returned function unregisters it. */
  whenEnded(listener: () => void): () => void {
    if (this.ended !== undefined) {
      listener();
      return () => {};
    }
    this.onEnd.add(listener);
    return () => this.onEnd.delete(listener);
  }

  // --- Actions

  /** Call the VM with `act`, then schedule a tick. The attempt's end throws. */
  private act<T>(act: (vm: Vm) => T): T {
    if (this.ended !== undefined) throw this.ended;
    try {
      return act(this.vm);
    } catch (error) {
      if (isShutDown(error)) {
        this.end(new AttemptShutDown());
        throw this.ended;
      }
      throw error;
    } finally {
      this.schedule();
    }
  }

  /** The promise the notification of `handle` settles. */
  private promise(handle: number): Promise<unknown> {
    if (this.ended !== undefined) return quiet(Promise.reject(this.ended));
    return quiet(
      new Promise<unknown>((resolve, reject) => {
        this.waiting.set(handle, { resolve, reject });
      }),
    );
  }

  /** An action and the promise of its result, in one. */
  private issue(act: (vm: Vm) => number): Promise<unknown> {
    let handle: number;
    try {
      handle = this.act(act);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return this.promise(handle);
  }

  // --- State, as the database's store uses it

  getState(key: string, name?: string): Promise<Uint8Array | null> {
    return quiet(
      this.issue((vm) => vm.getState(key, name)).then((value) => (value === undefined ? null : (value as Uint8Array))),
    );
  }

  setState(key: string, value: Uint8Array, name?: string): void {
    // Notified at once: nothing waits for it.
    this.act((vm) => vm.setState(key, value, name, false));
  }

  clearState(key: string, name?: string): void {
    this.act((vm) => vm.clearState(key, name, false));
  }

  stateKeys(): Promise<string[]> {
    return quiet(this.issue((vm) => vm.getStateKeys(KEYS_NAME)).then((keys) => (keys ?? []) as string[]));
  }

  /**
   * Every write issued before this is stored once it resolves: a write of its
   * own that asks Restate to ack it, which it does only after the writes
   * before it. This is what the empty `sync` run was.
   */
  sync(): Promise<void> {
    return quiet(this.issue((vm) => vm.clearState(SYNC_KEY, SYNC_KEY, true)).then(() => undefined));
  }

  // --- Calls

  /** A call: the promise of its result, and of its invocation id. */
  call(target: {
    service: string;
    handler: string;
    key?: string;
    input: Uint8Array;
    idempotencyKey?: string;
    headers?: { key: string; value: string }[];
    name?: string;
  }): { result: Promise<Uint8Array | null>; invocationId: Promise<string> } {
    let handles: { invocationId: number; result: number };
    try {
      handles = this.act((vm) =>
        vm.call(
          target.service,
          target.handler,
          target.input,
          target.key,
          target.idempotencyKey,
          target.headers,
          target.name,
        ),
      );
    } catch (error) {
      const rejected = Promise.reject(error instanceof Error ? error : new Error(String(error)));
      rejected.catch(() => {});
      return { result: rejected, invocationId: rejected };
    }
    const invocationId = quiet(
      this.promise(handles.invocationId).then((id) => {
        this.called.add(String(id));
        return String(id);
      }),
    );
    const result = quiet(
      this.promise(handles.result).then((value) => (value === undefined ? null : (value as Uint8Array))),
    );
    return { result, invocationId };
  }

  /** A send: the promise of the invocation id it was given. */
  send(target: {
    service: string;
    handler: string;
    key?: string;
    input: Uint8Array;
    delay?: number;
    idempotencyKey?: string;
    headers?: { key: string; value: string }[];
    name?: string;
  }): Promise<string> {
    const handle = this.issue((vm) =>
      vm.send(
        target.service,
        target.handler,
        target.input,
        target.key,
        target.delay,
        target.idempotencyKey,
        target.headers,
        target.name,
      ),
    );
    return quiet(handle.then((id) => String(id)));
  }

  /** The result of an invocation, once it ends. */
  attach(invocationId: string, name?: string): Promise<Uint8Array | null> {
    return quiet(
      this.issue((vm) => vm.attachInvocation(invocationId, name)).then((value) =>
        value === undefined ? null : (value as Uint8Array),
      ),
    );
  }

  cancel(invocationId: string, name?: string): void {
    this.act((vm) => vm.cancelInvocation(invocationId, name, false));
  }

  /** Cancel the invocations this attempt called, as a cancelled invocation's would be. */
  cancelCalls(): string[] {
    const ids = [...this.called];
    for (const id of ids) this.cancel(id);
    return ids;
  }

  /** Resolves once a cancellation arrived, in this attempt or an earlier one. */
  cancelled(): Promise<void> {
    if (this.vm.isCancelled()) this.cancelledResolve?.();
    return this.cancelledPromise;
  }

  isCancelled(): boolean {
    return this.vm.isCancelled();
  }

  // --- Traces, shown in Restate's UI as runs

  startTrace(name: string, parent?: number): number {
    return this.act((vm) => vm.startTrace(name, parent));
  }

  endTrace(trace: number, output: Uint8Array): void {
    this.act((vm) => vm.endTraceSuccess(trace, output));
  }

  // --- Keeping the attempt alive

  /**
   * Tell Restate the attempt makes progress every `everyMs`, until it ends:
   * work outside Restate that may outlast its inactivity timeout.
   */
  heartbeatEvery(everyMs: number): void {
    if (this.heartbeats !== undefined || this.ended !== undefined) return;
    this.heartbeats = setInterval(() => {
      if (this.ended !== undefined) return;
      try {
        this.act((vm) => vm.heartbeat());
      } catch {
        // The attempt ended: the tick notices.
      }
    }, everyMs);
    this.heartbeats.unref?.();
  }

  // --- The input, and the end

  input(): restate.Request & { key: string } {
    const input = this.vm.input();
    const headers = new Map(input.headers.map(({ key, value }) => [key, value]));
    return {
      id: input.invocationId,
      key: input.key,
      headers,
      attemptHeaders: headers,
      body: input.input,
      extraArgs: [],
      idempotencyKey: input.idempotencyKey,
      target: undefined as never,
      attemptCompletedSignal: undefined as never,
    } as unknown as restate.Request & { key: string };
  }

  /** The handler ended with its output. */
  endSuccess(output: Uint8Array): void {
    this.act((vm) => vm.endSuccess(output));
  }

  /** The handler ended with a terminal failure. */
  endFailure(failure: VmFailure): void {
    this.act((vm) => vm.endFailure(failure));
  }

  /** The attempt failed, and Restate retries it. */
  fail(message: string, stacktrace?: string): void {
    if (this.ended !== undefined) return;
    this.vm.notifyError(message, stacktrace);
    this.schedule();
  }
}
