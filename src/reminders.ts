// Drop-day reminders. For stores dropwatch will not poll (Pokemon Center,
// Target, Walmart...) the useful thing is to be on the page at the right
// minute, so a reminder fires the same alerts at a set time.

import type { Reminder } from "./types.js";

/** A reminder this far past its time is reported as missed, not fired. */
export const LATE_LIMIT_MS = 30 * 60 * 1000;

export function parseWhen(input: string, now: number): Date {
  const when = new Date(input);
  if (Number.isNaN(when.getTime())) {
    throw new Error(`could not read "${input}" as a date and time; use e.g. "2026-11-14 08:55"`);
  }
  if (when.getTime() <= now) throw new Error(`${input} is already in the past`);
  return when;
}

export function splitDue(
  reminders: Reminder[],
  now: number,
): { due: Reminder[]; missed: Reminder[]; pending: Reminder[] } {
  const due: Reminder[] = [];
  const missed: Reminder[] = [];
  const pending: Reminder[] = [];
  for (const r of reminders) {
    if (r.done) continue;
    const late = now - new Date(r.at).getTime();
    if (late < 0) pending.push(r);
    else if (late <= LATE_LIMIT_MS) due.push(r);
    else missed.push(r);
  }
  return { due, missed, pending };
}
