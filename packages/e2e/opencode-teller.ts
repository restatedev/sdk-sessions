// Test only: the OpenCode agent's process gets the teller, as the others get
// theirs from @restatedev/agents/test/fakes/fakes (which crash.ts imports
// first): OpenCode's model comes from a plugin, not from a module an import
// hook can swap, so @restatedev/agents/opencode/db is swapped for
// ./opencode-db.ts, whose every boot of OpenCode has the scripted provider of
// @restatedev/agents/test/fakes/opencode, answering as the teller.
//
//   MODEL=scripted/scripted node --import @restatedev/agents/test/fakes/fakes --import ./opencode-teller.ts serve.ts opencode
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const wrapper = new URL('./opencode-db.ts', import.meta.url).href;
// What `@restatedev/agents/opencode` imports as ./db.ts.
const db = new URL(import.meta.resolve('@restatedev/agents/opencode/db')).href;
if (!fileURLToPath(db).endsWith('.ts')) throw new Error(`@restatedev/agents/opencode/db is ${db}, not its source`);

registerHooks({
  resolve(specifier, context, next) {
    const resolved = next(specifier, context);
    if (context.parentURL === wrapper || resolved.url !== db) return resolved;
    return { ...resolved, url: wrapper };
  },
});
