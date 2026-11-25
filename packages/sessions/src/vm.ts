// The VM of a session object's attempt, on the explicit recovery protocol
// (version 1): shared-core's state machine, through the addon
// (`native/src/vm.rs`).
//
// It has no journal: every attempt runs the handler from the start and
// recovers from the state the earlier attempts stored. An action returns a
// handle, and its result comes back as a notification of that handle
// (`takeNotification`), which the driver settles a promise with, in its tick:
// the only place notifications are taken, since taking one is processing it
// (it counts in the `ShutdownMessage` of a shut-down attempt). There is no
// single await point, so a handler awaits what it likes, with its own
// combinators.
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
  /** The number of this attempt: 1 for the first. */
  attempt: number;
}

/** The handles of a call: its invocation id, and its result. */
export interface VmCallHandle {
  invocationId: number;
  result: number;
}

/** The target of a call or a send. */
export interface VmTarget {
  service: string;
  handler: string;
  key?: string;
  idempotencyKey?: string;
  headers?: VmHeader[];
}

/** Whose state a state action is on: the object's, or the invocation's own. */
export type VmScope = 'object' | 'invocation';

/**
 * How an action appears in Restate's record of the attempt (its UI): its
 * name, the span it is inside of, and how much of it is recorded. None of it
 * changes what the action does.
 */
export interface VmActionOptions {
  name?: string;
  parentSpan?: number;
  record?: 'default' | 'none' | 'summary' | 'full';
}

/** A send that commits with a transaction, inside its commit's atomic group. */
export interface VmGroupSend {
  target: VmTarget;
  input: Uint8Array;
  /** In milliseconds. */
  delay?: number;
  name?: string;
}

/** What a commit on the VM commits with beside its writes. */
export interface VmCommit {
  sends: VmGroupSend[];
  /** The span the commit's group is inside of. */
  parentSpan?: number;
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
 * The attempt's state machine. An action returns a handle, notified later
 * through {@link Vm.takeNotification}; one whose result is optional returns
 * `null` unless asked for it (`wantResult`).
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
  /** Whether to close the response now: the last message is written, and the runtime closed its side. */
  shouldCloseOutput(): boolean;

  isReadyToExecute(): boolean;
  isFeatureSupported(feature: number): boolean;
  input(): VmInput;

  /**
   * The next ready notification, in arrival order, or `null`: only the
   * driver's tick calls it. Handle {@link Vm.cancelHandle} is the cancel
   * signal. Throws once the attempt is closed: {@link isShutDown} tells a
   * shutdown from a failure.
   */
  takeNotification(): VmNotification | null;
  /** The reserved handle of the cancel signal (1). */
  cancelHandle(): number;
  /** The handles of an aborted atomic group's actions: never notified. */
  takeAborted(): number[];

  getState(scope: VmScope, key: string, options?: VmActionOptions): number;
  getStateKeys(scope: VmScope, options?: VmActionOptions): number;
  setState(
    scope: VmScope,
    key: string,
    buffer: Uint8Array,
    wantResult?: boolean,
    options?: VmActionOptions,
  ): number | null;
  clearState(scope: VmScope, key: string, wantResult?: boolean, options?: VmActionOptions): number | null;
  clearAllState(scope: VmScope, wantResult?: boolean, options?: VmActionOptions): number | null;

  /** `delay` is in milliseconds. */
  call(target: VmTarget, buffer: Uint8Array, delay?: number, options?: VmActionOptions): VmCallHandle;
  /** Returns the handle of the invocation id. `delay` is in milliseconds. */
  send(target: VmTarget, buffer: Uint8Array, delay?: number, options?: VmActionOptions): number;
  attachInvocation(invocationId: string, options?: VmActionOptions): number;
  cancelInvocation(invocationId: string, wantResult?: boolean, options?: VmActionOptions): number | null;

  /** The signal `index` (from 0) of `signalName` this invocation received. */
  signalRead(signalName: string, index: number, options?: VmActionOptions): number;
  /** A signal to another invocation, carrying `bytes`, `failure`, or nothing. */
  signalSend(
    targetInvocationId: string,
    signalName: string,
    bytes?: Uint8Array | null,
    failure?: VmFailure | null,
    wantResult?: boolean,
    options?: VmActionOptions,
  ): number | null;

