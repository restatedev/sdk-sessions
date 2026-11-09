import { tool } from '@restatedev/agents';
import { z } from 'zod';
import { workspace } from '../agents.ts';
import { MAX_ATTEMPTS, outsideWhere } from '../policy.ts';
import { changes, runCommand } from '../workspace.ts';
import { briefOf, type CheckDetail, gate, record, taskName } from './ledger.ts';

/**
 * The boss's own check of a task's current result: the signal the cascade decides on, never the
 * agent's report. It runs the brief's verification command, not one chosen now, so the goalposts
 * stay where the brief put them.
 */
export const runCheck = tool({
  name: 'run_check',
  description:
    "Check a task's current result yourself: run its brief's verification command in the workspace, and " +
    'compare the changed files with its Where. Passes only if the command exits 0 and nothing changed outside Where.',
  input: z.object({ name: taskName }),
  run: async ({ name }, { ctx, idempotencyKey }) => {
    const { state } = await gate(ctx, idempotencyKey, name, 'check');
    const brief = await briefOf(ctx, name);
    const run = await runCommand(brief.verification, workspace);
    const now = await changes(workspace);
    const outside = now ? outsideWhere(now.files, brief.where) : [];
    const passed = run.exitCode === 0 && outside.length === 0;
    const detail: CheckDetail = { ...run, outside, ...(now && { stat: now.stat }) };
    await record(ctx, idempotencyKey, name, state.tier, 'checked', JSON.stringify(detail), passed);
    return [
      `${passed ? 'PASSED' : 'FAILED'}: \`${brief.verification}\` exited ${run.exitCode ?? 'killed'}${run.timedOut ? ' (timed out)' : ''}`,
      outside.length > 0 && `Changed outside Where (${brief.where.join(', ')}): ${outside.join(', ')}`,
      `Changed:\n${now?.stat ?? '(the workspace is not a git repository: scope not checked)'}`,
      `Output:\n${run.output}`,
      `[foreman] "${name}" is with the ${state.tier}, attempt ${state.attempts} of ${MAX_ATTEMPTS}.`,
    ]
      .filter(Boolean)
      .join('\n\n');
  },
});
