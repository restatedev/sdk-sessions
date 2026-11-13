// Restate's side of an invocation, for tests: the service protocol on the
// wire, written and read by hand, over the SDK's own request handler. An
// attempt of a session object's handler runs as it does against a Restate
// server, with the SDK's VM (the shared core it ships) and everything of
// @restatedev/sessions, and a test decides when a notification comes in and when
// the input closes, as the inactivity timeout closes it, to the microtask.
//
// It answers what a session asks of Restate: the result of a run (a commit's
// sync) is acknowledged while the input is open. The invocation's state is
// empty and complete (no lazy read), so a handler awaits nothing of Restate's
// but what it commits, and its cancellation.
import { createEndpointHandler } from '@restatedev/restate-sdk/fetch';

// --- Protocol buffers, as much as the messages here need

const varint = (n: number): number[] => {
  const bytes: number[] = [];
  for (; n > 127; n = Math.floor(n / 128)) bytes.push((n % 128) | 128);
  return [...bytes, n];
};
const field = (number: number, wire: 0 | 2, payload: number[]) =>
  wire === 0 ? [...varint(number * 8), ...payload] : [...varint(number * 8 + 2), ...varint(payload.length), ...payload];
const uint = (number: number, value: number) => field(number, 0, varint(value));
const bytes = (number: number, value: Uint8Array | number[] | string) =>
  field(number, 2, typeof value === 'string' ? [...new TextEncoder().encode(value)] : [...value]);

/** A decoded message: its fields' values by number, a number or the bytes of each. */
type Fields = Map<number, (number | Uint8Array)[]>;
function decode(buffer: Uint8Array): Fields {
  const fields: Fields = new Map();
  let at = 0;
  const readVarint = () => {
    let value = 0;
    for (let scale = 1; ; scale *= 128) {
      const byte = buffer[at++]!;
      value += (byte & 127) * scale;
      if (byte < 128) return value;
    }
  };
  while (at < buffer.length) {
    const tag = readVarint();
    const number = Math.floor(tag / 8);
    let value: number | Uint8Array;
    if (tag % 8 === 0) value = readVarint();
    else if (tag % 8 === 2) {
      const length = readVarint();
      value = buffer.subarray(at, at + length);
      at += length;
    } else throw new Error(`wire type ${tag % 8} of field ${number}`);
    fields.set(number, [...(fields.get(number) ?? []), value]);
  }
  return fields;
}
/** A repeated uint32 field: packed, or one by one. */
const uints = (fields: Fields, number: number): number[] =>
  (fields.get(number) ?? []).flatMap((v) => (typeof v === 'number' ? [v] : unpack(v)));
function unpack(packed: Uint8Array): number[] {
  const values: number[] = [];
  for (let at = 0; at < packed.length;) {
    let value = 0;
    for (let scale = 1; ; scale *= 128) {
      const byte = packed[at++]!;
      value += (byte & 127) * scale;
      if (byte < 128) break;
    }
    values.push(value);
  }
  return values;
}

/** What an invocation waits for, as it tells Restate: the signals and completions, at any depth. */
export interface Awaited {
  signals: number[];
  completions: number[];
}
function awaited(future: Uint8Array | undefined): Awaited {
  const out: Awaited = { signals: [], completions: [] };
  const walk = (buffer: Uint8Array) => {
    const fields = decode(buffer);
    out.completions.push(...uints(fields, 1));
    out.signals.push(...uints(fields, 2));
    for (const nested of fields.get(4) ?? []) walk(nested as Uint8Array);
  };
  if (future) walk(future);
  out.signals.sort((a, b) => a - b);
  out.completions.sort((a, b) => a - b);
  return out;
}

// --- Messages

const TYPE = {
  start: 0x0000,
  suspension: 0x0001,
  error: 0x0002,
  end: 0x0003,
  proposeRunCompletion: 0x0005,
  awaitingOn: 0x0006,
  proposeRunCompletionAck: 0x0007,
  input: 0x0400,
  output: 0x0401,
  signal: 0xfbff,
} as const;

/** The cancel signal's id. */
export const CANCEL = 1;

const frame = (type: number, body: number[]) => {
  const out = new Uint8Array(8 + body.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, type);
  view.setUint32(4, body.length);
  out.set(body, 8);
  return out;
};

