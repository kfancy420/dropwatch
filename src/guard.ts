// Keeps dropwatch on the public web.
//
// A shop's address, or one it redirects to, must not lead to this computer or
// the home network. An address written as numbers is checked as written. A
// name is checked when it is looked up, at the moment of connecting, so a name
// that points somewhere private is refused whenever it starts doing so.

import { lookup as dnsLookup } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";

import { Agent, fetch as undiciFetch } from "undici";

import { bareHost } from "./retailers.js";
import type { FetchLike } from "./types.js";

const PRIVATE = new BlockList();
for (const [network, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  // Multicast, reserved and broadcast.
  ["224.0.0.0", 3],
] as const) {
  PRIVATE.addSubnet(network, bits, "ipv4");
}
for (const [network, bits] of [
  // Unspecified, loopback and the retired "IPv4-compatible" range.
  ["::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  PRIVATE.addSubnet(network, bits, "ipv6");
}

/** True for an IP address that is not on the public internet. */
export function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/%.*$/, "");
  const family = isIP(bare);
  if (!family) return false;
  // An IPv4 address wrapped in IPv6 (::ffff:127.0.0.1) is held to the IPv4 list.
  return PRIVATE.check(bare, family === 6 ? "ipv6" : "ipv4");
}

/** True for a host that names this computer or the home network. */
export function isLocalHost(hostname: string): boolean {
  const host = bareHost(hostname).replace(/^\[|\]$/g, "");
  if (isIP(host)) return isPrivateAddress(host);
  return host === "localhost" || /\.(localhost|local|internal|lan|home)$/.test(host);
}

export class PrivateAddressError extends Error {
  readonly code = "EPRIVATE";
}

/** A DNS lookup that fails when any address behind the name is private. */
export function publicOnly(resolve: LookupFunction = dnsLookup as LookupFunction): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, options, (err, address, family) => {
      if (!err) {
        const found = typeof address === "string" ? [address] : address.map((a) => a.address);
        if (found.some(isPrivateAddress)) {
          err = new PrivateAddressError(`${hostname} leads to a private address`);
        }
      }
      callback(err, address, family);
    });
  };
}

/**
 * A fetch that connects to private addresses only when the address itself
 * says so (localhost, 192.168.1.20), which a person has to type in on purpose.
 */
export function guardedFetch(resolve?: LookupFunction): FetchLike {
  const anywhere = new Agent();
  const publicWeb = new Agent({ connect: { lookup: publicOnly(resolve) } });
  return ((url, init) =>
    undiciFetch(url, {
      ...init,
      dispatcher: isLocalHost(hostnameOf(url)) ? anywhere : publicWeb,
    })) as FetchLike;
}

let shared: FetchLike | undefined;

export const safeFetch: FetchLike = (url, init) => (shared ??= guardedFetch())(url, init);

/** True when a failed fetch was stopped by publicOnly. */
export function stoppedAsPrivate(err: unknown): boolean {
  for (let depth = 0; err instanceof Error && depth < 5; depth++) {
    if (err instanceof PrivateAddressError) return true;
    err = err.cause;
  }
  return false;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
