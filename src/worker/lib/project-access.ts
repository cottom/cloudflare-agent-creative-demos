import { getWorkspace } from "@cloudflare/computer";
import { REVISION_HISTORY_LIMIT, staleRevisionFiles } from "../../shared/policy";
import type {
  ExportArtifact,
  MutationResult,
  ProjectKind,
  ProjectMutation,
  ProjectState
} from "../../shared/types";

type ProjectStub = ReturnType<typeof getProjectStub>;

/**
 * `getWorkspace` is designed to take a Durable Object stub, but its
 * `WorkspaceStubHost` contract is declared with the concrete `WorkspaceStub`
 * class (which carries a `#private` brand). Across RPC you receive a
 * structural `Stub<WorkspaceStub>` proxy, which can never satisfy that brand
 * even though it forwards every call correctly. Narrowed once, here.
 */
function openWorkspace(stub: ProjectStub) {
  return getWorkspace(stub as unknown as Parameters<typeof getWorkspace>[0]);
}

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

const REVISIONS_DIR = "/project/revisions";
const revisionPath = (revision: number) => `${REVISIONS_DIR}/${String(revision).padStart(6, "0")}.json`;

/**
 * How many per-revision snapshots to retain in the workspace mirror.
 *
 * Every mutation writes a full copy of project state here — including each
 * canvas drag — so an unbounded archive grows without limit inside the Durable
 * Object's SQLite storage, and each retained state itself carries up to 100
 * activity entries.
 */
async function pruneRevisionHistory(
  workspace: Awaited<ReturnType<typeof openWorkspace>>,
  currentRevision: number
): Promise<void> {
  if (currentRevision <= REVISION_HISTORY_LIMIT) return;
  const entries: Array<{ name: string; isDirectory: boolean }> =
    await workspace.fs.readdir(REVISIONS_DIR).catch(() => []);
  const stale = staleRevisionFiles(
    entries.filter((entry) => !entry.isDirectory).map((entry) => entry.name)
  );
  if (!stale.length) return;
  await Promise.all(
    stale.map((name) => workspace.fs.rm(`${REVISIONS_DIR}/${name}`).catch(() => undefined))
  );
}

export async function syncProjectWorkspace(env: Env, state: ProjectState): Promise<void> {
  const stub = getProjectStub(env, state.kind, state.id);
  using workspace = await openWorkspace(stub);
  const json = JSON.stringify(state, null, 2);
  const readme = [
    `# ${state.name}`,
    "",
    `Kind: ${state.kind}`,
    `Revision: ${state.revision}`,
    `Updated: ${state.updatedAt}`,
    "",
    "This directory is the durable Cloudflare Computer workspace mirror of the canonical Project Durable Object state.",
    `Snapshots under \`revisions/\` are capped at the ${REVISION_HISTORY_LIMIT} most recent revisions.`
  ].join("\n");

  await workspace.fs.mkdir(REVISIONS_DIR, { recursive: true });
  // These three writes are independent; issuing them together turns four
  // sequential round-trips to the Durable Object into two.
  await Promise.all([
    workspace.fs.writeFile("/project/project.json", json),
    workspace.fs.writeFile(revisionPath(state.revision), json),
    workspace.fs.writeFile("/project/README.md", readme)
  ]);
  await pruneRevisionHistory(workspace, state.revision);
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
  using workspace = await openWorkspace(stub);
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
  using workspace = await openWorkspace(stub);
  const content = await workspace.fs.readFile(path, "utf8");
  return content.length > 30_000 ? `${content.slice(0, 30_000)}

[truncated]` : content;
}

export async function listWorkspace(env: Env, kind: ProjectKind, projectId: string) {
  const stub = getProjectStub(env, kind, projectId);
  using workspace = await openWorkspace(stub);
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
