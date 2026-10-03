// Keeps dropwatch on the public web.
//
// No address may lead to this computer or the home network, whether a person
// typed it in or a shop redirected to it. The check sits where the connection
// is opened, so nothing reaches the network without passing it. An address
// written as numbers is checked as written. A name is checked when it is
// looked up, so a name that points somewhere private is refused whenever it
// starts doing so.

import { lookup as dnsLookup } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";

import { Agent, buildConnector, fetch as undiciFetch } from "undici";

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
  // The same range as seen through an IPv6-only network's NAT64 gateway.
  PRIVATE.addSubnet(`64:ff9b::${network}`, 96 + bits, "ipv6");
}
for (const [network, bits] of [
  // Unspecified, loopback and the retired "IPv4-compatible" range.
  ["::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  // Teredo and 6to4 tunnels, which can carry a private IPv4 address inside.
  ["2001::", 32],
  ["2002::", 16],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
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

const unbracketed = (hostname: string) => bareHost(hostname).replace(/^\[|\]$/g, "");

/** True for a host that names this computer or the home network. */
export function isLocalHost(hostname: string): boolean {
  const host = unbracketed(hostname);
  if (isIP(host)) return isPrivateAddress(host);
  return host === "localhost" || /\.(localhost|local|internal|lan|home)$/.test(host);
}

function isLoopback(hostname: string): boolean {
  const host = unbracketed(hostname);
  return host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
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

export interface GuardOptions {
  /** Stands in for DNS in tests. */
  resolve?: LookupFunction;
  /** Lets the app's own tests reach a pretend shop on this computer (127.0.0.1, localhost). */
  allowLoopback?: boolean;
}

/** A fetch that only ever connects to the public web. */
export function guardedFetch(options: GuardOptions = {}): FetchLike {
  const checked = buildConnector({ lookup: publicOnly(options.resolve) });
  const unchecked = buildConnector({});
  const dispatcher = new Agent({
    // Every connection is opened here, whatever led to it.
    connect: (target, callback) => {
      if (options.allowLoopback && isLoopback(target.hostname)) return unchecked(target, callback);
      if (isLocalHost(target.hostname)) {
        return callback(new PrivateAddressError(`${target.hostname} is a private address`), null);
      }
      checked(target, callback);
    },
  });
  return ((url, init) => undiciFetch(url, { ...init, dispatcher })) as FetchLike;
}

let shared: FetchLike | undefined;

export const safeFetch: FetchLike = (url, init) => (shared ??= guardedFetch())(url, init);

/** True when a failed fetch was stopped by the guard. */
export function stoppedAsPrivate(err: unknown): boolean {
  for (let depth = 0; err instanceof Error && depth < 5; depth++) {
    if (err instanceof PrivateAddressError) return true;
    err = err.cause;
  }
  return false;
}
