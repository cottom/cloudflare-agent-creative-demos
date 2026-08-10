import { describe, expect, it } from "vitest";
import { isServableArtifactKey, staleRevisionFiles } from "../src/shared/policy";

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
