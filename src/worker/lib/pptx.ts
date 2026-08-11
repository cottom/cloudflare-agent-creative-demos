import PptxGenJS from "pptxgenjs";
import {
  PPTIST_VIEWPORT_RATIO,
  PPTIST_VIEWPORT_SIZE,
  pptistPlainText,
  type PptistDocument,
  type PptistElement,
  type PptistSlide
} from "../../shared/pptist";
import type { PresentationDocument } from "../../shared/types";

/**
 * Server-side PPTX rendering of a PPTist deck.
 *
 * PPTist ships a full-fidelity exporter that runs in the browser; this exists
 * for the paths with no browser — the durable build workflow and the REST
 * export endpoint. It covers the element types the agent and workflow author
 * (text, shape, image, table) and skips the rest rather than failing, so an
 * exotic slide still yields a usable file.
 *
 * Geometry converts from PPTist's viewport pixels to inches on a 13.333 x 7.5
 * stage: PPTist lays out against a 1000 x 562.5 canvas.
 */

const SLIDE_W_IN = 13.333;
const SLIDE_H_IN = SLIDE_W_IN * PPTIST_VIEWPORT_RATIO;
const PX_TO_IN = SLIDE_W_IN / PPTIST_VIEWPORT_SIZE;

type Slide = ReturnType<PptxGenJS["addSlide"]>;

function color(value: string | undefined, fallback: string): string {
  const hex = (value ?? fallback).replace(/^#/, "").toUpperCase();
  return /^[0-9A-F]{6}$/.test(hex) ? hex : fallback.replace(/^#/, "").toUpperCase();
}

function box(element: PptistElement) {
  return {
    x: element.left * PX_TO_IN,
    y: element.top * PX_TO_IN,
    w: Math.max(element.width * PX_TO_IN, 0.05),
    h: Math.max(element.height * PX_TO_IN, 0.05),
    ...(element.rotate ? { rotate: Math.round(element.rotate) } : {})
  };
}

/** Rough point size from the inline styles PPTist writes into its HTML. */
function fontSizeOf(html: string, fallback: number): number {
  const match = /font-size:\s*(\d+(?:\.\d+)?)px/i.exec(html);
  if (!match?.[1]) return fallback;
  // PPTist px on a 1000-wide stage maps to ~0.75pt per px at 13.333in wide.
  return Math.max(8, Math.round(Number(match[1]) * 0.75));
}

function renderSlide(pptx: PptxGenJS, slide: Slide, source: PptistSlide, theme: PptistDocument["theme"], images: Map<string, string>): void {
  const fontName = theme?.fontName ?? "Aptos";
  const fontColor = color(theme?.fontColor, "111827");

  for (const element of source.elements) {
    if (element.type === "text") {
      const text = pptistPlainText(element.content);
      if (!text) continue;
      const isList = /<li[\s>]/i.test(element.content);
      const lines = text.split("\n").filter(Boolean);
      slide.addText(
        isList ? lines.map((line) => ({ text: line, options: { bullet: true } })) : text,
        {
          ...box(element),
          fontFace: fontName,
          fontSize: fontSizeOf(element.content, 18),
          color: color(element.defaultColor, fontColor),
          bold: /<strong|<b[\s>]|font-weight:\s*(bold|[6-9]00)/i.test(element.content),
          italic: /<em|<i[\s>]|font-style:\s*italic/i.test(element.content),
          align: /text-align:\s*center/i.test(element.content) ? "center"
            : /text-align:\s*right/i.test(element.content) ? "right" : "left",
          valign: element.vAlign ?? "top",
          ...(element.fill ? { fill: { color: color(element.fill, "FFFFFF") } } : {}),
          margin: 0.04
        }
      );
      continue;
    }

    if (element.type === "shape") {
      // PPTist shapes are SVG paths; approximate with a rectangle carrying the
      // same fill and any text, which keeps the composition readable.
      slide.addShape("rect" as Parameters<Slide["addShape"]>[0], {
        ...box(element),
        fill: { color: color(element.fill, "5B6CFF") },
        ...(element.opacity !== undefined ? { transparency: Math.round((1 - element.opacity) * 100) } : {})
      });
      const shapeText = element.text?.content ? pptistPlainText(element.text.content) : "";
      if (shapeText) {
        slide.addText(shapeText, {
          ...box(element),
          fontFace: fontName,
          fontSize: fontSizeOf(element.text?.content ?? "", 16),
          color: color(element.text?.defaultColor, "FFFFFF"),
          align: "center",
          valign: element.text?.align ?? "middle"
        });
      }
      continue;
    }

    if (element.type === "image") {
      const data = images.get(element.src);
      if (data) slide.addImage({ ...box(element), data });
      continue;
    }

    if (element.type === "table") {
      const rows = element.data.map((row) => row.map((cell) => pptistPlainText(cell.text)));
      if (!rows.length) continue;
      slide.addTable(rows as Parameters<Slide["addTable"]>[0], {
        ...box(element),
        fontFace: fontName,
        fontSize: 12,
        color: fontColor,
        border: { type: "solid", pt: 0.5, color: "D9E0EB" }
      });
    }
    // charts / video / audio / latex / line are left to PPTist's own exporter.
  }
}

export async function renderPptx(
  document: PresentationDocument,
  images: Map<string, string> = new Map()
): Promise<Uint8Array> {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "PPTIST", width: SLIDE_W_IN, height: SLIDE_H_IN });
  pptx.layout = "PPTIST";
  pptx.author = "Cloudflare Creative Agent Demo";
  pptx.company = "Cloudflare Creative Agent Demo";
  pptx.subject = document.objective;
  pptx.title = document.title;

  const deck = document.deck;
  const backgroundColor = color(deck.theme?.backgroundColor, "FFFFFF");

  for (const source of deck.slides) {
    const slide = pptx.addSlide();
    slide.background = { color: color(source.background?.color, backgroundColor) };
    if (source.remark) slide.addNotes(source.remark);
    renderSlide(pptx, slide, source, deck.theme, images);
  }

  const output = await pptx.write({ outputType: "arraybuffer" });
  if (output instanceof ArrayBuffer) return new Uint8Array(output);
  if (ArrayBuffer.isView(output)) return new Uint8Array(output.buffer, output.byteOffset, output.byteLength);
  throw new Error("PptxGenJS returned an unsupported output type");
}
