// A session object's handlers are on the explicit recovery protocol (version
// 1), which the published SDK does not speak: this package serves them, and
// the discovery that declares them, ahead of the SDK's request handler. Every
// other request — a library's journaled objects, the health check — is the
// SDK's, unchanged.
//
//   - `/discover`: manifest v6, the SDK's manifest with `protocolFamily:
//     EXPLICIT_RECOVERY` on every session object's handler, the range of the
//     protocol the addon's VM speaks (`explicitRecoveryProtocol`), and the
//     durable execution range only if a handler is on that protocol.
//   - `/invoke/<object>/<handler>` of a session object: an attempt on the VM
//     (`handler.ts`); a request of another protocol is answered 415.
//   - A SIGTERM ends the attempts under way with an unasked
//     `ShutdownMessage`, and refuses new ones with 503 while the process goes
//     away.
//
// The SDK builds its own VM per invocation, and the dispatch that does it is
// module-private: there is no supported seam. What every transport does share
// is one class — `restate.endpoint()` returns a `NodeEndpoint`, and the tunnel
// behind `connect` builds `new NodeEndpoint()` of its own — and the request
// handler it hands out. So this wraps that class's four ways of producing one.
//
// It is a patch on another package's prototype, which is worth naming plainly.
// It touches four methods whose contract is "give me a request handler", and
// the handler it returns is the SDK's own for everything but a session
// object's invocations and the discovery that names them.
import * as http2 from 'node:http2';
import type { Http2ServerRequest, Http2ServerResponse } from 'node:http2';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as restate from '@restatedev/restate-sdk';
import { goAway, serveSession, type Stream } from './handler.ts';
import { isSessionObject, PROTOCOL_FAMILY } from './object.ts';
import { explicitRecoveryProtocolRange, Identity, type VmHeader } from './vm.ts';

/** Marks the prototype this package has already wrapped. */
const PATCHED = Symbol.for('restate-sessions.endpoint-patched') as unknown as string;

/** What this package needs of the SDK's endpoint, which its types do not say. */
interface Endpoint {
  builder: {
    serviceDefinitions: Map<string, object>;
    keySet: string[];
    journalValueCodecProvider?: unknown;
    build(): { discoveryMetadata: Manifest };
  };
  handler(options?: { bidirectional?: boolean }): (request: never, response: never) => void;
  http2Handler(options?: { bidirectional?: boolean }): (request: never, response: never) => void;
  http1Handler(options?: { bidirectional?: boolean }): (request: never, response: never) => void;
  listen(port?: number): Promise<number>;
}

/** The session objects bound to `endpoint`, by name. */
function sessionsOf(endpoint: Endpoint): Map<string, { name: string }> {
  const bound = new Map<string, { name: string }>();
  for (const [name, definition] of endpoint.builder.serviceDefinitions) {
    if (isSessionObject(definition)) bound.set(name, definition as { name: string });
  }
  return bound;
}

/**
 * What an endpoint with session objects cannot also have. Each would need a
 * second way of running an attempt, and there is none any more.
 */
function refuseWhatTheVmCannotServe(endpoint: Endpoint, sessions: Map<string, unknown>): void {
  if (sessions.size === 0) return;
  if (endpoint.builder.journalValueCodecProvider !== undefined) {
    throw new Error(
      '@restatedev/sessions: a journal value codec is not supported for session objects: ' +
        'their attempts are never replayed, and nothing of theirs is journaled to encode',
    );
  }
}

/** The request's headers, as the verifier takes them. */
function headersOf(headers: Readonly<Record<string, string | string[] | undefined>>): VmHeader[] {
  return Object.entries(headers).flatMap(([key, value]) =>
    value === undefined ? [] : [{ key, value: Array.isArray(value) ? (value[0] ?? '') : value }],
  );
}

/** The SDK's manifest, as far as this module reads and changes it. */
interface Manifest {
  minProtocolVersion?: number;
  maxProtocolVersion?: number;
  services: { name: string; handlers: { name: string; protocolFamily?: string }[] }[];
  [field: string]: unknown;
}

/** The content type of manifest v6, the first with protocol families. */
const MANIFEST_V6 = 'application/vnd.restate.endpointmanifest.v6+json';

/**
 * Manifest v6 of `endpoint`, served in `protocolMode`: its SDK manifest, with
 * every session object's handler on the explicit recovery protocol. Throws
 * if the endpoint cannot serve them: a session object needs a bidirectional
 * stream (HTTP/2).
 */
