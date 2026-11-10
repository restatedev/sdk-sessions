// Test only: a scripted model for OpenCode, an AI SDK language model that
// OpenCode calls like any other (given through a plugin's `language` hook),
// that needs no API key and answers what the test says. `script.reply` gives
// each reply from the request's prompt and tools; a test sets it, and
// replaces it with one that throws where the model must not be asked.
// `script.requests` keeps each request's prompt, title requests apart.
// `teller` is a reply of the bank's teller, for the agent's tests.
import { randomUUID } from 'node:crypto';
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Message,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider';
import { Model, Provider, type Plugin } from '@opencode/plugin';

/**
 * A reply of the model: text, and maybe a tool call; or, with `error`, its text and then the stream fails with it.
 * `finish` is how its stream says it ended (`stop`, or `tool-calls` with a call, unless it says otherwise).
 */
export interface Reply {
  text?: string;
  call?: { id: string; name: string; input: Record<string, unknown> };
  /** More tool calls of the same reply, after `call`. */
  calls?: { id: string; name: string; input: Record<string, unknown> }[];
  error?: unknown;
  finish?: 'stop' | 'length' | 'content-filter' | 'error' | 'other';
}

/** A request to the model: its prompt, and the names of the tools it offers. */
export interface Request {
  prompt: LanguageModelV3Message[];
  tools: string[];
}

/** The text of a message, and of the tool results in it. */
export const textOf = (message: LanguageModelV3Message): string =>
  typeof message.content === 'string'
    ? message.content
    : message.content
        .map((part) => {
          if (part.type === 'text') return part.text;
          if (part.type !== 'tool-result') return '';
          const { output } = part;
          if (output.type === 'text' || output.type === 'error-text') return output.value;
          return 'value' in output ? JSON.stringify(output.value) : output.type;
        })
        .join('');

const none = undefined;
/** `reply` as a model's stream. */
function stream({ text, call, calls = [], error, finish }: Reply): LanguageModelV3StreamPart[] {
  const parts: LanguageModelV3StreamPart[] = [{ type: 'stream-start', warnings: [] }];
  if (text !== undefined) {
    parts.push({ type: 'text-start', id: 'text' }, { type: 'text-delta', id: 'text', delta: text });
    if (error !== undefined) return [...parts, { type: 'error', error }];
    parts.push({ type: 'text-end', id: 'text' });
  }
  for (const c of call ? [call, ...calls] : calls) {
    parts.push({ type: 'tool-call', toolCallId: c.id, toolName: c.name, input: JSON.stringify(c.input) });
  }
  const reason = finish ?? (call || calls.length > 0 ? 'tool-calls' : 'stop');
  parts.push({
    type: 'finish',
    finishReason: { unified: reason, raw: reason },
    usage: {
      inputTokens: { total: 0, noCache: none, cacheRead: none, cacheWrite: none },
      outputTokens: { total: 0, text: none, reasoning: none },
    },
  });
  return parts;
}

/** The script: `reply` answers each request but a title's; `requests` keeps them. */
export const script = {
  reply: (_request: Request): Reply => {
    throw new Error('the model was asked, and no test expected it');
  },
  requests: [] as Request[],
};

const model = {
  specificationVersion: 'v3',
  provider: 'scripted',
  modelId: 'scripted',
  supportedUrls: {},
  doGenerate: () => Promise.reject(new Error('the scripted model only streams')),
  doStream: async (options: LanguageModelV3CallOptions) => {
    const request = { prompt: options.prompt, tools: (options.tools ?? []).map((tool) => tool.name) };
    // OpenCode also asks for a session title, offering no tools.
    let parts: LanguageModelV3StreamPart[];
    if (request.tools.length === 0) parts = stream({ text: 'Title' });
    else {
      script.requests.push(request);
      parts = stream(script.reply(request));
    }
    return {
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          for (const part of parts) controller.enqueue(part);
          controller.close();
        },
      }),
    };
  },
} satisfies LanguageModelV3;

const providerID = Provider.ID.make('scripted');
// OpenCode makes an AI SDK model in two steps: it loads the provider's
// package, then makes the model, which a plugin's `language` hook may replace.
// It installs a package with npm (not in the workerd profile, since 2.1)
// unless it is a file: ./opencode-carrier.js, whose models the hook replaces.
const CARRIER = `aisdk:${new URL('./opencode-carrier.js', import.meta.url).href}`;

