import type { CanvasProjectState, ExportArtifact, PptProjectState } from "../../shared/types";
import { registerArtifact, writeWorkspaceFile } from "./project-access";
import { renderPptx } from "./pptx";
import { isServableArtifactKey } from "../../shared/policy";

export function artifactUrl(key: string): string {
  return `/api/artifacts?key=${encodeURIComponent(key)}`;
}

/**
 * Load every image referenced by freeform slide elements into data URIs.
 *
 * PptxGenJS needs the bytes inline: a Worker cannot fetch its own asset route
 * mid-request, and R2 objects are not publicly addressable.
 */
async function collectSlideImages(env: Env, state: PptProjectState): Promise<Map<string, string>> {
  // PPTist stores an image `src`; ours point at /api/artifacts?key=…, so the
  // R2 key is recovered from the URL before fetching the bytes.
  const sources = new Map<string, string>();
  for (const slide of state.document.deck.slides) {
    for (const element of slide.elements) {
      if (element.type !== "image" || !element.src) continue;
      const key = artifactKeyFromSrc(element.src);
      if (key) sources.set(element.src, key);
    }
  }
  const entries = await Promise.all([...sources].map(async ([src, key]) => {
    const object = await env.ARTIFACTS.get(key);
    if (!object) return null;
    const buffer = await object.arrayBuffer();
    const contentType = object.httpMetadata?.contentType ?? "image/png";
    let binary = "";
    const view = new Uint8Array(buffer);
    for (let index = 0; index < view.length; index += 1) binary += String.fromCharCode(view[index]!);
    return [src, `data:${contentType};base64,${btoa(binary)}`] as [string, string];
  }));
  return new Map(entries.filter((entry): entry is [string, string] => entry !== null));
}

/** Recover the R2 key from an /api/artifacts URL written into a PPTist deck. */
function artifactKeyFromSrc(src: string): string | null {
  try {
    const url = new URL(src, "https://placeholder.local");
    const key = url.searchParams.get("key");
    return key && isServableArtifactKey(key) ? key : null;
  } catch {
    return null;
  }
}

export async function savePresentationExport(env: Env, state: PptProjectState): Promise<ExportArtifact> {
  const bytes = await renderPptx(state.document, await collectSlideImages(env, state));
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

/**
 * Persist an AI-generated image for a presentation and register it as an
 * artifact so it appears in the deck's asset list and survives the session.
 */
export async function saveSlideImage(
  env: Env,
  state: PptProjectState,
  slideId: string,
  bytes: Uint8Array,
  prompt: string
): Promise<{ key: string; artifact: ExportArtifact }> {
  const id = crypto.randomUUID();
  const key = `ppt/${state.id}/generated/${slideId}-${id}.jpg`;
  await env.ARTIFACTS.put(key, bytes, {
    httpMetadata: { contentType: "image/jpeg" },
    customMetadata: { projectId: state.id, slideId, prompt: prompt.slice(0, 900) }
  });
  const artifact: ExportArtifact = {
    id: `slide-image-${id}`,
    kind: "image",
    key,
    name: `${slideId}-${id.slice(0, 8)}.jpg`,
    contentType: "image/jpeg",
    revision: state.revision,
    createdAt: new Date().toISOString()
  };
  await registerArtifact(env, "ppt", state.id, artifact);
  return { key, artifact };
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