export function manifestV6(
  endpoint: { builder: Endpoint['builder'] },
  protocolMode: 'BIDI_STREAM' | 'REQUEST_RESPONSE',
): Record<string, unknown> {
  const sessions = sessionsOf(endpoint as Endpoint);
  const sdk = endpoint.builder.build().discoveryMetadata;
  const services = sdk.services.map((service) =>
    sessions.has(service.name)
      ? { ...service, handlers: service.handlers.map((h) => ({ ...h, protocolFamily: PROTOCOL_FAMILY })) }
      : service,
  );
  const handlers = services.flatMap((service) => service.handlers);
  const explicit = handlers.filter((handler) => handler.protocolFamily === PROTOCOL_FAMILY);
  if (explicit.length > 0 && protocolMode !== 'BIDI_STREAM') {
    throw new Error(
      `@restatedev/sessions: session objects need a bidirectional stream (HTTP/2): the explicit recovery ` +
        `protocol is not served over request/response (${[...sessions.keys()].join(', ')})`,
    );
  }
  const { minProtocolVersion, maxProtocolVersion, services: _, ...rest } = sdk;
  // The durable execution range only if a handler speaks that protocol.
  const durable = explicit.length < handlers.length || handlers.length === 0;
  return {
    ...rest,
    protocolMode,
    ...(durable ? { minProtocolVersion, maxProtocolVersion } : {}),
    ...(explicit.length > 0 ? { explicitRecoveryProtocol: explicitRecoveryProtocolRange() } : {}),
    services,
  };
}

/** Answer `/discover` with manifest v6, if Restate takes it (`accept`). */
function discover(
  endpoint: Endpoint,
  protocolMode: 'BIDI_STREAM' | 'REQUEST_RESPONSE',
  accept: string | string[] | undefined,
  response: Http2ServerResponse | ServerResponse,
): void {
  const fail = (status: number, message: string) => {
    (response as Http2ServerResponse).writeHead(status, { 'content-type': 'text/plain' });
    response.end(message);
  };
  const accepted = Array.isArray(accept) ? accept.join(',') : (accept ?? '');
  if (!accepted.includes(MANIFEST_V6)) {
    fail(
      500,
      '@restatedev/sessions: the Restate server is too old: session objects use the explicit recovery protocol, ' +
        `which needs discovery protocol version 6 (it accepts ${accepted || 'nothing'})`,
    );
    return;
  }
  let manifest: Record<string, unknown>;
  try {
    manifest = manifestV6(endpoint, protocolMode);
  } catch (error) {
    fail(500, (error as Error).message);
    return;
  }
  (response as Http2ServerResponse).writeHead(200, {
    'content-type': MANIFEST_V6,
    'x-restate-server': 'restate-sdk-typescript (@restatedev/sessions)',
  });
  response.end(JSON.stringify(manifest));
}

/** Whether the process is going away (a SIGTERM): new attempts are refused. */
let draining = false;
let watching = false;

/**
 * On a SIGTERM, end the attempts under way with an unasked `ShutdownMessage`
 * (Restate starts each again, elsewhere, with no retry counted) and refuse
 * new ones with 503, which Restate retries with a backoff: by then this port
 * is gone. With no other SIGTERM listener the process then goes, as it
 * would have without this one.
 */
function watchSigterm(): void {
  if (watching) return;
  watching = true;
  process.on('SIGTERM', onSigterm);
}

/** What {@link watchSigterm} does on a SIGTERM. */
function onSigterm(): void {
  draining = true;
  const ended = goAway();
  if (process.listenerCount('SIGTERM') > 1) return;
  process.removeListener('SIGTERM', onSigterm);
  // A moment for the shutdowns to reach the socket, then the signal's own end.
  setTimeout(() => process.kill(process.pid, 'SIGTERM'), ended > 0 ? 200 : 0);
}

