import { IncomingMessage, type Server } from 'node:http';
import { Socket } from 'node:net';

export interface LoopbackLocalAuthTransport {
  readonly kind: 'numeric-loopback-development';
  /** Called by the transport owner for the exact Fetch request it constructed,
   * before dispatch. Header values never manufacture socket/peer authority. */
  admit(request: Request, incoming: IncomingMessage, server: Server): void;
}
interface Context { readonly sourceKey: string }
interface Authority {
  readonly publicOrigin: string;
  readonly cookieName: 'sfw_dev_session';
  readonly context: (request: Request) => Context;
}
const owners = new WeakMap<LoopbackLocalAuthTransport, Authority>();
function unavailable(): never { throw new Error('Local authentication transport is unavailable'); }
function numericLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** Initial development transport only. A configured https origin is not TLS
 * evidence; public TLS and reverse proxies require a separately qualified
 * actual ingress adapter and are deliberately not supported by this factory. */
export function createLoopbackLocalAuthTransport(options: { publicOrigin: string }): LoopbackLocalAuthTransport {
  const origin = new URL(options.publicOrigin);
  if (origin.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(origin.hostname)
    || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) unavailable();
  const publicOrigin = origin.origin, host = origin.host;
  const boundHost = origin.hostname === '[::1]' ? '::1' : '127.0.0.1';
  const port = Number(origin.port || '80'), admitted = new WeakMap<Request, Context>();
  const transport: LoopbackLocalAuthTransport = Object.freeze({
    kind: 'numeric-loopback-development' as const,
    admit(request: Request, incoming: IncomingMessage, server: Server) {
      const address = server.address(), socket = incoming.socket;
      // The trusted composer supplies real incoming/listener objects. Its
      // ownership boundary is not protection against malicious host code.
      if (!(incoming instanceof IncomingMessage) || !(socket instanceof Socket)
        || !address || typeof address === 'string' || address.address !== boundHost || address.port !== port
        || socket.destroyed || socket.localPort !== port || !numericLoopback(socket.localAddress)
        || !numericLoopback(socket.remoteAddress) || incoming.headers.host !== host
        || request.headers.get('host') !== host || new URL(request.url).origin !== publicOrigin
        || request.method !== incoming.method) unavailable();
      // Source quotas are connection-owned and do not include ephemeral ports.
      // All peers of this explicitly local development listener share a bucket.
      admitted.set(request, Object.freeze({ sourceKey: 'numeric-loopback-development' }));
    },
  });
  owners.set(transport, Object.freeze({ publicOrigin, cookieName: 'sfw_dev_session' as const,
    context(request: Request) { return admitted.get(request) ?? unavailable(); },
  }));
  return transport;
}

/** Only a factory-owned transport supplies authority; an options callback or
 * request/proxy header cannot grant admission. */
export function localAuthTransportAuthority(transport: LoopbackLocalAuthTransport): Authority {
  return owners.get(transport) ?? unavailable();
}
