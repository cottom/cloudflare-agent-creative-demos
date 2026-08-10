import type { ProjectKind } from "../../shared/types";

type FileEntry = { path: string; name: string; isDirectory: boolean };

type Props = {
  kind: ProjectKind;
  files: FileEntry[];
  loading: boolean;
  onRefresh: () => Promise<void>;
};

export function WorkspacePanel({ kind, files, loading, onRefresh }: Props) {
  return (
    <details className="workspace-panel">
      <summary>
        <span>Cloudflare Computer workspace</span>
        <button className="text-button" onClick={(event) => { event.preventDefault(); void onRefresh(); }}>
          {loading ? "Reading…" : "Refresh files"}
        </button>
      </summary>
      <p>Durable SQLite-backed project files. Canonical project JSON, revision snapshots, generated assets, and exports survive Agent session resets.</p>
      <div className="workspace-tree">
        {files.length === 0 && <span className="muted">Open this panel and refresh to inspect the real workspace.</span>}
        {files.map((file) => (
          <div key={file.path} className={file.isDirectory ? "directory" : "file"}>
            <span>{file.isDirectory ? "▸" : "·"}</span>{file.path}
          </div>
        ))}
      </div>
      <small>Project type: {kind}</small>
    </details>
  );
}
