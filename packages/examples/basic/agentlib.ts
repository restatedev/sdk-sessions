/**
 * A durable chat agent on agentlib (@restatedev/agentlib), Restate's own agent
 * library: a virtual object of the classic Restate SDK, its run journaled, its
 * conversation in the object's state. It takes the tools of @restatedev/agents,
 * as every agent does, beside agentlib's own.
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
import { serve, tool } from '@restatedev/agents';
import * as agentlib from '@restatedev/agents/agentlib';
import { z } from 'zod';

// A tool, for any framework's agent (as in chat.ts).
const weather = tool({
  name: 'get_weather',
  description: 'The current weather in a city.',
  input: z.object({ city: z.string() }),
  // A stand-in for a real weather API.
  run: async ({ city }) => `Sunny and 21°C in ${city}`,
});

const assistant = agentlib.agent({
  name: 'agentlib_assistant',
  system: 'You are a friendly assistant. Answer briefly.',
  // Beside it, a tool of agentlib's own, by the name the model calls it.
  tools: [
    weather,
    {
      transfer: asyncTool({
        description: 'Send money to someone.',
        input: z.object({ to: z.string(), euros: z.number() }),
        // Waits for the signal `approval`: `pending` lists it, `signal` approves or denies it.
        needsApproval: true,
        execute: async ({ to, euros }, { callId }) => `Sent ${euros} euros to ${to} (transfer ${callId})`,
      }),
    },
  ],
});

await serve(assistant);
