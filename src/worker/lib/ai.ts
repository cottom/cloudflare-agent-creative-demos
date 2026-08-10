import { generateObject } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import { PPT_THEMES } from "../../shared/themes";
import type {
  CanvasVariantsWorkflowParams,
  PptBuildWorkflowParams,
  PresentationDocument
} from "../../shared/types";

export const DEFAULT_LLM_MODEL = "@cf/moonshotai/kimi-k2.6";
export const DEFAULT_IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";

export function workersLanguageModel(env: Env) {
  return createWorkersAI({ binding: env.AI })((env as Env & { LLM_MODEL?: string }).LLM_MODEL ?? DEFAULT_LLM_MODEL);
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

const presentationSchema = z.object({
  title: z.string().min(3).max(120),
  objective: z.string().min(8).max(500),
  audience: z.string().min(2).max(160),
  themeId: z.enum(["midnight", "editorial", "minimal", "sunrise"]),
  slides: z.array(z.object({
    title: z.string().min(2).max(120),
    subtitle: z.string().max(180).optional(),
    body: z.array(z.string().min(2).max(240)).min(1).max(8),
    notes: z.string().max(1200).optional(),
    layout: z.enum(["title", "statement", "bullets", "two_column", "metrics"])
  })).min(3).max(30)
});

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

export async function generatePresentationDocument(
  env: Env,
  params: PptBuildWorkflowParams,
  plan: PptPlan,
  humanResponse?: Record<string, unknown>
): Promise<PresentationDocument> {
  const requestedTheme = typeof humanResponse?.themeId === "string" ? humanResponse.themeId : plan.recommendedTheme;
  const additionalDirection = typeof humanResponse?.direction === "string" ? humanResponse.direction : "";
  const approvedOutline = Array.isArray(humanResponse?.slides) ? humanResponse.slides : plan.slides;
  const { object } = await generateObject({
    model: workersLanguageModel(env),
    schema: presentationSchema,
    temperature: 0.3,
    prompt: [
      "You are a senior presentation writer. Produce the final editable presentation document.",
      `Objective: ${params.objective}`,
      `Audience: ${params.audience ?? plan.audience}`,
      `Theme ID requested: ${requestedTheme}`,
      `Approved plan: ${JSON.stringify({ ...plan, slides: approvedOutline })}`,
      params.sourceNotes ? `Source notes:\n${params.sourceNotes}` : "",
      additionalDirection ? `Human direction:\n${additionalDirection}` : "",
      "Requirements: concise slide titles, evidence-oriented bullet points, logical narrative, no fabricated statistics, and useful speaker notes when context is needed."
    ].filter(Boolean).join("\n\n")
  });
  const theme = PPT_THEMES[object.themeId] ?? PPT_THEMES.midnight;
  return {
    title: object.title,
    objective: object.objective,
    audience: object.audience,
    theme,
    slides: object.slides.map((slide, index) => ({
      id: `slide-${crypto.randomUUID()}`,
      title: slide.title,
      subtitle: slide.subtitle,
      body: slide.body,
      notes: slide.notes,
      layout: slide.layout,
      elements: []
    }))
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
  const model = (env as Env & { IMAGE_MODEL?: string }).IMAGE_MODEL ?? DEFAULT_IMAGE_MODEL;
  const response = await env.AI.run(model as Parameters<Ai["run"]>[0], {
    prompt,
    seed,
    steps: 4
  } as never) as { image?: string };
  if (!response?.image) throw new Error(`Workers AI image model ${model} returned no image`);
  const binary = atob(response.image);
  return Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);
}
