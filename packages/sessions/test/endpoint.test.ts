// Every way the SDK hands out a request handler serves a session object's
// invocations on the explicit recovery protocol, and its discovery as
// manifest v6: `endpoint.ts` wraps the class that `restate.endpoint()`,
// `restate.serve` and the tunnel behind `connect` all build theirs from.
//
// Over a real HTTP/2 server and client, which is what each of them has, with
// the core's fake runtime as Restate: the tunnel runs an `http2.createServer`
// of its own and hands the handler the request and response it makes
// (`tunnel/connection.js`).
import * as http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as restate from '@restatedev/sessions';
import { FakeRuntime } from './fake.ts';
import { output } from './side.ts';
import { messages } from './wire.ts';

const probe = restate.sessionObject({
  name: 'Probe',
  handlers: {
    greet: async (_ctx: restate.SessionContext, who: string) => `hello ${who}`,
  },
  views: {
    peek: async () => 'peeked',
  },
});

/** A journaled object beside it: the SDK goes on serving these. */
const plain = restate.object({
  name: 'Plain',
  handlers: { ping: async (_ctx: restate.ObjectContext) => 'pong' },
});

const MANIFEST_V5 = 'application/vnd.restate.endpointmanifest.v5+json';
const MANIFEST_V6 = 'application/vnd.restate.endpointmanifest.v6+json';

