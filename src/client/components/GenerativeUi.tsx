import { useMemo, useState } from "react";
import {
  isFieldVisible,
  resolveOptions,
  validateForm,
  type FormValues,
  type UiField,
  type UiOption,
  type UiResponse,
  type UiSpec
} from "../../shared/ui-schema";

type Props = {
  spec: UiSpec;
  /** False once the user has answered, or while the turn is busy. */
  active: boolean;
  onSubmit: (response: UiResponse) => void;
};

/**
 * Renders one interactive card from the agent's UI spec.
 *
 * Every component is prebuilt and styled here — the model only chooses which
 * one to show and supplies labels, options and validation bounds.
 */
export function GenerativeUi({ spec, active, onSubmit }: Props) {
  switch (spec.component) {
    case "choice":
      return <ChoiceCard spec={spec} active={active} onSubmit={onSubmit} />;
    case "radio":
      return <RadioCard spec={spec} active={active} onSubmit={onSubmit} />;
    case "select":
      return <SelectCard spec={spec} active={active} onSubmit={onSubmit} />;
    case "multi_select":
      return <MultiSelectCard spec={spec} active={active} onSubmit={onSubmit} />;
    case "form":
      return <FormCard spec={spec} active={active} onSubmit={onSubmit} />;
    case "confirm":
      return <ConfirmCard spec={spec} active={active} onSubmit={onSubmit} />;
  }
}

function CardShell({ spec, children }: { spec: UiSpec; children: React.ReactNode }) {
  return (
    <section className="generative-card">
      <div className="interaction-kicker">Your input</div>
      <h3>{spec.title}</h3>
      {spec.description && <p>{spec.description}</p>}
      {children}
    </section>
  );
}

/** Options carry an optional `path`, echoed back so the agent can branch. */
function answerFor(spec: UiSpec, option: UiOption): UiResponse {
  return { component: spec.component, selected: option.value, ...(option.path ? { path: option.path } : {}) };
}

function ChoiceCard({ spec, active, onSubmit }: Props) {
  return (
    <CardShell spec={spec}>
      <div className="generative-options">
        {(spec.options ?? []).map((option) => (
          <button key={option.value} className="generative-option" disabled={!active} onClick={() => onSubmit(answerFor(spec, option))}>
            <strong>{option.label}</strong>
            {option.description && <small>{option.description}</small>}
          </button>
        ))}
      </div>
    </CardShell>
  );
}

function RadioCard({ spec, active, onSubmit }: Props) {
  const options = spec.options ?? [];
  const [value, setValue] = useState(options[0]?.value ?? "");
  const chosen = options.find((option) => option.value === value);
  return (
    <CardShell spec={spec}>
      <div className="generative-radios">
        {options.map((option) => (
          <label key={option.value} className={value === option.value ? "radio-row selected" : "radio-row"}>
            <input type="radio" name={`radio-${spec.title}`} checked={value === option.value} disabled={!active} onChange={() => setValue(option.value)} />
            <span>
              <strong>{option.label}</strong>
              {option.description && <small>{option.description}</small>}
            </span>
          </label>
        ))}
      </div>
      <button className="button primary wide-button" disabled={!active || !chosen} onClick={() => chosen && onSubmit(answerFor(spec, chosen))}>
        {spec.submitLabel ?? "Continue"}
      </button>
    </CardShell>
  );
}

function SelectCard({ spec, active, onSubmit }: Props) {
  const options = spec.options ?? [];
  const [value, setValue] = useState("");
  const chosen = options.find((option) => option.value === value);
  return (
    <CardShell spec={spec}>
      <select className="generative-select" value={value} disabled={!active} onChange={(event) => setValue(event.target.value)}>
        <option value="">Select…</option>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <button className="button primary wide-button" disabled={!active || !chosen} onClick={() => chosen && onSubmit(answerFor(spec, chosen))}>
        {spec.submitLabel ?? "Continue"}
      </button>
    </CardShell>
  );
}

function MultiSelectCard({ spec, active, onSubmit }: Props) {
  const [selected, setSelected] = useState<string[]>([]);
  const min = spec.minSelected ?? 1;
  const max = spec.maxSelected;
  const toggle = (value: string) =>
    setSelected((current) =>
      current.includes(value)
        ? current.filter((item) => item !== value)
        : max !== undefined && current.length >= max ? current : [...current, value]
    );
  const valid = selected.length >= min && (max === undefined || selected.length <= max);

  return (
    <CardShell spec={spec}>
      <div className="generative-checks">
        {(spec.options ?? []).map((option) => (
          <label key={option.value} className={selected.includes(option.value) ? "check-row selected" : "check-row"}>
            <input type="checkbox" checked={selected.includes(option.value)} disabled={!active} onChange={() => toggle(option.value)} />
            <span>
              <strong>{option.label}</strong>
              {option.description && <small>{option.description}</small>}
            </span>
          </label>
        ))}
      </div>
      <div className="field-hint">
        {max !== undefined ? `Choose ${min}–${max}` : `Choose at least ${min}`} · {selected.length} selected
      </div>
      <button
        className="button primary wide-button"
        disabled={!active || !valid}
        onClick={() => onSubmit({ component: "multi_select", selectedValues: selected })}
      >
        {spec.submitLabel ?? "Continue"}
      </button>
    </CardShell>
  );
}

