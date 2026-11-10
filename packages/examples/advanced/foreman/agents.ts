/**
 * The agents that do the delegated work, and how the boss's tools reach them.
 *
 *   worker   (OpenCode + Claude Sonnet 5.5)   the cheap tier, in the workspace
 *   senior   (OpenCode + Claude Sonnet 5.5)   one rung up, only with the user's approval
 *   reviewer (OpenCode + Claude Sonnet 5.5)   a second opinion on a diff, read-only
 *
 * The boss is a pi agent; the agents it delegates to are OpenCode agents, each with OpenCode's own
 * coding tools in the workspace. All Anthropic (ANTHROPIC_API_KEY): Fable 5.2 for the boss, Sonnet
 * 5.5 for every agent it delegates to. Each model can be changed with its *_MODEL variable: a stronger SENIOR_MODEL (Opus 5.5) makes
 * the senior a real rung up.
 *
 * Each is a session object of its own, keyed `<boss key>.<task name>`: a correction goes back to the
 * same agent, which still has its history, and tasks with different names run at once.
 */
import { join } from 'node:path';
import { signal, subagent, type Tool } from '@restatedev/agents';
import * as opencode from '@restatedev/agents/opencode';
import { z } from 'zod';
import { REVIEWER_MODEL, SENIOR_MODEL, WORKER_MODEL } from './models.ts';
import type { Tier } from './policy.ts';
import * as prompts from './prompts.ts';

// OpenCode's coding tools (read, write, edit, shell, glob, grep) and the boss's checks run here, on
// this machine and not in a sandbox: point it at a throwaway clone, never at a repo you care about.
// It is made if it is missing.
export const workspace = process.env.WORKSPACE ?? join(import.meta.dirname, 'scratch');

// The cheap tier.
export const worker = opencode.agent({
  name: 'worker',
  description: 'The cheap tier: one bounded task with a mechanical check',
  model: WORKER_MODEL,
  workspace,
  background: true,
  system: prompts.WORKER,
});

export const senior = opencode.agent({
  name: 'senior',
  description: 'One rung up: a task the worker could not finish',
  model: SENIOR_MODEL,
  workspace,
  background: true,
  system: prompts.SENIOR,
});

// A reviewer of another family (another provider's model, through REVIEWER_MODEL) catches more of
// a model's blind spots than one on the worker's own model. It has no workspace, so none of OpenCode's
// tools: it sees the diff the boss sends, and can change nothing.
export const reviewer = opencode.agent({
  name: 'reviewer',
  description: 'A second opinion on a diff',
  model: REVIEWER_MODEL,
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
