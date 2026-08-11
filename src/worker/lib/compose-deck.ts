import puppeteer from "@cloudflare/puppeteer";
import type { PptistDocument } from "../../shared/pptist";

/**
 * Compose a deck with PPTist's real layout engine, from the server.
 *
 * The build workflow has to be durable, so it cannot depend on a user having
 * the editor open. But PPTist's composition planner, responsive text auto-fit
 * and per-slide QA pass only run in a browser. Browser Run bridges the two:
 * the workflow drives the headless composer page and reads the finished deck
 * back out, so server-generated decks are composed by exactly the same engine
 * a human edits with.
 */

export type ComposeSlideInput = {
  layoutId: string;
  variantId?: string;
  slots?: Record<string, unknown>;
  notes?: string;
  /** Absolute URL of an already-generated image for this slide's image slot. */
  imageUrl?: string;
};

export type ComposeDeckInput = {
  title: string;
  styleId: string;
  slides: ComposeSlideInput[];
};

type ComposePageResult = {
  ok: boolean;
  deck?: PptistDocument;
  warnings?: Array<{ slide: number; layoutId: string; messages: string[] }>;
  error?: string;
};

export async function composeDeckHeadless(
  env: Env,
  input: ComposeDeckInput
): Promise<{ deck: PptistDocument; warnings: string[] }> {
  if (!env.BROWSER) throw new Error("Browser Run binding (BROWSER) is not configured");
  if (!env.PUBLIC_ORIGIN) throw new Error("PUBLIC_ORIGIN is not configured");

  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    // Image slots are fetched by the page itself, so relative artifact URLs
    // are made absolute against the deployed origin.
    const slides = input.slides.map((slide) => ({
      ...slide,
      imageUrl: slide.imageUrl ? new URL(slide.imageUrl, env.PUBLIC_ORIGIN).toString() : undefined
    }));

    await page.goto(new URL("/compose", env.PUBLIC_ORIGIN).toString(), { waitUntil: "load" });
    // The bundle registers `composeDeck` after PPTist's chunks resolve.
    await page.waitForFunction("typeof window.composeDeck === 'function'", { timeout: 60_000 });

    const result = await page.evaluate(
      async (request) => window.composeDeck(request as never),
      { title: input.title, styleId: input.styleId, slides }
    ) as ComposePageResult;

    if (!result?.ok || !result.deck) {
      throw new Error(`PPTist composition failed: ${result?.error ?? "unknown error"}`);
    }

    const warnings = (result.warnings ?? []).flatMap((entry) =>
      entry.messages.map((message) => `slide ${entry.slide} (${entry.layoutId}): ${message}`)
    );
    return { deck: result.deck, warnings };
  } finally {
    // Browser Run bills per browser-hour and caps concurrency, so the session
    // is always closed even when composition throws.
    await browser.close();
  }
}
