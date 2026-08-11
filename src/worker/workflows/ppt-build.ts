import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";
import type {
  ApprovalMetadata,
  ExportArtifact,
  PptBuildWorkflowParams,
  ProjectInteraction,
  ProjectState,
  WorkflowProgressPayload
} from "../../shared/types";
import type { StudioAgent } from "../studio-agent";
import { generatePptPlan, generatePresentationDocument } from "../lib/ai";

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

    await this.reportProgress({ step: "write", status: "running", percent: 0.35, message: "Writing the approved deck" });
    const document = await step.do("generate-final-presentation", {
      retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
      timeout: "8 minutes"
    }, async () => generatePresentationDocument(this.env, params, plan, response));

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

    const result = { projectId: params.projectId, revision, slideCount: document.slides.length, artifact };
    await this.reportProgress({ step: "complete", status: "complete", percent: 1, message: "Presentation and PPTX are ready" });
    await step.reportComplete(result);
    return result;
  }
}
