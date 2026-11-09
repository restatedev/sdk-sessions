import { tool } from '@restatedev/agents';
import { z } from 'zod';
import { askUser, handTo } from '../agents.ts';
import { approves } from '../policy.ts';
import { handoffText } from '../prompts.ts';
import { briefOf, type CheckDetail, claim, gate, record, taskName } from './ledger.ts';

/**
 * One rung up: from the worker to the senior, after the worker's attempts failed their
 * check, and only once the user approves. The wait is a Restate signal, so the boss holds no
 * process while the user thinks it over, for minutes or days.
 *
 * The senior starts cold, so the handoff carries state, built from the ledger rather than from the
 * worker's account of itself: what the last check said, and what the workspace looks like.
 */
export const escalateTask = tool({
  name: 'escalate_task',
  description:
    'Move a task the worker failed one rung up, to the senior. Asks the user first, and waits for the answer. ' +
    'The senior gets the brief and a handoff built from the ledger.',
  input: z.object({
    name: taskName,
    why: z.string().describe('For the user: what failed, and why the senior should succeed'),
    established: z.string().describe("Facts about the task you verified yourself, not the worker's claims"),
    doNotRedo: z.string().describe('Searches and conclusions already settled'),
  }),
  run: async ({ name, why, established, doNotRedo }, { ctx, callId, idempotencyKey }) => {
    const { state, rows } = await gate(ctx, idempotencyKey, name, 'escalate');
    const brief = await briefOf(ctx, name);

    const reply = await askUser.run({ task: name, why }, { ctx, callId });
    if (!approves(reply)) {
      await record(ctx, idempotencyKey, name, state.tier, 'denied', reply);
      return `The user declined: ${reply}\n\nStop here: take_back_task, and report to the user.`;
    }

    // The gate let this through only after a failed check, so the last check is the failure.
    const check = JSON.parse(rows.findLast((r) => r.kind === 'checked')!.detail) as CheckDetail;
    const failure = [check.outside.length > 0 && `Changed outside Where: ${check.outside.join(', ')}`, check.output]
      .filter(Boolean)
      .join('\n');
    const task = handoffText(brief, {
      attempts: state.attempts,
      state: check.stat ?? '(unknown: the workspace is not a git repository)',
      failure,
      established,
      doNotRedo,
    });
    const answer = await handTo.senior.run({ name, task }, { ctx, callId });
    await record(ctx, idempotencyKey, name, 'senior', 'escalated', answer);
    return claim(answer);
  },
});
