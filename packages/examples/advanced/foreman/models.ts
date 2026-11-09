/**
 * The models, and a registry that knows the boss's: pi-ai's catalog (1.4.0) stops at Claude Fable
 * 5.1, so Fable 5.2 is added to its Anthropic provider, as 5.1 with its own id. Once pi-ai lists
 * it, `models` can go.
 */
import { createModels } from '@earendil-works/pi-ai/models';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';

export const BOSS_MODEL = process.env.BOSS_MODEL ?? 'anthropic/claude-fable-5-2';
export const WORKER_MODEL = process.env.WORKER_MODEL ?? 'anthropic/claude-sonnet-5-5';
export const SENIOR_MODEL = process.env.SENIOR_MODEL ?? 'anthropic/claude-sonnet-5-5';
export const REVIEWER_MODEL = process.env.REVIEWER_MODEL ?? 'anthropic/claude-sonnet-5-5';

/** Anthropic's models, with the ones pi-ai doesn't list yet. */
function anthropic() {
  const provider = anthropicProvider();
  const known = provider.getModels();
  const base = known.find((m) => m.id === 'claude-fable-5-1');
  const extra =
    base && !known.some((m) => m.id === 'claude-fable-5-2')
      ? [{ ...base, id: 'claude-fable-5-2', name: 'Claude Fable 5.2' }]
      : [];
  return {
    ...provider,
    getModels: () => [...provider.getModels(), ...extra],
    getAllModels: () => [...(provider.getAllModels?.() ?? provider.getModels()), ...extra],
  };
}

/** A registry for `model`, if it is Anthropic's; for another provider's, the agent's default. */
export function modelsOf(model: string) {
  if (!model.startsWith('anthropic/')) return undefined;
  const models = createModels();
  models.setProvider(anthropic());
  return models;
}
