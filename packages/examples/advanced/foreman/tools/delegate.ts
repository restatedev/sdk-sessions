import { tool } from '@restatedev/agents';
import { z } from 'zod';
import { handTo } from '../agents.ts';
import { briefText } from '../prompts.ts';
import { addTask, claim, gate, record, taskName } from './ledger.ts';

/** Hand a new task to the worker, with every field of a brief: the worker sees nothing else. */
export const delegateTask = tool({
  name: 'delegate_task',
  description: 'Hand a new task to the worker, the cheap tier, with a full brief. Answers with its report.',
  input: z.object({
    name: taskName.describe('A short new name, such as "rename-getuser": the same name later means this task'),
    goal: z.string().describe('The outcome, in one or two sentences: not the steps'),
    context: z.string().optional().describe('Why, and decisions already made'),
    invariants: z.array(z.string()).min(1).describe('What must stay true, and who else the change affects'),
    where: z.array(z.string()).min(1).describe('The only paths it may change, relative to the workspace'),
    acceptance: z.array(z.string()).min(1).describe('Observable conditions for done'),
    verification: z
      .string()
      .min(1)
      .describe('The exact command that checks it, run in the workspace root. No mechanical check: do not delegate'),
    outOfScope: z.array(z.string()).optional().describe('Tempting adjacent work to leave alone'),
    words: z.number().int().min(50).max(1000).default(200).describe('The cap on its report, in words'),
  }),
  run: async (brief, { ctx, callId, idempotencyKey }) => {
    await gate(ctx, idempotencyKey, brief.name, 'delegate');
    await addTask(ctx, idempotencyKey, brief);
    const answer = await handTo.worker.run({ name: brief.name, task: briefText(brief) }, { ctx, callId });
    await record(ctx, idempotencyKey, brief.name, 'worker', 'delegated', answer);
    return claim(answer);
  },
});
