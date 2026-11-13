// @restatedev/agents/agentlib: an agent of Restate's agentlib
// (@restatedev/agentlib) in a virtual object of the classic Restate SDK,
// journaled and replayed, with the handlers and views of every agent here.
//
//   const assistant = agentlib.agent({ name: 'assistant', tools: [weather] });
//   await serve(assistant);
//
// The modules: agent.ts (the object, its handlers and views), runtime.ts (a
// turn, from start to end), turn.ts (a turn's messages and the model's
// conversation), steering.ts, messages.ts (the messages clients read),
// model.ts, tools.ts (the tools of @restatedev/agents, made agentlib's), and
// state.ts (the object's state).
export { agent } from './agent.ts';
export { DEFAULT_MODEL } from './model.ts';
export type { Definition, Options } from './options.ts';
export type { AgentlibContext, AgentlibTool, Approval, Tools } from './tools.ts';
