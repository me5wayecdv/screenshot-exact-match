import { describe, expect, it } from "vitest";

import { planPublishAudience } from "@/lib/audience";

describe("planPublishAudience", () => {
  it("blocks publishing when no student is linked (nobody could see it)", () => {
    expect(planPublishAudience({ linkedIds: [], assignedIds: [] })).toEqual({
      blocked: "no_students",
    });
  });

  it("treats an empty selection as 'everyone' and assigns every linked student", () => {
    expect(planPublishAudience({ linkedIds: ["a", "b"], assignedIds: [] })).toEqual({
      blocked: null,
      assignIds: ["a", "b"],
      everyone: true,
    });
  });

  it("tops up an 'everyone' audience with students who joined later", () => {
    expect(
      planPublishAudience({
        linkedIds: ["a", "b", "c"],
        assignedIds: ["a", "b"],
        audienceMode: "auto_all",
      }),
    ).toEqual({ blocked: null, assignIds: ["c"], everyone: true });
  });

  it("never widens a recorded explicit cohort", () => {
    expect(
      planPublishAudience({
        linkedIds: ["a", "b", "c"],
        assignedIds: ["b"],
        audienceMode: "explicit",
      }),
    ).toEqual({ blocked: null, assignIds: [], everyone: false });
  });

  it("treats a legacy full selection as 'everyone'", () => {
    expect(
      planPublishAudience({ linkedIds: ["a", "b"], assignedIds: new Set(["a", "b"]) }),
    ).toEqual({ blocked: null, assignIds: [], everyone: true });
  });

  it("keeps a legacy strict subset exactly as selected", () => {
    expect(
      planPublishAudience({ linkedIds: ["a", "b", "c"], assignedIds: new Set(["b"]) }),
    ).toEqual({ blocked: null, assignIds: [], everyone: false });
  });
});
