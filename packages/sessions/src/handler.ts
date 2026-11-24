// Serving one attempt of a session object's handler on the explicit recovery
// protocol (`driver.ts`), rather than through the SDK's journaled context.
//
// The core takes a stream — the request's headers and body, and where to write
// the response — so that a test can drive it with wire bytes and `endpoint.ts`
// can hand it an HTTP/2 one. It is reached only for a session object's
// handler; everything else a deployment serves stays the SDK's.
import * as restate from '@restatedev/restate-sdk';
import { millisOrDurationToMillis, type Serde } from '@restatedev/restate-sdk-core';
import { AttemptDriver, AttemptFailed, AttemptShutDown } from './driver.ts';
import { handlerEntry, invoke, type AttemptContext } from './object.ts';
import { refusedStatus, Vm, type VmHeader } from './vm.ts';

/** The content type of the explicit recovery protocol's invocations, version 1. */
export const CONTENT_TYPE = 'application/vnd.restate.invocation.explicitrecovery.v1';

/**
 * How long the response waits, after the attempt's last message, for Restate
 * to close the request: Restate closes first, then the attempt (D35). One
 * that never does is closed anyway.
 */
export const CLOSE_TIMEOUT_MS = 30_000;

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

/** `headers` as the VM takes them. */
function vmHeaders(headers: Readonly<Record<string, string | string[] | undefined>>): VmHeader[] {
  return Object.entries(headers).flatMap(([key, value]) =>
    value === undefined ? [] : [{ key, value: Array.isArray(value) ? (value[0] ?? '') : value }],
  );
}

/** The attempts this process is serving, with what closes each one's response: a SIGTERM ends them (`goAway`). */
const live = new Map<AttemptDriver, () => void>();

/**
 * The process is going away: end every attempt it serves with an unasked
 * `ShutdownMessage` and close its response at once; Restate starts each
 * again, elsewhere. Returns how many there were.
 */
export function goAway(): number {
  const attempts = [...live];
  for (const [driver, close] of attempts) {
    driver.goAway();
    close();
  }
  return attempts.length;
}

/** How many attempts this process is serving now. */
export const serving = (): number => live.size;

/**
 * Run one attempt of `definition`'s handler `name` over `stream`, and end its
 * response. A request of another protocol family or version is answered with
 * the status the VM refuses it with (415), and nothing runs.
 */
export async function serveSession(definition: { name: string }, name: string, stream: Stream): Promise<void> {
  const entry = handlerEntry(definition, name);
  if (entry === undefined) throw new Error(`${definition.name}/${name} is no handler or view of a session object`);

  let vm: Vm;
  try {
    vm = new Vm(vmHeaders(stream.headers));
  } catch (error) {
    const status = refusedStatus(error);
    if (status === undefined) throw error;
    // Not a 500: Restate offers the next lower version of its range on a 415.
    stream.writeHead(status, {});
    stream.close();
    return;
  }
  const head = vm.getResponseHead();
  stream.writeHead(head.statusCode, Object.fromEntries(head.headers.map(({ key, value }) => [key, value])));

  const driver = new AttemptDriver(vm, (chunk) => stream.write(chunk), {
    service: definition.name,
    handler: name,
    shared: entry.view,
    explicitCancellation: entry.explicit,
  });
  // The database's store acts on the VM from the runtime's thread, in the
  // addon; this is how it asks for the tick that writes what it sent.
  vm.setScheduler(() => driver.scheduleTick());

  // The response closes once the attempt's last message is written and the
  // runtime closed its side (it closes first), or when the process goes
  // away: not when the handler returns. A handler that Restate shut down at
  // work of its own (outside `ctx.working`) runs on until that work is done,
  // its actions throwing.
  let closed = false;
  const whenClosed = Promise.withResolvers<void>();
  const close = () => {
    if (closed) return;
    closed = true;
    live.delete(driver);
    stream.close();
    whenClosed.resolve();
  };
  live.set(driver, close);
  driver.whenClosable(close);

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
    // Input this handler cannot read will not read on the next attempt
    // either: a terminal failure ends the invocation, where a retryable one
    // would have Restate send the same bytes forever. The SDK's own handler
    // does the same for input its journal codec cannot decode.
    let input: unknown;
    try {
      input = entry.inputSerde.deserialize(driver.body);
    } catch (error) {
      throw new restate.TerminalError(`failed to deserialize the input: ${(error as Error).message}`, {
        errorCode: 400,
      });
    }
    const output = await invoke(definition, name, contextOf(driver, stream.headers, vm), input);
    // A cancellation that arrived while the handler ran is still cancelling
    // its calls: they go out before the attempt ends, or not at all.
    await driver.cancellingCalls;
    driver.endSuccess(entry.outputSerde.serialize(output));
  } catch (error) {
    await driver.cancellingCalls;
    endWith(driver, error, entry.asTerminalError);
  } finally {
    // The attempt's last words are buffered: a turn lets the tick write them,
    // and the response closes once Restate closed the request too.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!closed) {
      const timeout = setTimeout(close, CLOSE_TIMEOUT_MS);
      timeout.unref?.();
      await Promise.race([pump, whenClosed.promise]);
      // The end of the input reached the VM: the tick that follows closes.
      await new Promise((resolve) => setTimeout(resolve, 0));
      driver.scheduleTick();
      await new Promise((resolve) => setTimeout(resolve, 0));
      // Restate closed the request, and the VM has no last message to write:
      // it was shut down before it started, say. Nothing more will come.
      if (!closed && driver.over !== undefined) close();
      clearTimeout(timeout);
    }
    close();
  }
}