/** What the SDK answers a request whose signature does not verify: nothing runs. */
function unauthorized(response: Http2ServerResponse | ServerResponse): void {
  (response as Http2ServerResponse).writeHead(401, { 'content-type': 'text/plain' });
  response.end('Unauthorized');
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
 * The path of `url` and the route it names, as the SDK reads it: the last
 * three fragments. Nothing if it names no invocation, or is no path at all —
 * `//` is a URL with an empty host, which `URL` refuses. Restate sends none
 * of those, but anything that reaches the port can, and this runs in the
 * request listener, where a throw is an `uncaughtException`.
 */
function parse(url: string): { path: string; service: string; handler: string } | undefined {
  let path;
  try {
    path = new URL(url, 'http://invoke').pathname;
  } catch {
    return undefined;
  }
  const parts = path.split('/');
  if (parts.length < 3 || parts[parts.length - 3] !== 'invoke') return undefined;
  const service = parts[parts.length - 2]!;
  const handler = parts[parts.length - 1]!;
  return service === '' || handler === '' ? undefined : { path, service, handler };
}

/** The route of an invocation's path, as the SDK reads it. */
export function invokeRoute(url: string): { service: string; handler: string } | undefined {
  const route = parse(url);
  return route === undefined ? undefined : { service: route.service, handler: route.handler };
}

/** The path of `url`, if it is one; `undefined` for anything `URL` refuses. */
function pathOf(url: string): string | undefined {
  try {
    return new URL(url, 'http://invoke').pathname;
  } catch {
    return undefined;
  }
}

/**
 * `sdk`, with a session object's invocations run on the VM instead, and the
 * discovery that declares them answered here. A request that is neither —
 * the health check, a library's journaled objects — is the SDK's, unchanged.
 */
function routing(
  endpoint: Endpoint,
  sdk: (request: never, response: never) => void,
  bidirectional: (request: { httpVersionMajor?: number }) => boolean,
): (request: Http2ServerRequest | IncomingMessage, response: Http2ServerResponse | ServerResponse) => void {
  const sessions = sessionsOf(endpoint);
  refuseWhatTheVmCannotServe(endpoint, sessions);
  if (sessions.size > 0) watchSigterm();
  // The SDK verifies a request's signature in the handler this routes ahead
  // of, so a request served here is verified here instead. Every `connect`
  // has keys: its key carries the signing key, and the SDK refuses one that
  // does not.
  const identity = endpoint.builder.keySet.length > 0 ? new Identity(endpoint.builder.keySet) : undefined;
  // `null` is a verified request, as the addon answers `None` with: a
  // deployment without keys verifies nothing, and stands for the same.
  const unsigned = (path: string, request: { headers: IncomingMessage['headers'] }) =>
    identity === undefined ? null : identity.verify(path, headersOf(request.headers));
  return (request, response) => {
    if (sessions.size === 0) {
      sdk(request as never, response as never);
      return;
    }
    const url = request.url ?? '';
    const path = pathOf(url);
    if (path !== undefined && path.split('/').at(-1) === 'discover') {
      if (unsigned(path, request) !== null) return unauthorized(response);
      discover(endpoint, bidirectional(request) ? 'BIDI_STREAM' : 'REQUEST_RESPONSE', request.headers.accept, response);
      return;
    }
    const route = parse(url);
    const definition = route === undefined ? undefined : sessions.get(route.service);
    if (definition === undefined || route === undefined) {
      sdk(request as never, response as never);
      return;
    }
    if (unsigned(route.path, request) !== null) return unauthorized(response);
    if (draining) {
      // Going away: before any VM or user code runs. Restate counts a retry
      // and backs off, and the next attempt reaches the process that replaces
      // this one. The body is not drained: it stays open on this protocol.
      (response as Http2ServerResponse).writeHead(503, {});
      response.end();
      return;
    }
    serveSession(
      definition,
      route.handler,
      streamOf(request as Http2ServerRequest, response as Http2ServerResponse),
    ).catch((error: unknown) => {
      // The attempt could not be served at all: the VM wrote nothing.
      if (!response.headersSent) (response as Http2ServerResponse).writeHead(500, { 'content-type': 'text/plain' });
      response.end(error instanceof Error ? error.message : String(error));
    });
  };
}

/**
 * Wrap the SDK's endpoint class, once per process, so that every request
 * handler it hands out routes a session object's invocations to the VM.
 * Called by {@link sessionObject}: the package declares `sideEffects: false`,
 * so this cannot be the work of an import.
 */
export function patchEndpoint(): void {
  const prototype = Object.getPrototypeOf(restate.endpoint()) as Record<string, unknown>;
  if (prototype[PATCHED] === true) return;
  const missing = (['handler', 'http2Handler', 'http1Handler', 'listen'] as const).filter(
    (method) => typeof prototype[method] !== 'function',
  );
  if (missing.length > 0) {
    throw new Error(
      `@restatedev/sessions runs a session object's invocations by wrapping the SDK's endpoint, which this SDK ` +
        `version does not have (${missing.join(', ')}): use the @restatedev/restate-sdk that @restatedev/sessions pins`,
    );
  }

  // The SDK's own defaults: HTTP/2 is bidirectional unless told otherwise,
  // HTTP/1.1 only when asked.
  const wrap = (
    method: 'handler' | 'http2Handler' | 'http1Handler',
    mode: (set: boolean | undefined, request: { httpVersionMajor?: number }) => boolean,
  ) => {
    const original = prototype[method] as Endpoint['handler'];
    prototype[method] = function (this: Endpoint, options?: { bidirectional?: boolean }) {
      const sdk = original.call(this, options);
      return routing(this, sdk, (request) => mode(options?.bidirectional, request)) as never;
    };
  };
  // `handler` dispatches per request, so the rule is the one for that
  // request's protocol; a handler built for one protocol knows it already.
  wrap('handler', (set, request) => ((request.httpVersionMajor ?? 2) >= 2 ? set !== false : set === true));
  wrap('http2Handler', (set) => set !== false);
  wrap('http1Handler', (set) => set === true);

  // `listen` builds its server from the module's own handler, not from
  // `http2Handler`, so wrapping it is building the server here.
  prototype.listen = function (this: Endpoint, port?: number): Promise<number> {
    const chosen = port ?? Number(process.env.PORT ?? 9080);
    const server = http2.createServer(this.http2Handler() as never);
    return new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(chosen, () => {
        const address = server.address();
        if (address === null || typeof address === 'string') reject(new TypeError('listen binds to a port'));
        else resolve(address.port);
      });
    });
  };
  prototype[PATCHED] = true;
}
