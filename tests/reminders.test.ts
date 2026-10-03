import { describe, expect, it } from "vitest";

import { parseWhen, splitDue } from "../src/reminders.js";
import type { Reminder } from "../src/types.js";

const at = (iso: string, done = false): Reminder => ({
  id: iso,
  name: "drop",
  url: "https://www.pokemoncenter.com/",
  at: iso,
  done,
});
const now = Date.parse("2026-11-14T09:00:00Z");

describe("reminders", () => {
  it("sorts reminders into due, missed and pending", () => {
    const { due, missed, pending } = splitDue(
      [
        at("2026-11-14T08:59:00Z"),
        at("2026-11-14T08:00:00Z"),
        at("2026-11-14T10:00:00Z"),
        at("2026-11-14T08:58:00Z", true),
      ],
      now,
    );
    expect(due.map((r) => r.at)).toEqual(["2026-11-14T08:59:00Z"]);
    expect(missed.map((r) => r.at)).toEqual(["2026-11-14T08:00:00Z"]);
    expect(pending.map((r) => r.at)).toEqual(["2026-11-14T10:00:00Z"]);
  });

  it("rejects unreadable and past times", () => {
    expect(() => parseWhen("next tuesday-ish", now)).toThrow(/could not read/);
    expect(() => parseWhen("2026-11-13T09:00:00Z", now)).toThrow(/in the past/);
    expect(parseWhen("2026-11-15T09:00:00Z", now).toISOString()).toBe("2026-11-15T09:00:00.000Z");
  });
});
