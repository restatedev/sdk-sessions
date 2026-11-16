// Serving one invocation of a session object's handler on the explicit
// recovery VM (`driver.ts`), instead of through the SDK's journaled context
// with the selector patched into it.
//
// The core takes a stream — the request's headers and body, and where to write
// the response — so that a test can drive it with wire bytes and `serve.ts`
// can hand it an HTTP/2 one. It is reached only for a session object's
// handler; everything else a deployment serves stays the SDK's.
import * as restate from '@restatedev/restate-sdk';
import type { Serde } from '@restatedev/restate-sdk-core';
import { AttemptDriver, AttemptFailed, AttemptShutDown } from './driver.ts';
import { handlerEntry, invoke, type AttemptContext } from './object.ts';
import { Vm, type VmHeader } from './vm.ts';

/** The lowest service protocol version the VM accepts; the SDK serves anything below. */
const MIN_PROTOCOL = 7;

/** One invocation on the wire: what the core reads, and where it writes. */
export interface Stream {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** The request body, which only the input pump reads. */
  readonly body: AsyncIterable<Uint8Array>;
  writeHead(status: number, headers: Record<string, string>): void;
  write(chunk: Uint8Array): void;
  /** The response body ends. */
  close(): void;
}

/**
 * Whether this package serves `headers`' invocation, or the SDK does. The VM
 * accepts the service protocol V7 and V8 only; a Restate that speaks less
 * works today on the SDK's VM, so it keeps it.
 */
export function servedHere(headers: Readonly<Record<string, string | string[] | undefined>>): boolean {
  const type = headers['content-type'];
  const match = /application\/vnd\.restate\.invocation\.v(\d+)/.exec((Array.isArray(type) ? type[0] : type) ?? '');
  return match !== null && Number(match[1]) >= MIN_PROTOCOL;
}

/** `headers` as the VM takes them. */
function vmHeaders(headers: Readonly<Record<string, string | string[] | undefined>>): VmHeader[] {
  return Object.entries(headers).flatMap(([key, value]) =>
    value === undefined ? [] : [{ key, value: Array.isArray(value) ? (value[0] ?? '') : value }],
  );
}

/**
 * Run one attempt of `definition`'s handler `name` over `stream`, and end its
 * response. `bidirectional` is false on a request/response transport, which
 * cannot serve such a handler: the VM fails the invocation at once, pausing
 * it, since no response could reach it.
 */
export async function serveSession(
  definition: { name: string },
  name: string,
  stream: Stream,
  { bidirectional = true } = {},
): Promise<void> {
  const entry = handlerEntry(definition, name);
  if (entry === undefined) throw new Error(`${definition.name}/${name} is no handler or view of a session object`);

  const vm = new Vm(vmHeaders(stream.headers), bidirectional);
  const head = vm.getResponseHead();
  stream.writeHead(head.statusCode, Object.fromEntries(head.headers.map(({ key, value }) => [key, value])));

  const driver = new AttemptDriver(vm, (chunk) => stream.write(chunk), {
    service: definition.name,
    handler: name,
    shared: entry.view,
    explicitCancellation: entry.explicit,
  });

  // The input pump: the only reader of the request body. It runs until the
  // body ends, beside the handler.
  const ready = Promise.withResolvers<void>();
  ready.promise.catch(() => {});
  const pump = (async () => {
    try {
      for await (const chunk of stream.body) {
        driver.notifyInput(chunk);
        if (driver.isReadyToExecute()) ready.resolve();
      }
    } catch {
      // The peer went away; the end of the body says the same.
    } finally {
      driver.notifyInputClosed();
      // Ready or not, nothing more is coming.
      ready.resolve();
    }
  })();

  try {
    await ready.promise;
    if (driver.over !== undefined || !driver.isReadyToExecute()) return;
    driver.startHeartbeats();
    const input = entry.inputSerde.deserialize(driver.body);
    const output = await invoke(definition, name, contextOf(driver, stream.headers), input);
    driver.endSuccess(entry.outputSerde.serialize(output));
  } catch (error) {
    endWith(driver, error);
  } finally {
    await pump;
    // The attempt's last words are buffered: a turn lets the tick write them.
    await new Promise((resolve) => setTimeout(resolve, 0));
    stream.close();
  }
}

