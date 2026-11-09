/**
 * The boss's tools: one per move of the cascade, each asking policy.ts before it acts (ledger.ts's
 * `gate`), so the rules hold whatever the model thinks. There is no free-form "ask the worker" tool.
 */
import { runCheck } from './check.ts';
import { acceptTask, takeBackTask } from './close.ts';
import { correctTask } from './correct.ts';
import { delegateTask } from './delegate.ts';
import { escalateTask } from './escalate.ts';
import { reviewTask } from './review.ts';

export const tools = [delegateTask, runCheck, reviewTask, correctTask, escalateTask, acceptTask, takeBackTask];
