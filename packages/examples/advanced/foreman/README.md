# A foreman: a big model that delegates to small ones

You chat with a boss on a big model. It hands bounded work to agents on cheaper models, checks
what they hand back itself, and moves a task to a stronger model only when the cheaper one failed,
and only after you approve. The boss runs a cascade: each task starts on the cheapest model that
can do it, and moves up only on evidence.

```
you ──chat──▶ boss (GPT-6 Astra)      plans, briefs, checks, decides
               ├─ worker   (GPT-6 Luna)       the cheap tier: bounded tasks, in the workspace
               ├─ senior   (GPT-6.1 Sol)      one rung up, only after you approve
               └─ reviewer (GPT-6 Sol)        a second opinion on a diff, read-only
```

The rules hold in code, not only in the boss's prompt. The boss has no free-form "ask the worker"
tool: it has one tool per move ([`tools/`](tools/index.ts)), and each asks
[`policy.ts`](policy.ts) before it acts. A refused move is the tool's answer to the model, with the
reason, and the model goes on.

| Rule                                                | Held by                                                                                                                                   |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| A brief has a goal, invariants, Where, and a check  | `delegate_task`'s input: no command to check it, no delegation                                                                            |
| Never accept "done" on the agent's word             | `accept_task` needs a passing `run_check`: the brief's own command, and the changed files against the brief's Where                       |
| Correct before you promote                          | `correct_task` sends the result back to the same agent, which keeps its history; `escalate_task` is refused until a correction failed too |
| One rung at a time, with your say-so                | `escalate_task` waits for your `approval` signal; the senior gets a handoff built from the ledger: the diff stat, the failure verbatim    |
| Take it back when the top tier fails, or you say no | `correct_task` and `escalate_task` refuse; `take_back_task` closes the task                                                               |

Every move, refusals included, goes into a ledger in the boss's SQL database
([`tools/ledger.ts`](tools/ledger.ts)), written by the tools and never by the model. Each agent is a
session object with its conversation in its own database: a crash, or a day waiting for your
approval, loses nothing. A task is keyed `<boss key>.<task name>`, so a correction goes back to the
same agent, and tasks with different names run at once.

## Run it

The agents' coding tools (read, write, edit, bash) and the boss's checks run on this machine, not
in a sandbox, in `WORKSPACE`: give it a throwaway clone of a git repository, never one you care
about. The boss's checks read git, to see what changed.

```sh
OPENAI_API_KEY=… WORKSPACE=/tmp/throwaway-clone node advanced/foreman/foreman.ts
npx @restatedev/restate-server                                         # 1.8 or later, in another terminal
npx @restatedev/restate deployments register http://localhost:9080

curl localhost:8080/boss/acme/chat -d 'Rename getUser to fetchUser across src/, and make sure the tests pass'
curl localhost:8080/boss/acme/tasks      # each task: its tier, its attempts, its last check
curl localhost:8080/boss/acme/ledger     # every move, refusals included
curl localhost:8080/boss/acme/pending    # an escalation, waiting for you
curl localhost:8080/boss/acme/signal --json '{"name": "approval", "value": "yes"}'
curl localhost:8080/worker/acme.<task>/messages   # what the worker was asked, and what it did
```

`chat` answers once the boss is done, so watch `ledger` from another terminal. `BOSS_MODEL`,
`WORKER_MODEL`, `SENIOR_MODEL` and `REVIEWER_MODEL` change the models. The reviewer is stronger
than the worker it reviews; a reviewer on another provider's model would catch more of a model's
blind spots.

## The files

| File                           | What                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| [`foreman.ts`](foreman.ts)     | The boss, its views (`tasks`, `ledger`), and `serve`                                 |
| [`agents.ts`](agents.ts)       | The worker, the senior and the reviewer, and how the boss's tools reach them         |
| [`tools/`](tools/index.ts)     | The boss's tools, one per move, and the ledger with its policy gate                  |
| [`policy.ts`](policy.ts)       | The rules, as pure functions of a task's ledger                                      |
| [`prompts.ts`](prompts.ts)     | Every text a model reads: the system prompts, the brief, the correction, the handoff |
| [`workspace.ts`](workspace.ts) | The boss's own checks: the brief's command, and git's diff                           |

Writers share the one workspace, so the boss hands out writing tasks one at a time.
