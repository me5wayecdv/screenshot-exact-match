import { describe, expect, it } from "vitest";

import {
  approvedIds,
  displayName,
  pendingCount,
  pendingTeacherNames,
  splitRoster,
  waitingOn,
} from "@/lib/enrollment";

const row = (id: string, status: string, name = `طالب ${id}`) => ({
  student_id: id,
  full_name: name,
  status,
});

describe("splitRoster", () => {
  it("separates pending, approved and rejected without losing anyone", () => {
    const split = splitRoster([row("a", "pending"), row("b", "approved"), row("c", "rejected")]);
    expect(split.pending.map((r) => r.student_id)).toEqual(["a"]);
    expect(split.approved.map((r) => r.student_id)).toEqual(["b"]);
    expect(split.rejected.map((r) => r.student_id)).toEqual(["c"]);
  });

  // The column arrives with a default for old rows; an unknown value must be
  // treated as "not decided yet", never as "already mine".
  it("treats an unknown status as pending, never as approved", () => {
    const split = splitRoster([row("a", "something_else"), row("b", ""), row("c", "APPROVED")]);
    expect(split.approved).toEqual([]);
    expect(split.pending).toHaveLength(3);
  });

  it("handles a null or empty roster", () => {
    expect(splitRoster(null).approved).toEqual([]);
    expect(splitRoster(undefined).pending).toEqual([]);
  });
});

describe("approvedIds", () => {
  it("is the publish audience: pending and rejected students are excluded", () => {
    const rows = [row("a", "approved"), row("b", "pending"), row("c", "rejected")];
    expect(approvedIds(rows)).toEqual(["a"]);
  });

  it("returns nothing when every request is still waiting", () => {
    expect(approvedIds([row("a", "pending"), row("b", "pending")])).toEqual([]);
  });
});

describe("pendingCount", () => {
  it("counts only requests waiting for a decision", () => {
    expect(pendingCount([row("a", "pending"), row("b", "approved")])).toBe(1);
  });
});

describe("displayName", () => {
  it("never shows an empty cell for a nameless request", () => {
    expect(displayName({ full_name: "   " })).toBe("—");
    expect(displayName({})).toBe("—");
  });

  it("trims a real name", () => {
    expect(displayName({ full_name: "  أحمد علي  " })).toBe("أحمد علي");
  });
});

describe("the student's side", () => {
  it("names the teachers still deciding", () => {
    expect(
      pendingTeacherNames([
        { teacher_id: "t1", teacher_name: "أ. منى", requested_at: "2026-11-03" },
        { teacher_id: "t2", teacher_name: "  ", requested_at: "2026-11-03" },
      ]),
    ).toEqual(["أ. منى"]);
  });

  it("reports how many requests are outstanding", () => {
    expect(waitingOn([])).toBe(0);
    expect(waitingOn([{ teacher_id: "t1", teacher_name: "أ", requested_at: "2026-11-03" }])).toBe(
      1,
    );
    expect(waitingOn(null)).toBe(0);
  });
});
