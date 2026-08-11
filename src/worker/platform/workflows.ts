import { listAssetKinds } from "../../shared/asset-kinds";
import type { JsonObject } from "../../shared/types";

/**
 * The agent surface a workflow may call.
 *
 * Deliberately narrower than `StudioAgent`: callers hold an RPC *stub*, not
 * the class, and a registry entry has no business reaching for the rest of the
 * agent's API. Declaring only the start methods also keeps this module from
 * importing the agent and dragging its dependency graph along.
 */
export type WorkflowStarter = {
  startPptBuildWorkflow(params: JsonObject): Promise<unknown>;
  startCanvasVariantsWorkflow(params: JsonObject): Promise<unknown>;
};

/**
 * The workflow registry.
 *
 * The router used to branch on literal workflow ids, which meant a third
 * presentation workflow could not be added without editing request routing.
 * A workflow is now one entry here; the API exposes whatever this table holds
 * and validates the request against the same entry that dispatches it.
 *
 * `kinds` is the authority on which assets a workflow accepts. It is
 * cross-checked against the asset-kind registry at startup, so a workflow and
 * an asset kind can never disagree about whether they support each other.
 */

export type WorkflowParamField = {
  name: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  description: string;
};

export type WorkflowDefinition = {
  id: string;
  label: string;
  description: string;
  /** Asset kinds this workflow can run against. */
  kinds: string[];
  /** Advertised in the public API so integrators can build their own forms. */
  params: WorkflowParamField[];
  /** Whether the workflow pauses for human approval partway through. */
  requiresApproval: boolean;
  start: (agent: WorkflowStarter, params: JsonObject) => Promise<unknown>;
};

const pptBuild: WorkflowDefinition = {
  id: "ppt-build",
  label: "Build presentation",
  description: "Researches a brief, plans slide layouts, generates imagery and composes a deck for review.",
  kinds: ["ppt"],
  requiresApproval: true,
  params: [
    { name: "brief", type: "string", required: true, description: "What the presentation should cover" },
    { name: "audience", type: "string", required: false, description: "Who the deck is for" },
    { name: "slideCount", type: "number", required: false, description: "Target number of slides" }
  ],
  start: (agent, params) => agent.startPptBuildWorkflow(params as never)
};

const canvasVariants: WorkflowDefinition = {
  id: "canvas-variants",
  label: "Generate canvas variants",
  description: "Generates image variants for a canvas node and stages them for selection.",
  kinds: ["canvas"],
  requiresApproval: true,
  params: [
    { name: "prompt", type: "string", required: true, description: "Image direction" },
    { name: "variants", type: "number", required: false, description: "How many variants to produce" }
  ],
  start: (agent, params) => agent.startCanvasVariantsWorkflow(params as never)
};

const REGISTRY = new Map<string, WorkflowDefinition>([
  [pptBuild.id, pptBuild],
  [canvasVariants.id, canvasVariants]
]);

export function registerWorkflow(definition: WorkflowDefinition): void {
  REGISTRY.set(definition.id, definition);
}

export function getWorkflow(id: string): WorkflowDefinition | undefined {
  return REGISTRY.get(id);
}

export function listWorkflows(): WorkflowDefinition[] {
  return [...REGISTRY.values()];
}

/** Workflows a given asset kind can start — drives kind-aware UI and docs. */
export function workflowsForKind(kind: string): WorkflowDefinition[] {
  return listWorkflows().filter((workflow) => workflow.kinds.includes(kind));
}

/**
 * Verify the two registries agree.
 *
 * Each asset kind lists the workflows it supports and each workflow lists the
 * kinds it accepts. Duplicating that edge is deliberate — both sides read
 * naturally on their own — but duplicated facts drift, so this asserts they
 * match. Called from tests rather than at request time.
 */
export function assertRegistriesConsistent(): void {
  const problems: string[] = [];
  for (const kind of listAssetKinds()) {
    for (const workflowId of kind.workflows) {
      const workflow = REGISTRY.get(workflowId);
      if (!workflow) {
        problems.push(`Asset kind "${kind.id}" lists unknown workflow "${workflowId}"`);
      } else if (!workflow.kinds.includes(kind.id)) {
        problems.push(`Workflow "${workflowId}" does not accept kind "${kind.id}" that claims it`);
      }
    }
  }
  for (const workflow of REGISTRY.values()) {
    for (const kindId of workflow.kinds) {
      const kind = listAssetKinds().find((item) => item.id === kindId);
      if (!kind) {
        problems.push(`Workflow "${workflow.id}" lists unknown asset kind "${kindId}"`);
      } else if (!kind.workflows.includes(workflow.id)) {
        problems.push(`Asset kind "${kindId}" does not list workflow "${workflow.id}" that targets it`);
      }
    }
  }
  if (problems.length) throw new Error(`Registry mismatch:\n- ${problems.join("\n- ")}`);
}

/** Validate a start request against the declared parameter shape. */
export function validateWorkflowParams(
  workflow: WorkflowDefinition,
  params: JsonObject
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  for (const field of workflow.params) {
    const value = params[field.name];
    if (value === undefined || value === null || value === "") {
      if (field.required) errors.push(`${field.name} is required`);
      continue;
    }
    if (typeof value !== field.type) {
      errors.push(`${field.name} must be a ${field.type}`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}
