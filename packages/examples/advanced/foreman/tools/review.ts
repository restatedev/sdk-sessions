import { tool } from '@restatedev/agents';
import { z } from 'zod';
import { askReviewer, workspace } from '../agents.ts';
import { reviewText } from '../prompts.ts';
import { diffOf } from '../workspace.ts';
import { briefOf, gate, record, taskName } from './ledger.ts';

/** A second opinion on a task's diff, from a model of another family than the worker's. */
export const reviewTask = tool({
  name: 'review_task',
  description: "A second opinion on a task's diff, from a model of another family. Answers with its findings.",
  input: z.object({ name: taskName }),
  run: async ({ name }, { ctx, callId, idempotencyKey }) => {
    const { state } = await gate(ctx, idempotencyKey, name, 'review');
    const brief = await briefOf(ctx, name);
    const findings = await askReviewer.run({ name, task: reviewText(brief, await diffOf(workspace)) }, { ctx, callId });
    await record(ctx, idempotencyKey, name, state.tier, 'reviewed', findings);
    return `${findings}\n\n[foreman] Findings are claims too: verify each one before you act on it.`;
  },
});
