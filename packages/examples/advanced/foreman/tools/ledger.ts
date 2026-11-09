/**
 * The boss's ledger: each task's brief, and everything the boss's tools did to it, in the boss's
 * SQL database next to its conversation. The tools write it, never the model, and policy.ts
 * decides from it.
 */
import * as restate from '@restatedev/sessions';
import { z } from 'zod';
import { type Action, decide, type Event, stateOf, type Tier } from '../policy.ts';
import type { Brief } from '../prompts.ts';

export const SCHEMA = [
  `CREATE TABLE tasks (
     name       TEXT PRIMARY KEY,
     brief      TEXT NOT NULL,
     created_by TEXT NOT NULL
   )`,
  `CREATE TABLE ledger (
     seq    INTEGER PRIMARY KEY AUTOINCREMENT,
     id     TEXT NOT NULL UNIQUE,
     task   TEXT NOT NULL,
     tier   TEXT NOT NULL,
     kind   TEXT NOT NULL,
     passed INTEGER,
     detail TEXT NOT NULL
   )`,
];

/** What reads the ledger: a handler's context, or a view's. */
type Reader = { db: Pick<restate.SessionContext['db'], 'query'> };
type Writer = Pick<restate.SessionContext, 'db'>;

interface Row {
  task: string;
  tier: Tier;
  kind: Event['kind'];
  passed: number | null;
  detail: string;
}

const eventsOf = (ctx: Reader, task: string) =>
  ctx.db.query<Row>('SELECT task, tier, kind, passed, detail FROM ledger WHERE task = ? ORDER BY seq', [task]);

const asEvents = (rows: Row[]): Event[] => rows.map((r) => ({ kind: r.kind, tier: r.tier, passed: r.passed === 1 }));

export async function briefOf(ctx: Reader, task: string): Promise<Brief> {
  const [row] = await ctx.db.query<{ brief: string }>('SELECT brief FROM tasks WHERE name = ?', [task]);
  if (!row) throw new restate.TerminalError(`There is no task named "${task}".`);
  return JSON.parse(row.brief) as Brief;
}

/** Store a new task's brief, as tool call `id`'s. */
export async function addTask(ctx: Writer, id: string, brief: Brief) {
  await ctx.db.execute('INSERT OR IGNORE INTO tasks (name, brief, created_by) VALUES (?, ?, ?)', [
    brief.name,
    JSON.stringify(brief),
    id,
  ]);
}

/** Record what tool call `id` did. Its id makes it once: a crash that runs the call again updates the row. */
export async function record(
  ctx: Writer,
  id: string,
  task: string,
  tier: Tier,
  kind: Event['kind'],
  detail: string,
  passed?: boolean,
) {
  await ctx.db.execute(
    `INSERT INTO ledger (id, task, tier, kind, passed, detail) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET passed = excluded.passed, detail = excluded.detail`,
    [id, task, tier, kind, passed === undefined ? null : passed ? 1 : 0, detail],
  );
}

/**
 * The task's state and ledger, if policy.ts allows `action` on it. If not, the refusal is recorded
 * and becomes the tool's answer to the model, which can act on the reason.
 *
 * A tool call that already recorded passes: a crash ran it again after it got past the gate, and
 * the state it changed would otherwise refuse its own re-run.
 */
export async function gate(ctx: Writer, id: string, task: string, action: Action) {
  const rows = await eventsOf(ctx, task);
  const state = stateOf(asEvents(rows));
  const [mine] = await ctx.db.query('SELECT 1 FROM ledger WHERE id = ?', [id]);
  if (mine) return { state, rows };
  if (action === 'delegate' && !state.exists) {
    // Another call is handing out this name right now: its brief is stored, its answer isn't yet.
    const [row] = await ctx.db.query<{ created_by: string }>('SELECT created_by FROM tasks WHERE name = ?', [task]);
    if (row && row.created_by !== id) state.exists = true;
  }
  const decision = decide(task, state, action);
  if (!decision.ok) {
    // Under an id of its own: the call didn't get past the gate, so a re-run must meet it again.
    await record(ctx, `${id}:refused`, task, state.tier, 'refused', `${action}: ${decision.why}`);
    throw new restate.TerminalError(decision.why);
  }
  return { state, rows };
}

/** What a `checked` row's detail holds. */
export interface CheckDetail {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  outside: string[];
  stat?: string;
}

/** A row's detail on one line: for a check, its exit code, what fell outside Where, and the line that says why. */
function summary({ kind, detail }: Row) {
  if (kind !== 'checked') return detail.replace(/\s+/g, ' ');
  const c = JSON.parse(detail) as CheckDetail;
  const lines = c.output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const why = lines.find((l) => /error|assert|fail/i.test(l)) ?? lines.at(-1);
  return [`exit ${c.exitCode ?? 'killed'}`, c.outside.length > 0 && `outside Where: ${c.outside.join(', ')}`, why]
    .filter(Boolean)
    .join(' · ');
}

const cut = (text: string, max = 110) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** The `tasks` view: each task, who has it, how many attempts, and what its last check said. */
export async function tasksView(ctx: Reader) {
  const tasks = await ctx.db.query<{ name: string; brief: string }>('SELECT name, brief FROM tasks ORDER BY rowid');
  return Promise.all(
    tasks.map(async (t) => {
      const { tier, attempts, check, denied, status } = stateOf(asEvents(await eventsOf(ctx, t.name)));
      return {
        name: t.name,
        goal: cut((JSON.parse(t.brief) as Brief).goal, 60),
        tier,
        attempts,
        check,
        denied,
        status,
      };
    }),
  );
}

/** The `ledger` view: everything the boss's tools did, oldest first, a line each. */
export async function ledgerView(ctx: Reader) {
  const rows = await ctx.db.query<Row>('SELECT task, tier, kind, passed, detail FROM ledger ORDER BY seq');
  // `passed` only on checks: undefined is left out of the JSON.
  return rows.map((row) => ({
    task: row.task,
    tier: row.tier,
    kind: row.kind,
    passed: row.passed === null ? undefined : row.passed === 1,
    detail: cut(summary(row)),
  }));
}

// ── Shared by the tools ────────────────────────────────────────────────────────────────────────

export const taskName = z
  .string()
  .regex(/^[a-z0-9-]+$/)
  .describe('The task\'s name, such as "rename-getuser"');

/** An agent's answer, as the boss should read it. */
export const claim = (answer: string) =>
  `${answer}\n\n[foreman] Recorded. This is the agent's claim: run_check before you decide.`;
