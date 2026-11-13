/**
 * A durable chat agent on agentlib, Restate's own agent library. Its run is
 * journaled: if the process dies mid-reply, Restate replays it, and a model
 * call or tool call that finished is not made again. A transfer waits for a
 * person's approval.
 *
 *   OPENAI_API_KEY=… node basic/agentlib.ts
 *   npx @restatedev/restate-server   # Restate, in another terminal
 *   npx @restatedev/restate deployments register http://localhost:9080
 *   curl localhost:8080/agentlib_assistant/alice/chat -d 'Hi, I am Alice. Is it warm in Lisbon?'
 *   curl localhost:8080/agentlib_assistant/alice/chat/send -d 'Send 50 euros to Bob'
 *   curl localhost:8080/agentlib_assistant/alice/pending      # the transfer waits
 *   curl localhost:8080/agentlib_assistant/alice/signal --json '{"name":"approval","value":"ok"}'
 */
import { serve, tool } from '@restatedev/agents';
import * as agentlib from '@restatedev/agents/agentlib';
import { z } from 'zod';

const weather = tool({
  name: 'get_weather',
  description: 'The current weather in a city.',
  input: z.object({ city: z.string() }),
  run: ({ city }) => `Sunny and 21°C in ${city}`, // a stand-in for a real weather API
});

const transfer = tool({
  name: 'transfer',
  description: 'Send money to someone.',
  input: z.object({ to: z.string(), euros: z.number() }),
  run: ({ to, euros }) => `Sent ${euros} euros to ${to}`,
});

const assistant = agentlib.agent({
  name: 'agentlib_assistant',
  system: 'You are a friendly assistant. Answer briefly.',
  tools: [weather, transfer],
  approval: ['transfer'], // waits for a person: `pending` lists it, `signal` answers it
});

await serve(assistant);
