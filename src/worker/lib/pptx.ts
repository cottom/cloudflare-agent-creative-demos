import PptxGenJS from "pptxgenjs";
import type { PresentationDocument } from "../../shared/types";

function normalizeColor(color: string): string {
  return color.replace(/^#/, "").toUpperCase();
}

export async function renderPptx(document: PresentationDocument): Promise<Uint8Array> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Cloudflare Creative Agent Demo";
  pptx.company = "Cloudflare Creative Agent Demo";
  pptx.subject = document.objective;
  pptx.title = document.title;
  pptx.lang = "zh-CN";
  pptx.theme = {
    headFontFace: document.theme.fontFamily,
    bodyFontFace: document.theme.fontFamily,
    lang: "zh-CN"
  };

  for (const [index, source] of document.slides.entries()) {
    const slide = pptx.addSlide();
    slide.background = { color: normalizeColor(document.theme.background) };
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
      valign: "mid"
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
      paraSpaceAfterPt: 14
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
