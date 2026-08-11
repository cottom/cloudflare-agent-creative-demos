import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";
import type {
  ApprovalMetadata,
  PresentationDocument,
  ExportArtifact,
  PptBuildWorkflowParams,
  ProjectInteraction,
  ProjectState,
  WorkflowProgressPayload
} from "../../shared/types";
import type { StudioAgent } from "../studio-agent";
import { generateDeckPlan, generateImageBytes, generatePptPlan, type DeckPlan } from "../lib/ai";
import { artifactUrl, saveSlideImage } from "../lib/artifacts";
import { composeDeckHeadless } from "../lib/compose-deck";
import type { PptistDocument } from "../../shared/pptist";

export class PptBuildWorkflow extends AgentWorkflow<StudioAgent, PptBuildWorkflowParams, WorkflowProgressPayload, Env> {
  async run(event: AgentWorkflowEvent<PptBuildWorkflowParams>, step: AgentWorkflowStep) {
    const params = event.payload;
    await this.reportProgress({ step: "plan", status: "running", percent: 0.05, message: "Creating presentation strategy" });

    const plan = await step.do("generate-presentation-plan", {
      retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
      timeout: "5 minutes"
    }, async () => generatePptPlan(this.env, params));

    const interactionId = `ppt-plan-${this.workflowId}`;
    const interaction: ProjectInteraction = {
      id: interactionId,
      projectId: params.projectId,
      sessionId: params.sessionId,
      workflowId: this.workflowId,
      source: "workflow",
      kind: "ppt_plan_review",
      title: "Review the AI presentation plan",
      description: "Confirm the narrative and theme before the workflow writes the long-lived presentation asset.",
      payload: {
        plan,
        themeOptions: ["midnight", "editorial", "minimal", "sunrise"],
        editableFields: ["themeId", "direction", "slides"]
      },
      status: "pending",
      createdAt: new Date().toISOString()
    };
    await step.do(
      "publish-plan-review",
      async (): Promise<ProjectInteraction> => this.agent.createWorkflowInteraction(interaction)
    );
    await this.reportProgress({
      step: "approval", status: "waiting", percent: 0.25,
      message: "Waiting for presentation plan approval", interactionId
    });

    // `waitForApproval` resolves only when approved — it inspects `approved`
    // itself and throws `WorkflowRejectedError` otherwise — and it returns the
    // approval's `metadata`, not the event envelope.
    const approval = await this.waitForApproval<ApprovalMetadata | undefined>(step, {
      timeout: "7 days"
    });
    const response = approval?.response ?? {};

    await this.reportProgress({ step: "write", status: "running", percent: 0.35, message: "Choosing layouts for each slide" });
    const deckPlan = await step.do("generate-deck-plan", {
      retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
      timeout: "8 minutes"
    }, async (): Promise<DeckPlan> => generateDeckPlan(this.env, params, plan, response));

    // The model decides which slides earn a picture, so only those cost a
    // generation. Bounded concurrency keeps Workers AI load predictable.
    const imageTargets = deckPlan.slides
      .map((slide, index) => ({ index, prompt: slide.imagePrompt }))
      .filter((entry): entry is { index: number; prompt: string } => Boolean(entry.prompt));

    await this.reportProgress({
      step: "images", status: "running", percent: 0.5,
      message: imageTargets.length ? `Generating ${imageTargets.length} slide image(s)` : "No slide images requested"
    });

    const imageUrls: Record<number, string> = {};
    for (let start = 0; start < imageTargets.length; start += 2) {
      const batch = imageTargets.slice(start, start + 2);
      const settled = await Promise.all(batch.map((target) =>
        step.do(`generate-slide-image-${target.index}`, {
          retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
          timeout: "8 minutes"
        }, async (): Promise<{ index: number; url: string }> => {
          const state = await this.agent.getProjectSnapshot();
          if (state.kind !== "ppt") throw new Error("Project kind mismatch");
          const bytes = await generateImageBytes(this.env, target.prompt, (target.index + 1) * 7919);
          const saved = await saveSlideImage(this.env, state, `plan-${target.index}`, bytes, target.prompt);
          return { index: target.index, url: artifactUrl(saved.key) };
        }).catch(() => null)
      ));
      for (const entry of settled) {
        if (entry) imageUrls[entry.index] = entry.url;
      }
    }

    await this.reportProgress({ step: "compose", status: "running", percent: 0.68, message: "Composing slides with the PPTist engine" });
    const composed = await step.do("compose-with-pptist", {
      retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
      timeout: "10 minutes"
    }, async (): Promise<{ deck: PptistDocument; warnings: string[] }> =>
      composeDeckHeadless(this.env, {
        title: deckPlan.title,
        styleId: deckPlan.styleId,
        slides: deckPlan.slides.map((slide, index) => ({
          layoutId: slide.layoutId,
          variantId: slide.variantId,
          slots: slide.slots as Record<string, unknown>,
          notes: slide.notes,
          imageUrl: imageUrls[index]
        }))
      })
    );

    const document: PresentationDocument = {
      title: deckPlan.title,
      objective: deckPlan.objective,
      audience: deckPlan.audience,
      deck: composed.deck
    };

    // Return only the revision: `applyWorkflowCommands` resolves to the whole
    // project, which would be persisted as this step's output and counts
    // against the 1 MiB step-result limit.
    const revision = await step.do(
      "commit-presentation-project",
      async (): Promise<number> => {
        const state = await this.agent.applyWorkflowCommands(
          this.workflowId,
          [{ type: "ppt.replace_document", document }],
          `Workflow rebuilt presentation: ${document.title}`,
          "commit-presentation-document"
        );
        return state.revision;
      }
    );

    await this.reportProgress({ step: "export", status: "running", percent: 0.82, message: "Rendering a real PPTX export" });
    const artifact = await step.do("render-pptx-export", {
      retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
      timeout: "5 minutes"
    }, async (): Promise<ExportArtifact> => this.agent.exportCurrentPpt());

    const result = { projectId: params.projectId, revision, slideCount: document.deck.slides.length, artifact };
    await this.reportProgress({ step: "complete", status: "complete", percent: 1, message: "Presentation and PPTX are ready" });
    await step.reportComplete(result);
    return result;
  }
}
