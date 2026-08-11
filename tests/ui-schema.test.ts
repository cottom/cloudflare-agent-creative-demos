import { describe, expect, it } from "vitest";
import {
  isFieldVisible,
  parseUiSpec,
  resolveOptions,
  validateForm,
  type UiField
} from "../src/shared/ui-schema";

const field = (overrides: Partial<UiField> & Pick<UiField, "name" | "label" | "type">): UiField =>
  ({ ...overrides }) as UiField;

describe("ui spec parsing", () => {
  it("accepts a well-formed choice card", () => {
    const spec = parseUiSpec({
      component: "choice",
      title: "Pick a theme",
      options: [{ value: "midnight", label: "Midnight" }, { value: "minimal", label: "Minimal" }]
    });
    expect(spec?.component).toBe("choice");
    expect(spec?.options).toHaveLength(2);
  });

  it("rejects option-based components with no options", () => {
    expect(parseUiSpec({ component: "select", title: "Pick one" })).toBeNull();
    expect(parseUiSpec({ component: "multi_select", title: "Pick some", options: [] })).toBeNull();
  });

  it("rejects a form with no fields, and malformed input", () => {
    expect(parseUiSpec({ component: "form", title: "Details" })).toBeNull();
    expect(parseUiSpec({ component: "nope", title: "Bad" })).toBeNull();
    expect(parseUiSpec(null)).toBeNull();
  });

  it("keeps the branch path on an option", () => {
    const spec = parseUiSpec({
      component: "choice",
      title: "Next step",
      options: [{ value: "rebuild", label: "Rebuild", path: "workflow/rebuild" }]
    });
    expect(spec?.options?.[0]?.path).toBe("workflow/rebuild");
  });
});

describe("dependent fields", () => {
  const region = field({ name: "region", label: "Region", type: "select" });
  const city = field({
    name: "city",
    label: "City",
    type: "select",
    optionsBy: { field: "region", map: { emea: [{ value: "lon", label: "London" }], amer: [{ value: "nyc", label: "New York" }] } }
  });

  it("resolves cascading options from another field's value", () => {
    expect(resolveOptions(city, { region: "emea" }).map((option) => option.value)).toEqual(["lon"]);
    expect(resolveOptions(city, { region: "amer" }).map((option) => option.value)).toEqual(["nyc"]);
    expect(resolveOptions(city, {})).toEqual([]);
    expect(resolveOptions(region, {})).toEqual([]);
  });

  it("shows a field only when its condition matches", () => {
    const detail = field({ name: "detail", label: "Detail", type: "text", showIf: { field: "mode", equals: "custom" } });
    expect(isFieldVisible(detail, { mode: "custom" })).toBe(true);
    expect(isFieldVisible(detail, { mode: "auto" })).toBe(false);

    const anyOf = field({ name: "extra", label: "Extra", type: "text", showIf: { field: "mode", oneOf: ["a", "b"] } });
    expect(isFieldVisible(anyOf, { mode: "b" })).toBe(true);
    expect(isFieldVisible(anyOf, { mode: "c" })).toBe(false);
  });
});

describe("form validation", () => {
  it("requires visible required fields only", () => {
    const fields = [
      field({ name: "mode", label: "Mode", type: "radio" }),
      field({ name: "detail", label: "Detail", type: "text", required: true, showIf: { field: "mode", equals: "custom" } })
    ];
    expect(validateForm(fields, { mode: "auto" })).toEqual({});
    expect(validateForm(fields, { mode: "custom" })).toHaveProperty("detail");
    expect(validateForm(fields, { mode: "custom", detail: "x" })).toEqual({});
  });

  it("enforces length, numeric bounds and email shape", () => {
    const fields = [
      field({ name: "name", label: "Name", type: "text", minLength: 3 }),
      field({ name: "count", label: "Count", type: "number", min: 1, max: 5 }),
      field({ name: "mail", label: "Mail", type: "email" })
    ];
    const errors = validateForm(fields, { name: "ab", count: "9", mail: "nope" });
    expect(errors.name).toContain("at least 3");
    expect(errors.count).toContain("Maximum is 5");
    expect(errors.mail).toContain("valid email");
    expect(validateForm(fields, { name: "abc", count: "3", mail: "a@b.co" })).toEqual({});
  });

  it("treats an invalid model-supplied pattern as no constraint", () => {
    const fields = [field({ name: "code", label: "Code", type: "text", pattern: "([unclosed" })];
    expect(validateForm(fields, { code: "anything" })).toEqual({});
  });

  it("does not require an unchecked checkbox", () => {
    const fields = [field({ name: "agree", label: "Agree", type: "checkbox", required: true })];
    expect(validateForm(fields, { agree: false })).toEqual({});
  });
});
