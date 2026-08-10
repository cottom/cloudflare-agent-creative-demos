import { useEffect, useMemo, useState } from "react";
import type { ProjectInteraction } from "../../shared/types";

type Props = {
  interaction: ProjectInteraction;
  busy?: boolean;
  onApprove: (response: Record<string, unknown>) => Promise<void>;
  onReject: (reason: string) => Promise<void>;
};

export function InteractionCard({ interaction, busy, onApprove, onReject }: Props) {
  const plan = interaction.payload.plan as Record<string, unknown> | undefined;
  const initialTheme = typeof plan?.recommendedTheme === "string" ? plan.recommendedTheme : "midnight";
  const initialDirections = useMemo(() => {
    const raw = interaction.payload.directions;
    if (!Array.isArray(raw)) return [];
    return raw.map((item) => {
      const value = item as Record<string, unknown>;
      return {
        title: String(value.title ?? "Creative direction"),
        rationale: String(value.rationale ?? ""),
        prompt: String(value.prompt ?? "")
      };
    });
  }, [interaction.id]);
  const [themeId, setThemeId] = useState(initialTheme);
  const [direction, setDirection] = useState("");
  const [directions, setDirections] = useState(initialDirections);
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    setThemeId(initialTheme);
    setDirection("");
    setDirections(initialDirections);
    setSelected([]);
  }, [interaction.id, initialTheme, initialDirections]);

  const planSlides = Array.isArray(plan?.slides) ? plan?.slides as Array<Record<string, unknown>> : [];
  const choiceOptions = Array.isArray(interaction.payload.options)
    ? interaction.payload.options as Array<Record<string, unknown>>
    : [];
  const multiple = interaction.kind === "multi_select" || interaction.payload.multiple === true;

  const approve = async () => {
    if (interaction.kind === "ppt_plan_review") {
      await onApprove({ themeId, direction, slides: planSlides });
      return;
    }
    if (interaction.kind === "canvas_variant_review") {
      await onApprove({ directions });
      return;
    }
    if (interaction.kind === "choice" || interaction.kind === "multi_select") {
      await onApprove({ selected: multiple ? selected : selected[0] });
      return;
    }
    await onApprove({ approved: true });
  };

  return (
    <section className="interaction-card">
      <div className="interaction-kicker">Human input required</div>
      <h3>{interaction.title}</h3>
      {interaction.description && <p>{interaction.description}</p>}

      {interaction.kind === "ppt_plan_review" && (
        <div className="interaction-body">
          <label>
            Theme
            <select value={themeId} onChange={(event) => setThemeId(event.target.value)}>
              <option value="midnight">Midnight Signal</option>
              <option value="editorial">Editorial Ink</option>
              <option value="minimal">Minimal Cloud</option>
              <option value="sunrise">Sunrise Lab</option>
            </select>
          </label>
          <div className="plan-list">
            {planSlides.map((slide, index) => (
              <div className="plan-row" key={`${index}-${String(slide.title)}`}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <div><strong>{String(slide.title ?? "Untitled")}</strong><small>{String(slide.purpose ?? "")}</small></div>
              </div>
            ))}
          </div>
          <label>
            Additional direction
            <textarea value={direction} onChange={(event) => setDirection(event.target.value)} placeholder="Example: make the opening more decisive and keep the tone investor-ready." />
          </label>
        </div>
      )}

      {interaction.kind === "canvas_variant_review" && (
        <div className="interaction-body">
          {directions.map((item, index) => (
            <div className="prompt-editor" key={`${interaction.id}-${index}`}>
              <input
                value={item.title}
                onChange={(event) => setDirections((items) => items.map((current, currentIndex) => currentIndex === index ? { ...current, title: event.target.value } : current))}
              />
              <textarea
                value={item.prompt}
                onChange={(event) => setDirections((items) => items.map((current, currentIndex) => currentIndex === index ? { ...current, prompt: event.target.value } : current))}
              />
              <small>{item.rationale}</small>
            </div>
          ))}
        </div>
      )}

      {(interaction.kind === "choice" || interaction.kind === "multi_select") && (
        <div className="choice-list">
          {choiceOptions.map((option) => {
            const value = String(option.value ?? option.label ?? "option");
            const checked = selected.includes(value);
            return (
              <label className="choice-option" key={value}>
                <input
                  type={multiple ? "checkbox" : "radio"}
                  checked={checked}
                  onChange={() => setSelected((current) => {
                    if (!multiple) return [value];
                    return checked ? current.filter((item) => item !== value) : [...current, value];
                  })}
                />
                <span><strong>{String(option.label ?? value)}</strong><small>{String(option.description ?? "")}</small></span>
              </label>
            );
          })}
        </div>
      )}

      <div className="interaction-actions">
        <button className="button ghost" disabled={busy} onClick={() => void onReject("Rejected from demo UI")}>Reject</button>
        <button className="button primary" disabled={busy || ((interaction.kind === "choice" || interaction.kind === "multi_select") && selected.length === 0)} onClick={() => void approve()}>
          {busy ? "Submitting…" : "Approve & continue"}
        </button>
      </div>
    </section>
  );
}