  /** Notified once every action made before it is applied. */
  flush(options?: VmActionOptions): number;
  atomicGroupStart(): void;
  atomicGroupEnd(wantResult?: boolean, options?: VmActionOptions): number | null;
  atomicGroupAbort(): number[];

  /** A span, shown in Restate's UI; inside `parent`, or the attempt itself. */
  spanStart(name: string, parent?: number): number;
  /** End `span` with `bytes`, with `failure`, or with nothing. */
  spanEnd(span: number, bytes?: Uint8Array | null, failure?: VmFailure | null): void;

  /** Tells Restate the attempt makes progress, delaying its shutdown. */
  heartbeat(): void;
  /** Whether the invocation was cancelled: before this attempt, or by the cancel signal a tick took. */
  isCancelled(): boolean;
  /** The SDK ends the attempt on its own (the process is going away): an unasked `ShutdownMessage`. */
  shutdown(): void;
  /**
   * Fail what the database's store waits for, once the attempt is over and
   * nothing will answer: its reads and commits wait in the addon, so the
   * driver cannot reject them itself.
   */
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
   * Throws for a request of another protocol family or version: see
   * {@link refusedStatus} for the status to answer it with (415).
   */
  new (headers: VmHeader[]): Vm;
}

export const Vm = (addon as { Vm: VmConstructor }).Vm;

/** The range of versions of the explicit recovery protocol the VM speaks, for discovery. */
export const explicitRecoveryProtocolRange = (): { minVersion: number; maxVersion: number } =>
  (
    addon as { explicitRecoveryProtocolRange: () => { minVersion: number; maxVersion: number } }
  ).explicitRecoveryProtocolRange();

/**
 * The HTTP status to answer a request with whose VM could not be made: 415
 * for a content type of another protocol family or version. `undefined` if
 * `error` is not such a refusal.
 */
export function refusedStatus(error: unknown): number | undefined {
  const message = (error as { message?: unknown }).message;
  if (typeof message !== 'string') return undefined;
  const match = /^VM_REFUSED (\d+):/.exec(message);
  return match === null ? undefined : Number(match[1]);
}

/**
 * The VM's refusal of a value user code passed to an action, which Restate
 * would refuse as malformed (an invocation id that is not one, say): its code
 * (400) and why. The VM sent nothing, and the attempt goes on: the driver
 * fails that action alone, with a `TerminalError`. `undefined` if `error` is
 * not such a refusal.
 */
export function invalidInput(error: unknown): { code: number; message: string } | undefined {
  const message = (error as { message?: unknown } | undefined)?.message;
  if (typeof message !== 'string') return undefined;
  // Anywhere in the text: a commit's send crosses the SQL engine, which may wrap it.
  const match = /INVALID_INPUT (\d+): ([\s\S]*)$/.exec(message);
  return match === null ? undefined : { code: Number(match[1]), message: match[2] ?? '' };
}

/**
 * Restate's signature on a request, as the SDK verifies it before dispatch.
 * This package serves a session object's invocations and its discovery ahead
 * of that handler, so it verifies the signature itself.
 */
export interface Identity {
  /**
   * `null` if the headers carry a signature of `path` by one of the keys, and
   * why not otherwise. It is `null` and not `undefined`: the addon answers
   * `None`, which is how that crosses the boundary.
   */
  verify(path: string, headers: VmHeader[]): string | null;
}

interface IdentityConstructor {
  /** The v1 public keys a deployment accepts (`publickeyv1_…`). */
  new (keys: string[]): Identity;
}

export const Identity = (addon as { Identity: IdentityConstructor }).Identity;

/**
 * What the database's store's waits fail with once the attempt is over, as
 * the addon's errors carry it: the text crosses the boundary, the class does
 * not (`native/src/vm.rs`).
 */
export const STATE_WAIT_OVER = 'restate-sessions: the attempt is over';

/** The message of the error a closed attempt throws when Restate shut it down. */
const SHUT_DOWN = 'ATTEMPT_SHUT_DOWN';

/**
 * Whether `error` says the attempt was shut down (Restate closed the input,
 * or the process is going away), rather than failed. A new attempt runs the
 * handler from the start.
 */
export const isShutDown = (error: unknown): boolean => error instanceof Error && error.message.startsWith(SHUT_DOWN);
