// Restate's side of a session object's invocation, played by the core's fake
// runtime of the explicit recovery protocol (`fake.ts`): it holds the
// object's state, applies the attempt's actions, answers its reads, commits
// and calls, and can cancel the invocation or shut the attempt down at a
// moment a test chooses. It also checks everything the attempt sends against
// the protocol: `settle` fails on any violation it found. Shared by the tests
// that serve a handler with `serveSession` (`handler.test.ts`,
// `saga.test.ts`, `transaction-cancel.test.ts`, `protocol.test.ts`).
import { CancelledError } from '@restatedev/restate-sdk';
import { serveSession, type Stream } from '../src/handler.ts';
import { HEAD_KEY } from '../src/object.ts';
import { FakeRuntime, type FakeOutcome } from './fake.ts';
import { ACTION, decode as decodeFields, members, messages, num, str, TYPE, type Message } from './wire.ts';

export { TYPE } from './wire.ts';

export const text = (b: Uint8Array | undefined) => (b === undefined ? undefined : Buffer.from(b).toString());

/** A call or a send the attempt made, as it went on the wire. */
export interface Made {
  service: string;
  handler: string;
  key: string;
  idempotencyKey: string | undefined;
  /** The input, as the text of its bytes. */
  input: string;
  /** Inside the commit's atomic group (a transaction's send). */
  inGroup: boolean;
  /** The invocation id Restate gave it. */
  id?: string;
}

/**
 * What the attempt asked Restate for, which Restate answers: a state read
 * (of its key), a commit (an atomic group whose result it wants), a flush, or
 * a call's result.
 */
export type Ask = `read ${string}` | 'commit' | 'flush' | 'keys' | `call ${string}` | `signal ${string}`;

export interface SideOptions {
  /**
   * Restate cancels the invocation once, instead of nothing, as it receives
   * the attempt's first commit (`true`) or its N-th (a number, from 1), and
   * applies the commit only once the attempt has taken the signal in.
   */
  cancelOnCommit?: boolean | number;
  /**
   * A retry of a cancelled invocation: an attempt was lost, then the
   * invocation was cancelled, and this attempt starts knowing it
   * (`StartMessage.cancelled`).
   */
  cancelAtStart?: boolean;
  /**
   * Restate cancels the invocation just before it answers the N-th thing the
   * attempt asks for (from 1; see {@link Ask}), and answers it only once the
   * attempt has taken the signal in.
   */
  cancelBeforeAnswer?: number;
  /**
   * From the N-th thing the attempt asks for (from 1), Restate applies and
   * answers nothing more: a test shuts the attempt down meanwhile.
   */
  withholdAnswer?: number;
  /**
   * Start the invocation with only the database's head preloaded, as
   * production does, so that the attempt reads every other key from Restate.
   */
  lazy?: boolean;
  /** Calls to these targets (`Service/handler`) get their id, and their result only once {@link release}d. */
  hold?: string[];
  /** Calls to these targets (`Service/handler`) fail with this terminal failure. */
  fail?: Record<string, { code: number; message: string }>;
  /** The fake runtime gives every call an invocation id of its own: kept for the tests that ask for it. */
  idPerCall?: boolean;
  /** The violations of the protocol the test expects: `settle` fails on any other. */
  allowViolations?: boolean;
  /**
   * The invocation's runtime, for a later attempt of it: `start` then starts
   * that runtime's next attempt (its key and input are the invocation's).
   */
  runtime?: FakeRuntime;
}

/** Let the event loop run for `ms`, so the attempt takes in what it was sent. */
export const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether an action message wants its result: it has a result id. */
const wantsResult = (message: Message) => num(message, ACTION.resultId) !== 0;

/** A call or send of `message`, as {@link Made} has it. */
function made(message: Message, inGroup: boolean): Made {
  const parameter = message.fields.get(4)?.[0] as Uint8Array | undefined;
  const content = parameter === undefined ? undefined : decodeValue(parameter);
  return {
    service: str(message, 1)!,
    handler: str(message, 2)!,
    key: str(message, 3) ?? '',
    idempotencyKey: str(message, 6),
    input: text(content) ?? '',
    inGroup,
  };
}

/** The content of a `Value` message (field 1). */
function decodeValue(value: Uint8Array): Uint8Array {
  return (decodeFields(value).get(1)?.[0] as Uint8Array | undefined) ?? new Uint8Array();
}

/** What `message` asks Restate for, if anything. */
function askOf(message: Message): Ask | undefined {
  switch (message.type) {
    case TYPE.getState:
      return `read ${str(message, 2)}`;
    case TYPE.getStateKeys:
      return 'keys';
    case TYPE.atomicGroup:
      return wantsResult(message) ? 'commit' : undefined;
    case TYPE.flush:
      return 'flush';
    case TYPE.call:
      return wantsResult(message) ? `call ${str(message, 1)}/${str(message, 2)}` : undefined;
    case TYPE.readSignal:
      return `signal ${str(message, 1)}`;
    default:
      return undefined;
  }
}

