// `serve`: the services of a program, on PORT, with what they need beside
// them (a library's objects, such as each @restatedev/agents agent's companion).
//
// A session object's invocation is served here, on the explicit recovery VM
// (`handler.ts`); everything else a deployment serves — discovery, the health
// check, a library's journaled objects — is the SDK's, as it was. See
// `docs/explicit-recovery.md` on why `connect` is not routed this way yet.
import * as http2 from 'node:http2';
import type { Http2ServerRequest, Http2ServerResponse } from 'node:http2';
import * as restate from '@restatedev/restate-sdk';
import { isRemote } from './calls.ts';
import { servedHere, serveSession, type Stream } from './handler.ts';
import { isSessionObject } from './object.ts';

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
export const serve = (...services: Service[]): Promise<number> => {
  const port = Number(process.env.PORT ?? 9080);
  const server = http2.createServer(http2Handler(...services));
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') reject(new TypeError('serve binds to a port'));
      else resolve(address.port);
    });
  });
};

/** The route of an invocation's path: `/invoke/<service>/<handler>`. */
function invokeRoute(url: string): { service: string; handler: string } | undefined {
  const parts = new URL(url, 'http://invoke').pathname.split('/').filter(Boolean);
  if (parts.length !== 3 || parts[0] !== 'invoke') return undefined;
  return { service: parts[1]!, handler: parts[2]! };
}

/** One invocation over HTTP/2, as {@link Stream}. */
function streamOf(request: Http2ServerRequest, response: Http2ServerResponse): Stream {
  return {
    headers: request.headers,
    body: request,
    writeHead: (status, headers) => void response.writeHead(status, headers),
    write: (chunk) => void response.write(chunk),
    close: () => void response.end(),
  };
}

/**
 * The HTTP/2 request handler of `services`, with what they need beside them:
 * a session object's invocation runs on the explicit recovery VM, and every
 * other request is the SDK's. For a server of your own:
 *
 *   http2.createServer(restate.http2Handler(notes, orders)).listen(9080);
 */
export function http2Handler(...services: Service[]): (req: Http2ServerRequest, res: Http2ServerResponse) => void {
  const all = served(services, process.env.RESTATE_SERVE_ONLY);
  const endpoint = restate.endpoint();
  for (const service of all) endpoint.bind(service);
  const sdk = endpoint.http2Handler();
  const sessions = new Map(all.filter((s) => isSessionObject(s)).map((s) => [s.name, s]));
  return (request, response) => {
    const route = invokeRoute(request.url ?? '');
    const definition = route === undefined ? undefined : sessions.get(route.service);
    // A Restate that speaks a protocol the VM does not take keeps the SDK's,
    // which serves it today.
    if (definition === undefined || route === undefined || !servedHere(request.headers)) {
      sdk(request, response);
      return;
    }
    serveSession(definition, route.handler, streamOf(request, response)).catch((error: unknown) => {
      // The attempt could not be served at all: the VM wrote nothing, so say so here.
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(error instanceof Error ? error.message : String(error));
    });
  };
}

/**
 * Connect out to Restate Cloud, rather than listening for it: the SDK's
 * `connect`, with the services it needs beside them, each once (the SDK's
 * own leaves them out, so an agent would run without its companion).
 *
 *   restate.connect({ services: [notes, orders], name: 'notes-v1' });
 *
 * `name` is the deployment you register (`connect://notes-v1`); the key is
 * RESTATE_CONNECT_KEY. RESTATE_SERVE_ONLY applies as it does to
 * {@link serve}. It returns the SDK's `Connection` and does not wait for
 * the handshake: `await restate.connect(…).ready` is what waits.
 */
export const connect = (options: ConnectOptions) =>
  restate.connect({ ...options, services: served(options.services, process.env.RESTATE_SERVE_ONLY) });

/** {@link connect}'s options: the SDK's, whose `services` this module completes. */
type ConnectOptions = Omit<Parameters<typeof restate.connect>[0], 'services'> & { services: Service[] };

/**
 * What {@link serve} serves of `services`: each with what it needs beside
 * it, once; with `names` (separated by commas), only the services it names,
 * each with what it needs beside it. For an endpoint of your own:
 *
 *   const endpoint = restate.endpoint();
 *   for (const service of restate.served([notes, orders])) endpoint.bind(service);
 */
export function served(services: Service[], names?: string): Service[] {
  // A handle names what another deployment serves. Binding one would register a
  // service with no handlers, over the real one: the collision, from inside.
  const handles = services.filter(isRemote).map((s) => s.name);
  if (handles.length > 0) {
    throw new Error(
      `${handles.join(', ')}: a remote handle names what another deployment serves, so it cannot be served here`,
    );
  }
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
