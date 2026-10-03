// One polite GET for every source.
//
// dropwatch identifies itself honestly and never disguises itself as a
// browser. When a site answers with a block or a rate limit we report it and
// back off; we do not try to get around it.

import { bareHost, refusedHost } from "./retailers.js";
import type { FetchLike } from "./types.js";

export const USER_AGENT =
  "dropwatch (personal restock notifier; one request per item per interval; github.com/kfancy420/dropwatch)";

export const SOURCE_ERROR_KINDS = [
  "blocked",
  "rate_limited",
  "not_found",
  "robots",
  "restricted",
  "network",
  "bad_response",
  "config",
] as const;

export type SourceErrorKind = (typeof SOURCE_ERROR_KINDS)[number];

export class SourceError extends Error {
  constructor(
    public readonly kind: SourceErrorKind,
    message: string,
    /** Seconds the server asked us to wait (Retry-After), when it said so. */
    public readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
/** Product pages run to a megabyte or two. Anything far past that is not one. */
const MAX_BODY_BYTES = 5 * 1024 * 1024;

export interface GetOptions {
  accept?: string;
  maxBytes?: number;
  /** Keep the first maxBytes of a longer answer instead of failing. */
  truncate?: boolean;
  /** Told each address a redirect leads to before it is fetched. Throw to refuse it. */
  onRedirect?(url: string): Promise<void>;
}

type Response = Awaited<ReturnType<FetchLike>>;

/**
 * Fetches a URL. Redirects are followed by hand, a few at most, so that every
 * address on the way is held to the same rules as the first one.
 */
export async function politeGet(
  url: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  options: GetOptions = {},
): Promise<string> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let current = url;
  for (let hop = 0; ; hop++) {
    const answer = await getOnce(current, fetchImpl, options, signal);
    if ("body" in answer) return answer.body;
    if (hop >= MAX_REDIRECTS) {
      throw new SourceError("bad_response", `${hostOf(url)} redirects too many times`);
    }
    const next = redirectTarget(current, answer.location);
    await options.onRedirect?.(next);
    current = next;
  }
}

async function getOnce(
  url: string,
  fetchImpl: FetchLike,
  options: GetOptions,
  signal: AbortSignal,
): Promise<{ body: string } | { location: string }> {
  const refused = refusedHost(hostnameOf(url));
  if (refused) {
    throw new SourceError(
      "restricted",
      `${refused} does not allow automated checks, so dropwatch will not ask ${hostOf(url)}`,
    );
  }
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: options.accept ?? "application/json, text/html;q=0.9",
      },
      signal,
      redirect: "manual",
    });
  } catch (err) {
    throw new SourceError(
      "network",
      `could not reach ${hostOf(url)}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (res.ok) return { body: await readBody(res, url, options) };

  discard(res);
  const location = res.headers.get("location");
  if (res.status >= 300 && res.status < 400 && location) return { location };

  const retryAfterSec = retryAfterSeconds(res.headers.get("retry-after"));
  if (res.status === 429) {
    throw new SourceError(
      "rate_limited",
      `${hostOf(url)} asked us to slow down (429)`,
      retryAfterSec,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new SourceError(
      "blocked",
      `${hostOf(url)} refused the request (${res.status}); it does not allow automated checks`,
      retryAfterSec,
    );
  }
  if (res.status === 404 || res.status === 410) {
    throw new SourceError("not_found", `${url} was not found (${res.status})`);
  }
  throw new SourceError(
    "network",
    `${hostOf(url)} answered ${res.status}`,
    retryAfterSec,
  );
}

function redirectTarget(from: string, location: string): string {
  let next: URL;
  try {
    next = new URL(location, from);
  } catch {
    throw new SourceError("bad_response", `${hostOf(from)} redirects to an address that makes no sense`);
  }
  if (next.protocol !== "https:" && next.protocol !== "http:") {
    throw new SourceError("bad_response", `${hostOf(from)} redirects away from the web`);
  }
  // A shop on the internet has no business sending us to this computer or the home network.
  if (isLocalHost(next.hostname) && !isLocalHost(hostnameOf(from))) {
    throw new SourceError("bad_response", `${hostOf(from)} redirects to a private address`);
  }
  next.hash = "";
  return next.href;
}

async function readBody(res: Response, url: string, options: GetOptions): Promise<string> {
  const max = options.maxBytes ?? MAX_BODY_BYTES;
  const tooLarge = () =>
    new SourceError("bad_response", `${hostOf(url)} sent more than dropwatch will read`);

  const declared = Number(res.headers.get("content-length"));
  if (!options.truncate && Number.isFinite(declared) && declared > max) {
    discard(res);
    throw tooLarge();
  }
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    if (text.length <= max) return text;
    if (options.truncate) return text.slice(0, max);
    throw tooLarge();
  }

  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > max) {
        if (!options.truncate) throw tooLarge();
        text += decoder.decode(value.subarray(0, value.byteLength - (size - max)), { stream: true });
        void reader.cancel().catch(() => {});
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch (err) {
    void reader.cancel().catch(() => {});
    if (err instanceof SourceError) throw err;
    throw new SourceError(
      "network",
      `${hostOf(url)} stopped answering part way: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return text + decoder.decode();
}

/** Lets go of an answer we will not read. */
function discard(res: Response): void {
  void res.body?.cancel?.().catch(() => {});
}

/** Retry-After is either a number of seconds or a date. */
function retryAfterSeconds(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds > 0 ? seconds : undefined;
  const at = Date.parse(header);
  if (Number.isNaN(at)) return undefined;
  const wait = Math.ceil((at - Date.now()) / 1000);
  return wait > 0 ? wait : undefined;
}

function isLocalHost(hostname: string): boolean {
  const host = bareHost(hostname).replace(/^\[|\]$/g, "");
  if (host.includes(":")) return host === "::1" || /^(fc|fd|fe80)/.test(host);
  return (
    host === "localhost" ||
    host === "0.0.0.0" ||
    /\.(localhost|local|internal|lan|home)$/.test(host) ||
    /^(127|10)\.\d+\.\d+\.\d+$/.test(host) ||
    /^192\.168\.\d+\.\d+$/.test(host) ||
    /^169\.254\.\d+\.\d+$/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host)
  );
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
