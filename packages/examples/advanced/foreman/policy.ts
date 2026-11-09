/**
 * The rules of the boss's cascade, as pure functions: given what happened
 * to a task (its ledger), may the boss do this next, and if not, what should it do instead?
 *
 * The boss's tools call `decide` before they act, so a rule holds whatever the model thinks:
 *
 * - The worker never judges its own progress. A task is accepted on a check the
 *   boss ran, never on the agent's "done".
 * - Correct before you promote. A failed result goes back once to the same agent, which keeps its
 *   history. A tier gets MAX_ATTEMPTS hand-offs, the first brief and one correction, and then the
 *   task moves up.
 * - One rung per promotion. worker → senior, only after the worker's attempts failed their check,
 *   and only with the user's approval (the escalate tool waits for it).
 * - Taking it back. When the senior's attempts fail too, or the user declines to escalate, the task
 *   comes back to the boss. Execution doesn't go higher; the boss diagnoses and re-briefs, as a new task.
 *
 * Nothing here does I/O: the rules, and nothing but the rules.
 */

/** The rungs that do delegated work. The boss itself is the rung above: it diagnoses, it doesn't type. */
export type Tier = 'worker' | 'senior';

/** One row of a task's ledger, as the boss's tools record it. */
export type Event =
  /** The first brief, answered by the worker. */
  | { kind: 'delegated'; tier: Tier }
  /** The same agent sent back its result with the failure quoted, and answered. */
  | { kind: 'corrected'; tier: Tier }
  /** The user approved; the senior got the handoff brief, and answered. */
  | { kind: 'escalated'; tier: Tier }
  /** The user declined to escalate. */
  | { kind: 'denied'; tier: Tier }
  /** The boss ran the brief's verification command and looked at the diff. */
  | { kind: 'checked'; tier: Tier; passed: boolean }
  /** A second opinion on the diff, from the reviewer. */
  | { kind: 'reviewed'; tier: Tier }
  | { kind: 'accepted'; tier: Tier }
  | { kind: 'taken_back'; tier: Tier }
  /** The policy refused a move: kept for the record, it changes nothing. */
  | { kind: 'refused'; tier: Tier };

/** The hand-offs a tier gets: the first brief, and one sharper correction. */
export const MAX_ATTEMPTS = 2;

export interface TaskState {
  /** Whether the task was handed out at all. */
  exists: boolean;
  /** The tier working on it now. */
  tier: Tier;
  /** Hand-offs to the current tier: its first brief, then each correction. */
  attempts: number;
  /** The boss's last check since the last hand-off: what the current result is known to be. */
  check: 'none' | 'passed' | 'failed';
  /** Whether the user declined to escalate it. */
  denied: boolean;
  status: 'open' | 'accepted' | 'taken_back';
}

/** What a task's ledger says about it now. */
export function stateOf(events: readonly Event[]): TaskState {
  const state: TaskState = { exists: false, tier: 'worker', attempts: 0, check: 'none', denied: false, status: 'open' };
  for (const event of events) {
    switch (event.kind) {
      case 'delegated':
        Object.assign(state, { exists: true, tier: event.tier, attempts: 1, check: 'none' });
        break;
      case 'escalated':
        // A new tier starts its own count: the senior gets a first brief and one correction too.
        Object.assign(state, { tier: event.tier, attempts: 1, check: 'none', denied: false });
        break;
      case 'corrected':
        state.attempts += 1;
        state.check = 'none';
        break;
      case 'checked':
        state.check = event.passed ? 'passed' : 'failed';
        break;
      case 'denied':
        state.denied = true;
        break;
      case 'accepted':
      case 'taken_back':
        state.status = event.kind;
        break;
      case 'reviewed':
      case 'refused':
        break;
    }
  }
  return state;
}

/** What the boss can do to a task. */
export type Action = 'delegate' | 'check' | 'review' | 'correct' | 'escalate' | 'accept' | 'take_back';

/** Allowed, or not, with the reason and the move that is allowed instead, for the model to act on. */
export type Decision = { ok: true } | { ok: false; why: string };

const no = (why: string): Decision => ({ ok: false, why });

/** Whether the boss may do `action` to the task `name`, in `state`. */
export function decide(name: string, state: TaskState, action: Action): Decision {
  if (action === 'delegate') {
    return state.exists
      ? no(`A task named "${name}" exists. Send it back with correct_task, or give new work a new name.`)
      : { ok: true };
  }
  if (!state.exists) return no(`There is no task named "${name}". Hand it out with delegate_task first.`);
  if (state.status !== 'open') {
    return no(`"${name}" is ${state.status.replace('_', ' ')}. More work on it is a new task, with a new name.`);
  }

  const correction = `send it back once with correct_task, quoting the failure verbatim`;
  const exhausted = state.attempts >= MAX_ATTEMPTS;
  switch (action) {
    case 'check':
    case 'review':
    case 'take_back':
      return { ok: true };

    case 'accept':
      if (state.check === 'none') {
        return no(`Run run_check on "${name}" first. A task is accepted on its check, never on the agent's word.`);
      }
      if (state.check === 'failed') return no(`The last check of "${name}" failed: it cannot be accepted.`);
      return { ok: true };

    case 'correct':
      if (state.check === 'none') {
        return no(`Run run_check on "${name}" first: a correction quotes what failed, so it needs the evidence.`);
      }
      if (!exhausted) return { ok: true };
      return state.tier === 'worker'
        ? no(
            `The ${state.tier} had ${state.attempts} attempts at "${name}". More corrections won't help: ` +
              `escalate_task (it asks the user first), or take_back_task if the brief is wrong.`,
          )
        : no(
            `The senior had ${state.attempts} attempts at "${name}" too. Take it back (take_back_task): ` +
              `diagnose it yourself, then re-brief it as a new task.`,
          );

    case 'escalate':
      if (state.tier === 'senior') {
        return no(`"${name}" is already with the senior, the top delegated tier. Correct it, or take it back.`);
      }
      if (state.denied) return no(`The user declined to escalate "${name}". Take it back and report.`);
      if (state.check === 'none') return no(`Run run_check on "${name}" first: promotion needs evidence.`);
      if (state.check === 'passed') {
        return no(`The last check of "${name}" passed. Escalation is for failure: accept it, or correct it.`);
      }
      if (!exhausted) return no(`Correct before you promote: ${correction}.`);
      return { ok: true };
  }
  // Every action has its case above: a new one fails to compile here.
  throw new Error(`no rule for ${String(action satisfies never)}`);
}

/**
 * The changed files that fall outside the brief's `where`: a cascade trigger ("diff far outside
 * the brief's Where"). An entry is a file or a directory, relative to the workspace; `.` is all of it.
 */
export function outsideWhere(files: readonly string[], where: readonly string[]): string[] {
  const roots = where.map((w) => w.replace(/^\.\//, '').replace(/\/+$/, ''));
  if (roots.some((r) => r === '' || r === '.')) return [];
  return files.filter((f) => !roots.some((r) => f === r || f.startsWith(`${r}/`)));
}

/** Whether a reply to the approval signal says yes: `true`, or a text such as "yes", "approved" or "go ahead". */
export const approves = (reply: string) => /^\s*"?\s*(true|y|yes|ok|okay|approve|approved|go)\b/i.test(reply);
