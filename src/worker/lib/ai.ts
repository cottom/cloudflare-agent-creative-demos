import { generateObject } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import {
  createPptistTheme,
  pptistElementId,
  pptistSlideId,
  PPTIST_VIEWPORT_SIZE,
  type PptistSlide
} from "../../shared/pptist";
import type {
  CanvasVariantsWorkflowParams,
  PptBuildWorkflowParams,
  PresentationDocument
} from "../../shared/types";

export const DEFAULT_LLM_MODEL = "@cf/moonshotai/kimi-k2.6";
export const DEFAULT_IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";

export function workersLanguageModel(env: Env) {
  return createWorkersAI({ binding: env.AI })(env.LLM_MODEL ?? DEFAULT_LLM_MODEL);
}

const pptPlanSchema = z.object({
  title: z.string().min(3).max(120),
  objective: z.string().min(8).max(500),
  audience: z.string().min(2).max(160),
  recommendedTheme: z.enum(["midnight", "editorial", "minimal", "sunrise"]),
  slides: z.array(z.object({
    title: z.string().min(2).max(120),
    purpose: z.string().min(3).max(240),
    keyPoints: z.array(z.string().min(2).max(220)).min(1).max(6),
    layout: z.enum(["title", "statement", "bullets", "two_column", "metrics"])
  })).min(3).max(30)
});

export type PptPlan = z.infer<typeof pptPlanSchema>;

/**
 * The deck plan the model produces.
 *
 * It picks a PPTist layout recipe per slide and fills its content slots — it
 * never authors HTML or coordinates. PPTist's engine themes, positions and
 * auto-fits everything, which is what makes the output look designed instead
 * of like the same bullet list thirteen times.
 *
 * Slots are a flat optional union of every layout's slot names: a per-layout
 * discriminated union produces far more malformed output from smaller models
 * than a permissive object does, and the engine validates slots anyway.
 */
const slotSchema = z.object({
  title: z.string().max(160).optional(),
  subtitle: z.string().max(240).optional(),
  eyebrow: z.string().max(60).optional(),
  body: z.string().max(600).optional(),
  caption: z.string().max(200).optional(),
  bullets: z.array(z.string().max(200)).max(6).optional(),
  ordered: z.string().max(10).optional(),
  leftHeading: z.string().max(120).optional(),
  leftBullets: z.array(z.string().max(200)).max(5).optional(),
  leftBody: z.string().max(400).optional(),
  rightHeading: z.string().max(120).optional(),
  rightBullets: z.array(z.string().max(200)).max(5).optional(),
  rightBody: z.string().max(400).optional(),
  quote: z.string().max(320).optional(),
  attribution: z.string().max(120).optional(),
  stat: z.string().max(40).optional(),
  statLabel: z.string().max(120).optional(),
  stats: z.array(z.object({ stat: z.string().max(40), statLabel: z.string().max(120) })).max(4).optional(),
  cards: z.array(z.object({ heading: z.string().max(80), body: z.string().max(220).optional() })).max(6).optional(),
  steps: z.array(z.object({ heading: z.string().max(80), body: z.string().max(220).optional() })).max(6).optional(),
  headers: z.array(z.string().max(60)).max(5).optional(),
  rows: z.array(z.array(z.string().max(120)).max(5)).max(6).optional(),
  chartType: z.enum(["bar", "line", "pie"]).optional(),
  labels: z.array(z.string().max(40)).max(12).optional(),
  series: z.array(z.object({ name: z.string().max(40), data: z.array(z.number()).max(12) })).max(4).optional(),
  imageSide: z.enum(["left", "right"]).optional()
});

export const LAYOUT_IDS = [
  "title", "section", "closing", "bullets", "twoColumn", "imageText",
  "bigStat", "quote", "chart", "comparison", "cards", "numbered", "imageFull"
] as const;