/**
 * Restate's side: it holds the object's state, applies the attempt's actions
 * and answers them, as the fake runtime does.
 */
export function restateSide(state = new Map<string, Uint8Array>(), options: SideOptions = {}) {
  const { cancelOnCommit = false, cancelAtStart = false, cancelBeforeAnswer, lazy = false } = options;
  const holding = new Set(options.hold ?? []);
  let rt: FakeRuntime | undefined = options.runtime;

  // The request body, as the attempt reads it.
  const inbound: Uint8Array[] = [];
  let resolveChunk: (() => void) | undefined;
  let bodyClosed = false;
  const toSdk = {
    push(chunk: Uint8Array) {
      if (chunk.length === 0 || bodyClosed) return;
      inbound.push(chunk);
      resolveChunk?.();
      resolveChunk = undefined;
    },
    close() {
      bodyClosed = true;
      resolveChunk?.();
      resolveChunk = undefined;
    },
  };
  const body: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (inbound.length > 0) yield inbound.shift()!;
        if (bodyClosed) return;
        await new Promise<void>((resolve) => (resolveChunk = resolve));
      }
    },
  };

  let head: { status: number; headers: Record<string, string> } | undefined;
  let ended = false;
  /** What the attempt wrote and the fake has not received yet. */
  let unread: Buffer = Buffer.alloc(0);
  /** Everything the attempt wrote, as messages. */
  const sentMessages: Message[] = [];
  /** Whether the one cancel signal has been sent. */
  let signalled = false;
  let commitsSeen = 0;
  const asks: Ask[] = [];
  const calls: Made[] = [];
  const sends: Made[] = [];
  /** The answers withheld, by target, oldest first: the invocation ids. */
  const held = new Map<string, string[]>();
  /** The calls already answered or held, by invocation id: an earlier attempt's are its side's. */
  const handled = new Set<string>(rt?.calls().map((c) => c.invocationId) ?? []);
  /** How many of the attempt's messages were out when the signal went in. */
  let signalledAt: number | undefined;
  /** Serializes {@link exchange}. */
  let exchanging: Promise<void> = Promise.resolve();

  const runtime = () => {
    if (rt === undefined) throw new Error('start the invocation first');
    return rt;
  };
  /** This side's attempt of the invocation, once started. */
  let mine: number | undefined;
  /**
   * Whether this side's attempt is the runtime's latest: an earlier side of
   * the same invocation must not take a later attempt's output, nor close it.
   */
  const current = () => rt !== undefined && mine !== undefined && rt.attemptNumber() === mine;

  /** Hand the attempt what the runtime wrote, and close its body once the runtime closed its side. */
  const deliver = () => {
    if (!current()) return;
    const out = runtime().takeOutput();
    toSdk.push(out);
    if (runtime().isClosed()) toSdk.close();
  };

  /** Mirror the fake's object state into `state`. */
  const mirror = () => {
    if (rt === undefined) return;
    state.clear();
    for (const { key, value } of rt.objectState()) state.set(key, new Uint8Array(value));
  };

  const cancelNow = () => {
    signalled = true;
    signalledAt = sentMessages.length;
    runtime().cancel();
    deliver();
  };

  /** Give the calls and sends made the invocation ids Restate gave them. */
  const fillIds = () => {
    const records = runtime().calls();
    const taken = new Set([...calls, ...sends].flatMap((m) => (m.id === undefined ? [] : [m.id])));
    for (const m of [...calls, ...sends]) {
      if (m.id !== undefined) continue;
      const same = (c: (typeof records)[number]) =>
        c.service === m.service && c.handler === m.handler && c.key === m.key;
      const record =
        records.find((c) => same(c) && !taken.has(c.invocationId) && text(c.parameter) === m.input) ??
        // A call made again with its idempotency key reaches the same invocation.
        (m.idempotencyKey === undefined
          ? undefined
          : records.find((c) => same(c) && c.idempotencyKey === m.idempotencyKey));
      if (record === undefined) continue;
      m.id = record.invocationId;
      taken.add(record.invocationId);
    }
  };

  /** Answer the calls made and not answered: echo their input, or fail, unless held. */
  const answerCalls = () => {
    fillIds();
    for (const call of runtime().calls()) {
      if (handled.has(call.invocationId) || call.output !== undefined) continue;
      handled.add(call.invocationId);
      const target = `${call.service}/${call.handler}`;
      // A call to key `k` is never answered: that is what a `start()`ed
      // call, whose result nobody holds, looks like to the handler.
      if (call.key === 'k') continue;
      if (holding.has(target)) {
        held.set(target, [...(held.get(target) ?? []), call.invocationId]);
        continue;
      }
      const failure = options.fail?.[target];
      runtime().completeCall(
        call.invocationId,
        failure === undefined
          ? { bytes: call.parameter }
          : { failure: { code: failure.code, message: failure.message, metadata: [] } },
      );
    }
  };

  /** Hand the fake one message of the attempt's, as the options say. */
  const receive = async (message: Message, bytes: Uint8Array) => {
    sentMessages.push(message);
    if (message.type === TYPE.call) (wantsResult(message) ? calls : sends).push(made(message, false));
    if (message.type === TYPE.atomicGroup) {
      for (const member of members(message)) if (member.type === TYPE.call) sends.push(made(member, true));
    }
    const ask = askOf(message);
    if (ask === undefined) {
      runtime().receive(bytes);
      return;
    }
    asks.push(ask);
    if (ask === 'commit') commitsSeen++;
    const cancelHere =
      !signalled &&
      ((cancelBeforeAnswer !== undefined && cancelBeforeAnswer === asks.length) ||
        (ask === 'commit' &&
          (cancelOnCommit === true ? 1 : cancelOnCommit === false ? 0 : cancelOnCommit) === commitsSeen));
    if (options.withholdAnswer === asks.length) {
      runtime().setAutoApply(false);
      runtime().receive(bytes);
      return;
    }
    if (!cancelHere) {
      runtime().receive(bytes);
      return;
    }
    // The signal reaches the attempt with this still outstanding: the one
    // bounded wait, so that it takes the signal in first.
    runtime().setAutoApply(false);
    runtime().receive(bytes);
    cancelNow();
    await pause(20);
    runtime().applyPending(1_000_000);
    runtime().setAutoApply(true);
  };

  /** One round: what the attempt wrote reaches the fake, and what the fake answers reaches the attempt. */
  const round = async () => {
    if (rt === undefined || !current()) return;
    for (;;) {
      // Whole messages only: the header says how long each is.
      if (unread.length < 8) break;
      const length = unread.readUInt32BE(4);
      if (unread.length < 8 + length) break;
      const bytes = unread.subarray(0, 8 + length);
      unread = unread.subarray(8 + length);
      const [message] = messages(bytes);
      try {
        await receive(message!, bytes);
      } catch (error) {
        // A violation: the fake failed the attempt, and keeps it.
        if (!(error as Error).message.startsWith('FAKE_VIOLATION')) throw error;
      }
      answerCalls();
      deliver();
    }
    answerCalls();
    deliver();
    mirror();
  };
  /** {@link round}, one at a time. */
  const exchange = () => {
    exchanging = exchanging.then(round);
    return exchanging;
  };

  const stream: Stream = {
    headers: Object.fromEntries(FakeRuntime.requestHeaders().map(({ key, value }) => [key, value])),
    body,
    writeHead: (status, headers) => void (head = { status, headers }),
    write: (chunk) => {
      unread = Buffer.concat([unread, chunk]);
      void exchange();
    },
    close: () => {
      ended = true;
      void exchange().then(() => {
        try {
          if (current()) rt?.sdkClosed();
        } catch {
          // The runtime had nothing to close: an attempt that never started.
        }
        return mirror();
      });
    },
  };

  const outcomes = (): FakeOutcome[] => rt?.outcomes() ?? [];

  return {
    stream,
    get head() {
      return head;
    },
    get ended() {
      return ended;
    },
    /** The fake runtime, once {@link start}ed. */
    get rt() {
      return runtime();
    },
    /** Everything the attempt wrote, as messages. */
    sent: () => [...sentMessages],
    /** What the attempt asked Restate for, in order: see {@link Ask}. */
    asks,
    /** The calls the attempt made (a result wanted), in order. */
    calls,
    /** The sends the attempt made, in order, a transaction's in its commit's group included. */
    sends,
    /** The invocation ids the attempt sent a cancellation to, in order. */
    get cancels() {
      return rt?.cancelsSent() ?? [];
    },
    /** How many of the attempt's messages were out when the signal went in. */
    get signalledAt() {
      return signalledAt;
    },
    /** How each attempt ended, as the runtime saw it. */
    outcomes,
    /** Start the invocation for `key` with `input`, and its first attempt (its second for `cancelAtStart`). */
    start(key: string, input: unknown, { handler, service }: { handler?: string; service?: string } = {}) {
      if (options.runtime !== undefined) {
        toSdk.push(options.runtime.startAttempt());
        mine = options.runtime.attemptNumber();
        return;
      }
      rt = new FakeRuntime({
        invocationId: 'inv_test',
        key,
        ...(handler !== undefined ? { handler } : {}),
        ...(service !== undefined ? { service } : {}),
        input: new TextEncoder().encode(JSON.stringify(input)),
        objectPreload: lazy ? [HEAD_KEY] : 'all',
      });
      for (const [k, v] of state) rt.setObjectState(k, v);
      if (cancelAtStart) {
        // An attempt the runtime lost, then the cancellation: the next one
        // starts knowing it.
        rt.startAttempt();
        rt.loseAttempt();
        rt.cancel();
        signalled = true;
        signalledAt = 0;
      }
      toSdk.push(rt.startAttempt());
      mine = rt.attemptNumber();
    },
    /** Restate cancels the invocation now. */
    cancel() {
      cancelNow();
    },
    /**
     * Restate shuts the attempt down: it closes its side, for a reason of its
     * own (`own`, the default) or for the attempt's silence (`inactivity`).
     */
    shutDown(reason: 'own' | 'inactivity' = 'own') {
      runtime().shutDown(reason);
      deliver();
    },
    /** Answer the oldest withheld call to `target` (`Service/handler`), echoing its input. */
    release(target: string) {
      const next = held.get(target)?.shift();
      if (next === undefined) throw new Error(`no call to ${target} is withheld`);
      const call = runtime()
        .calls()
        .find((c) => c.invocationId === next)!;
      runtime().completeCall(next, { bytes: call.parameter });
      deliver();
    },
    /** Wait until `condition` holds, polling, or fail after `ms`. */
    async until(condition: () => boolean, what: string, ms = 10_000) {
      const deadline = Date.now() + ms;
      while (!condition()) {
        if (Date.now() >= deadline) throw new Error(`waited ${ms}ms for ${what}`);
        await pause(1);
      }
    },
    /**
     * Run until the attempt's response ends: the fake answers as it goes, and
     * after the attempt's last message it closes its side, then the attempt
     * closes. Fails on any violation of the protocol the fake found.
     */
    async settle({ ms = 20_000 } = {}) {
      const deadline = Date.now() + ms;
      const over = () => ended;
      while (!over() && Date.now() < deadline) await pause(1);
      await exchange();
      await pause(0);
      await exchange();
      if (!ended) throw new Error(`the attempt did not end within ${ms}ms`);
      if (!options.allowViolations && rt !== undefined && rt.violations().length > 0) {
        throw new Error(`the fake runtime found violations: ${rt.violations().join('; ')}`);
      }
    },
    state,
  };
}

