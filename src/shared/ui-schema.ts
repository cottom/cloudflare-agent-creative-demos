import { z } from "zod";

/**
 * The interactive-UI DSL.
 *
 * This is "declarative generative UI": the agent returns a validated spec and
 * the client renders it from a curated component library. The model never
 * emits markup, so a bad or hostile spec can change wording and options —
 * never behaviour, styling or accessibility.
 *
 * The schema is deliberately flat rather than a discriminated union: smaller
 * instruct models emit malformed unions far more often than they misuse
 * optional fields. `component` selects the renderer; unused fields are absent.
 */

export const uiOptionSchema = z.object({
  value: z.string().min(1).max(80),
  label: z.string().min(1).max(120),
  description: z.string().max(240).optional(),
  /**
   * Branch marker. When the user picks this option the value is echoed back as
   * `path`, so the agent can route follow-up work without re-parsing prose.
   */
  path: z.string().max(80).optional()
});

export const uiFieldTypeSchema = z.enum([
  "text",
  "textarea",
  "number",
  "email",
  "url",
  "date",
  "select",
  "radio",
  "checkbox",
  "multi_select",
  "slider"
]);

export const uiFieldSchema = z.object({
  name: z.string().min(1).max(40),
  label: z.string().min(1).max(120),
  type: uiFieldTypeSchema,
  help: z.string().max(240).optional(),
  placeholder: z.string().max(120).optional(),
  defaultValue: z.string().max(400).optional(),
  required: z.boolean().optional(),
  // Validation. Mirrors JSON Schema semantics: a bounded number renders as a
  // slider, an enum renders as a select, a pattern is enforced before submit.
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().positive().optional(),
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().positive().optional(),
  pattern: z.string().max(200).optional(),
  options: z.array(uiOptionSchema).max(12).optional(),
  /**
   * Cascading options: choices depend on another field's current value.
   * `{ field: "region", map: { emea: [...], amer: [...] } }`
   */
  optionsBy: z.object({
    field: z.string().min(1).max(40),
    map: z.record(z.string(), z.array(uiOptionSchema).max(12))
  }).optional(),
  /** Conditional visibility — the other half of a dependent form. */
  showIf: z.object({
    field: z.string().min(1).max(40),
    equals: z.string().max(80).optional(),
    oneOf: z.array(z.string().max(80)).max(12).optional()
  }).optional()
});

export const uiSpecSchema = z.object({
  component: z.enum(["choice", "radio", "select", "multi_select", "form", "confirm"]),
  title: z.string().min(2).max(120),
  description: z.string().max(400).optional(),
  submitLabel: z.string().max(40).optional(),
  cancelLabel: z.string().max(40).optional(),
  /** Used by choice / radio / select / multi_select. */
  options: z.array(uiOptionSchema).max(12).optional(),
  /** multi_select bounds. */
  minSelected: z.number().int().nonnegative().optional(),
  maxSelected: z.number().int().positive().optional(),
  /** Used by form. */
  fields: z.array(uiFieldSchema).max(10).optional()
});

export type UiOption = z.infer<typeof uiOptionSchema>;
export type UiField = z.infer<typeof uiFieldSchema>;
export type UiFieldType = z.infer<typeof uiFieldTypeSchema>;
export type UiSpec = z.infer<typeof uiSpecSchema>;

/** What the client sends back as the tool's output. */
export type UiResponse = {
  component: UiSpec["component"];
  selected?: string;
  selectedValues?: string[];
  values?: Record<string, string | string[] | boolean>;
  /** Branch taken, when the chosen option declared a `path`. */
  path?: string;
  cancelled?: boolean;
};

/**
 * Validate an unknown tool input into a renderable spec.
 *
 * Returns null rather than throwing: a malformed spec degrades to showing the
 * raw tool call in the transcript, and never breaks the chat.
 */
export function parseUiSpec(input: unknown): UiSpec | null {
  const parsed = uiSpecSchema.safeParse(input);
  if (!parsed.success) return null;
  const spec = parsed.data;
  const needsOptions = spec.component === "choice" || spec.component === "radio"
    || spec.component === "select" || spec.component === "multi_select";
  if (needsOptions && !spec.options?.length) return null;
  if (spec.component === "form" && !spec.fields?.length) return null;
  return spec;
}

export type FormValues = Record<string, string | string[] | boolean>;

/** Resolve a field's options, following `optionsBy` against current values. */
export function resolveOptions(field: UiField, values: FormValues): UiOption[] {
  if (field.optionsBy) {
    const key = values[field.optionsBy.field];
    if (typeof key === "string") return field.optionsBy.map[key] ?? [];
    return [];
  }
  return field.options ?? [];
}

/** Whether a conditional field should currently be shown. */
export function isFieldVisible(field: UiField, values: FormValues): boolean {
  if (!field.showIf) return true;
  const actual = values[field.showIf.field];
  const value = Array.isArray(actual) ? actual : [String(actual ?? "")];
  if (field.showIf.equals !== undefined) return value.includes(field.showIf.equals);
  if (field.showIf.oneOf) return field.showIf.oneOf.some((candidate) => value.includes(candidate));
  return true;
}

/**
 * Validate the visible fields of a form.
 *
 * Hidden fields are skipped: a required field inside a branch the user did not
 * take must never block submission.
 */
export function validateForm(fields: UiField[], values: FormValues): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    if (!isFieldVisible(field, values)) continue;
    const raw = values[field.name];
    const empty = raw === undefined || raw === "" || (Array.isArray(raw) && raw.length === 0);

    if (field.required && empty && field.type !== "checkbox") {
      errors[field.name] = `${field.label} is required`;
      continue;
    }
    if (empty) continue;

    if (typeof raw === "string") {
      if (field.minLength !== undefined && raw.length < field.minLength) {
        errors[field.name] = `Use at least ${field.minLength} characters`;
      } else if (field.maxLength !== undefined && raw.length > field.maxLength) {
        errors[field.name] = `Use at most ${field.maxLength} characters`;
      } else if (field.pattern && !safeMatches(field.pattern, raw)) {
        errors[field.name] = `${field.label} is not in the expected format`;
      } else if (field.type === "email" && !raw.includes("@")) {
        errors[field.name] = "Enter a valid email address";
      } else if (field.type === "number" || field.type === "slider") {
        const numeric = Number(raw);
        if (!Number.isFinite(numeric)) errors[field.name] = "Enter a number";
        else if (field.min !== undefined && numeric < field.min) errors[field.name] = `Minimum is ${field.min}`;
        else if (field.max !== undefined && numeric > field.max) errors[field.name] = `Maximum is ${field.max}`;
      }
    }
  }
  return errors;
}

/**
 * A model-supplied pattern is untrusted input. Compiling it can throw on bad
 * syntax, so failures are treated as "no constraint" rather than crashing the
 * form the user is trying to submit.
 */
function safeMatches(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return true;
  }
}

/** Human-readable summary of a response, used for the transcript line. */
export function describeUiResponse(response: UiResponse): string {
  if (response.cancelled) return "Dismissed";
  if (response.selectedValues?.length) return response.selectedValues.join(", ");
  if (response.selected) return response.selected;
  if (response.values) {
    return Object.entries(response.values)
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join("/") : String(value)}`)
      .join(" · ");
  }
  return "Submitted";
}
