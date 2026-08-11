import { describe, expect, it } from "vitest";
import { repairDeckPlan } from "../src/worker/lib/ai";

const basePlan = {
  title: "Standardize on Workers",
  objective: "Persuade the platform team",
  audience: "Platform leadership",
  styleId: "bold" as const,
  slides: [] as never[]
};

const plan = (slides: unknown[]) => ({ ...basePlan, slides }) as Parameters<typeof repairDeckPlan>[0];

describe("deck plan repair", () => {
  it("supplies an image prompt for image layouts that omit one", () => {
    // imageText needs body content to build at all, so it is given bullets;
    // imageFull is buildable from a title alone.
    const repaired = repairDeckPlan(plan([
      { layoutId: "imageFull", slots: { title: "The inflection point" } },
      { layoutId: "imageText", slots: { title: "How it works", bullets: ["It routes at the edge"] } }
    ]));
    for (const slide of repaired.slides) {
      expect(slide.imagePrompt).toBeTruthy();
      // The prompt must describe the slide, not a generic stock image.
      expect(slide.imagePrompt).toContain(slide.slots.title as string);
      expect(slide.imagePrompt).toContain("no words or lettering");
    }
  });

  it("leaves an explicit image prompt untouched", () => {
    const repaired = repairDeckPlan(plan([
      { layoutId: "imageFull", slots: { title: "T" }, imagePrompt: "a specific art direction" }
    ]));
    expect(repaired.slides[0]?.imagePrompt).toBe("a specific art direction");
  });

  it("does not add images to text-only layouts", () => {
    const repaired = repairDeckPlan(plan([
      { layoutId: "bullets", slots: { title: "T", bullets: ["a"] } },
      { layoutId: "quote", slots: { quote: "q" } }
    ]));
    expect(repaired.slides.every((slide) => slide.imagePrompt === undefined)).toBe(true);
  });

  it("falls back to the deck title when the slide has none", () => {
    const repaired = repairDeckPlan(plan([{ layoutId: "imageFull", slots: {} }]));
    expect(repaired.slides[0]?.imagePrompt).toContain("Standardize on Workers");
  });
});

describe("layout downgrade for unbuildable slides", () => {
  it("rescues a cards slide with no cards into bullets", () => {
    // Exactly what PPTist rejected: 'cards requires a non-empty cards array'.
    const repaired = repairDeckPlan(plan([
      { layoutId: "cards", slots: { title: "Why it works", body: "Three reasons it holds up" } }
    ]));
    const slide = repaired.slides[0]!;
    expect(slide.layoutId).toBe("bullets");
    expect(slide.slots.bullets).toContain("Three reasons it holds up");
  });

  it("rescues numbered and comparison the same way", () => {
    const repaired = repairDeckPlan(plan([
      { layoutId: "numbered", slots: { title: "Steps", subtitle: "Do this first" } },
      { layoutId: "comparison", slots: { title: "A vs B", body: "A is faster" } }
    ]));
    expect(repaired.slides.map((s) => s.layoutId)).toEqual(["bullets", "bullets"]);
  });

  it("falls back to a section divider when there is no body content at all", () => {
    const repaired = repairDeckPlan(plan([{ layoutId: "cards", slots: { title: "Only a title" } }]));
    expect(repaired.slides[0]?.layoutId).toBe("section");
  });

  it("leaves a properly filled layout alone", () => {
    const repaired = repairDeckPlan(plan([
      { layoutId: "cards", slots: { title: "T", cards: [{ heading: "One", body: "b" }] } }
    ]));
    expect(repaired.slides[0]?.layoutId).toBe("cards");
  });

  it("downgrades an image layout and still gives it an image prompt", () => {
    const repaired = repairDeckPlan(plan([
      { layoutId: "imageText", slots: { title: "No body here" } }
    ]));
    // imageText without bullets is rejected, so it becomes a section — and a
    // section needs no image, so no prompt should be synthesised.
    expect(repaired.slides[0]?.layoutId).toBe("section");
    expect(repaired.slides[0]?.imagePrompt).toBeUndefined();
  });
});
