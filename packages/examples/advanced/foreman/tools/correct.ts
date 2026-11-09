import { tool } from '@restatedev/agents';
import { z } from 'zod';
import { handTo } from '../agents.ts';
import { correctionText } from '../prompts.ts';
import { briefOf, claim, gate, record, taskName } from './ledger.ts';

/**
 * Correct before you promote: the result goes back to the agent that made it, under the
 * same name, so it keeps its history. The cheapest loop there is, and each tier gets one.
 */
export const correctTask = tool({
  name: 'correct_task',
  description:
    'Send a result back to the agent that made it, which keeps its history, with what failed and the fix. ' +
    'Each tier gets one correction.',
  input: z.object({
    name: taskName,
    failure: z.string().describe('What failed, verbatim: the check output, or a finding you verified'),
    fix: z.string().describe('The exact fix, in a sentence or two'),
  }),
  run: async ({ name, failure, fix }, { ctx, callId, idempotencyKey }) => {
    const { state } = await gate(ctx, idempotencyKey, name, 'correct');
    const brief = await briefOf(ctx, name);
    const answer = await handTo[state.tier].run({ name, task: correctionText(brief, failure, fix) }, { ctx, callId });
    await record(ctx, idempotencyKey, name, state.tier, 'corrected', answer);
    return claim(answer);
  },
});
