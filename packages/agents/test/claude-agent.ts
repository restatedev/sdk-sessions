// The bank agent on Claude Code (@restatedev/agents/claude-agent): a
// ClaudeCodeAgent object per conversation, whose tools (./bank.ts) move money
// in the ledger.
//
// Environment: PORT (default 9080), ANTHROPIC_API_KEY (or ANTHROPIC_BASE_URL
// of a model of your own), MODEL, and ABORT_PER_MILLE (see ../faults.ts).
import { sessionObject } from '@restatedev/agents';
import * as claudeAgent from '@restatedev/agents/claude-agent';
import { serveIfMain } from '@restatedev/sessions/test/faults';
import { ledger } from '@restatedev/sessions/test/ledger';
import { bank } from './bank.ts';

/** Answer a message, once per invocation. */
export const prompt = claudeAgent.chat({
  system: 'You keep the books of a bank, with your tools. Answer briefly.',
  tools: bank('ClaudeCodeAgent'),
});

export const agent = sessionObject({
  name: 'ClaudeCodeAgent',
  handlers: { chat: prompt },
  views: { messages: claudeAgent.messages() },
});

serveIfMain(import.meta, [agent, ledger]);
