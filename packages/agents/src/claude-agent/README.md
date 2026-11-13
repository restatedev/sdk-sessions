# Claude Code

[Claude Code](https://code.claude.com), Anthropic's coding agent, through
the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk)
(`@anthropic-ai/claude-agent-sdk`), which runs Claude Code as a process of
its own: here one for each attempt of the agent's handler, whose
transcript (Claude Code's history, which it resumes from) is kept in the
object's SQL database, a row per line, beside the conversation of turns
([SQL in Restate virtual objects](../../../sessions/README.md)). The
integration pins the SDK exactly (0.3.322, with Claude Code 2.1.322), an
optional peer dependency.

**Not the `claude` integration.** [`@restatedev/agents/claude`](../claude/README.md)
is the Anthropic SDK's tool runner, in the handler's own process, with the
tools you give it: the lightest. This one runs Claude Code: its loop, its
history, its compaction, and, with a workspace, its own coding tools.

## Use

```ts
import { serve } from '@restatedev/agents';
import * as claudeAgent from '@restatedev/agents/claude-agent';

const coder = claudeAgent.agent({ name: 'coder', workspace: (ctx) => `/work/${ctx.key}` });
await serve(coder);
```

| Option      | What                                                                                                                                                                                                                                                                                |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`     | A Claude model id (`claude-sonnet-5-5`; `anthropic/` before it is left out); or else `MODEL`; or else none, and Claude Code takes its own default. With `ANTHROPIC_API_KEY` (or whatever Claude Code reads: `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`…), from the environment |
| `system`    | The system prompt; with a workspace, added to Claude Code's own (which tells the model about its tools). A changed `system` reaches a key's existing session                                                                                                                        |
| `tools`     | `tool()`s and Restate's tools of `@restatedev/agents` (`call`, `send`, `workflow`, `subagent`, `signal`), served to Claude Code from the handler's process (an in-process MCP server, `restate`: the model sees `mcp__restate__<name>`)                                             |
| `output`    | A zod object: the answer as data, which the agent replies with as JSON, and `chat` answers with (see [Structured answers](../../README.md#structured-answers))                                                                                                                      |
| `workspace` | A directory of the local machine, made if missing, where Claude Code works, with its own tools (Read, Write, Edit, Bash, Glob, Grep); or a function of the context that gives one (`(ctx) => \`/work/${ctx.key}\``). Use a sandbox. Without one, the agent has only `tools`         |
| `approval`  | With a workspace: `true` has every call of Claude Code's own tools wait for a person's approval, the signal `approval` ([Permissions](#permissions))                                                                                                                                |
| `retry`     | How often Claude Code asks the model again after a failure that passes (an outage, a rate limit): `maxRetries` (default 10, at most 15), `enabled: false` for none. Past them the attempt fails, and Restate's retry resumes the turn                                               |
| `effort`    | How much effort the model puts into each reply (`low` … `max`)                                                                                                                                                                                                                      |
| `maxTurns`  | The most model requests of a turn: past them, the turn fails                                                                                                                                                                                                                        |
| `sandbox`   | Claude Code's sandbox for its shell (the SDK's `sandbox` settings)                                                                                                                                                                                                                  |
| `env`       | Environment variables for Claude Code, over the handler's process's own                                                                                                                                                                                                             |

Claude Code loads no settings, `CLAUDE.md` or MCP servers from disk
(`settingSources: []`, `strictMcpConfig`), and leaves out its tools of
background work and of a person present: its subagents (`Agent`,
`Workflow`), background shells, scheduled wake-ups, questions to the user,
skills, plan mode, and web fetch and search. Restate's `subagent` tool is the
way to delegate: its calls are made once.

For a session object of your own, `claudeAgent.chat(options)` is the
handler and `claudeAgent.messages()` the view; `options` may be a function
of the invocation's context. `claudeAgent.prompt(ctx, text, options)`
answers a prompt in a handler of your own; `withClaudeAgent(ctx, options,
work)` runs `work` with `prompt(text)`, for more than one.

## Through crashes

Claude Code keeps its history in its transcript, a JSONL file, which it
resumes from. The SDK's `sessionStore` mirrors each line as Claude Code
writes it, and loads them back before a resumed process starts, in a fresh
config directory: here each line is a row of `ctx.db`
(`restate_agents_claude_agent_entries`), and the transaction that stores a
batch of lines also copies what is new of the turn into it (the model's
replies, the tools' results, a message steered to the turn): what clients
read (`messages`). The two never disagree after a crash. So:

- **A message is answered once per invocation** (`answerOnce`). A retried
  attempt of an answered prompt answers without starting Claude Code; so
  does one whose turn holds its final reply.
- **A tool runs only once its call is stored.** Claude Code starts a tool
  before its transcript's line reaches the store, but awaits a `PreToolUse`
  hook before every tool: the hook waits until the call is committed.
- **A crashed attempt's turn goes on.** A retry of a prompt that never
  reached the transcript submits it. One that did resumes its turn: each
  call it cut off gets a result first, stored in the transcript and the
  turn before Claude Code starts: a tool of yours is run again under the
  same call id, so its Restate calls are made once (their idempotency keys
  are the call's); a call of Claude Code's own tools gets Claude Code's own
  "interrupted" note, and the model decides. Then, if the transcript shows
  the turn ended (its final reply, an empty one too; a reply cut off at the
  output limit or declined; a request refused for good), the turn answers
  or fails as it did, without starting Claude Code: Claude Code would find
  nothing to go on with. Otherwise (the turn's messages end with the user's:
  its prompt, its calls' results; or with an outage's error), Claude Code
  goes on with the turn ("Continue from where you left off."), without a
  new prompt. A resumed Claude Code that writes nothing to its transcript
  for a minute (it writes as it sends its request) fails the attempt.
- **A tool's error fails the attempt**, and Restate retries it, resuming
  the turn; a `restate.TerminalError` of a `tool()` is its answer to the
  model.
- **A killed invocation's turn is closed, never finished**, in the
  conversation alone, by the next message or by the companion's `settle`,
  without Claude Code. The next prompt resumes the transcript, whose open
  calls Claude Code closes itself (its "interrupted" note), and tells the
  model how the turn before it ended, and which of its calls did happen
  (`(Ended: … These calls did happen: transfer (toolu_…).)`).
- **A stopped turn** (`stop`) interrupts Claude Code, which ends its turn
  without the model and records the stop in its transcript; the turn closes
  cancelled, and the next prompt tells the model.
- **An attempt that ends** (suspended, its connection lost) kills its
  Claude Code at once (SIGKILL): one only told to stop would finish the
  turn alone, asking the model again. The next attempt resumes the turn.
- **A provider's outage** is Claude Code's to retry (`retry`); past its
  retries the attempt fails, and the next resumes the turn.
- **A refused prompt** (a wrong API key, an unknown model) fails at once
  with a terminal error, 424, and closes its turn: Claude Code would ask
  again for minutes. A reply the model declines ends the turn (a terminal
  error), once Claude Code tried its own fallback model: on a refusal,
  Claude Code asks a fallback model of its choosing once, by itself.

**A message steered to the turn** (`steer`) is given to Claude Code as a
tool call returns (its `PostToolUse` hook, which Claude Code awaits): the
call's result is copied and published, and each waiting message is streamed
to Claude Code, which places it at its next step, after the round's
results. Its transcript's line stores it in the turn, once. One sent while
the model writes its final answer is answered as a turn of its own. So is
one Claude Code was given but did not place at a step (it queued it too
late): Claude Code would answer it after the turn, as a turn of its own,
so the process is killed as the turn ends (never kept), and anything of
such a turn it began is stored nowhere (`processes.dropped` counts them).

## Permissions

With a workspace, Claude Code's own tools run without asking within it:
edits there (`acceptEdits`), reads and searches, and the shell. What
Claude Code's rules ask about (an edit outside the workspace, say) is
denied, as nobody is present to answer (`permissionPrompts: 'none'`), and
the model is told.

With `approval: true`, every call of Claude Code's own tools waits for the
signal `approval` (`claudeAgent.APPROVAL`) to the agent, as a `signal()`
tool waits ([Signals](../../README.md#signals)): `pending` shows the wait
with the tool, its input and Claude Code's own title for the ask. `true`,
`{"approved": true}`, or a text such as `approved`, `yes` or `ok` allows the
call; anything else denies it, and the model is told why (`The user denied
tool "Write": <the text, or the reason>`).

```ts
claudeAgent.agent({ name: 'coder', workspace: (ctx) => `/work/${ctx.key}`, approval: true });
```

The wait outlasts a crash, or a suspension: the resumed turn gives the call
Claude Code's "interrupted" note, the model makes it again under a new id,
and the call, with the same tool and input, joins the wait. The person is
asked once, and the tool runs once, after the decision.

## Process reuse

Starting Claude Code takes about 0.4 s before its first model request; the
next message on a process already open, about 20 to 50 ms. So a process is
kept, idle, once its turn is answered, for the key's next turn in the same
deployment process (Restate runs one turn of a key at a time). It is only a
cache: the transcript in `ctx.db` stays what Claude Code is resumed from,
and a turn takes a kept process only if it holds the transcript exactly as
the store has it, its last line the store's last, and was started with the
same options. Otherwise the process is killed and the turn starts its own,
which resumes the transcript from the store: so a key whose turns move
between deployment processes (replicas, a serverless platform) is answered
as without reuse, and correctly, one start per move.

- A process's callbacks (our tools, the hooks, `canUseTool`, the store) are
  fixed at its start: each reaches the turn that holds the process now,
  with that turn's `ctx`.
- A process is kept only after a turn it answered, every line it wrote
  stored. One whose attempt ended mid-turn (suspended, its connection lost,
  killed, a crash), or whose turn was stopped, failed or refused, is killed:
  the next attempt resumes the turn in a process of its own.
- An idle process is closed after `idleMs` (60 s), and the least recently
  used past `maxIdle` (16): each holds about 200 MB.
- `spares` (0 by default) keeps that many processes started, for keys'
  first turns, so that those do not wait for a start either. A spare cannot
  resume a session (Claude Code's `prewarm`), so it only serves a key with
  none yet; its session's id is Claude Code's, stored with its first lines.
- `reuse: false` starts a process for every turn: for a platform that
  freezes a process between requests (AWS Lambda, say), where an idle Claude
  Code would be frozen too.

`claudeAgent.processes` counts the processes started for turns, the turns
that took a kept one, those that took a spare, and the turns Claude Code
began on its own that were dropped.

## Not yet

- Claude Code's subagents and background work (`Agent`, `Workflow`,
  background shells): left out, their recovery not mapped onto turns.
- `output` asked for in the prompt, as for most frameworks, not through
  Claude Code's structured outputs (`outputFormat`).

## Notes

- **A process per attempt**: Claude Code starts in about 0.4 s and holds
  about 200 MB while it runs. Its native binary (~350 MB) comes from the
  SDK's package for the platform. It runs on Node 22 and 24.
- **Two copies of each conversation**: the transcript's lines (Claude Code's
  own format, opaque to the integration but for what it copies) and the
  turn's items. Claude Code compacts its own history: `window`, `budget` and
  summaries do not apply.
- **Orphans**: on Linux with `setpriv` (util-linux), Claude Code dies with
  the handler's process (`--pdeathsig SIGKILL`). Elsewhere, a handler's
  process that dies (SIGKILL) leaves its Claude Code to make one more model
  request before it exits; it can run no tool (each waits for the dead
  process's hook) and stores nothing.
- **Undocumented behaviour it rests on**, each pinned by a test, so that an
  upgrade of the SDK fails loudly: resuming an interrupted turn without a
  prompt (`CLAUDE_CODE_RESUME_INTERRUPTED_TURN`, which Anthropic's own runner
  sets, with `CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS`, which the
  integration sets so that no remote setting decides it); the transcript's
  lines (a reply's line per content block, a steered message's
  `queued_command`, a result line chained after the transcript's last); the
  `sessionStore` (alpha); the 2 s grace of a process told to stop.
- **What would make it simpler**, to ask of the Claude Agent SDK: a
  documented option to resume an interrupted turn, with results for its
  cut-off calls; an option for the store's `projectKey` (today the sanitized
  working directory); and a guarantee that a tool call's line reaches the
  store before the tool runs.

## Run

```sh
cd packages/examples && ANTHROPIC_API_KEY=… node basic/claude-agent.ts
```

With a Restate server, and the agent registered with it: see
[Run an example](../../../examples/README.md#run-an-example).

## Tests

The tests run Claude Code itself on a scripted model,
[`test/fakes/claude-agent.ts`](../../test/fakes/claude-agent.ts): the
teller of the Claude agent's tests, served as the Messages API on a local
port, streaming (`pnpm --filter @restatedev/agents test claude-agent`):

- [`test/claude-agent.test.ts`](../../test/claude-agent.test.ts): each point
  above, with crashes that stop an attempt in a tool call (twice in a row
  too), at the turn's end, or at any of its state requests, and kills; a
  stop, an ended attempt (no model request after it), refusals, outages, a
  declined reply, `maxTurns`, asking again for `output`, the system prompt
  and the model, `messages`, `clear`, steering, the workspace and its
  permissions (approved, denied, through a crash), and Claude Code dying
  with its parent.
- [`test/claude-agent.ts`](../../test/claude-agent.ts): the bank agent,
  through crashes and kills in [the crash test](../../../e2e/crash.ts)
  (`pnpm --filter e2e crash`).
