// Test only: a scripted model for OpenCode, an AI SDK language model that
// OpenCode calls like any other (given through a plugin's `language` hook),
// that needs no API key and answers what the test says. `script.reply` gives
// each reply from the request's prompt and tools; a test sets it, and
// replaces it with one that throws where the model must not be asked.
// `script.requests` keeps each request's prompt, title requests apart.
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Message,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider';
import { Model, Provider, type Plugin } from '@opencode/plugin';

/** A reply of the model: text, and maybe a tool call. */
export interface Reply {
  text?: string;
  call?: { id: string; name: string; input: Record<string, unknown> };
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
function stream({ text, call }: Reply): LanguageModelV3StreamPart[] {
  const parts: LanguageModelV3StreamPart[] = [{ type: 'stream-start', warnings: [] }];
  if (text !== undefined) {
    parts.push({ type: 'text-start', id: 'text' }, { type: 'text-delta', id: 'text', delta: text });
    parts.push({ type: 'text-end', id: 'text' });
  }
  if (call) {
    parts.push({ type: 'tool-call', toolCallId: call.id, toolName: call.name, input: JSON.stringify(call.input) });
  }
  const reason = call ? 'tool-calls' : 'stop';
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