const deckPlanSchema = z.object({
  title: z.string().min(3).max(120),
  objective: z.string().min(8).max(500),
  audience: z.string().min(2).max(160),
  styleId: z.enum(["academic", "minimal", "bold", "playful"]),
  slides: z.array(z.object({
    layoutId: z.enum(LAYOUT_IDS),
    variantId: z.string().max(40).optional(),
    slots: slotSchema,
    notes: z.string().max(800).optional(),
    /**
     * Set only when a picture genuinely earns its place. The model decides —
     * every slide having art is as monotonous as none of them having it.
     */
    imagePrompt: z.string().min(20).max(900).optional()
  })).min(3).max(20)
});

export type DeckPlan = z.infer<typeof deckPlanSchema>;
export type DeckPlanSlide = DeckPlan["slides"][number];

/**
 * Per-layout schemas whose content fields are REQUIRED.
 *
 * `slotSchema` has 27 fields and every one is optional, which makes
 * `{layoutId: "cards", slots: {title: "…"}}` perfectly valid. Structured
 * output takes that offer: measured against the live model, a single planning
 * call filled `title` on every slide and nothing else, for every layout. The
 * composer then had no content to place, and the repair pass downgraded each
 * slide to a bare divider — a complete deck of empty slides.
 *
 * Prompt wording cannot fix a schema that says content is optional. So slots
 * are filled by a second, per-slide call against a schema small enough to hold
 * in attention and strict enough that an empty answer fails validation and is
 * retried by the SDK rather than accepted.
 */
const FILL_SCHEMAS: Record<string, z.ZodType> = {
  bullets: z.object({ bullets: z.array(z.string().min(8).max(200)).min(3).max(6) }),
  imageText: z.object({ bullets: z.array(z.string().min(8).max(200)).min(2).max(4) }),
  cards: z.object({
    cards: z.array(z.object({ heading: z.string().min(2).max(80), body: z.string().min(10).max(220) })).min(3).max(4)
  }),
  numbered: z.object({
    steps: z.array(z.object({ heading: z.string().min(2).max(80), body: z.string().min(10).max(220) })).min(3).max(5)
  }),
  comparison: z.object({
    headers: z.array(z.string().min(1).max(60)).min(2).max(4),
    rows: z.array(z.array(z.string().min(1).max(120)).min(2).max(4)).min(2).max(5)
  }),
  twoColumn: z.object({
    leftHeading: z.string().min(2).max(120),
    leftBullets: z.array(z.string().min(8).max(200)).min(2).max(4),
    rightHeading: z.string().min(2).max(120),
    rightBullets: z.array(z.string().min(8).max(200)).min(2).max(4)
  }),
  bigStat: z.object({
    stats: z.array(z.object({ stat: z.string().min(1).max(40), statLabel: z.string().min(3).max(120) })).min(1).max(3)
  }),
  quote: z.object({
    quote: z.string().min(20).max(320),
    attribution: z.string().min(2).max(120)
  }),
  chart: z.object({
    chartType: z.enum(["bar", "line", "pie"]),
    labels: z.array(z.string().min(1).max(40)).min(3).max(8),
    series: z.array(z.object({ name: z.string().min(1).max(40), data: z.array(z.number()).min(3).max(8) })).min(1).max(3)
  }),
  title: z.object({ subtitle: z.string().min(10).max(240), eyebrow: z.string().min(2).max(60) }),
  section: z.object({ subtitle: z.string().min(10).max(240) }),
  closing: z.object({ subtitle: z.string().min(10).max(240), eyebrow: z.string().min(2).max(60) }),
  imageFull: z.object({ subtitle: z.string().min(10).max(240) })
};

/**
 * Fill one slide's content slots against its own layout's schema.
 *
 * Returns the slide unchanged on failure. A slide that keeps its title is
 * worth more than a workflow that dies because one of twelve calls came back
 * malformed, and the downgrade path still catches whatever stays empty.
 */
