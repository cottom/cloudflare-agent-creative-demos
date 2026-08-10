import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep, ApprovalEventPayload } from "agents/workflows";
import type {
  CanvasCommand,
  CanvasNode,
  CanvasVariantsWorkflowParams,
  ProjectInteraction,
  ProjectState,
  WorkflowProgressPayload
} from "../../shared/types";
import type { StudioAgent } from "../studio-agent";
import { generateCanvasDirections, generateImageBytes } from "../lib/ai";
import { saveCanvasImage } from "../lib/artifacts";
import { readProject } from "../lib/project-access";

/** Image variants generated in flight at once. */
const IMAGE_CONCURRENCY = 2;

function stableSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0) || 1;
}

function normalizedDirections(
  original: Array<{ title: string; prompt: string; rationale: string }>,
  response?: Record<string, unknown>
) {
  const candidate = response?.directions;
  if (!Array.isArray(candidate)) return original;
  const parsed = candidate.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    if (typeof value.prompt !== "string" || !value.prompt.trim()) return [];
    return [{
      title: typeof value.title === "string" ? value.title : "Creative direction",
      rationale: typeof value.rationale === "string" ? value.rationale : "Human-edited direction",
      prompt: value.prompt
    }];
  });
  return parsed.length ? parsed : original;
}