export type Side = ReturnType<typeof restateSide>;

/** How `step` ended: `ok`, or the name of what it failed with. */
export async function said(step: () => Promise<unknown>): Promise<string> {
  try {
    await step();
    return 'ok';
  } catch (error) {
    return error instanceof CancelledError ? 'CancelledError' : (error as Error).name;
  }
}

/**
 * The state an earlier invocation of `key` left, which ran `handler` of
 * `definition` with `input`: its schema is applied. On a key never written,
 * an attempt's first commit is the schema's, made as the session opens. After
 * this, it is the handler's own.
 */
export async function seeded(
  definition: { name: string },
  handler: string,
  key: string,
  input: unknown = null,
): Promise<Map<string, Uint8Array>> {
  const state = new Map<string, Uint8Array>();
  const r = restateSide(state);
  const serving = serveSession(definition, handler, r.stream);
  r.start(key, input, { handler, service: definition.name });
  await r.settle();
  await serving;
  return state;
}

/** How many commits the attempt made: atomic groups whose result it wanted. */
export const commits = (sent: Message[]) => sent.filter((m) => m.type === TYPE.atomicGroup && wantsResult(m)).length;

/** How the invocation ended: its output's value as text, or its failure. */
export function outcome(sent: Message[]): { value: string } | { code: number; message: string } | undefined {
  const end = sent.find((m) => m.type === TYPE.end);
  if (end === undefined) return undefined;
  const ok = end.fields.get(1)?.[0] as Uint8Array | undefined;
  if (ok !== undefined) return { value: text(decodeValue(ok))! };
  const failure = decodeFields(end.fields.get(2)![0] as Uint8Array);
  return {
    code: (failure.get(1)?.[0] as number | undefined) ?? 0,
    message: text(failure.get(2)?.[0] as Uint8Array) ?? '',
  };
}

/** The value the invocation ended with, as text (fails if it ended with a failure). */
export function output(sent: Message[]): string | undefined {
  const ended = outcome(sent);
  return ended !== undefined && 'value' in ended ? ended.value : undefined;
}

/** Run `handler` of `definition` once on `state` for `key`, answering everything: its outcome. */
export async function run(
  definition: { name: string },
  handler: string,
  state: Map<string, Uint8Array>,
  key: string,
  input: unknown = null,
) {
  const r = restateSide(state);
  const serving = serveSession(definition, handler, r.stream);
  r.start(key, input, { handler, service: definition.name });
  await r.settle();
  await serving;
  return outcome(r.sent());
}
