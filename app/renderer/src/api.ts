// Talking to the background process, and the small clocks the screens share.

import { useEffect, useState, useSyncExternalStore } from "react";

import type { AppState, Bridge, MethodName, Methods } from "../../shared/types.js";

declare global {
  interface Window {
    dropwatch: Bridge;
  }
}

/** Runs one action in the background process. Rejects with a message fit to show. */
export async function call<K extends MethodName>(
  method: K,
  ...args: Parameters<Methods[K]>
): Promise<ReturnType<Methods[K]>> {
  const result = await window.dropwatch.call(method, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

export function useAppState(): AppState | undefined {
  const [state, setState] = useState<AppState>();
  useEffect(() => {
    const stop = window.dropwatch.onState(setState);
    void call("getState").then(setState);
    return stop;
  }, []);
  return state;
}

// One timer for every "12s ago" on screen.
const listeners = new Set<() => void>();
let now = Date.now();
let timer: number | undefined;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  timer ??= window.setInterval(() => {
    now = Date.now();
    listeners.forEach((l) => l());
  }, 1000);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}

export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now);
}

export function ago(at: number, current: number): string {
  const sec = Math.max(0, Math.round((current - at) / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  return hr < 24 ? `${hr} hr ago` : `${Math.round(hr / 24)} d ago`;
}

export function until(at: number, current: number): string {
  const sec = Math.max(0, Math.round((at - current) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  const hr = Math.round(min / 60);
  return hr < 48 ? `${hr} hr` : `${Math.round(hr / 24)} days`;
}

export function price(value: number): string {
  return `$${value.toFixed(2)}`;
}
