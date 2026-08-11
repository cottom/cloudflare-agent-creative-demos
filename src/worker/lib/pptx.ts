import PptxGenJS from "pptxgenjs";
import type { PptTheme, PresentationDocument, SlideElement } from "../../shared/types";

function normalizeColor(color: string): string {
  return color.replace(/^#/, "").toUpperCase();
}

type Slide = ReturnType<PptxGenJS["addSlide"]>;

const SHAPE_NAMES: Record<Exclude<SlideElement & { type: "shape" }, never>["shape"], string> = {
  rect: "rect",
  roundRect: "roundRect",
  ellipse: "ellipse",
  triangle: "triangle",
  line: "line"
};

/**
 * Render freeform elements.
 *
 * Geometry is already stored in inches, so it maps 1:1 onto PptxGenJS and the
 * export matches the editor without a conversion step.
 */
function renderElements(
  pptx: PptxGenJS,
  slide: Slide,
  elements: SlideElement[],
  theme: PptTheme,
  images: Map<string, string>
): void {
  const ordered = [...elements].sort((a, b) => a.z - b.z);
  for (const element of ordered) {
    const box = {
      x: element.x,
      y: element.y,
      w: element.w,
      h: element.h,
      ...(element.rotation ? { rotate: Math.round(element.rotation) } : {})
    };

    if (element.type === "text") {
      const lines = element.text.split("\n");
      slide.addText(element.bullet ? lines.map((text) => ({ text, options: { bullet: true } })) : element.text, {
        ...box,
        fontFace: theme.fontFamily,
        fontSize: element.fontSize,
        bold: element.bold,
        italic: element.italic,
        underline: element.underline ? { style: "sng" } : undefined,
        color: normalizeColor(element.color ?? theme.foreground),
        align: element.align ?? "left",
        valign: element.valign ?? "top",
        ...(element.fill ? { fill: { color: normalizeColor(element.fill) } } : {}),
        ...(element.lineSpacing ? { lineSpacingMultiple: element.lineSpacing } : {}),
        margin: 0.04
      });
      continue;
    }

    if (element.type === "shape") {
      slide.addShape(SHAPE_NAMES[element.shape] as Parameters<Slide["addShape"]>[0], {
        ...box,
        ...(element.fill ? { fill: { color: normalizeColor(element.fill) } } : {}),
        ...(element.stroke
          ? { line: { color: normalizeColor(element.stroke), width: element.strokeWidth ?? 1 } }
          : {}),
        ...(element.shape === "roundRect" ? { rectRadius: element.radius ?? 0.2 } : {})
      });
      continue;
    }

    if (element.type === "table") {
      const [header, ...body] = element.rows;
      const rows = element.headerRow && header
        ? [
            header.map((text) => ({
              text,
              options: { bold: true, color: normalizeColor(theme.background), fill: { color: normalizeColor(theme.accent) } }
            })),
            ...body
          ]
        : element.rows;
      slide.addTable(rows as Parameters<Slide["addTable"]>[0], {
        ...box,
        fontFace: theme.fontFamily,
        fontSize: element.fontSize ?? 12,
        color: normalizeColor(theme.foreground),
        border: { type: "solid", pt: 0.5, color: normalizeColor(theme.muted) }
      });
      continue;
    }

    // Images are referenced by R2 key. The Worker cannot fetch its own asset
    // route from inside a request, so bytes are prefetched into data URIs by
    // the caller; an unresolved key is skipped rather than failing the export.
    const dataUri = images.get(element.assetKey);
    if (dataUri) {
      slide.addImage({ ...box, data: dataUri, ...(element.altText ? { altText: element.altText } : {}) });
    }
  }
}

export async function renderPptx(
  document: PresentationDocument,
  images: Map<string, string> = new Map()
): Promise<Uint8Array> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Cloudflare Creative Agent Demo";
  pptx.company = "Cloudflare Creative Agent Demo";
  pptx.subject = document.objective;
  pptx.title = document.title;
  pptx.theme = {
    headFontFace: document.theme.fontFamily,
    bodyFontFace: document.theme.fontFamily
  };

  for (const [index, source] of document.slides.entries()) {
    const slide = pptx.addSlide();
    slide.background = { color: normalizeColor(document.theme.background) };
    if (source.notes) slide.addNotes(source.notes);

    // A slide that has been edited freely owns its own layout; rendering the
    // fixed template underneath would double up every title and bullet list.
    if (source.elements.length > 0) {
      renderElements(pptx, slide, source.elements, document.theme, images);
      continue;
    }
    slide.addText(String(index + 1).padStart(2, "0"), {
      x: 0.55, y: 0.35, w: 0.7, h: 0.35,
      fontFace: document.theme.fontFamily,
      fontSize: 11,
      color: normalizeColor(document.theme.accent),
      bold: true,
      margin: 0
    });
    slide.addText(source.title, {
      x: 0.65, y: 0.95, w: 11.9, h: 1.0,
      fontFace: document.theme.fontFamily,
      fontSize: source.layout === "statement" ? 33 : 27,
      bold: true,
      color: normalizeColor(document.theme.foreground),
      breakLine: false,
      margin: 0.03,
      valign: "middle"
    });
    if (source.subtitle) {
      slide.addText(source.subtitle, {
        x: 0.7, y: 2.0, w: 11.6, h: 0.55,
        fontFace: document.theme.fontFamily,
        fontSize: 15,
        color: normalizeColor(document.theme.muted),
        margin: 0.02
      });
    }
    const body = source.body.map((item) => `• ${item}`).join("\n\n");
    slide.addText(body, {
      x: 0.75,
      y: source.subtitle ? 2.75 : 2.35,
      w: source.layout === "two_column" ? 10.9 : 11.2,
      h: source.subtitle ? 3.75 : 4.15,
      fontFace: document.theme.fontFamily,
      fontSize: source.layout === "statement" ? 20 : 18,
      color: normalizeColor(document.theme.foreground),
      margin: 0.04,
      breakLine: false,
      valign: "top",
      paraSpaceAfter: 14
    });
    slide.addText(document.title, {
      x: 0.7, y: 7.08, w: 5.4, h: 0.2,
      fontFace: document.theme.fontFamily,
      fontSize: 8,
      color: normalizeColor(document.theme.muted),
      margin: 0
    });
  }

  const output = await pptx.write({ outputType: "arraybuffer" });
  if (output instanceof ArrayBuffer) return new Uint8Array(output);
  if (ArrayBuffer.isView(output)) return new Uint8Array(output.buffer, output.byteOffset, output.byteLength);
  throw new Error("PptxGenJS returned an unsupported output type");
}
