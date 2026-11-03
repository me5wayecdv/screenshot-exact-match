import { describe, expect, it } from "vitest";

import {
  missingAssignments,
  modeFromCoverage,
  planPublishAudience,
  topUpAfterPublish,
} from "@/lib/audience";

describe("planPublishAudience", () => {
  it("blocks publishing when no student is linked (nobody could see it)", () => {
    expect(planPublishAudience({ linkedIds: [], assignedIds: [] })).toEqual({
      blocked: "no_students",
    });
  });

  // Regression (live, 2026-11-03): the DB default audience_mode='explicit'
  // was mistaken for a teacher decision, so a first publish with one linked
  // student produced mode 'explicit' + a "0 students will see it" toast.
  it("publishes to everyone when nothing was selected", () => {
    expect(planPublishAudience({ linkedIds: ["a"], assignedIds: [] })).toEqual({
      blocked: null,
      mode: "auto_all",
      assignIds: ["a"],
    });
  });

  it("treats a selection covering every linked student as 'everyone'", () => {
    expect(
      planPublishAudience({ linkedIds: ["a", "b"], assignedIds: new Set(["a", "b"]) }),
    ).toEqual({ blocked: null, mode: "auto_all", assignIds: [] });
  });

  it("keeps a strict subset explicit and never widens it", () => {
    expect(
      planPublishAudience({ linkedIds: ["a", "b", "c"], assignedIds: new Set(["b"]) }),
    ).toEqual({ blocked: null, mode: "explicit", assignIds: [] });
  });

  it("tops up an everyone-audience exam after a late join", () => {
    // Published when only "a" was linked, then "b" joined: the audience is
    // still everyone, so "b" is the only one missing.
    expect(planPublishAudience({ linkedIds: ["a", "b"], assignedIds: ["a"] })).toEqual({
      blocked: null,
      mode: "explicit",
      assignIds: [],
    });
    expect(missingAssignments(["a", "b"], ["a"])).toEqual(["b"]);
    expect(modeFromCoverage(["a", "b"], ["a", "b"])).toBe("auto_all");
  });
});

describe("modeFromCoverage", () => {
  it("reads an empty selection as everyone", () => {
    expect(modeFromCoverage(["a", "b"], [])).toBe("auto_all");
  });

  it("reads full coverage as everyone and partial as explicit", () => {
    expect(modeFromCoverage(["a", "b"], ["a", "b"])).toBe("auto_all");
    expect(modeFromCoverage(["a", "b", "c"], ["a", "b"])).toBe("explicit");
  });
});

describe("missingAssignments", () => {
  it("lists only linked students without a row", () => {
    expect(missingAssignments(["a", "b", "c"], new Set(["b"]))).toEqual(["a", "c"]);
    expect(missingAssignments([], [])).toEqual([]);
  });
});

describe("topUpAfterPublish", () => {
  // Live bug (2026-11-04): the publish handler re-inserted the pre-publish
  // selection after the RPC had already assigned everyone, so every publish
  // raised a raw "duplicate key" toast next to its success toast. The top-up
  // must be empty once the server has done the work.
  it("writes nothing when the transition already assigned every linked student", () => {
    expect(topUpAfterPublish(["a", "b"], ["a", "b"], "auto_all")).toEqual([]);
  });

  it("adds only the students still missing (older schema, or linked mid-publish)", () => {
    expect(topUpAfterPublish(["a", "b", "c"], ["a"], "auto_all")).toEqual(["b", "c"]);
  });

  it("never widens an explicit subset, even if students are missing", () => {
    expect(topUpAfterPublish(["a", "b", "c"], ["b"], "explicit")).toEqual([]);
  });

  it("returns unique ids only, so one student cannot be inserted twice", () => {
    const missing = topUpAfterPublish(["a", "a"], [], "auto_all");
    expect(new Set(missing).size).toBe(missing.length);
  });
});