export class CanvasVariantsWorkflow extends AgentWorkflow<StudioAgent, CanvasVariantsWorkflowParams, WorkflowProgressPayload, Env> {
  async run(event: AgentWorkflowEvent<CanvasVariantsWorkflowParams>, step: AgentWorkflowStep) {
    const params = event.payload;
    await this.reportProgress({ step: "creative-directions", status: "running", percent: 0.04, message: "Planning distinct visual directions" });

    const referenceContext = await step.do("read-selected-context", async () => this.agent.getCurrentProjectContext());
    const plan = await step.do("generate-creative-directions", {
      retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
      timeout: "5 minutes"
    }, async () => generateCanvasDirections(this.env, params, referenceContext));

    const interactionId = `canvas-directions-${this.workflowId}`;
    const interaction: ProjectInteraction = {
      id: interactionId,
      projectId: params.projectId,
      sessionId: params.sessionId,
      workflowId: this.workflowId,
      source: "workflow",
      kind: "canvas_variant_review",
      title: "Review image-generation directions",
      description: "Edit or approve prompts before real Workers AI image generation consumes credits.",
      payload: { campaignName: plan.campaignName, directions: plan.directions, aspectRatio: params.aspectRatio ?? "4:5" },
      status: "pending",
      createdAt: new Date().toISOString()
    };
    await step.do(
      "publish-directions-review",
      async (): Promise<ProjectInteraction> => this.agent.createWorkflowInteraction(interaction)
    );
    await this.reportProgress({
      step: "approval", status: "waiting", percent: 0.2,
      message: "Waiting for visual direction approval", interactionId
    });

    const approval = await this.waitForApproval<ApprovalEventPayload>(step, {
      timeout: "7 days"
    });
    if (!approval.approved) throw new Error(approval.reason ?? "Visual directions were not approved");
    const response = (approval.metadata?.response as Record<string, unknown> | undefined) ?? {};
    const directions = normalizedDirections(plan.directions, response).slice(0, Math.max(1, Math.min(params.count, 6)));

    const startX = 650;
    const startY = 80;
    const nodeWidth = params.aspectRatio === "9:16" ? 260 : params.aspectRatio === "16:9" ? 420 : 320;
    const nodeHeight = params.aspectRatio === "9:16" ? 462 : params.aspectRatio === "16:9" ? 236 : params.aspectRatio === "1:1" ? 320 : 400;
    const nodes: CanvasNode[] = directions.map((direction, index) => ({
      id: `generated-${this.workflowId}-${index + 1}`,
      type: "image",
      x: startX + (index % 3) * (nodeWidth + 60),
      y: startY + Math.floor(index / 3) * (nodeHeight + 100),
      width: nodeWidth,
      height: nodeHeight,
      rotation: 0,
      zIndex: 20 + index,
      title: direction.title,
      prompt: direction.prompt,
      status: "generating"
    }));

    await step.do(
      "create-canvas-placeholders",
      async (): Promise<ProjectState> => this.agent.applyWorkflowCommands(
        this.workflowId,
        nodes.map((node): CanvasCommand => ({ type: "canvas.add_node", node })),
        `Created ${nodes.length} image generation placeholders`,
        "create-canvas-placeholders"
      )
    );

    const failedNodeIds: string[] = [];
    const generatedNodeIds: string[] = [];

    /** Generate one variant. Resolves either way — a failure is recorded, not thrown. */
    const generateVariant = async (index: number): Promise<void> => {
      const node = nodes[index];
      const direction = directions[index];
      if (!node || !direction) return;
      try {
        const saved = await step.do(`generate-and-persist-image-${index + 1}`, {
          retries: { limit: 4, delay: "10 seconds", backoff: "exponential" },
          timeout: "8 minutes"
        }, async () => {
          const bytes = await generateImageBytes(
            this.env,
            direction.prompt,
            stableSeed(`${this.workflowId}:${index + 1}`)
          );
          const current = await readProject(this.env, "canvas", params.projectId);
          if (current.kind !== "canvas") throw new Error("Project kind mismatch");
          return saveCanvasImage(this.env, current, this.workflowId, node.id, bytes);
        });
        await step.do(
          `attach-image-${index + 1}`,
          async (): Promise<ProjectState> => this.agent.applyWorkflowCommands(
            this.workflowId,
            [{ type: "canvas.set_generated_asset", nodeId: node.id, assetKey: saved.key, prompt: direction.prompt, status: "ready" }],
            `Attached generated image: ${direction.title}`,
            `attach-image-${index + 1}`
          )
        );
        generatedNodeIds.push(node.id);
      } catch {
        // One bad variant must not cost the user the others: mark this node and
        // let the remaining directions finish.
        failedNodeIds.push(node.id);
        await step.do(
          `mark-image-error-${index + 1}`,
          async (): Promise<ProjectState> => this.agent.applyWorkflowCommands(
            this.workflowId,
            [{ type: "canvas.update_node", nodeId: node.id, patch: { status: "error" } }],
            `Marked failed image generation: ${direction.title}`,
            `mark-image-error-${index + 1}`
          )
        ).catch(() => undefined);
      }
    };

    // Bounded concurrency: enough to cut wall-clock time meaningfully without
    // bursting Workers AI, and it keeps at most IMAGE_CONCURRENCY writers
    // competing for the project revision at a time.
    for (let start = 0; start < nodes.length; start += IMAGE_CONCURRENCY) {
      const batch = nodes.slice(start, start + IMAGE_CONCURRENCY);
      await this.reportProgress({
        step: `generate-${start + 1}`,
        status: "running",
        percent: 0.28 + (start / nodes.length) * 0.58,
        message: `Generating ${start + 1}-${start + batch.length} of ${nodes.length}`
      });
      await Promise.all(batch.map((_, offset) => generateVariant(start + offset)));
    }

    if (!generatedNodeIds.length) {
      throw new Error(`Every image variant failed to generate (${failedNodeIds.length} attempted)`);
    }

    const finalState = await step.do(
      "read-final-canvas",
      async (): Promise<ProjectState> => this.agent.getProjectSnapshot()
    );
    const result = {
      projectId: params.projectId,
      revision: finalState.revision,
      generatedNodeIds,
      failedNodeIds
    };
    await this.reportProgress({
      step: "complete",
      status: "complete",
      percent: 1,
      message: failedNodeIds.length
        ? `Canvas variants ready (${generatedNodeIds.length} of ${nodes.length}; ${failedNodeIds.length} failed)`
        : "Canvas variants are ready"
    });
    await step.reportComplete(result);
    return result;
  }
}
