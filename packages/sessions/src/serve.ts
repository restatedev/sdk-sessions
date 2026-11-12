// `serve`: the services of a program, on PORT, with what they need beside
// them (a library's objects, such as each @restatedev/agents agent's companion).
import * as restate from '@restatedev/restate-sdk';

type Service = restate.ServeOptions['services'][number];

/** Where a definition keeps the services it needs served beside it: see {@link needing}. */
const NEEDS = Symbol.for('restate-sessions.needs');

/**
 * `definition`, which needs `services` served beside it: {@link serve}
 * serves them too. For a library whose objects call one of their own (an
 * agent's companion, say).
 */
export const needing = <D extends object>(definition: D, services: () => Service[]): D =>
  Object.defineProperty(definition, NEEDS, { value: services });

/**
 * Serve `services` on PORT (default 9080), with the services they need
 * beside them, each once. RESTATE_SERVE_ONLY, names separated by commas
 * (`triage,planner`), serves only those of them, each with what it needs
 * beside it: one program (or image), deployed in parts.
 *
 *   await restate.serve(notes, orders);
 */
export const serve = (...services: Service[]) =>
  restate.serve({ services: served(services, process.env.RESTATE_SERVE_ONLY), port: Number(process.env.PORT ?? 9080) });

/**
 * What {@link serve} serves of `services`: each with what it needs beside
 * it, once; with `names` (separated by commas), only the services it names,
 * each with what it needs beside it. For an endpoint of your own:
 *
 *   const endpoint = restate.endpoint();
 *   for (const service of restate.served([notes, orders])) endpoint.bind(service);
 */
export function served(services: Service[], names?: string): Service[] {
  const all = withNeeds(services);
  const wanted = (names ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (wanted.length === 0) return all;
  const known = all.map((s) => s.name);
  const unknown = wanted.filter((name) => !known.includes(name));
  if (unknown.length > 0) {
    throw new Error(`RESTATE_SERVE_ONLY names ${unknown.join(', ')}: the services are ${known.join(', ')}`);
  }
  return withNeeds(all.filter((s) => wanted.includes(s.name)));
}

/** `services`, each with what it needs beside it, once. */
function withNeeds(services: Service[]): Service[] {
  const all = new Map<string, Service>();
  const add = (service: Service) => {
    if (all.has(service.name)) return;
    all.set(service.name, service);
    for (const needed of (service as { [NEEDS]?: () => Service[] })[NEEDS]?.() ?? []) add(needed);
  };
  services.forEach(add);
  return [...all.values()];
}
