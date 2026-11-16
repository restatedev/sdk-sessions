// The VM of a session object's attempt: shared-core's explicit recovery state
// machine, through the addon (`native/src/vm.rs`).
//
// It never replays a journal: every attempt runs the handler from the start
// and recovers from the state the earlier attempts stored. An action returns
// a handle, and its result comes back as a notification of that handle
// (`takeNotification`), which the driver settles a promise with. There is no
// `do_progress` and no single await point, so a handler awaits what it likes,
// with its own combinators — which is what the selector had to fake.
//
// The VM is synchronous and does no I/O: every call only buffers output.
import { addon } from './addon.ts';

/** A header of the request, or of a call. */
export interface VmHeader {
  key: string;
  value: string;
}

/** A terminal failure: what a handler throws, and what a failed action completes with. */
export interface VmFailure {
  code: number;
  message: string;
  metadata: VmHeader[];
}

/** The response's head: written before the body. */
export interface VmResponseHead {
  statusCode: number;
  headers: VmHeader[];
}

/** The invocation's input, once the VM is ready to execute. */
export interface VmInput {
  invocationId: string;
  key: string;
  headers: VmHeader[];
  input: Buffer;
  scope?: string;
  limitKey?: string;
  idempotencyKey?: string;
}

/** The handles of a call: its invocation id, and its result. */
export interface VmCallHandle {
  invocationId: number;
  result: number;
}

/** A ready result: `kind` says which field holds it. */
export type VmNotification = { handle: number } & (
  | { kind: 'void' }
  | { kind: 'success'; bytes: Buffer }
  | { kind: 'failure'; failure: VmFailure }
  | { kind: 'stateKeys'; keys: string[] }
  | { kind: 'invocationId'; id: string }
);

/** Where the attempt is: `starting` until the input is in, then `running`, then `closed`. */
export type VmState = 'starting' | 'running' | 'closed';

/**
 * The attempt's state machine. A command returns a handle, notified later
 * through {@link Vm.takeNotification}; a fire-and-forget command with `ack`
 * is notified once Restate stores it, and at once without.
 */
export interface Vm {
  /**
   * What the VM calls, on this thread, after the addon acts on it from the
   * runtime's — the database's store reading or writing the object's state.
   * It is the driver's tick: it writes the output and settles what completed.
   */
  setScheduler(scheduler: () => void): void;

  getResponseHead(): VmResponseHead;

  notifyInput(buffer: Uint8Array): void;
  /** The runtime closed the input stream. While the handler runs, this shuts the attempt down. */
  notifyInputClosed(): void;
  /** The bytes buffered so far for the response body. */
  takeOutput(): Buffer;

  isReadyToExecute(): boolean;
  input(): VmInput;

  /**
   * The next ready result, in no particular order, or `null`. Throws once
   * the attempt is closed: {@link isShutDown} tells a shutdown from a failure.
   */
  takeNotification(): VmNotification | null;

  getState(key: string, name?: string): number;
  getStateKeys(name?: string): number;
  setState(key: string, buffer: Uint8Array, name?: string, ack?: boolean): number;
  clearState(key: string, name?: string, ack?: boolean): number;
  clearAllState(name?: string, ack?: boolean): number;

  call(
    service: string,
    handler: string,
    buffer: Uint8Array,
    key?: string,
    idempotencyKey?: string,
    headers?: VmHeader[],
    name?: string,
  ): VmCallHandle;
  /** Returns the handle of the invocation id. `delay` is in milliseconds. */
  send(
    service: string,
    handler: string,
    buffer: Uint8Array,
    key?: string,
    delay?: number,
    idempotencyKey?: string,
    headers?: VmHeader[],
    name?: string,
  ): number;
  attachInvocation(invocationId: string, name?: string): number;
  cancelInvocation(invocationId: string, name?: string, ack?: boolean): number;

  /** A trace, shown in Restate's UI as a run until it is ended. */
  startTrace(name: string, parent?: number): number;
  endTraceSuccess(trace: number, buffer: Uint8Array): void;
  endTraceFailure(trace: number, failure: VmFailure): void;

  /** Tells Restate the attempt makes progress, delaying its shutdown. */
  heartbeat(): void;
  /** Whether the invocation was cancelled, in this attempt or an earlier one. */
  isCancelled(): boolean;
  /**
   * Fail what the database's store waits for, as a cancelled invocation's
   * awaits fail: its reads and acks live in the addon, so the driver cannot
   * reject them itself.
   */
  cancelStateWaits(): void;
  /** The same, for an attempt that is over: nothing will answer them. */
  endStateWaits(): void;
  /**
   * Let go of the scheduler. It holds the driver's tick, and so the driver and
   * this VM: an attempt that kept it would never be freed.
   */
  clearScheduler(): void;
  state(): VmState;

  endSuccess(buffer: Uint8Array): void;
  endFailure(failure: VmFailure): void;
  /** Fails the attempt, for example with a retryable error of the handler. */
  notifyError(message: string, stacktrace?: string, delayOverrideMs?: number): void;
}

interface VmConstructor {
  /**
   * `bidirectional` is false on a request/response transport (AWS Lambda,
   * HTTP/1.1), which cannot serve such a handler: no response could reach
   * it. The VM then fails the invocation at once, which pauses it.
   */
  new (headers: VmHeader[], bidirectional: boolean): Vm;
}

export const Vm = (addon as { Vm: VmConstructor }).Vm;

/**
 * What the database's store's waits fail with, as the addon's errors carry it:
 * the text crosses the boundary, the class does not (`native/src/vm.rs`).
 */
export const STATE_WAIT_CANCELLED = 'restate-sessions: the invocation was cancelled';
export const STATE_WAIT_OVER = 'restate-sessions: the attempt is over';

/** The message of the error a closed attempt throws when Restate shut it down. */
const SHUT_DOWN = 'ATTEMPT_SHUT_DOWN';

/**
 * Whether `error` says the attempt was shut down (Restate closed the input),
 * rather than failed. A new attempt runs the handler from the start.
 */
export const isShutDown = (error: unknown): boolean => error instanceof Error && error.message.startsWith(SHUT_DOWN);
