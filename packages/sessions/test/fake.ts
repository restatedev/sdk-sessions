// The core's fake Restate runtime of the explicit recovery protocol
// (`explicit_recovery::fake_runtime`), as the addon binds it for the tests
// (`native/src/fake_runtime.rs`, the feature `fake_runtime`, which `pnpm
// build` turns on). One invocation over as many attempts as it takes: it
// applies what the SDK sends, answers, decides between restart and suspend,
// and checks everything against the protocol: a violation throws
// `FAKE_VIOLATION …` and is kept in `violations()`.
import { addon } from '../src/addon.ts';
import type { VmFailure, VmHeader } from '../src/vm.ts';

/** A value: `bytes` (a success), `failure`, or neither (void). */
export interface FakeValue {
  bytes?: Uint8Array;
  failure?: VmFailure;
}

/** A value as the fake reports it. */
export interface FakeValueOut {
  kind: 'void' | 'success' | 'failure';
  bytes?: Buffer;
  failure?: VmFailure;
}

/** The invocation the fake runs; every field has a default. */
export interface FakeInvocation {
  invocationId?: string;
  service?: string;
  handler?: string;
  key?: string;
  /** A target without a key, which has no object state. */
  keyless?: boolean;
  shared?: boolean;
  input?: Uint8Array;
  headers?: VmHeader[];
  idempotencyKey?: string;
  /** `"all"` (the default), `"lazy"`, or the keys to preload. */
  objectPreload?: 'all' | 'lazy' | string[];
  invocationPreload?: 'all' | 'lazy' | string[];
  firstNextResultId?: number;
  maxConsecutiveFailures?: number;
  maxIdleRestarts?: number;
  features?: number[];
}

/** How an attempt ended, as the runtime saw it. */
export interface FakeOutcome {
  kind: 'completed' | 'failed_invocation' | 'paused' | 'failed' | 'restarted' | 'lost' | 'suspended';
  code?: number;
  reason?: string;
  rule?: number;
}

/** An invocation a `Call` made, sends included. */
export interface FakeCall {
  invocationId: string;
  service: string;
  handler: string;
  key: string;
  idempotencyKey?: string;
  parameter: Buffer;
  /** Milliseconds since the UNIX epoch; 0 for as soon as possible. */
  invokeTime: number;
  attempt: number;
  output?: FakeValueOut;
}

export interface FakeRuntime {
  contentType(): string;
  setObjectState(key: string, value: Uint8Array): void;
  clearObjectState(key: string): void;
  setInvocationState(key: string, value: Uint8Array): void;
  scriptCallee(
    service: string,
    handler: string,
    behavior: 'pending' | 'returns' | 'not_found',
    value?: FakeValue,
  ): void;
  status(): { status: 'ready' | 'running' | 'suspended' | 'paused' | 'completed'; output?: FakeValueOut };
  objectState(): { key: string; value: Buffer }[];
  invocationState(): { key: string; value: Buffer }[];
  outcomes(): FakeOutcome[];
  attemptNumber(): number;
  nextResultId(): number;
  calls(): FakeCall[];
  signalsSent(): { targetInvocationId: string; name: string; value: FakeValueOut }[];
  cancelsSent(): string[];
  violations(): string[];
  lastRetryDelay(): number | null;
  isClosed(): boolean;
  isAttemptRunning(): boolean;
  startAttempt(): Buffer;
  receive(bytes: Uint8Array): void;
  takeOutput(): Buffer;
  setAutoApply(autoApply: boolean): void;
  applyPending(max: number): number;
  shutDown(reason: 'inactivity' | 'own'): void;
  shutdownAnswerTimedOut(): void;
  sdkClosed(): void;
  breakStream(): void;
  loseAttempt(): void;
  completeCall(invocationId: string, output?: FakeValue): void;
  sendSignal(name: string, value?: FakeValue): void;
  cancel(): void;
  resume(): void;
}

interface FakeRuntimeConstructor {
  new (invocation?: FakeInvocation): FakeRuntime;
  /**
   * An invocation id in Restate's format, the `n`-th the fake mints: 0 is the
   * invocation's own by default, its calls' are 1, 2, … One above those is an
   * invocation the fake does not run (a signal's target, say).
   */
  invocationId(n: number): string;
  /** The headers of the request that opens an attempt. */
  requestHeaders(): VmHeader[];
}

const bound = (addon as { FakeRuntime?: FakeRuntimeConstructor }).FakeRuntime;
if (bound === undefined) {
  throw new Error('this addon has no FakeRuntime: build it for the tests, with `pnpm build` (feature fake_runtime)');
}

export const FakeRuntime: FakeRuntimeConstructor = bound;
