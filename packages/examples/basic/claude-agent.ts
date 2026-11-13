/**
 * A durable chat agent on Claude Code (the Claude Agent SDK), which runs as
 * a process of its own for each attempt: its transcript lives in the
 * object's SQL database, line by line.
 *
 * Each key is a conversation of its own, with a workspace of its own, where
 * Claude Code's own tools (read, write, edit, bash, glob, grep) work. If the
 * process dies mid-reply, Restate retries the call and Claude Code goes on
 * with the turn it was in, from the stored transcript.
 *
 *   ANTHROPIC_API_KEY=… node basic/claude-agent.ts
 *   npx @restatedev/restate-server   # Restate, in another terminal
 *   npx @restatedev/restate deployments register http://localhost:9080
 *   curl localhost:8080/claude_code/alice/chat -d 'Write a haiku about Lisbon to haiku.txt, then read it back.'
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, tool } from '@restatedev/agents';
import * as claudeAgent from '@restatedev/agents/claude-agent';
import { z } from 'zod';

// A tool, for any framework's agent: Claude Code calls it as `mcp__restate__get_weather`.
const weather = tool({
  name: 'get_weather',
  description: 'The current weather in a city.',
  input: z.object({ city: z.string() }),
  // A stand-in for a real weather API.
  run: async ({ city }) => `Sunny and 21°C in ${city}`,
});

const coder = claudeAgent.agent({
  name: 'claude_code',
  system: 'Answer briefly.',
  tools: [weather],
  // Each key's own directory: use a sandbox (a container, say) for anything that matters.
  workspace: (ctx) => join(tmpdir(), 'claude-code-workspaces', ctx.key),
});

await serve(coder);
