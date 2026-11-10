/**
 * A durable chat agent on OpenCode 2.2, embedded in the handler: its
 * session, messages and events live in a database of the key's own, beside
 * the object's. OpenCode needs Node 24.
 *
 * Each key is a conversation of its own. If the process dies mid-reply,
 * Restate retries the call and OpenCode resumes the turn it was in.
 *
 *   OPENAI_API_KEY=… node basic/opencode.ts
 *   npx @restatedev/restate-server   # Restate, in another terminal
 *   npx @restatedev/restate deployments register http://localhost:9080
 *   curl localhost:8080/opencode_assistant/alice/chat -d 'Hi, I am Alice. Is it warm in Lisbon?'
 */
import { serve, tool } from '@restatedev/agents';
import * as opencode from '@restatedev/agents/opencode';
import { z } from 'zod';

// A tool, for any framework's agent (the framework's own tools work too).
const weather = tool({
  name: 'get_weather',
  description: 'The current weather in a city.',
  input: z.object({ city: z.string() }),
  // A stand-in for a real weather API.
  run: async ({ city }) => `Sunny and 21°C in ${city}`,
});

// No workspace: the agent has only its tools, none of OpenCode's coding tools.
const assistant = opencode.agent({
  name: 'opencode_assistant',
  system: 'You are a friendly assistant. Answer briefly.',
  tools: [weather],
});

await serve(assistant);
