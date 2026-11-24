// Restate's side of an invocation, for tests: the service protocol on the
// wire, written and read by hand. These are the codec — frames, protobuf
// fields and the message types — that the tests of the binding
// (`vm.test.ts`), the driver (`driver.test.ts`), the handler and the endpoint
// build their messages with, and read the attempt's answers back with.

// --- Protocol buffers, as much as the messages here need

const varint = (n: number): number[] => {
  const bytes: number[] = [];
  for (; n > 127; n = Math.floor(n / 128)) bytes.push((n % 128) | 128);
  return [...bytes, n];
};
export const field = (number: number, wire: 0 | 2, payload: number[]) =>
  wire === 0 ? [...varint(number * 8), ...payload] : [...varint(number * 8 + 2), ...varint(payload.length), ...payload];
export const uint = (number: number, value: number) => field(number, 0, varint(value));
export const bytes = (number: number, value: Uint8Array | number[] | string) =>
  field(number, 2, typeof value === 'string' ? [...new TextEncoder().encode(value)] : [...value]);

/** A decoded message: its fields' values by number, a number or the bytes of each. */
export type Fields = Map<number, (number | Uint8Array)[]>;
export function decode(buffer: Uint8Array): Fields {
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
// --- Messages of the explicit recovery protocol (`explicit_recovery.proto`)

export const TYPE = {
  start: 0x0000,
  shutdown: 0x0001,
  error: 0x0002,
  end: 0x0003,
  heartbeat: 0x0004,
  getState: 0x0410,
  getStateKeys: 0x0411,
  setState: 0x0412,
  clearState: 0x0413,
  clearAllState: 0x0414,
  call: 0x0420,
  attach: 0x0421,
  cancelInvocation: 0x0422,
  readSignal: 0x0430,
  sendSignal: 0x0431,
  flush: 0x0440,
  atomicGroup: 0x0441,
  spanStart: 0x0450,
  spanEnd: 0x0451,
  result: 0x8000,
  signal: 0x8001,
} as const;

/** The fields every action has: its result id (11), name (12), parent span (13) and record level (14). */
export const ACTION = { resultId: 11, name: 12, parentSpan: 13, record: 14 } as const;

/** `RecordLevel`: what Restate keeps of an action. */
export const RECORD = { default: 0, none: 1, summary: 2, full: 3 } as const;

/** The member kinds of an atomic group, by their field in `AtomicGroupActionMessage.Action`. */
export const MEMBER: Record<number, number> = {
  1: TYPE.setState,
  2: TYPE.clearState,
  3: TYPE.clearAllState,
  4: TYPE.call,
  5: TYPE.cancelInvocation,
  6: TYPE.sendSignal,
  7: TYPE.spanStart,
  8: TYPE.spanEnd,
};

export const frame = (type: number, body: number[]) => {
  const out = new Uint8Array(8 + body.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, type);
  view.setUint32(4, body.length);
  out.set(body, 8);
  return out;
};

/** One message: its type and decoded fields. */
export interface Message {
  type: number;
  fields: Fields;
}

/** The messages in `output`, in order. */
export function messages(output: Uint8Array): Message[] {
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  const out: Message[] = [];
  for (let at = 0; at < output.length;) {
    const type = view.getUint16(at);
    const length = view.getUint32(at + 4);
    out.push({ type, fields: decode(output.subarray(at + 8, at + 8 + length)) });
    at += 8 + length;
  }
  return out;
}

/** The members of an atomic group, as messages of their own type. */
export function members(group: Message): Message[] {
  return (group.fields.get(1) ?? []).map((action) => {
    const [[number, [body]]] = [...decode(action as Uint8Array)] as [[number, [Uint8Array]]];
    return { type: MEMBER[number]!, fields: decode(body) };
  });
}

/** The text of field `number` of `message`. */
export const str = (message: Message, number: number): string | undefined => {
  const value = message.fields.get(number)?.[0];
  return value instanceof Uint8Array ? Buffer.from(value).toString() : undefined;
};

/** The number of field `number` of `message`, 0 when absent (proto3). */
export const num = (message: Message, number: number): number => {
  const value = message.fields.get(number)?.[0];
  return typeof value === 'number' ? value : 0;
};
