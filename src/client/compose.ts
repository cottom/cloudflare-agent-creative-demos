import { mountPptist } from "@lofcz/pptist";
import "@lofcz/pptist/embed.css";

/**
 * Headless PPTist composer.
 *
 * The durable build workflow runs server-side, but PPTist's layout engine —
 * composition planner, auto-fit text measurement and the per-slide QA pass —
 * only exists in a browser. Rather than reimplement that on the server (and
 * lose exactly the parts that make a deck look designed), the workflow drives
 * this page inside Browser Run and reads the finished deck back out.
 *
 * The page exposes one promise-returning entry point on `window`; Puppeteer
 * awaits it and collects both the deck and the engine's QA warnings.
 */

type PlanSlide = {
  layoutId: string;
  variantId?: string;
  slots?: Record<string, unknown>;
  notes?: string;
  /** Resolved before composition; the workflow generates the image first. */
  imageUrl?: string;
};

type ComposeRequest = {
  title: string;
  styleId: string;
  slides: PlanSlide[];
};

type ComposeResult = {
  ok: boolean;
  deck?: unknown;
  warnings: Array<{ slide: number; layoutId: string; messages: string[] }>;
  error?: string;
};

declare global {
  interface Window {
    composeDeck: (request: ComposeRequest) => Promise<ComposeResult>;
  }
}

export function mountComposer(root: HTMLElement): void {
  root.style.height = "100vh";
  window.composeDeck = (request) => composeDeck(root, request);
}

async function composeDeck(host: HTMLElement, request: ComposeRequest): Promise<ComposeResult> {
  const warnings: ComposeResult["warnings"] = [];
  try {
    const { controller } = await mountPptist(host, {
      locale: "en",
      showLoadingData: false,
      // Nothing here is user-facing; skip the export bundle entirely.
      exportTabs: { pptx: false, image: false, json: false, pdf: false, pptist: false }
    });

    const [first, ...rest] = request.slides;
    // `deck.setup` applies the visual identity and returns the composition
    // rhythm (anchors with no consecutive repeats, plus one "loud" slide).
    const setup = await controller.deck.setup({
      styleId: request.styleId,
      slideCount: request.slides.length,
      ...(first
        ? { title: { slots: (first.slots ?? {}) as Record<string, unknown>, ...(first.variantId ? { variantId: first.variantId } : {}) } }
        : {})
    });

    const plan = (setup.data as { plan?: { slides?: Array<{ anchor?: string }> } } | undefined)?.plan;

    for (const [index, slide] of rest.entries()) {
      const slots: Record<string, unknown> = { ...(slide.slots ?? {}) };
      if (slide.imageUrl) slots.image = slide.imageUrl;

      const result = await controller.slides.createFromLayout({
        layoutId: slide.layoutId,
        ...(slide.variantId ? { variantId: slide.variantId } : {}),
        slots
      });

      const issues = [
        ...(result.warnings ?? []),
        ...(result.errors ?? [])
      ].map((issue) => (typeof issue === "string" ? issue : issue?.message ?? JSON.stringify(issue)));
      if (issues.length) {
        warnings.push({ slide: index + 2, layoutId: slide.layoutId, messages: issues });
      }

      if (slide.notes) {
        const slideId = (result.data as { slideId?: string } | undefined)?.slideId;
        if (slideId) await controller.slides.update(slideId, { remark: slide.notes });
      }
    }

    // Anchors are advisory; surfacing the plan helps the caller explain choices.
    if (plan?.slides?.length) {
      warnings.push({ slide: 0, layoutId: "plan", messages: [`anchors: ${plan.slides.map((s) => s.anchor).join(", ")}`] });
    }

    return { ok: true, deck: controller.getDocument(), warnings };
  } catch (error) {
    return { ok: false, warnings, error: error instanceof Error ? error.message : String(error) };
  }
}