async function fillSlideSlots(
  env: Env,
  plan: DeckPlan,
  slide: DeckPlanSlide,
  diagnostics?: string[]
): Promise<DeckPlanSlide> {
  const schema = FILL_SCHEMAS[slide.layoutId];
  if (!schema) {
    diagnostics?.push(`${slide.layoutId}: no fill schema`);
    return slide;
  }
  try {
    const { object } = await generateObject({
      model: workersLanguageModel(env),
      schema,
      // Fail fast. The SDK's default retry budget multiplies a schema this
      // model struggles with into minutes of wall clock, and a slide that
      // cannot be filled should fall back immediately, not stall the deck.
      maxRetries: 1,
      // A hung provider call must not consume the whole step's budget. The
      // slide falls back to its heading, which the downgrade path handles.
      abortSignal: AbortSignal.timeout(45_000),
      temperature: 0.5,
      prompt: [
        `You are writing the content of one slide in a presentation titled "${plan.title}".`,
        `Deck objective: ${plan.objective}`,
        `Audience: ${plan.audience}`,
        `This slide's heading: ${slide.slots.title ?? "(untitled)"}`,
        slide.notes ? `Speaker intent: ${slide.notes}` : "",
        "",
        `Write the content for a "${slide.layoutId}" slide. Every field is required.`,
        "Be specific and substantive — no placeholders, no restating the heading.",
        "Plain text or Markdown (**bold**, _italic_). Never HTML."
      ].filter(Boolean).join("\n")
    });
    return { ...slide, slots: { ...slide.slots, ...(object as object) } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(JSON.stringify({ event: "slide_fill_failed", layoutId: slide.layoutId, error: message }));
    diagnostics?.push(`${slide.layoutId}: ${message.slice(0, 300)}`);
    return slide;
  }
}

const canvasDirectionsSchema = z.object({
  campaignName: z.string().min(2).max(100),
  directions: z.array(z.object({
    title: z.string().min(2).max(80),
    rationale: z.string().min(5).max(320),
    prompt: z.string().min(20).max(1900)
  })).min(1).max(8)
});

export type CanvasDirectionPlan = z.infer<typeof canvasDirectionsSchema>;

export async function generatePptPlan(env: Env, params: PptBuildWorkflowParams): Promise<PptPlan> {
  const count = Math.max(3, Math.min(params.slideCount ?? 8, 20));
  const { object } = await generateObject({
    model: workersLanguageModel(env),
    schema: pptPlanSchema,
    temperature: 0.35,
    prompt: [
      "You are a senior presentation strategist.",
      `Create a coherent ${count}-slide presentation plan.`,
      `Objective: ${params.objective}`,
      `Audience: ${params.audience ?? "business decision makers"}`,
      params.sourceNotes ? `Source notes:\n${params.sourceNotes}` : "",
      "Make each slide carry one clear claim. Avoid generic filler. Choose one of the supported theme IDs."
    ].filter(Boolean).join("\n\n")
  });
  return object;
}

export async function generateDeckPlan(
  env: Env,
  params: PptBuildWorkflowParams,
  plan: PptPlan,
  humanResponse?: Record<string, unknown>,
  /**
   * `singleShot` skips the repair round trip. Two sequential model calls fit
   * comfortably inside a durable workflow step but not inside a single fetch
   * handler, which is what the diagnostic route runs in.
   */
  options?: { singleShot?: boolean; diagnostics?: string[] }
): Promise<DeckPlan> {
  const additionalDirection = typeof humanResponse?.direction === "string" ? humanResponse.direction : "";
  const approvedOutline = Array.isArray(humanResponse?.slides) ? humanResponse.slides : plan.slides;
  const basePrompt = [
      "You are a presentation designer composing slides in PPTist.",
      `Produce EXACTLY ${Math.max(3, Math.min(params.slideCount ?? plan.slides.length ?? 8, 20))} slides — no fewer.`,
      "For each slide choose the layout recipe whose composition matches its job, then fill that layout's content slots.",
      "",
      "Layouts and their slots:",
      "- title / section / closing: title, subtitle, eyebrow",
      "- bullets: title, bullets[] (variants: standard, leftRail, rightRail)",
      "- twoColumn: title, leftHeading, leftBullets[], rightHeading, rightBullets[] (variants: even, leftWide, rightWide)",
      "- imageText: title AND bullets[] (or body), caption (variants: imageRight, imageLeft) — needs an imagePrompt. A title alone is rejected.",
      "- bigStat: stats[] of {stat,statLabel}, or stat + statLabel, title, body (variants: centered, edgeAligned)",
      "- quote: quote, attribution (variants: centered, leftHeavy)",
      "- chart: title, chartType, labels[], series[] of {name,data[]}",
      "- comparison: title, headers[], rows[][] — rows must be non-empty.",
      "- cards: title, cards[] of {heading,body} (variants: grid, accentPanel, leftOffset, rightOffset)",
      "- numbered: title, steps[] of {heading,body} (variants: standard, rightRail)",
      "- imageFull: title, subtitle — needs an imagePrompt; use it for the single most striking slide",
      "",
      "Rules:",
      "- A layout's content slots are MANDATORY, not optional. Choosing 'cards' and leaving cards[] empty,",
      "  or 'numbered' with no steps[], produces a slide with nothing on it but a heading. Write the content.",
      "- If you do not have enough substance to fill a layout's slots, choose 'bullets' and write real bullets",
      "  instead of choosing a richer layout and leaving it empty.",
      "- Vary the layout family across the deck. A deck where every slide is 'bullets' is the failure mode to avoid.",
      "- Open with 'title' and end with 'closing'.",
      "- Match the layout to the content: parallel items -> cards, ordered steps -> numbered, a headline number -> bigStat, data -> chart, a memorable line -> quote.",
      "- Write slot text as plain text or Markdown (**bold**, _italic_). NEVER write HTML tags.",
      "- Give the single most striking slide the 'imageFull' layout with an imagePrompt.",
      "- Add imagePrompt to 1-3 slides total, where a picture genuinely adds meaning (imageFull or imageText). Prompts must be self-contained, describe composition, subject, lighting and mood, and must not ask for legible text in the image.",
      "- Do not invent statistics that are not in the source material.",
      "",
      `Objective: ${params.objective}`,
      `Audience: ${params.audience ?? plan.audience}`,
      `Approved outline: ${JSON.stringify({ ...plan, slides: approvedOutline })}`,
      params.sourceNotes ? `Source notes:\n${params.sourceNotes}` : "",
      additionalDirection ? `Human direction:\n${additionalDirection}` : ""
  ].filter(Boolean).join("\n");

  if (options?.singleShot) {
    const only = await generateObject({
      model: workersLanguageModel(env),
      schema: deckPlanSchema,
      temperature: 0.4,
      prompt: basePrompt
    });
    return only.object;
  }

  const first = await generateObject({
    model: workersLanguageModel(env),
    schema: deckPlanSchema,
    temperature: 0.4,
    prompt: basePrompt
  });

  /**
   * Second pass: fill each slide's content against its own layout's schema.
   *
   * Concurrent, because slides are independent — but bounded. Firing one call
   * per slide at once pushed a twenty-slide deck past the provider's
   * concurrency limit, and the whole step then failed with a request timeout
   * and was retried from the beginning, re-running planning each time. A
   * bounded window keeps the step's cost proportional to the deck instead of
   * to the burst it creates.
   */
  const draft = first.object;
  const filled: DeckPlanSlide[] = [];
  const FILL_CONCURRENCY = 3;
  for (let index = 0; index < draft.slides.length; index += FILL_CONCURRENCY) {
    const window = draft.slides.slice(index, index + FILL_CONCURRENCY);
    filled.push(
      ...(await Promise.all(
        window.map((slide) => fillSlideSlots(env, draft, slide, options?.diagnostics))
      ))
    );
  }
  const stillEmpty = filled.filter((slide) => emptyRequiredSlots(slide).length > 0).length;
  if (stillEmpty) {
    console.warn(JSON.stringify({ event: "deck_plan_slots_unfilled", slides: filled.length, stillEmpty }));
  }
  return { ...draft, slides: filled };
}

/** Compose one authored slide into PPTist text elements on the 1000x562.5 stage. */
function composeSlide(slide: {
  title: string;
  subtitle?: string;
  body: string[];
  notes?: string;
}): PptistSlide {
  const elements: PptistSlide["elements"] = [
    {
      id: pptistElementId(),
      type: "text",
      left: 70,
      top: 62,
      width: PPTIST_VIEWPORT_SIZE - 140,
      height: 80,
      rotate: 0,
      content: `<p style="font-size:32px"><strong>${escapeHtml(slide.title)}</strong></p>`,
      defaultFontName: "Aptos",
      defaultColor: "#111827"
    }
  ];

  if (slide.subtitle) {
    elements.push({
      id: pptistElementId(),
      type: "text",
      left: 70,
      top: 148,
      width: PPTIST_VIEWPORT_SIZE - 140,
      height: 44,
      rotate: 0,
      content: `<p style="font-size:18px">${escapeHtml(slide.subtitle)}</p>`,
      defaultFontName: "Aptos",
      defaultColor: "#667085"
    });
  }

  if (slide.body.length) {
    elements.push({
      id: pptistElementId(),
      type: "text",
      left: 70,
      top: slide.subtitle ? 208 : 172,
      width: PPTIST_VIEWPORT_SIZE - 140,
      height: 280,
      rotate: 0,
      content: slide.body.map((line) => `<li style="font-size:18px">${escapeHtml(line)}</li>`).join(""),
      defaultFontName: "Aptos",
      defaultColor: "#334155"
    });
  }

  return {
    id: pptistSlideId(),
    type: "content",
    elements,
    ...(slide.notes ? { remark: slide.notes } : {})
  };
}

/** Model output becomes HTML, so it must be escaped before interpolation. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Layouts whose composition requires an image slot to build at all. */
const IMAGE_LAYOUTS = new Set(["imageText", "imageFull"]);

/**
 * Repair a deck plan before composition.
 *
 * The model regularly picks an image layout and then omits `imagePrompt`.
 * PPTist cannot build `imageText`/`imageFull` without an image, so the slide
 * fails and silently drops out of the deck — that is how a requested 7-slide
 * deck arrived as 3. Rather than re-prompt and hope, derive a prompt from the
 * slide's own content so the layout the model chose can actually be built.
 */
/**
 * Required content slot per layout. PPTist rejects a slide whose layout has no
 * body content, and a rejected slide silently disappears from the deck.
 */
const REQUIRED_SLOTS: Record<string, Array<keyof DeckPlanSlide["slots"]>> = {
  cards: ["cards"],
  numbered: ["steps"],
  comparison: ["rows"],
  chart: ["labels"],
  bullets: ["bullets", "body"],
  // The engine rejects imageText with a title and nothing else
  // ("[contentEmpty] … the slide was rejected"), but either slot satisfies it.
  imageText: ["bullets", "body"],
  twoColumn: ["leftBullets", "leftBody", "rightBullets"],
  quote: ["quote"],
  bigStat: ["stats", "stat"]
};

function hasContent(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === "string" ? value.trim().length > 0 : value !== undefined;
}

/**
 * Downgrade a slide whose layout cannot be built to one that can.
 *
 * Losing the composition the model wanted is a much smaller failure than
 * losing the slide: a deck that silently arrives as 3 of 7 pages reads as the
 * model writing a short deck, not as a bug.
 */
function ensureBuildable(slide: DeckPlanSlide): DeckPlanSlide {
  const required = REQUIRED_SLOTS[slide.layoutId];
  if (!required || required.some((slot) => hasContent(slide.slots[slot]))) return slide;

  const salvaged = [
    slide.slots.body,
    ...(slide.slots.bullets ?? []),
    ...(slide.slots.cards ?? []).map((card) => [card.heading, card.body].filter(Boolean).join(" — ")),
    ...(slide.slots.steps ?? []).map((step) => [step.heading, step.body].filter(Boolean).join(" — ")),
    slide.slots.subtitle
  ].filter((line): line is string => Boolean(line && line.trim()));

  if (!salvaged.length) {
    // Nothing to say in a body — a section divider is honest and always builds.
    return { ...slide, layoutId: "section", variantId: undefined };
  }
  return { ...slide, layoutId: "bullets", variantId: undefined, slots: { ...slide.slots, bullets: salvaged.slice(0, 6) } };
}

/** Slots the model left empty on a slide whose layout requires one of them. */
function emptyRequiredSlots(slide: DeckPlanSlide): string[] {
  const required = REQUIRED_SLOTS[slide.layoutId];
  if (!required || required.some((slot) => hasContent(slide.slots[slot]))) return [];
  return required as string[];
}

export function repairDeckPlan(plan: DeckPlan): DeckPlan {
  // A downgrade is invisible in the finished deck — it just looks like a plain
  // slide the model chose — so the fact that one happened is logged. Repeated
  // downgrades mean the generation prompt is failing, not the composer.
  const downgraded = plan.slides
    .map((slide, index) => ({ index: index + 1, layoutId: slide.layoutId, empty: emptyRequiredSlots(slide) }))
    .filter((entry) => entry.empty.length > 0);
  if (downgraded.length) {
    console.warn(JSON.stringify({
      event: "deck_plan_downgraded",
      slides: plan.slides.length,
      downgradedCount: downgraded.length,
      downgraded
    }));
  }

  return {
    ...plan,
    slides: plan.slides.map((original) => {
      const slide = ensureBuildable(original);
      if (!IMAGE_LAYOUTS.has(slide.layoutId) || slide.imagePrompt) return slide;
      const subject = slide.slots.title ?? slide.slots.subtitle ?? plan.title;
      return {
        ...slide,
        imagePrompt: [
          `Editorial photograph illustrating: ${subject}.`,
          `Context: ${plan.objective}.`,
          "Cinematic lighting, shallow depth of field, muted professional palette,",
          "generous negative space for overlaid text, no words or lettering in the image."
        ].join(" ")
      };
    })
  };
}

export async function generateCanvasDirections(
  env: Env,
  params: CanvasVariantsWorkflowParams,
  referenceContext?: string
): Promise<CanvasDirectionPlan> {
  const count = Math.max(1, Math.min(params.count, 6));
  const { object } = await generateObject({
    model: workersLanguageModel(env),
    schema: canvasDirectionsSchema,
    temperature: 0.65,
    prompt: [
      "You are an expert creative director and image prompt engineer.",
      `Create exactly ${count} genuinely distinct campaign image directions.`,
      `Objective: ${params.objective}`,
      `Aspect ratio: ${params.aspectRatio ?? "4:5"}`,
      referenceContext ? `Selected canvas context: ${referenceContext}` : "",
      "Every prompt must be self-contained, production-ready, include composition, subject, lighting, material, background, camera/lens feel, and leave safe negative space for later text. Do not ask the image model to render legible copy."
    ].filter(Boolean).join("\n\n")
  });
  return { ...object, directions: object.directions.slice(0, count) };
}

export async function generateImageBytes(env: Env, prompt: string, seed: number): Promise<Uint8Array> {
  const model = env.IMAGE_MODEL ?? DEFAULT_IMAGE_MODEL;
  const response = await env.AI.run(model as Parameters<Ai["run"]>[0], {
    prompt,
    seed,
    steps: 4
  } as never) as { image?: string };
  if (!response?.image) throw new Error(`Workers AI image model ${model} returned no image`);
  const binary = atob(response.image);
  return Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);
}
