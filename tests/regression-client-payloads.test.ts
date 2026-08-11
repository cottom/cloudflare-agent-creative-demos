import { describe, expect, it } from "vitest";
import { contractFor, validateSubmission } from "../src/shared/interaction-contract";
import type { InteractionKind } from "../src/shared/types";

/** Exactly what src/client/components/InteractionCard.tsx sends today. */
describe("real client payloads", () => {
  it("accepts the plan-review payload the shipped UI sends", () => {
    const contract = contractFor({
      kind: "ppt_plan_review" as InteractionKind,
      payload: { themeOptions: ["midnight", "editorial", "minimal", "sunrise"], editableFields: ["themeId", "direction", "slides"] }
    });
    expect(validateSubmission(contract, { themeId: "editorial", direction: "", slides: [] } as never)).toEqual([]);
  });

  it("accepts the canvas-review payload the shipped UI sends", () => {
    const contract = contractFor({
      kind: "canvas_variant_review" as InteractionKind,
      payload: { campaignName: "x", directions: [], aspectRatio: "4:5" }
    });
    expect(validateSubmission(contract, { directions: [] } as never)).toEqual([]);
  });

  it("accepts the choice payload the shipped UI sends", () => {
    const contract = contractFor({ kind: "choice" as InteractionKind, payload: { options: ["a", "b"] } });
    expect(validateSubmission(contract, { selected: "a" } as never)).toEqual([]);
  });
});