/** End the attempt the way `error` says to. */
function endWith(driver: AttemptDriver, error: unknown, asTerminalError?: (error: unknown) => Error | undefined): void {
  if (error instanceof AttemptShutDown) return; // the attempt is over; nothing more is sent
  // The handler option of the same name: an error it names ends the
  // invocation rather than being retried. The SDK applies it, so this does.
  if (asTerminalError !== undefined && !(error instanceof restate.TerminalError)) {
    const terminal = asTerminalError(error);
    if (terminal !== undefined) {
      driver.endFailure(
        terminal instanceof restate.TerminalError ? terminal : new restate.TerminalError(terminal.message),
      );
      return;
    }
  }
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
  vm: Vm,
): AttemptContext {
  const headers = new Map(Object.entries(attemptHeaders));
  const request = driver.request(headers);

  /** The attempt's end, as `invocationEndPromise` gives it: a promise that rejects. */
  const ending = Promise.withResolvers<never>();
  ending.promise.catch(() => {});
  driver.whenEnded(() => ending.reject(driver.over ?? new AttemptShutDown()));

  const context = {
    key: driver.key,
    request: () => request,
    // The object's state is the addon's: it reads and writes it as the VM's
    // own commands, so nothing of it is implemented here. A session opened on
    // a VM never asks (see `commitOnly` in `session.ts`); anything else that
    // does is a mistake, and says so.
    get: servedByVm('get'),
    set: servedByVm('set'),
    clear: servedByVm('clear'),
    stateKeys: servedByVm('stateKeys'),
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
      // Marked handled: `start()` awaits only the invocation id, so nothing
      // holds this, and it rejects when the callee fails, on a cancellation,
      // and at the end of every attempt — including a successful one.
      const answered = quiet(
        result.then((value) => (call.outputSerde ?? restate.serde.json).deserialize(value ?? new Uint8Array())),
      );
      return Object.assign(answered, { invocationId });
    },
    genericSend: (send: GenericSend) =>
      void driver.send({
        service: send.service,
        handler: send.method,
        key: send.key,
        input: (send.inputSerde ?? restate.serde.json).serialize(send.parameter),
        // `SendOptions.delay` is milliseconds or a `Duration`; the VM takes
        // milliseconds.
        delay: send.delay === undefined ? undefined : millisOrDurationToMillis(send.delay),
        idempotencyKey: send.idempotencyKey,
        headers: Object.entries(send.headers ?? {}).map(([key, value]) => ({ key, value })),
      }),
    invocation: (invocationId: unknown) => ({
      cancel: () => driver.cancel(String(invocationId)),
      attach: (serde?: Serde<unknown>) =>
        quiet(
          driver
            .attach(String(invocationId))
            .then((value) => (serde ?? restate.serde.json).deserialize(value ?? new Uint8Array())),
        ),
    }),
    cancellation: () => driver.cancellation(),
    // A cancellation owed to the handler's next await, which a call of its
    // database takes before it issues anything (`session.ts`).
    takeCancellation: () => driver.takeCarriedCancellation(),
    cancelPreviousCalls: () => driver.cancelPreviousCalls(),
    // What `ctx.working` keeps alive, and the database's own calls too (`session.ts`).
    working: <T>(fn: () => T | Promise<T>) => driver.working(fn),
    invocationEndPromise: { promise: ending.promise },
    defaultSerde: restate.serde.json,
    // The addon reads and writes the object's state on this, rather than
    // calling back into JavaScript for every page (see `openOnVm`).
    vm,
    // What the protocol adds beyond the SDK's context: invocation state,
    // signals, flush and spans (`object.ts`).
    driver,
  };
  return context as unknown as AttemptContext;
}

/**
 * Mark a promise handled, so that one the handler never awaits does not bring
 * the process down when the attempt ends. The caller still sees the rejection.
 */
function quiet<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  return promise;
}

/** What a state member of the context does if anything calls it. */
const servedByVm = (of: string) => () => {
  throw new restate.TerminalError(
    `@restatedev/sessions: the VM serves the object's state in the addon; ctx.${of} is not called`,
  );
};

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
  delay?: number | Parameters<typeof millisOrDurationToMillis>[0];
}
