import type { PptistController } from "@lofcz/pptist";

/**
 * Bridge between the agent's tool calls and the live PPTist controller.
 *
 * The controller only exists in the browser, so the agent's PPTist tools are
 * declared without a server `execute`: the model emits a tool call, the chat
 * panel runs it here against the mounted editor, and the result goes back via
 * `addToolOutput`. That keeps PPTist as the single editing engine instead of
 * reimplementing its command surface on the server.
 *
 * A module-level handle is deliberate: the editor and the chat panel are
 * siblings in the tree, and threading a controller ref through App would add
 * plumbing for what is, in the browser, a genuine singleton.
 */
let controller: PptistController | null = null;

export function setPptistController(next: PptistController | null): void {
  controller = next;
}

export function getPptistController(): PptistController | null {
  return controller;
}

export type PptistToolResult = Record<string, unknown>;

/** Tool names the agent may route to the editor. */
export const PPTIST_TOOLS = ["pptist_domains", "pptist_describe", "pptist_state", "pptist_execute"] as const;
export type PptistToolName = (typeof PPTIST_TOOLS)[number];

export function isPptistTool(name: string): name is PptistToolName {
  return (PPTIST_TOOLS as readonly string[]).includes(name);
}

/**
 * Execute one agent tool call against the editor.
 *
 * Errors are returned rather than thrown so a bad command becomes a tool
 * result the model can read and correct, instead of a dead turn.
 */
export async function runPptistTool(name: PptistToolName, input: unknown): Promise<PptistToolResult> {
  if (!controller) return { ok: false, error: "The PPTist editor is not open. Ask the user to open the PPT project first." };
  const payload = (input ?? {}) as Record<string, unknown>;

  try {
    if (name === "pptist_domains") {
      return { ok: true, domains: controller.domains() };
    }

    if (name === "pptist_describe") {
      const commandType = String(payload.commandType ?? "");
      const description = controller.describe(commandType);
      return description
        ? { ok: true, description }
        : { ok: false, error: `Unknown PPTist command: ${commandType}` };
    }

    if (name === "pptist_state") {
      const state = controller.getState();
      return { ok: true, state };
    }

    const commands = Array.isArray(payload.commands) ? payload.commands : [];
    if (!commands.length) return { ok: false, error: "No commands supplied" };
    const results = await controller.executeBatch(
      commands as Parameters<PptistController["executeBatch"]>[0]
    );
    const failed = results.filter((result) => !result?.ok);
    return {
      ok: failed.length === 0,
      applied: results.length - failed.length,
      failed: failed.length,
      results
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
