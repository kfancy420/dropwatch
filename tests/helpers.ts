import type { FetchLike } from "../src/types.js";

export interface Route {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  /** Serve the body as a stream, the way a real fetch does. */
  chunked?: boolean;
}

function streamOf(text: string) {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return {
    getReader: () => ({
      read: async () => {
        if (at >= bytes.length) return { done: true };
        const value = bytes.subarray(at, at + 512);
        at += value.length;
        return { done: false, value };
      },
      cancel: async () => void (at = bytes.length),
    }),
  };
}

/** Fake fetch serving canned responses by URL; records every URL requested. */
export function fakeFetch(routes: Record<string, Route>): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    const route = routes[url] ?? { status: 404 };
    const status = route.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => route.headers?.[name.toLowerCase()] ?? null },
      text: async () => route.body ?? "",
      ...(route.chunked && { body: streamOf(route.body ?? "") }),
    };
  }) as FetchLike & { calls: string[] };
  impl.calls = calls;
  return impl;
}
