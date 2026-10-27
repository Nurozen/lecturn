/**
 * Who may ask to pair: only a process on this machine talking to the
 * server directly. Each check closes a different door:
 *
 * - `Origin`: browsers attach it to cross-origin requests, so refusing it keeps
 *   any web page, including one served from localhost, from posting a
 *   registration through the user's browser.
 * - Forwarding and Tailscale headers: Tailscale Serve, Lecturn Connect and
 *   reverse proxies all reach the server from loopback, so a loopback socket
 *   alone does not mean a local caller.
 * - `Host`: a DNS-rebound page arrives with its own hostname.
 * - The socket's remote address: the server may listen on every interface.
 */
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

import { readRemoteAddressFromSource } from "../auth/utils.ts";
import { isLoopbackHostname } from "../http.ts";

export interface PairingPeer {
  /** Lower-cased names, as the HTTP server hands them over. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly remoteAddress: string | undefined;
}

export type PairingRefusal = "origin" | "forwarded" | "host" | "remote-address";

const FORWARDING_HEADERS: ReadonlySet<string> = new Set(["forwarded", "x-real-ip"]);

const isForwardingHeader = (name: string) =>
  FORWARDING_HEADERS.has(name) || name.startsWith("x-forwarded-") || name.startsWith("tailscale-");

const hostnameOf = (host: string): string | null => {
  // Userinfo or a path would let URL parsing pick a hostname the client never sent.
  if (!/^[^\s@/?#\\]+$/.test(host)) return null;
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
};

/** Already normalized by `readRemoteAddressFromSource`, so IPv4-mapped IPv6 arrives as IPv4. */
const isLoopbackAddress = (address: string) =>
  address === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address);

export const pairingRefusal = (peer: PairingPeer): PairingRefusal | null => {
  const names = Object.keys(peer.headers).filter((name) => peer.headers[name] !== undefined);
  if (names.includes("origin")) return "origin";
  if (names.some(isForwardingHeader)) return "forwarded";
  const host = peer.headers["host"];
  const hostname = host === undefined ? null : hostnameOf(host);
  if (hostname === null || !isLoopbackHostname(hostname)) return "host";
  if (peer.remoteAddress === undefined || !isLoopbackAddress(peer.remoteAddress)) {
    return "remote-address";
  }
  return null;
};

export const pairingPeerOf = (request: HttpServerRequest.HttpServerRequest): PairingPeer => ({
  headers: request.headers,
  remoteAddress: readRemoteAddressFromSource(request.source),
});
