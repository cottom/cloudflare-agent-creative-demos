import type { CanvasProjectState, ExportArtifact, PptProjectState } from "../../shared/types";
import { registerArtifact, writeWorkspaceFile } from "./project-access";
import { renderPptx } from "./pptx";

export function artifactUrl(key: string): string {
  return `/api/artifacts?key=${encodeURIComponent(key)}`;
}

export async function savePresentationExport(env: Env, state: PptProjectState): Promise<ExportArtifact> {
  const bytes = await renderPptx(state.document);
  const key = `ppt/${state.id}/revision-${state.revision}.pptx`;
  await env.ARTIFACTS.put(key, bytes, {
    httpMetadata: { contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
    customMetadata: { projectId: state.id, revision: String(state.revision) }
  });
  await writeWorkspaceFile(env, "ppt", state.id, `/exports/revision-${state.revision}.pptx`, bytes);
  await writeWorkspaceFile(env, "ppt", state.id, "/exports/latest.pptx", bytes);
  const artifact: ExportArtifact = {
    id: `pptx-${state.id}-${state.revision}`,
    kind: "pptx",
    key,
    name: `${state.document.title.replace(/[^a-zA-Z0-9\u4e00-\u9fff-_]+/g, "-")}.pptx`,
    contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    revision: state.revision,
    createdAt: new Date().toISOString()
  };
  await registerArtifact(env, "ppt", state.id, artifact);
  return artifact;
}

export async function saveCanvasImage(
  env: Env,
  state: CanvasProjectState,
  workflowId: string,
  nodeId: string,
  bytes: Uint8Array
): Promise<{ key: string; artifact: ExportArtifact }> {
  const key = `canvas/${state.id}/${workflowId}/${nodeId}.jpg`;
  await env.ARTIFACTS.put(key, bytes, {
    httpMetadata: { contentType: "image/jpeg" },
    customMetadata: { projectId: state.id, workflowId, nodeId }
  });
  await writeWorkspaceFile(env, "canvas", state.id, `/assets/generated/${workflowId}/${nodeId}.jpg`, bytes);
  const artifact: ExportArtifact = {
    id: `image-${nodeId}`,
    kind: "image",
    key,
    name: `${nodeId}.jpg`,
    contentType: "image/jpeg",
    revision: state.revision,
    createdAt: new Date().toISOString()
  };
  await registerArtifact(env, "canvas", state.id, artifact);
  return { key, artifact };
}
