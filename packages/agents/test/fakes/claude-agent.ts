// Test only: the scripted teller (./claude.ts) as a Messages API on a local
// port, for Claude Code, which the Claude Agent SDK runs as a process of its
// own: it reaches the teller at ANTHROPIC_BASE_URL, with a fake key, and
// streams its replies (SSE), as the API does.
//
// Claude Code's requests are not the agent's alone: it adds its own system
// messages (the environment, a message steered to the turn), notes ("Continue
// from where you left off.") and reminders. The teller sees the conversation
// as an agent's: those left out, a steered message as the user's, and the
// tools by their names (Claude Code serves ours as `mcp__restate__<name>`).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type Anthropic from '@anthropic-ai/sdk';
import { HttpError, reply as tellerReply } from './claude.ts';

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type Message = Anthropic.Beta.Messages.BetaMessage;

/** A request as Claude Code made it, and the conversation the teller saw of it. */
export interface Request {
  body: { model?: string; system?: unknown; tools?: { name: string }[]; messages: MessageParam[] };
  messages: MessageParam[];
}

/** What Claude Code says that is no message of the user's. */
const NOTES = [
  /^Continue from where you left off\.$/,
  /^<system-reminder>/,
  /^\[Request interrupted/,
  /^No response requested\.$/,
];

/** The text of a message steered to the turn, as Claude Code shows it. */
const STEERED = /^The user sent a new message while you were working:\n([^]*?)\n\n/;

/** The conversation of a request, as an agent's: see the module's comment. */
export function conversationOf(messages: MessageParam[]): MessageParam[] {
  const out: MessageParam[] = [];
  for (const m of messages as (MessageParam | { role: 'system'; content: unknown })[]) {
    const content =
      typeof m.content === 'string'
        ? [{ type: 'text' as const, text: m.content }]
        : (m.content as { type: string; text?: string }[]);
    if (m.role === 'system') {
      const text = content.map((c) => c.text ?? '').join('');
      const steered = STEERED.exec(text)?.[1];
      if (steered !== undefined) out.push({ role: 'user', content: [{ type: 'text', text: steered }] });
      continue;
    }
    const kept = content.filter(
      (c) => c.type !== 'thinking' && !(c.type === 'text' && NOTES.some((n) => n.test(c.text ?? ''))),
    );
    if (kept.length > 0) out.push({ role: m.role, content: kept } as MessageParam);
  }
  // A steered message stays a message of its own, after the results it follows: the teller answers the latest.
  return out;
}

/**
 * The teller's script: `reply` answers each request (the teller's by
 * default; a test replaces it, to count, change or fail replies), and
 * `requests` has each request Claude Code made.
 */
export const script: {
  reply: (request: Request) => Message | Promise<Message>;
  requests: Request[];
} = { reply: ({ messages }) => tellerReply(messages), requests: [] };

/** The teller's own reply, for a test's `reply` to fall back on. */
export const teller = (request: Request) => tellerReply(request.messages);

/** `message`, its tools named as Claude Code offered them (`transfer` as `mcp__restate__transfer`). */
const named = (message: Message, tools: { name: string }[] = []): Message => ({
  ...message,
  content: message.content.map((c) =>
    c.type === 'tool_use'
      ? { ...c, name: tools.find((t) => t.name === c.name || t.name.endsWith(`__${c.name}`))?.name ?? c.name }
      : c,
  ),
});

/** An event of a stream (SSE). */
const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

/** `message` as the API streams it (SSE). */
function* events(message: Message): Generator<string> {
  yield event('message_start', {
    message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } },
  });
  for (const [index, block] of message.content.entries()) {
    if (block.type === 'text') {
      yield event('content_block_start', { index, content_block: { type: 'text', text: '' } });
      yield event('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
    } else if (block.type === 'tool_use') {
      yield event('content_block_start', {
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      });
      yield event('content_block_delta', {
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      });
    }
    yield event('content_block_stop', { index });
  }
  yield event('message_delta', {
    delta: {
      stop_reason: message.stop_reason,
      stop_sequence: null,
      ...(message.stop_details ? { stop_details: message.stop_details } : {}),
    },
    usage: { output_tokens: 1 },
  });
  yield event('message_stop', {});
}

let server: Server | undefined;

/** Start the teller, once per process, and point Claude Code at it: its URL. */
export async function startTeller(): Promise<string> {
  if (!server) {
    server = createServer((req, res) => void answer(req, res));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    // It answers while its process lives, and keeps none alive.
    server.unref();
  }
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Answer request `req`, as the Messages API. */
async function answer(req: IncomingMessage, res: ServerResponse) {
  let raw = '';
  for await (const chunk of req) raw += String(chunk);
  if (!req.url?.startsWith('/v1/messages') || req.url.startsWith('/v1/messages/count_tokens')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'not the teller' } }));
    return;
  }
  const body = JSON.parse(raw) as Request['body'];
  const request: Request = { body, messages: conversationOf(body.messages) };
  script.requests.push(request);
  let message: Message;
  try {
    message = named(await script.reply(request), body.tools);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const type = error instanceof HttpError ? error.type : 'api_error';
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type, message: (error as Error).message } }));
    return;
  }
  if (!(body as { stream?: boolean }).stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(message));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const sent of events(message)) res.write(sent);
  res.end();
}

/** The environment for Claude Code to reach the teller at `url`. */
export const tellerEnv = (url: string) => ({
  ANTHROPIC_BASE_URL: url,
  ANTHROPIC_API_KEY: 'sk-ant-teller',
});

export { HttpError };
