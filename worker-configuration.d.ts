/* Run `pnpm types` after installing to regenerate authoritative Cloudflare binding types. */
import type { CanvasProject, PptProject, StudioAgent } from "./src/worker/index";

interface Env {
  AI: Ai;
  LLM_MODEL: string;
  IMAGE_MODEL: string;
  ARTIFACTS: R2Bucket;
  ASSETS: Fetcher;
  PPT_PROJECT: DurableObjectNamespace<PptProject>;
  CANVAS_PROJECT: DurableObjectNamespace<CanvasProject>;
  STUDIO_AGENT: DurableObjectNamespace<StudioAgent>;
  PPT_BUILD_WORKFLOW: Workflow;
  CANVAS_VARIANTS_WORKFLOW: Workflow;
}
