// The agentlib agent's messages as clients read them: rendered from
// agentlib's messages, kept one per key (`c/<id>`), and paged by the
// `messages` view.
import type { Message } from '@restatedev/agentlib';
import { sdk as restate } from '@restatedev/sessions/internal';
import type { ChatMessage, Messages, MessagesRequest, Part } from '../common.ts';
import { emptyMeta, entryKey, META, type Meta } from './state.ts';

type ToolPart = Extract<Part, { type: 'tool' }>;
type ToolResult = Extract<Message, { role: 'tool' }>['result'];

/** A message as clients read it, without its id (that is its key), as the agent stores it. */
export interface Entry {
  role: ChatMessage['role'];
  parts: Part[];
  /** The cursor of the message's latest change. */
  at: number;
  /** It is its turn's message from the user (`view: 'summary'` shows these). */
  prompt?: true;
  /** It is its turn's answer (`view: 'summary'` shows these). */
  answer?: true;
}

/** An entry before it is stored, without its cursor. */
export type Rendered = Omit<Entry, 'at'>;

/** Returns what a tool's result says, as a tool part's output. */
export function outputOf(result: ToolResult): Pick<ToolPart, 'output' | 'error'> {
  switch (result.status) {
    case 'success': {
      const { output } = result;
      return { output: typeof output === 'string' ? output : JSON.stringify(output) };
    }
    case 'error':
      return { output: `Error: ${result.message}`, error: true };
    case 'denied':
      return { output: `Denied: ${result.message}`, error: true };
    case 'cancelled':
      return { output: `Cancelled: ${result.message}`, error: true };
    case 'pending':
    default:
      return {};
  }
}

/** A message steered to a turn, as agentlib notes it in the conversation. */
export function steeringNote(message: string): string {
  return JSON.stringify({ source: 'agent-runtime', type: 'steering', message });
}

/** Returns a user message's text: for agentlib's steering note, the steered message. */
export function userText(content: string): string {
  if (!content.startsWith('{')) return content;
  try {
    const note = JSON.parse(content) as { source?: unknown; type?: unknown; message?: unknown };
    const steering = note.source === 'agent-runtime' && note.type === 'steering';
    if (steering && typeof note.message === 'string') return note.message;
  } catch {
    // Not JSON: the user's own text.
  }
  return content;
}

/**
 * Renders a turn's messages of agentlib as clients read them: each reply
 * with its tool calls, each call with its result as its output. The first
 * message is the turn's prompt, and the last reply its answer.
 */
export function render(messages: readonly Message[]): Rendered[] {
  const rendered: Rendered[] = [];
  const callParts = new Map<string, ToolPart>();

  for (const message of messages) {
    switch (message.role) {
      case 'user':
        rendered.push({ role: 'user', parts: [{ type: 'text', text: userText(message.content) }] });
        break;
      case 'assistant': {
        const parts: Part[] = [];
        if (message.content) parts.push({ type: 'text', text: message.content });
        for (const call of message.calls ?? []) {
          const part: ToolPart = { type: 'tool', id: call.id, name: call.name, input: call.input };
          callParts.set(call.id, part);
          parts.push(part);
        }
        if (parts.length === 0) parts.push({ type: 'text', text: '' });
        rendered.push({ role: 'assistant', parts });
        break;
      }
      case 'tool': {
        const part = callParts.get(message.callId);
        if (part) Object.assign(part, outputOf(message.result));
        break;
      }
    }
  }

  const first = rendered[0];
  if (first?.role === 'user') first.prompt = true;
  const last = rendered.at(-1);
  if (last?.role === 'assistant') last.answer = true;
  return rendered;
}

/** How many messages one read of the `messages` view fetches at once. */
const BATCH = 25;

type View = restate.ObjectSharedContext;

/** Reads the entry `id`. At runtime, `get` returns a RestatePromise, although its type says Promise. */
function readEntry(ctx: View, id: number) {
  return ctx.get<Entry>(entryKey(id)) as unknown as restate.RestatePromise<Entry | null>;
}

/** Reads the entries of `ids` at once. A missing entry is `null`. */
function readEntries(ctx: View, ids: number[]) {
  return restate.RestatePromise.all(ids.map((id) => readEntry(ctx, id)));
}

/** Yields the ids from `from` down to `to` (included), newest first, a batch at a time. */
function* batches(from: number, to: number): Generator<number[]> {
  for (let id = from; id >= to; id -= BATCH) {
    const size = Math.min(BATCH, id - to + 1);
    yield Array.from({ length: size }, (_, i) => id - i);
  }
}

const chatMessage = (id: number, entry: Entry): ChatMessage => ({
  id,
  role: entry.role,
  parts: entry.parts,
});

/** Whether `entry` belongs in the view that `request` asks for. */
function inView(request: MessagesRequest, entry: Entry): boolean {
  if (request.view !== 'summary') return true;
  return entry.prompt === true || entry.answer === true;
}

/** The `messages` view: a page of the conversation, or what changed since a cursor. */
export async function readMessages(ctx: View, request: MessagesRequest = {}): Promise<Messages> {
  const meta = (await ctx.get<Meta>(META)) ?? emptyMeta();
  const page =
    request.cursor === undefined
      ? await pageBefore(ctx, meta, request)
      : await changedSince(ctx, meta, request);
  if (meta.first !== undefined) page.first = meta.first;
  return page;
}

/** The id after the conversation's last message (the turn being answered included). */
const endOf = (meta: Meta) => meta.chats + (meta.live?.n ?? 0);

/** The latest messages before `request.before` (by default, the end), at most `request.limit`. */
async function pageBefore(ctx: View, meta: Meta, request: MessagesRequest): Promise<Messages> {
  const first = meta.first ?? 0;
  const limit = request.limit ?? 50;
  const messages: ChatMessage[] = [];
  // The oldest id read so far: there are more if older ids are left.
  let oldest = Math.min(request.before ?? endOf(meta), endOf(meta));

  reading: for (const ids of batches(oldest - 1, first)) {
    const entries = await readEntries(ctx, ids);
    for (const [i, id] of ids.entries()) {
      if (messages.length >= limit) break reading;
      oldest = id;
      const entry = entries[i];
      if (entry && inView(request, entry)) messages.push(chatMessage(id, entry));
    }
  }

  return { messages: messages.toReversed(), more: oldest > first, cursor: meta.cursor };
}

/**
 * The messages new or changed since `request.cursor`, in the order they
 * changed, at most `request.limit`. An ended turn's messages are rewritten
 * in order as it ends, so the scan stops at the first message, older than
 * the turn being answered, that did not change.
 */
async function changedSince(ctx: View, meta: Meta, request: MessagesRequest): Promise<Messages> {
  const cursor = request.cursor ?? 0;
  const limit = request.limit ?? 50;
  const liveFrom = meta.live?.from ?? endOf(meta);
  const changed: [number, Entry][] = [];

  scanning: for (const ids of batches(endOf(meta) - 1, meta.first ?? 0)) {
    const entries = await readEntries(ctx, ids);
    for (const [i, id] of ids.entries()) {
      const entry = entries[i];
      if (!entry) continue;
      if (entry.at > cursor) changed.push([id, entry]);
      else if (id < liveFrom) break scanning;
    }
  }

  const ordered = changed
    .toSorted(([, a], [, b]) => a.at - b.at)
    .filter(([, entry]) => inView(request, entry));
  const page = ordered.slice(0, limit);
  const more = ordered.length > limit;
  const next = more ? page.at(-1)![1].at : meta.cursor;
  return { messages: page.map(([id, entry]) => chatMessage(id, entry)), more, cursor: next };
}
