// robots.txt check. dropwatch only fetches a URL when the site's robots.txt
// allows it for our user agent (or for "*").
//
// Matching follows RFC 9309: the most specific user-agent group wins, then the
// longest matching rule wins, and Allow beats Disallow on a tie.

import { politeGet, SourceError } from "./http.js";
import type { FetchLike } from "./types.js";

interface Rule {
  allow: boolean;
  pattern: string;
}

const AGENT_TOKEN = "dropwatch";

export function parseRobots(text: string): Map<string, Rule[]> {
  const groups = new Map<string, Rule[]>();
  let agents: string[] = [];
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === "user-agent") {
      if (!lastWasAgent) agents = [];
      agents.push(value.toLowerCase());
      if (!groups.has(value.toLowerCase())) groups.set(value.toLowerCase(), []);
      lastWasAgent = true;
    } else if (field === "allow" || field === "disallow") {
      lastWasAgent = false;
      // An empty Disallow means "nothing is disallowed".
      if (value === "") continue;
      for (const agent of agents) {
        groups.get(agent)?.push({ allow: field === "allow", pattern: value });
      }
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

function patternToRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

export function isAllowed(robotsText: string, pathAndQuery: string): boolean {
  const groups = parseRobots(robotsText);
  const rules = groups.get(AGENT_TOKEN) ?? groups.get("*") ?? [];
  let best: Rule | undefined;
  for (const rule of rules) {
    if (!patternToRegExp(rule.pattern).test(pathAndQuery)) continue;
    if (
      !best ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow)
    ) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}

const cache = new Map<string, { text: string; fetchedAt: number }>();
const CACHE_MS = 24 * 60 * 60 * 1000;
/** RFC 9309 asks crawlers to read at least 500 KiB of a robots.txt. */
const ROBOTS_MAX_BYTES = 512 * 1024;

/** Throws SourceError("robots") when the site's robots.txt disallows the URL. */
export async function assertRobotsAllowed(
  url: string,
  fetchImpl?: FetchLike,
): Promise<void> {
  const u = new URL(url);
  const cached = cache.get(u.origin);
  let text: string;
  if (cached && Date.now() - cached.fetchedAt < CACHE_MS) {
    text = cached.text;
  } else {
    try {
      text = await politeGet(`${u.origin}/robots.txt`, fetchImpl, {
        accept: "text/plain",
        maxBytes: ROBOTS_MAX_BYTES,
        truncate: true,
      });
    } catch (err) {
      // No robots.txt means no restrictions. Anything else (blocked, rate
      // limited, unreachable) is a refusal we respect.
      if (err instanceof SourceError && err.kind === "not_found") text = "";
      else throw err;
    }
    cache.set(u.origin, { text, fetchedAt: Date.now() });
  }
  if (!isAllowed(text, u.pathname + u.search)) {
    throw new SourceError(
      "robots",
      `${u.host} disallows automated access to ${u.pathname} in its robots.txt; dropwatch will not check it`,
    );
  }
}

/**
 * Fetches a page the site's robots.txt allows. If the site redirects, each
 * address on the way is checked against its own robots.txt too.
 */
export async function getAllowed(url: string, fetchImpl?: FetchLike, accept?: string): Promise<string> {
  await assertRobotsAllowed(url, fetchImpl);
  return politeGet(url, fetchImpl, {
    accept,
    onRedirect: (next) => assertRobotsAllowed(next, fetchImpl),
  });
}

export function clearRobotsCache(): void {
  cache.clear();
}