/**
 * A slider always renders a thumb at some position, so it is never really
 * empty. Seeding it with its minimum keeps the stored value in step with what
 * the user sees — otherwise an untouched required slider showing "3" fails
 * validation for being blank.
 */
function initialValue(field: UiField): string | string[] | boolean {
  if (field.type === "checkbox") return field.defaultValue === "true";
  if (field.type === "multi_select") return [];
  if (field.type === "slider") return field.defaultValue ?? String(field.min ?? 0);
  return field.defaultValue ?? "";
}

function FormCard({ spec, active, onSubmit }: Props) {
  const fields = useMemo(() => spec.fields ?? [], [spec.fields]);
  const [values, setValues] = useState<FormValues>(() =>
    Object.fromEntries(fields.map((field) => [field.name, initialValue(field)]))
  );
  const [touched, setTouched] = useState(false);
  const errors = validateForm(fields, values);
  const visible = fields.filter((field) => isFieldVisible(field, values));

  const set = (name: string, value: string | string[] | boolean) =>
    setValues((current) => ({ ...current, [name]: value }));

  const submit = () => {
    setTouched(true);
    if (Object.keys(errors).length > 0) return;
    // Hidden branches are dropped so the agent never receives values from a
    // path the user did not actually take.
    const payload = Object.fromEntries(visible.map((field) => [field.name, values[field.name] ?? ""]));
    onSubmit({ component: "form", values: payload });
  };

  return (
    <CardShell spec={spec}>
      <div className="generative-form">
        {visible.map((field) => (
          <FieldControl
            key={field.name}
            field={field}
            value={values[field.name]}
            values={values}
            active={active}
            error={touched ? errors[field.name] : undefined}
            onChange={(value) => set(field.name, value)}
          />
        ))}
      </div>
      <button className="button primary wide-button" disabled={!active} onClick={submit}>
        {spec.submitLabel ?? "Submit"}
      </button>
    </CardShell>
  );
}

function FieldControl({
  field,
  value,
  values,
  active,
  error,
  onChange
}: {
  field: UiField;
  value: string | string[] | boolean | undefined;
  values: FormValues;
  active: boolean;
  error?: string;
  onChange: (value: string | string[] | boolean) => void;
}) {
  const options = resolveOptions(field, values);
  const text = typeof value === "string" ? value : "";

  return (
    <label className={error ? "field invalid" : "field"}>
      <span className="field-label">
        {field.label}
        {field.required && <i className="required">*</i>}
      </span>

      {field.type === "textarea" && (
        <textarea value={text} placeholder={field.placeholder} disabled={!active} onChange={(event) => onChange(event.target.value)} />
      )}

      {(field.type === "text" || field.type === "email" || field.type === "url" || field.type === "date" || field.type === "number") && (
        <input
          type={field.type === "number" ? "number" : field.type === "date" ? "date" : field.type === "email" ? "email" : field.type === "url" ? "url" : "text"}
          value={text}
          placeholder={field.placeholder}
          min={field.min}
          max={field.max}
          step={field.step}
          disabled={!active}
          onChange={(event) => onChange(event.target.value)}
        />
      )}

      {field.type === "slider" && (
        <span className="slider-row">
          <input
            type="range"
            value={text}
            min={field.min ?? 0}
            max={field.max ?? 100}
            step={field.step ?? 1}
            disabled={!active}
            onChange={(event) => onChange(event.target.value)}
          />
          <b>{text}</b>
        </span>
      )}

      {field.type === "checkbox" && (
        <span className="checkbox-row">
          <input type="checkbox" checked={value === true} disabled={!active} onChange={(event) => onChange(event.target.checked)} />
          <small>{field.help ?? "Yes"}</small>
        </span>
      )}

      {field.type === "select" && (
        <select value={text} disabled={!active || options.length === 0} onChange={(event) => onChange(event.target.value)}>
          <option value="">{options.length === 0 ? "Choose the field above first…" : "Select…"}</option>
          {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      )}

      {field.type === "radio" && (
        <span className="inline-radios">
          {options.map((option) => (
            <label key={option.value} className={text === option.value ? "chip selected" : "chip"}>
              <input type="radio" name={field.name} checked={text === option.value} disabled={!active} onChange={() => onChange(option.value)} />
              {option.label}
            </label>
          ))}
        </span>
      )}

      {field.type === "multi_select" && (
        <span className="inline-radios">
          {options.map((option) => {
            const list = Array.isArray(value) ? value : [];
            const on = list.includes(option.value);
            return (
              <label key={option.value} className={on ? "chip selected" : "chip"}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={!active}
                  onChange={() => onChange(on ? list.filter((item) => item !== option.value) : [...list, option.value])}
                />
                {option.label}
              </label>
            );
          })}
        </span>
      )}

      {field.help && field.type !== "checkbox" && <small className="field-hint">{field.help}</small>}
      {error && <small className="field-error">{error}</small>}
    </label>
  );
}

function ConfirmCard({ spec, active, onSubmit }: Props) {
  return (
    <CardShell spec={spec}>
      <div className="generative-actions">
        <button className="button primary" disabled={!active} onClick={() => onSubmit({ component: "confirm", selected: "yes" })}>
          {spec.submitLabel ?? "Confirm"}
        </button>
        <button className="text-button" disabled={!active} onClick={() => onSubmit({ component: "confirm", selected: "no", cancelled: true })}>
          {spec.cancelLabel ?? "Cancel"}
        </button>
      </div>
    </CardShell>
  );
}
