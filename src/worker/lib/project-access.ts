import { getWorkspace } from "@cloudflare/computer";
import type {
  ExportArtifact,
  MutationResult,
  ProjectKind,
  ProjectMutation,
  ProjectState
} from "../../shared/types";


function validateWorkspacePath(path: string): void {
  if (!path.startsWith("/")) throw new Error("Workspace paths must be absolute");
  if (path.split("/").some((segment) => segment === "..")) throw new Error("Workspace path traversal is not allowed");
}

export function getProjectStub(env: Env, kind: ProjectKind, projectId: string) {
  if (kind === "ppt") {
    return env.PPT_PROJECT.get(env.PPT_PROJECT.idFromName(projectId));
  }
  return env.CANVAS_PROJECT.get(env.CANVAS_PROJECT.idFromName(projectId));
}

export async function initializeProject(env: Env, kind: ProjectKind, projectId: string): Promise<ProjectState> {
  const stub = getProjectStub(env, kind, projectId);
  return stub.initialize(projectId) as Promise<ProjectState>;
}

export async function readProject(env: Env, kind: ProjectKind, projectId: string): Promise<ProjectState> {
  const stub = getProjectStub(env, kind, projectId);
  await stub.initialize(projectId);
  return stub.getSnapshot() as Promise<ProjectState>;
}

export async function applyProjectMutation(
  env: Env,
  kind: ProjectKind,
  projectId: string,
  mutation: ProjectMutation
): Promise<MutationResult> {
  const stub = getProjectStub(env, kind, projectId);
  await stub.initialize(projectId);
  return stub.applyMutation(mutation) as Promise<MutationResult>;
}

export async function syncProjectWorkspace(env: Env, state: ProjectState): Promise<void> {
  const stub = getProjectStub(env, state.kind, state.id);
  using workspace = await getWorkspace(stub);
  const json = JSON.stringify(state, null, 2);
  await workspace.fs.mkdir("/project/revisions", { recursive: true });
  await workspace.fs.writeFile("/project/project.json", json);
  await workspace.fs.writeFile(`/project/revisions/${String(state.revision).padStart(6, "0")}.json`, json);
  await workspace.fs.writeFile("/project/README.md", [
    `# ${state.name}`,
    "",
    `Kind: ${state.kind}`,
    `Revision: ${state.revision}`,
    `Updated: ${state.updatedAt}`,
    "",
    "This directory is the durable Cloudflare Computer workspace mirror of the canonical Project Durable Object state."
  ].join("\n"));
}

export async function writeWorkspaceFile(
  env: Env,
  kind: ProjectKind,
  projectId: string,
  path: string,
  content: string | Uint8Array
): Promise<void> {
  validateWorkspacePath(path);
  const stub = getProjectStub(env, kind, projectId);
  using workspace = await getWorkspace(stub);
  const slash = path.lastIndexOf("/");
  if (slash > 0) await workspace.fs.mkdir(path.slice(0, slash), { recursive: true });
  await workspace.fs.writeFile(path, content);
}

export async function readWorkspaceFile(
  env: Env,
  kind: ProjectKind,
  projectId: string,
  path: string
): Promise<string> {
  validateWorkspacePath(path);
  const stub = getProjectStub(env, kind, projectId);
  using workspace = await getWorkspace(stub);
  const content = await workspace.fs.readFile(path, "utf8");
  return content.length > 30_000 ? `${content.slice(0, 30_000)}

[truncated]` : content;
}

export async function listWorkspace(env: Env, kind: ProjectKind, projectId: string) {
  const stub = getProjectStub(env, kind, projectId);
  using workspace = await getWorkspace(stub);
  const walk = async (path: string, depth = 0): Promise<Array<Record<string, unknown>>> => {
    if (depth > 4) return [];
    const entries = await workspace.fs.readdir(path).catch(() => []);
    const result: Array<Record<string, unknown>> = [];
    for (const entry of entries) {
      const fullPath = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`;
      result.push({ path: fullPath, name: entry.name, isDirectory: entry.isDirectory });
      if (entry.isDirectory) result.push(...await walk(fullPath, depth + 1));
    }
    return result;
  };
  return walk("/");
}

export async function registerArtifact(
  env: Env,
  kind: ProjectKind,
  projectId: string,
  artifact: ExportArtifact
): Promise<ProjectState> {
  const stub = getProjectStub(env, kind, projectId);
  const state = await stub.addArtifact(artifact) as ProjectState;
  await syncProjectWorkspace(env, state);
  return state;
}
