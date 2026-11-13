// withPi over an SQL database in memory, without a Restate server: the
// coding tools of a workspace write to the local file system. The attempt has
// the agent's companion (../support.ts): a `chat` turn publishes its steps,
// the coding tools' too.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { describe, expect, it } from 'vitest';
import { callTools, fakeProvider, say } from '../fakes/pi.ts';
import { followingOf, sqlAttempt } from '../support.ts';
import { chatHandler } from '@restatedev/agents';
import { withPi } from '@restatedev/agents/pi';

describe('withPi', () => {
  it('gives a workspace the coding tools, over the local file system', async () => {
    const root = await mkdtemp(join(tmpdir(), 'with-pi-'));
    const workspace = join(root, 'Assistant', 'acme.alice');
    const models = createModels();
    models.setProvider(
      fakeProvider('scribe', 'scribe', (context) => {
        const last = context.messages.at(-1)!;
        if (last.role === 'toolResult') return say(last.isError ? 'failed' : 'written');
        return callTools([['write', { path: 'notes.md', content: 'crushed' }]]);
      }),
    );
    try {
      // An attempt over a key of its own: the log starts afresh.
      const map = new Map<string, Uint8Array>();
      const attempt = sqlAttempt({ map, id: 'inv' });
      const chat = chatHandler(async (ctx, text) =>
        withPi(ctx, { models, model: 'scribe/scribe', workspace }, async (pi) => ({
          answer: await pi.prompt(text),
          agent: await (await pi.harness.root(pi.context)).agent(pi.context),
        })),
      );
      const { answer, agent } = await attempt.end(() => chat.handler(attempt.ctx, 'take a note'));
      expect(answer).toBe('written');
      expect(agent.tools.map((t) => t.name)).toEqual(['read', 'write', 'edit', 'bash']);
      expect(agent.sections.map((s) => s.key)).toContain('cwd');
      expect(await readFile(join(workspace, 'notes.md'), 'utf8')).toBe('crushed');
      // Published as the turn starts, once the reply with the call is stored, once its result is, and as it closes.
      expect(followingOf(map).made).toEqual(['start', 'publish', 'publish', 'close']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
