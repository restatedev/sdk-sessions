// Test only: @restatedev/agents/opencode/db, whose every boot of OpenCode has
// the scripted provider answering as the bank's teller (see ./opencode-teller.ts).
import * as db from '@restatedev/agents/opencode/db';
import { script, scriptedPlugin, teller } from '@restatedev/agents/test/fakes/opencode';

script.reply = teller;

export * from '@restatedev/agents/opencode/db';
export const openOpenCode: typeof db.openOpenCode = (database, fence, options) =>
  db.openOpenCode(database, fence, { ...options, plugins: [scriptedPlugin, ...(options.plugins ?? [])] });