/** How an attempt ended, or `working`: it has not. */
export type Outcome =
  | { kind: 'working' }
  | { kind: 'output'; value: unknown }
  | { kind: 'suspended'; on: Awaited }
  | { kind: 'error'; message: string };

let invocations = 0;

/**
 * An attempt of `service`'s `handler` for key `key` with `input`, started.
 * `closed`: the input is closed from the start, as a request-response
 * invocation's is.
 */
export function attempt(
  definition: object,
  path: `${string}/${string}`, // the service and its handler
  input: unknown,
  { closed = false, ack = true }: { closed?: boolean; ack?: boolean } = {},
) {
  const handle = createEndpointHandler({ services: [definition as never], bidirectional: true });
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let inputOpen = true;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const send = (type: number, message: number[]) => {
    if (inputOpen) controller.enqueue(frame(type, message));
  };
  const id = ++invocations;
  send(TYPE.start, [
    ...bytes(1, [id, 2, 3, 4]),
    ...bytes(2, `inv_test${id}`),
    ...uint(3, 1), // known_entries: the input
    ...bytes(6, `k${id}`),
    ...uint(9, id),
  ]);
  send(TYPE.input, bytes(14, bytes(1, JSON.stringify(input))));

  /** What the SDK told Restate it awaits, at each await that found nothing ready. */
  const reported: Awaited[] = [];
  /** The types of the messages it sent, in order. */
  const sent: number[] = [];
  let outcome: Outcome = { kind: 'working' };
  const ended = Promise.withResolvers<Outcome>();

  const api = {
    reported,
    sent,
    get outcome() {
      return outcome;
    },
    /** Resolves when the attempt ends: its outcome. */
    ended: ended.promise,
    get inputOpen() {
      return inputOpen;
    },
    /** Restate closes the input: its inactivity timeout. */
    closeInput() {
      if (!inputOpen) return;
      inputOpen = false;
      controller.close();
    },
    /** The cancel signal comes in. */
    cancel() {
      send(TYPE.signal, [...uint(2, CANCEL), ...bytes(4, [])]);
    },
  };
  if (closed) api.closeInput();

  void (async () => {
    const response = await handle(
      new Request(`http://restate.test/invoke/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/vnd.restate.invocation.v7' },
        body,
        duplex: 'half',
      }),
    );
    if (!response.ok || !response.body) throw new Error(`${response.status} ${await response.text()}`);
    let buffered = new Uint8Array(0);
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffered = new Uint8Array([...buffered, ...chunk]);
      while (buffered.length >= 8) {
        const view = new DataView(buffered.buffer, buffered.byteOffset);
        const type = view.getUint16(0);
        const length = view.getUint32(4);
        if (buffered.length < 8 + length) break;
        const message = decode(buffered.subarray(8, 8 + length));
        buffered = buffered.slice(8 + length);
        sent.push(type);
        if (type === TYPE.awaitingOn) reported.push(awaited(message.get(1)?.[0] as Uint8Array | undefined));
        else if (type === TYPE.proposeRunCompletion && ack) {
          send(TYPE.proposeRunCompletionAck, uint(1, message.get(1)![0] as number));
        } else if (type === TYPE.suspension) {
          outcome = { kind: 'suspended', on: awaited(message.get(4)?.[0] as Uint8Array | undefined) };
        } else if (type === TYPE.output) {
          const value = message.get(14)?.[0] as Uint8Array | undefined;
          const content = value ? (decode(value).get(1)?.[0] as Uint8Array | undefined) : undefined;
          outcome = {
            kind: 'output',
            value: content?.length ? JSON.parse(new TextDecoder().decode(content)) : undefined,
          };
        } else if (type === TYPE.error) {
          outcome = { kind: 'error', message: new TextDecoder().decode(message.get(2)?.[0] as Uint8Array) };
        }
        // The attempt said its last word: Restate closes its side.
        if (type === TYPE.suspension || type === TYPE.end || type === TYPE.error) api.closeInput();
      }
    }
    api.closeInput();
    ended.resolve(outcome);
  })().catch((e: unknown) => ended.reject(e));

  return api;
}
