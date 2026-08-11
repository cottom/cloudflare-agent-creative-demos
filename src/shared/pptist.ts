/**
 * PPTist is the canonical presentation model.
 *
 * The Durable Object stores exactly what the PPTist embed produces, so there is
 * no lossy mapping layer and no second source of truth. These types mirror the
 * subset of `@lofcz/pptist`'s public model that crosses our RPC boundary — they
 * are re-declared rather than imported because the worker must not pull in the
 * browser bundle, and because `Rpc.Serializable` rejects `unknown`.
 */

/** Slide geometry is in viewport pixels; the default stage is 1000 x 562.5. */
export const PPTIST_VIEWPORT_SIZE = 1000;
export const PPTIST_VIEWPORT_RATIO = 0.5625;

export type PptistElementType =
  | "text" | "image" | "shape" | "line" | "chart" | "table" | "video" | "audio" | "latex";

/** Common geometry shared by every element. */
export type PptistBaseElement = {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
  rotate: number;
  lock?: boolean;
  groupId?: string;
  name?: string;
};

export type PptistTextElement = PptistBaseElement & {
  type: "text";
  /** Rich text is stored as HTML (PPTist edits it with ProseMirror). */
  content: string;
  defaultFontName: string;
  defaultColor: string;
  fill?: string;
  lineHeight?: number;
  opacity?: number;
  vAlign?: "top" | "middle" | "bottom";
  textType?: string;
};

export type PptistImageElement = PptistBaseElement & {
  type: "image";
  src: string;
  fixedRatio: boolean;
  radius?: number;
};

export type PptistShapeElement = PptistBaseElement & {
  type: "shape";
  /** `[w, h]`; a plain array, since RPC serialization erases tuple-ness. */
  viewBox: number[];
  path: string;
  fixedRatio: boolean;
  fill: string;
  opacity?: number;
  text?: {
    content: string;
    defaultFontName: string;
    defaultColor: string;
    align: "top" | "middle" | "bottom";
  };
};

export type PptistTableElement = PptistBaseElement & {
  type: "table";
  colWidths: number[];
  data: Array<Array<{ id: string; colspan: number; rowspan: number; text: string }>>;
};

/**
 * Element kinds PPTist supports that this codebase does not introspect —
 * charts, video, audio, latex, lines. They round-trip untouched.
 *
 * The catch-all is typed as JSON rather than `unknown`: Durable Object RPC
 * checks return values against `Rpc.Serializable`, which rejects `unknown` and
 * would silently collapse every caller of the project state to `never`.
 */
type Opaque0 = string | number | boolean | null;
type Opaque1 = Opaque0 | Opaque0[] | { [key: string]: Opaque0 };
type Opaque2 = Opaque0 | Opaque1[] | { [key: string]: Opaque1 };
export type PptistOpaqueValue = Opaque0 | Opaque2[] | { [key: string]: Opaque2 };

export type PptistOpaqueElement = PptistBaseElement & {
  type: Exclude<PptistElementType, "text" | "image" | "shape" | "table">;
  [key: string]: PptistOpaqueValue | undefined;
};

export type PptistElement =
  | PptistTextElement
  | PptistImageElement
  | PptistShapeElement
  | PptistTableElement
  | PptistOpaqueElement;

export type PptistSlide = {
  id: string;
  elements: PptistElement[];
  remark?: string;
  background?: { type: "solid" | "image" | "gradient"; color?: string; image?: { src: string; size: string } };
  animations?: Array<{ id: string; elId: string; effect: string; type: string; duration: number; trigger: string }>;
  turningMode?: string;
  type?: "cover" | "contents" | "transition" | "content" | "end";
};

export type PptistTheme = {
  backgroundColor: string;
  themeColors: string[];
  fontColor: string;
  fontName: string;
  outline?: { width?: number; color?: string; style?: string };
  shadow?: { h: number; v: number; blur: number; color: string };
};

/** The serializable deck exchanged between the host and the PPTist embed. */
export type PptistDocument = {
  title: string;
  slides: PptistSlide[];
  theme?: Partial<PptistTheme>;
};

export function pptistElementId(): string {
  return `el-${crypto.randomUUID().slice(0, 12)}`;
}

export function pptistSlideId(): string {
  return `slide-${crypto.randomUUID().slice(0, 12)}`;
}

/** Text elements carry HTML; strip it for previews, exports and agent context. */
export function pptistPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** First text element on a slide, used as its human-facing title. */
export function pptistSlideTitle(slide: PptistSlide, fallback = "Untitled slide"): string {
  for (const element of slide.elements) {
    if (element.type === "text") {
      const text = pptistPlainText(element.content).split("\n")[0]?.trim();
      if (text) return text;
    }
    if (element.type === "shape" && element.text?.content) {
      const text = pptistPlainText(element.text.content).split("\n")[0]?.trim();
      if (text) return text;
    }
  }
  return fallback;
}

/** The pre-PPTist document shape, as it still exists in stored project state. */
type LegacyPresentationDocument = {
  title?: string;
  slides?: Array<{ title?: string; subtitle?: string; body?: string[]; notes?: string }>;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Convert a deck stored before PPTist became canonical.
 *
 * Runs on read rather than as a one-shot script: Durable Object state is
 * per-project and long-lived, so a project that has not been opened since the
 * change still needs upgrading whenever it next loads.
 */
export function pptistDeckFromLegacy(document: LegacyPresentationDocument): PptistDocument {
  const slides = (document.slides ?? []).map((slide): PptistSlide => {
    const elements: PptistElement[] = [{
      id: pptistElementId(),
      type: "text",
      left: 70,
      top: 62,
      width: PPTIST_VIEWPORT_SIZE - 140,
      height: 80,
      rotate: 0,
      content: `<p style="font-size:32px"><strong>${escapeHtml(slide.title ?? "Slide")}</strong></p>`,
      defaultFontName: "Aptos",
      defaultColor: "#111827"
    }];

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

    const body = (slide.body ?? []).filter(Boolean);
    if (body.length) {
      elements.push({
        id: pptistElementId(),
        type: "text",
        left: 70,
        top: slide.subtitle ? 208 : 172,
        width: PPTIST_VIEWPORT_SIZE - 140,
        height: 280,
        rotate: 0,
        content: body.map((line) => `<li style="font-size:18px">${escapeHtml(line)}</li>`).join(""),
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
  });

  return {
    title: document.title ?? "Presentation",
    theme: createPptistTheme(),
    slides: slides.length ? slides : [{ id: pptistSlideId(), type: "content", elements: [] }]
  };
}

export function createPptistTheme(): PptistTheme {
  return {
    backgroundColor: "#ffffff",
    themeColors: ["#5b6cff", "#7cffb2", "#e34b35", "#ff6b35", "#111827", "#667085"],
    fontColor: "#111827",
    fontName: "Aptos",
    outline: { width: 2, color: "#d9e0eb", style: "solid" },
    shadow: { h: 3, v: 3, blur: 2, color: "#e6ebf5" }
  };
}
