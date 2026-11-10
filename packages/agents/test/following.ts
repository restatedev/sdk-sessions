// Test support: what a follower of a turn sees, for the frameworks that keep
// their own history (pi, DeepSeek, OpenCode), whose tools run in a round of
// several calls.
import type * as restate from '@restatedev/sessions';
import { tool, type Tool } from '@restatedev/agents';
import { z } from 'zod';
import { followingOf, handlerOf, type PromptHandler, sqlAttempt } from './support.ts';

/** The prompt that the tests' models answer with a reply that calls `t1`, `t2` and `t3`, then with `Done`. */
export const THREE_TOOLS = 'Run three tools';

/** The tools `t1`, `t2` and `t3`: each answers `result of <name>`. */
export const threeTools = (): Tool[] =>
  ['t1', 't2', 't3'].map((name) =>
    tool({ name, description: `Tool ${name}.`, input: z.object({}), run: () => `result of ${name}` }),
  );

/**
 * `chat` (with {@link threeTools}) on an object of its own, asked
 * {@link THREE_TOOLS}: its answer, how often the conversation was published
 * (its revision: the turn's publishes and its close), and what a follower
 * reads at each of the turn's publishes, as it is made: the outputs of the
 * tool calls the conversation shows by then, in order (`null` for a call
 * without its result yet). `commits`, the commits of the turn's attempt.
 */
export async function followedRound(
  chat: (tools: Tool[]) => PromptHandler,
  messages: (ctx: restate.ViewContext, request: object) => Promise<{ messages: { parts: unknown[] }[] }>,
  { object }: { object?: { readonly name: string } } = {},
) {
  const map = new Map<string, Uint8Array>();
  const seen: (string | null)[][] = [];
  let reads = 0;
  const read = async () => {
    const reading = sqlAttempt({ map, key: 'round', id: `read${reads++}`, shared: true, object });
    return reading.end(() => messages(reading.view, {}));
  };
  const published = async () => {
    const parts = (await read()).messages.flatMap((m) => m.parts) as { type: string; output?: string }[];
    seen.push(parts.filter((p) => p.type === 'tool').map((p) => p.output ?? null));
  };
  let commits = 0;
  const turn = sqlAttempt({
    map,
    key: 'round',
    id: 'inv1',
    object,
    published,
    onSync: async () => {
      commits++;
    },
  });
  const answer = await turn.end(() => handlerOf(chat(threeTools()))(turn.ctx, THREE_TOOLS));
  return { answer, published: followingOf(map).revision, seen, commits };
}
