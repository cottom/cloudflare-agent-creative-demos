import { describe, expect, it } from "vitest";
import { isServableArtifactKey, staleRevisionFiles } from "../src/shared/policy";
import {
  getAssetKind,
  kindSupportsWorkflow,
  listAssetKinds,
  projectObjectName
} from "../src/shared/asset-kinds";

describe("artifact key guard", () => {
  it("serves keys written by this app", () => {
    expect(isServableArtifactKey("ppt/ppt-demo/revision-12.pptx")).toBe(true);
    expect(isServableArtifactKey("canvas/canvas-demo/wf-1/generated-1.jpg")).toBe(true);
  });

  it("rejects keys outside the app's own prefixes", () => {
    expect(isServableArtifactKey("secrets/key.pem")).toBe(false);
    expect(isServableArtifactKey("/ppt/ppt-demo/revision-1.pptx")).toBe(false);
    expect(isServableArtifactKey("")).toBe(false);
  });

  it("rejects traversal attempts", () => {
    expect(isServableArtifactKey("ppt/../secrets/key.pem")).toBe(false);
    expect(isServableArtifactKey("canvas/demo/../../etc/passwd")).toBe(false);
  });
});

describe("revision history retention", () => {
  const names = (count: number, from = 1) =>
    Array.from({ length: count }, (_, index) => `${String(from + index).padStart(6, "0")}.json`);

  it("keeps everything while under the limit", () => {
    expect(staleRevisionFiles(names(5), 20)).toEqual([]);
  });

  it("keeps exactly the limit at the boundary", () => {
    expect(staleRevisionFiles(names(20), 20)).toEqual([]);
  });

  it("drops the oldest snapshots once over the limit", () => {
    const stale = staleRevisionFiles(names(23), 20);
    expect(stale).toEqual(["000001.json", "000002.json", "000003.json"]);
  });

  it("orders by revision even when readdir returns them shuffled", () => {
    const shuffled = ["000010.json", "000002.json", "000007.json", "000001.json"];
    expect(staleRevisionFiles(shuffled, 2)).toEqual(["000001.json", "000002.json"]);
  });

  it("ignores non-snapshot entries", () => {
    expect(staleRevisionFiles(["README.md", "000001.json", "000002.json"], 1)).toEqual(["000001.json"]);
  });
});

describe("asset kind registry", () => {
  it("exposes every registered kind with the pieces a layer needs", () => {
    for (const kind of listAssetKinds()) {
      expect(kind.id).toBeTruthy();
      expect(typeof kind.createInitialState).toBe("function");
      expect(typeof kind.applyCommands).toBe("function");
      expect(typeof kind.summarizeForAgent).toBe("function");
      expect(kind.workflows.length).toBeGreaterThan(0);
      expect(kind.artifactPrefix).toBeTruthy();
    }
  });

  it("gates workflows by kind so a canvas cannot start a deck build", () => {
    expect(kindSupportsWorkflow("ppt", "ppt-build")).toBe(true);
    expect(kindSupportsWorkflow("canvas", "ppt-build")).toBe(false);
    expect(kindSupportsWorkflow("nope", "ppt-build")).toBe(false);
  });

  it("namespaces project objects by tenant then kind", () => {
    expect(projectObjectName("acme", "ppt", "q3")).toBe("acme:ppt:q3");
    // Two tenants using the same project id must never collide.
    expect(projectObjectName("a", "ppt", "x")).not.toBe(projectObjectName("b", "ppt", "x"));
  });

  it("summarises a seeded project without leaking the whole document", () => {
    const ppt = getAssetKind("ppt")!;
    const summary = ppt.summarizeForAgent(ppt.createInitialState("p1") as never, {});
    expect(summary.editor).toBe("pptist");
    expect(Array.isArray(summary.slides)).toBe(true);
  });
});