/** A server of `endpoint`'s handler, and an HTTP/2 client of it. */
async function serving(endpoint: { handler(): unknown }) {
  const server = http2.createServer(endpoint.handler() as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  return {
    client,
    close: async () => {
      client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let mixed: Awaited<ReturnType<typeof serving>>;
let alone: Awaited<ReturnType<typeof serving>>;

beforeAll(async () => {
  mixed = await serving(restate.endpoint().bind(probe).bind(plain));
  alone = await serving(restate.endpoint().bind(probe));
});

afterAll(async () => {
  await mixed.close();
  await alone.close();
});

/** A request's status, headers and body, once it ended. */
async function fetched(
  client: http2.ClientHttp2Session,
  headers: http2.OutgoingHttpHeaders,
): Promise<{ status: number; headers: http2.IncomingHttpHeaders; body: string }> {
  const request = client.request(headers);
  const head = Promise.withResolvers<http2.IncomingHttpHeaders>();
  request.on('response', (h) => head.resolve(h));
  const body: Buffer[] = [];
  request.on('data', (chunk: Buffer) => body.push(chunk));
  request.end();
  await new Promise<void>((resolve) => request.on('close', () => resolve()));
  const h = await head.promise;
  return { status: Number(h[':status']), headers: h, body: Buffer.concat(body).toString() };
}

/**
 * One invocation, as Restate makes it: the fake runtime's attempt over the
 * request, its answers written as they come, the request kept open — as
 * Restate keeps it — until the runtime closes its side.
 */
async function invoke(client: http2.ClientHttp2Session, path: string, key: string, input: unknown) {
  const rt = new FakeRuntime({ key, input: new TextEncoder().encode(JSON.stringify(input)) });
  const request = client.request({
    ':method': 'POST',
    ':path': path,
    ...Object.fromEntries(FakeRuntime.requestHeaders().map(({ key: k, value }) => [k, value])),
  });
  request.write(rt.startAttempt());
  const chunks: Buffer[] = [];
  const status = Promise.withResolvers<number>();
  request.on('response', (headers) => status.resolve(Number(headers[':status'])));
  let ended = false;
  const done = new Promise<void>((resolve) => {
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      rt.receive(chunk);
      const answer = rt.takeOutput();
      if (answer.length > 0) request.write(answer);
      // After the attempt's last message the runtime closes its side first.
      if (rt.isClosed() && !ended) {
        ended = true;
        request.end();
      }
    });
    request.on('close', () => resolve());
  });
  await done;
  rt.sdkClosed();
  expect(rt.violations()).toEqual([]);
  return { status: await status.promise, sent: messages(Buffer.concat(chunks)), rt };
}

describe('an endpoint the SDK built', () => {
  it('runs a session object on the explicit recovery protocol', async () => {
    const { status, sent, rt } = await invoke(mixed.client, '/invoke/Probe/greet', 'k1', 'world');
    expect(status).toBe(200);
    expect(output(sent)).toBe('"hello world"');
    expect(rt.status().status).toBe('completed');
  }, 30_000);

  it('runs a session object behind a prefixed deployment path', async () => {
    // The SDK matches the last three fragments, so these reach it too.
    const { status, sent } = await invoke(mixed.client, '/behind/a/prefix/invoke/Probe/greet', 'k2', 'again');
    expect(status).toBe(200);
    expect(output(sent)).toBe('"hello again"');
  }, 30_000);

  it('answers 415 to an invocation of a session object on another protocol', async () => {
    const { status, body } = await fetched(mixed.client, {
      ':method': 'POST',
      ':path': '/invoke/Probe/greet',
      'content-type': 'application/vnd.restate.invocation.v6',
    });
    expect(status).toBe(415);
    expect(body).toBe('');
  }, 30_000);

  it('leaves everything else to the SDK: a journaled object is still the SDK’s', async () => {
    // The SDK answers its own protocol's refusal: Plain is not routed here.
    const { status } = await fetched(mixed.client, {
      ':method': 'POST',
      ':path': '/invoke/Plain/ping',
      'content-type': 'application/vnd.restate.invocation.explicitrecovery.v1',
    });
    expect(status).toBe(415);
    const health = await fetched(mixed.client, { ':method': 'GET', ':path': '/health' });
    expect(health.status).toBe(200);
  }, 30_000);
});

/** The endpoint's manifest, as Restate asks for it. */
const discover = (client: http2.ClientHttp2Session, accept: string) =>
  fetched(client, { ':method': 'GET', ':path': '/discover', accept });

describe('discovery', () => {
  it('declares the session objects on the explicit recovery protocol, in manifest v6', async () => {
    const { status, headers, body } = await discover(alone.client, `${MANIFEST_V6}, ${MANIFEST_V5}`);
    expect(status).toBe(200);
    expect(headers['content-type']).toBe(MANIFEST_V6);
    const manifest = JSON.parse(body) as Record<string, unknown> & {
      services: { name: string; ty: string; handlers: { name: string; ty: string; protocolFamily?: string }[] }[];
    };
    expect(manifest.protocolMode).toBe('BIDI_STREAM');
    expect(manifest.explicitRecoveryProtocol).toEqual({ minVersion: 1, maxVersion: 1 });
    // Every handler is a session object's: no durable execution range.
    expect(manifest).not.toHaveProperty('minProtocolVersion');
    expect(manifest).not.toHaveProperty('maxProtocolVersion');
    const [service] = manifest.services;
    expect(service).toMatchObject({
      name: 'Probe',
      ty: 'VIRTUAL_OBJECT',
      enableLazyState: true,
      eagerStateKeysWhitelist: ['v22/head'],
    });
    expect(service!.handlers.map((h) => [h.name, h.ty, h.protocolFamily])).toEqual([
      ['greet', 'EXCLUSIVE', 'EXPLICIT_RECOVERY'],
      ['peek', 'SHARED', 'EXPLICIT_RECOVERY'],
    ]);
  }, 30_000);

  it('keeps the durable execution range for the journaled services beside them', async () => {
    const { status, body } = await discover(mixed.client, MANIFEST_V6);
    expect(status).toBe(200);
    const manifest = JSON.parse(body) as {
      minProtocolVersion?: number;
      maxProtocolVersion?: number;
      services: { name: string; handlers: { protocolFamily?: string }[] }[];
    };
    expect([manifest.minProtocolVersion, manifest.maxProtocolVersion]).toEqual([5, 8]);
    const plainService = manifest.services.find((s) => s.name === 'Plain')!;
    expect(plainService.handlers.every((h) => h.protocolFamily === undefined)).toBe(true);
  }, 30_000);

  it('tells a Restate that takes no manifest v6 that it is too old', async () => {
    const { status, body } = await discover(alone.client, MANIFEST_V5);
    expect(status).toBe(500);
    expect(body).toContain('the Restate server is too old');
  }, 30_000);

  it('an endpoint without session objects is the SDK’s, discovery included', async () => {
    const only = await serving(restate.endpoint().bind(plain));
    try {
      const { status, headers } = await discover(only.client, MANIFEST_V5);
      expect(status).toBe(200);
      expect(headers['content-type']).toBe(MANIFEST_V5);
    } finally {
      await only.close();
    }
  }, 30_000);
});