/** The model's name, as a session's model. */
export const MODEL = { providerID: 'scripted', id: 'scripted' };

/** An OpenCode plugin: a `scripted` provider, whose one model is the script. */
export const scriptedPlugin: Plugin.Plugin = {
  id: 'test.scripted',
  async setup(ctx) {
    const provider = await ctx.provider.transform((editor) => {
      editor.add({
        info: {
          id: providerID,
          name: 'Scripted',
          activation: 'enabled',
          package: CARRIER,
          settings: { baseURL: 'https://scripted.invalid/v1', apiKey: 'scripted' },
        },
        models: [
          {
            ...Model.Info.default(providerID, Model.ID.make('scripted')),
            package: CARRIER,
            limit: { context: 128_000, output: 8_192 },
          },
        ],
      });
    });
    const hook = await ctx.aisdk.hook(
      'language',
      (event) => {
        event.language = model;
      },
      { providerID },
    );
    return async () => {
      await hook.dispose();
      await provider.dispose();
    };
  },
};

/** How OpenCode asks the model to go on with a turn a restart interrupted. */
export const CONTINUE = /^The server restarted while you were working/;
/** A tool result of a call a restart interrupted. */
const INTERRUPTED = /Tool execution interrupted/;

/**
 * The teller's reply to the conversation `prompt`: it
 * transfers and audits on request, and reports the tool's result. When
 * OpenCode resumes a turn that a crash interrupted, it retries an
 * interrupted transfer with `retryOf` naming the prompt's first transfer (so
 * the money moves once), and reports a result that came before the crash.
 */
export function teller({ prompt }: Request): Reply {
  const last = prompt.at(-1)!;
  if (last.role === 'tool') return { text: `Done: ${textOf(last)}` };
  // Asked who it is, it repeats its system prompt.
  if (textOf(last).endsWith('Who are you?')) {
    return { text: prompt.flatMap((m) => (m.role === 'system' ? [m.content] : [])).join('\n') };
  }
  // A fresh tool call id, unique like a model's: a step run again calls its tools with new ids.
  const id = `call_${randomUUID()}`;
  let text = textOf(last);
  let retryOf: string | undefined;
  if (CONTINUE.test(text)) {
    // The interrupted prompt, and the last tool result since.
    const at = prompt.findLastIndex((m) => m.role === 'user' && !CONTINUE.test(textOf(m)));
    const result = prompt.slice(at).findLast((m) => m.role === 'tool');
    const part = result?.role === 'tool' ? result.content.findLast((c) => c.type === 'tool-result') : undefined;
    if (result && part && INTERRUPTED.test(textOf(result))) {
      const call = prompt
        .flatMap((m) => (m.role === 'assistant' ? m.content : []))
        .findLast((c) => c.type === 'tool-call' && c.toolCallId === part.toolCallId);
      if (call?.type !== 'tool-call') throw new Error(`no tool call ${part.toolCallId}`);
      const input = { ...(call.input as Record<string, unknown>) };
      // The prompt's first transfer: the one every retry of it retries.
      const first = prompt
        .slice(at)
        .flatMap((m) => (m.role === 'assistant' ? m.content : []))
        .find((c) => c.type === 'tool-call' && c.toolName === 'transfer');
      const original = first?.type === 'tool-call' ? first.toolCallId : call.toolCallId;
      if (call.toolName !== 'transfer' || 'amount' in input) {
        if (call.toolName === 'transfer') input.retryOf ??= original;
        return { call: { id, name: call.toolName, input } };
      }
      // OpenCode stores a tool call when its input starts, and its whole input once the call runs: a crash
      // between them leaves a call that may have run. The prompt is answered again, as a retry of it.
      retryOf = original;
    } else if (result) {
      return { text: `Done: ${textOf(result)}` };
    }
    text = textOf(prompt[at]!);
  }
  const move = /move (\d+) from (\d+) to (\d+)/i.exec(text);
  if (move) {
    const [amount, from, to] = move.slice(1).map(Number);
    return { text: 'On it.', call: { id, name: 'transfer', input: { from, to, amount, ...(retryOf && { retryOf }) } } };
  }
  if (/audit/i.test(text)) return { call: { id, name: 'audit', input: {} } };
  return { text: 'Ask me to "move 5 from 1 to 2", or to "audit" the books.' };
}
