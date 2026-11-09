/**
 * Chat with a big model that hands work to smaller ones and checks what comes back. The boss runs a
 * cascade: each task starts on the cheapest model that can do it, and moves up only on evidence.
 *
 *   you ──chat──▶ boss (GPT-6 Astra)       plans, briefs, checks, decides
 *                  ├─ worker   (GPT-6 Luna)        the cheap tier, in the workspace
 *                  ├─ senior   (GPT-6.1 Sol)       one rung up, only with your approval
 *                  └─ reviewer (GPT-6 Sol)         a second opinion on a diff, read-only
 *
 * The boss gets one tool per move of the cascade (tools/), and each asks policy.ts first:
 *
 * - a brief has a goal, invariants, the paths it may change, acceptance criteria and the exact check;
 * - a task is accepted on a check the boss ran itself (the brief's command, and the diff against
 *   the brief's Where), never on the agent's "done";
 * - a failed result goes back once to the same agent, then moves up one rung, and only after you
 *   approve: the boss waits on a signal, without holding a process.
 *
 * The ledger (what happened to each task) is written by the tools, not the model, in the boss's SQL
 * database next to its conversation. Every agent is a session object, so a crash, or a day spent
 * waiting for your approval, loses nothing.
 *
 *   OPENAI_API_KEY=… WORKSPACE=… node advanced/foreman/foreman.ts      # see README.md
 */
import { serve, sessionObject } from '@restatedev/agents';
import * as pi from '@restatedev/agents/pi';
import { reviewer, senior, worker } from './agents.ts';
import { BOSS } from './prompts.ts';
import { tools } from './tools/index.ts';
import { ledgerView, SCHEMA, tasksView } from './tools/ledger.ts';

const boss = sessionObject({
  name: 'boss',
  schema: SCHEMA,
  handlers: {
    chat: pi.chat({ model: process.env.BOSS_MODEL ?? 'openai/gpt-6-astra', system: BOSS, tools }),
  },
  views: {
    messages: pi.messages(),
    /** Each task: who has it, how many attempts, what its last check said. A view: it answers while the boss works. */
    tasks: tasksView,
    /** Everything the boss's tools did, refusals included, oldest first. */
    ledger: ledgerView,
  },
});

await serve(boss, worker, senior, reviewer);