/** End the attempt the way `error` says to. */
function endWith(driver: AttemptDriver, error: unknown): void {
  if (error instanceof AttemptShutDown) return; // the attempt is over; nothing more is sent
  if (error instanceof restate.TerminalError) {
    driver.endFailure(error);
    return;
  }
  if (error instanceof AttemptFailed) return; // the VM wrote why
  const retryable = error as { retryAfter?: number };
  const thrown = error instanceof Error ? error : new Error(String(error));
  driver.fail(thrown.message, thrown.stack, retryable.retryAfter);
}

/**
 * What `invoke` needs of a handler's context, over `driver`: the members of
 * the SDK's that a session object's attempt uses, and no others.
 */
function contextOf(
  driver: AttemptDriver,
  attemptHeaders: Readonly<Record<string, string | string[] | undefined>>,
): AttemptContext {
  const headers = new Map(Object.entries(attemptHeaders));
  const request = driver.request(headers);
  const raw = restate.serde.binary;

  /** The attempt's end, as `invocationEndPromise` gives it: a promise that rejects. */
  const ending = Promise.withResolvers<never>();
  ending.promise.catch(() => {});
  driver.whenEnded(() => ending.reject(driver.over ?? new AttemptShutDown()));

  const context = {
    key: driver.key,
    request: () => request,
    get: (name: string, serde?: Serde<unknown>, options?: restate.EntryOptions) =>
      driver
        .getState(name, named(options))
        .then((value) => (value === null ? null : (serde ?? raw).deserialize(value))),
    set: (name: string, value: unknown, serde?: Serde<unknown>, options?: restate.EntryOptions) =>
      driver.setState(name, (serde ?? raw).serialize(value), named(options)),
    clear: (name: string, options?: restate.EntryOptions) => driver.clearState(name, named(options)),
    stateKeys: () => driver.stateKeys(),
    sync: () => driver.sync(),
    run: () => {
      throw new restate.TerminalError(
        'a session object has no ctx.run: put journaled work in a restate.object, service or workflow, and call it with ctx.rpc',
      );
    },
    genericCall: (call: GenericCall) => {
      const { result, invocationId } = driver.call({
        service: call.service,
        handler: call.method,
        key: call.key,
        input: (call.inputSerde ?? restate.serde.json).serialize(call.parameter),
        idempotencyKey: call.idempotencyKey,
        headers: Object.entries(call.headers ?? {}).map(([key, value]) => ({ key, value })),
      });
      const answered = result.then((value) =>
        (call.outputSerde ?? restate.serde.json).deserialize(value ?? new Uint8Array()),
      );
      return Object.assign(answered, { invocationId });
    },
    genericSend: (send: GenericSend) =>
      void driver.send({
        service: send.service,
        handler: send.method,
        key: send.key,
        input: (send.inputSerde ?? restate.serde.json).serialize(send.parameter),
        delay: send.delay,
        idempotencyKey: send.idempotencyKey,
        headers: Object.entries(send.headers ?? {}).map(([key, value]) => ({ key, value })),
      }),
    invocation: (invocationId: unknown) => ({
      cancel: () => driver.cancel(String(invocationId)),
      attach: (serde?: Serde<unknown>) =>
        driver
          .attach(String(invocationId))
          .then((value) => (serde ?? restate.serde.json).deserialize(value ?? new Uint8Array())),
    }),
    cancellation: () => driver.cancellation(),
    cancelPreviousCalls: () => void driver.cancelPreviousCalls(),
    invocationEndPromise: { promise: ending.promise },
    defaultSerde: restate.serde.json,
  };
  return context as unknown as AttemptContext;
}

/** The command name an entry's options give, if any. */
const named = (options?: restate.EntryOptions): string | undefined => (options as { name?: string })?.name;

/** `ctx.genericCall`'s argument, as this package makes it (`calls.ts`). */
interface GenericCall {
  service: string;
  method: string;
  key?: string;
  parameter: unknown;
  inputSerde?: Serde<unknown>;
  outputSerde?: Serde<unknown>;
  idempotencyKey?: string;
  headers?: Record<string, string>;
}

/** `ctx.genericSend`'s argument. */
interface GenericSend extends GenericCall {
  delay?: number;
}
