import {
  SLIDE_HEIGHT_IN,
  SLIDE_WIDTH_IN,
  type PptSlide,
  type PptTheme,
  type ShapeElement,
  type SlideElement,
  type TableElement,
  type TextElement
} from "./types";

/**
 * Element helpers shared by the editor, the agent tools and the PPTX renderer.
 *
 * A slide is "freeform" once it has elements. Until then it renders through the
 * fixed `layout` (title / subtitle / bullets), which is what the AI workflow
 * produces. `elementsFromLayout` is the one-way door between the two: it
 * materialises the layout as real, draggable elements so nothing is lost when a
 * user starts editing freely.
 */

export function isFreeform(slide: PptSlide): boolean {
  return slide.elements.length > 0;
}

export function nextZ(elements: SlideElement[]): number {
  return elements.reduce((max, element) => Math.max(max, element.z), 0) + 1;
}

export function newElementId(): string {
  return `el-${crypto.randomUUID()}`;
}

export function createTextElement(overrides: Partial<TextElement> = {}): TextElement {
  return {
    id: newElementId(),
    type: "text",
    x: 1,
    y: 1,
    w: 5,
    h: 1,
    rotation: 0,
    z: 1,
    role: "body",
    text: "New text",
    fontSize: 18,
    align: "left",
    valign: "top",
    ...overrides
  };
}

export function createShapeElement(overrides: Partial<ShapeElement> = {}): ShapeElement {
  return {
    id: newElementId(),
    type: "shape",
    x: 1,
    y: 1,
    w: 3,
    h: 2,
    rotation: 0,
    z: 1,
    shape: "rect",
    fill: "5B6CFF",
    strokeWidth: 0,
    ...overrides
  };
}

export function createTableElement(overrides: Partial<TableElement> = {}): TableElement {
  return {
    id: newElementId(),
    type: "table",
    x: 1,
    y: 1.5,
    w: 8,
    h: 2,
    rotation: 0,
    z: 1,
    headerRow: true,
    fontSize: 12,
    rows: [
      ["Metric", "Q1", "Q2"],
      ["Revenue", "—", "—"],
      ["Margin", "—", "—"]
    ],
    ...overrides
  };
}

/**
 * Convert a layout-driven slide into equivalent freeform elements.
 *
 * Positions mirror `renderPptx`'s layout arithmetic so converting a slide does
 * not visibly move anything — the user keeps exactly the deck they had.
 */
export function elementsFromLayout(slide: PptSlide, theme: PptTheme): SlideElement[] {
  const elements: SlideElement[] = [];
  let z = 1;

  elements.push(createTextElement({
    x: 0.65,
    y: 0.95,
    w: 11.9,
    h: 1,
    z: z++,
    role: "title",
    text: slide.title,
    fontSize: slide.layout === "statement" ? 33 : 27,
    bold: true,
    color: theme.foreground,
    valign: "middle"
  }));

  if (slide.subtitle) {
    elements.push(createTextElement({
      x: 0.7,
      y: 2,
      w: 11.6,
      h: 0.55,
      z: z++,
      role: "caption",
      text: slide.subtitle,
      fontSize: 15,
      color: theme.muted
    }));
  }

  if (slide.body.length) {
    elements.push(createTextElement({
      x: 0.75,
      y: slide.subtitle ? 2.75 : 2.35,
      w: slide.layout === "two_column" ? 10.9 : 11.2,
      h: slide.subtitle ? 3.75 : 4.15,
      z: z++,
      role: "body",
      text: slide.body.join("\n"),
      fontSize: slide.layout === "statement" ? 20 : 18,
      color: theme.foreground,
      bullet: true
    }));
  }

  return elements;
}

/** Centre a newly inserted element so it always lands somewhere visible. */
export function centeredAt(w: number, h: number) {
  return {
    x: Math.max(0, (SLIDE_WIDTH_IN - w) / 2),
    y: Math.max(0, (SLIDE_HEIGHT_IN - h) / 2)
  };
}
