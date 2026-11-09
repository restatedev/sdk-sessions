import { tool } from '@restatedev/agents';
import { z } from 'zod';
import { gate, record, taskName } from './ledger.ts';

/** Accept a task: only on a check the boss ran that passed, never on the agent's word. */
export const acceptTask = tool({
  name: 'accept_task',
  description: 'Accept a task whose last check passed.',
  input: z.object({ name: taskName, note: z.string().describe('One line: what you checked, and what you found') }),
  run: async ({ name, note }, { ctx, idempotencyKey }) => {
    const { state } = await gate(ctx, idempotencyKey, name, 'accept');
    await record(ctx, idempotencyKey, name, state.tier, 'accepted', note);
    return `Accepted "${name}".`;
  },
});

/**
 * Taking it back: the task stops going up. The boss diagnoses it itself and re-briefs it
 * as a new task for a cheap rung, or settles it with the user. Promotion is for judgment, not typing.
 */
export const takeBackTask = tool({
  name: 'take_back_task',
  description: 'Stop delegating a task: it failed at the top tier, the user declined, or the brief was wrong.',
  input: z.object({ name: taskName, why: z.string() }),
  run: async ({ name, why }, { ctx, idempotencyKey }) => {
    const { state } = await gate(ctx, idempotencyKey, name, 'take_back');
    await record(ctx, idempotencyKey, name, state.tier, 'taken_back', why);
    return `Took back "${name}". Diagnose it yourself, then re-brief it as a new task, or settle it with the user.`;
  },
});
