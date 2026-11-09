// Test only: the AI SDK provider package of the scripted model (./opencode.ts),
// which OpenCode imports from this file (no npm in the workerd profile). Its
// models are never used: the plugin's `language` hook replaces them.
export function createCarrier() {
  return {
    languageModel: () => {
      throw new Error('the carrier has no models: the language hook gives the model');
    },
  };
}
