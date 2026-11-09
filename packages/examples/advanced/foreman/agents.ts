/**
 * The agents that do the delegated work, and how the boss's tools reach them.
 *
 *   worker   (pi + GPT-6 Luna)       the cheap tier, in the workspace
 *   senior   (pi + GPT-6.1 Sol)      one rung up, only with the user's approval
 *   reviewer (pi + GPT-6 Sol)        a second opinion on a diff, read-only
 *
 * All OpenAI (OPENAI_API_KEY), in tiers: Astra for the boss, Sol for the medium tier, Luna for light
 * work. Each model can be changed with its *_MODEL variable.
 *
 * Each is a session object of its own, keyed `<boss key>.<task name>`: a correction goes back to the
 * same agent, which still has its history, and tasks with different names run at once.
 */
import { join } from 'node:path';
import { signal, subagent, type Tool } from '@restatedev/agents';
import * as pi from '@restatedev/agents/pi';
import { z } from 'zod';
import type { Tier } from './policy.ts';
import * as prompts from './prompts.ts';

// The agents' coding tools (read, write, edit, bash) and the boss's checks run here, on this
// machine and not in a sandbox: point it at a throwaway clone, never at a repo you care about.
// pi creates it if it is missing.
export const workspace = process.env.WORKSPACE ?? join(import.meta.dirname, 'scratch');

// The cheap tier: about a twentieth of Sol's price per token.
export const worker = pi.agent({
  name: 'worker',
  description: 'The cheap tier: one bounded task with a mechanical check',
  model: process.env.WORKER_MODEL ?? 'openai/gpt-6-luna',
  workspace,
  background: true,
  system: prompts.WORKER,
});

export const senior = pi.agent({
  name: 'senior',
  description: 'One rung up: a task the worker could not finish',
  model: process.env.SENIOR_MODEL ?? 'openai/gpt-6.1-sol',
  workspace,
  background: true,
  system: prompts.SENIOR,
});

// Stronger than the worker it reviews, and another model than the senior's. A reviewer of another
// family (another provider's model) catches more of a model's blind spots: with OPENAI_API_KEY alone,
// this is the next best. It has no workspace: it sees the diff the boss sends, and can change nothing.
export const reviewer = pi.agent({
  name: 'reviewer',
  description: 'A second opinion on a diff',
  model: process.env.REVIEWER_MODEL ?? 'openai/gpt-6-sol',
  background: true,
  system: prompts.REVIEWER,
});

// Restate's own tools, which the boss's tools call rather than offer to the model. Each makes its
// call once, however often a crash runs the tool call again: the same call id, so the same
// idempotency key, and the same answer.

/** Hand a task (`{ name, task }`) to a tier's agent, and get its answer. */
export const handTo: Record<Tier, Tool> = { worker: subagent(worker), senior: subagent(senior) };

/** Ask the reviewer about a diff. */
export const askReviewer = subagent(reviewer);

/** Wait for the user's answer to an escalation: `pending` shows it, `signal` answers it. */
export const askUser = signal('approval', {
  description: 'Wait for the user to approve moving a task to the senior tier',
  input: z.object({ task: z.string(), why: z.string() }),
});
