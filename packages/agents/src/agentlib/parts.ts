// The pure parts of the agentlib agent (index.ts): its messages as clients
// read them, of agentlib's messages; which of a model's errors are its
// provider's refusals; and the tools' schemas as Anthropic takes them.
import type { Message } from '@restatedev/agentlib';
import { sdk as restate } from '@restatedev/sessions/internal';
import type { ChatMessage, Part } from '../common.ts';

/** A message as clients read it, without its id (its key's), as the agent keeps it. */
export interface Entry {
  role: ChatMessage['role'];
  parts: Part[];
  /** The cursor of its last change. */
  at: number;
  /** It is its turn's message (the user's), or its answer: `view: 'summary'` has these. */
  prompt?: true;
  answer?: true;
}

export type Rendered = Omit<Entry, 'at'>;

/** What a tool's result says, as a tool part's output. */
export function outputOf(
  result: Extract<Message, { role: 'tool' }>['result'],
): Pick<Extract<Part, { type: 'tool' }>, 'output' | 'error'> {
  switch (result.status) {
    case 'success':
      return { output: typeof result.output === 'string' ? result.output : JSON.stringify(result.output) };
    case 'error':
      return { output: `Error: ${result.message}`, error: true };
    case 'denied':
      return { output: `Denied: ${result.message}`, error: true };
    case 'cancelled':
      return { output: `Cancelled: ${result.message}`, error: true };
    case 'pending':
      return {};
    default:
      return {};
  }
}

/** A message steered to a turn, as agentlib notes it in the conversation (see {@link userText}). */
export const steeringNote = (message: string) => JSON.stringify({ source: 'agent-runtime', type: 'steering', message });

/** The text of a user message: a steering note of agentlib's says the message steered. */
export function userText(content: string): string {
  if (!content.startsWith('{')) return content;
  try {
    const note = JSON.parse(content) as { source?: unknown; type?: unknown; message?: unknown };
    if (note.source === 'agent-runtime' && note.type === 'steering' && typeof note.message === 'string') {
      return note.message;
    }
  } catch {
    // Not a note: the user's text.
  }
  return content;
}

/**
 * A turn's messages of agentlib (its message, the model's replies and the
 * tools' results, the messages steered to it), as clients read them: a
 * reply with its tool calls, each with its result as its output.
 */
export function render(messages: readonly Message[]): Rendered[] {
  const out: Rendered[] = [];
  const calls = new Map<string, Extract<Part, { type: 'tool' }>>();
  for (const message of messages) {
    if (message.role === 'user') out.push({ role: 'user', parts: [{ type: 'text', text: userText(message.content) }] });
    else if (message.role === 'assistant') {
      const parts: Part[] = message.content ? [{ type: 'text', text: message.content }] : [];
      for (const call of message.calls ?? []) {
        const part: Extract<Part, { type: 'tool' }> = { type: 'tool', id: call.id, name: call.name, input: call.input };
        calls.set(call.id, part);
        parts.push(part);
      }
      out.push({ role: 'assistant', parts: parts.length > 0 ? parts : [{ type: 'text', text: '' }] });
    } else {
      const part = calls.get(message.callId);
      if (part) Object.assign(part, outputOf(message.result));
    }
  }
  if (out[0]?.role === 'user') out[0].prompt = true;
  const last = out.at(-1);
  if (last?.role === 'assistant') last.answer = true;
  return out;
}

/** `schema` (a JSON schema) without the bounds of its numbers, at any depth. */
export function withoutBounds(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withoutBounds);
  if (typeof schema !== 'object' || schema === null) return schema;
  const bounds = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']);
  const type = (schema as { type?: unknown }).type;
  const numeric =
    type === 'integer' ||
    type === 'number' ||
    (Array.isArray(type) && type.some((t) => t === 'integer' || t === 'number'));
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => !(numeric && bounds.has(key)))
      .map(([key, value]) => [key, withoutBounds(value)]),
  );
}

/**
 * Whether `error`, a model's, is its provider's refusal that a retry does not
 * change: a terminal error of the model's own (agentlib's, such as an
 * overflow or a protocol error, and a cancellation, are other classes) for a
 * request the provider answered 4xx (a wrong API key, an unknown model, a
 * request it rejects), or for a missing API key.
 */
export const refused = (error: unknown): error is restate.TerminalError =>
  error instanceof restate.TerminalError &&
  error.constructor === restate.TerminalError &&
  ((error.code >= 400 && error.code < 500) || /API key/i.test(error.message));
