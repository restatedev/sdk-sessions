/**
 * A durable chat agent on agentlib (@restatedev/agentlib), Restate's own agent
 * library: a virtual object of the classic Restate SDK, its run journaled, its
 * conversation in the object's state. Its tools are agentlib's.
 *
 * Each key is a conversation of its own. If the process dies mid-reply,
 * Restate replays the run from its journal: a model call or a tool call that
 * finished is not made again. A transfer waits for a person's approval.
 *
 *   OPENAI_API_KEY=… node basic/agentlib.ts
 *   npx @restatedev/restate-server   # Restate, in another terminal
 *   npx @restatedev/restate deployments register http://localhost:9080
 *   curl localhost:8080/agentlib_assistant/alice/chat -d 'Hi, I am Alice. Is it warm in Lisbon?'
 *   curl localhost:8080/agentlib_assistant/alice/chat/send -d 'Send 50 euros to Bob'
 *   curl localhost:8080/agentlib_assistant/alice/pending                 # the transfer waits
 *   curl localhost:8080/agentlib_assistant/alice/signal --json '{"name": "approval", "value": "approved"}'
 *   curl localhost:8080/agentlib_assistant/alice/messages
 */
import { asyncTool } from '@restatedev/agentlib';
import { serve } from '@restatedev/agents';
import * as agentlib from '@restatedev/agents/agentlib';
import { z } from 'zod';

const assistant = agentlib.agent({
  name: 'agentlib_assistant',
  system: 'You are a friendly assistant. Answer briefly.',
  tools: {
    get_weather: asyncTool({
      description: 'The current weather in a city.',
      input: z.object({ city: z.string() }),
      // A stand-in for a real weather API.
      execute: async ({ city }) => `Sunny and 21°C in ${city}`,
    }),
    transfer: asyncTool({
      description: 'Send money to someone.',
      input: z.object({ to: z.string(), euros: z.number() }),
      // Waits for the signal `approval`: `pending` lists it, `signal` approves or denies it.
      needsApproval: true,
      execute: async ({ to, euros }, { callId }) => `Sent ${euros} euros to ${to} (transfer ${callId})`,
    }),
  },
});

await serve(assistant);
