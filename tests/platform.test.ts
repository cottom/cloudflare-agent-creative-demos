import { describe, expect, it } from "vitest";
import {
  bearerToken,
  canAccessProject,
  generateApiKey,
  hasScope,
  signEmbedToken,
  tenantFromApiKey,
  timingSafeEqualUtf8,
  verifyEmbedToken,
  type Principal,
  type Scope
} from "../src/worker/platform/auth";
import {
  assertRegistriesConsistent,
  getWorkflow,
  listWorkflows,
  validateWorkflowParams,
  workflowsForKind
} from "../src/worker/platform/workflows";
import { projectObjectName } from "../src/shared/asset-kinds";
import { artifactKeyBelongsToTenant } from "../src/shared/policy";
import {
  generateWebhookSecret,
  isWebhookEvent,
  MAX_ATTEMPTS,
  nextAttemptDelaySeconds,
  signPayload
} from "../src/worker/platform/webhooks";

const SECRET = "test-embed-secret";

function principal(overrides: Partial<Principal> = {}): Principal {
  return { tenantId: "acme", scopes: ["projects:read"], via: "api-key", ...overrides };
}

describe("api keys", () => {
  it("round-trips the tenant it was issued for", () => {
    const key = generateApiKey("acme-corp");
    expect(tenantFromApiKey(key)).toBe("acme-corp");
  });

  it("issues a distinct secret each time", () => {
    expect(generateApiKey("acme")).not.toBe(generateApiKey("acme"));
  });

  it("rejects a key whose tenant segment is not a legal object name", () => {
    // A crafted tenant segment must not become a Durable Object name.
    const forged = `cak_${btoa("acme:evil").replace(/=+$/, "")}_deadbeef`;
    expect(tenantFromApiKey(forged)).toBeNull();
  });

  it("rejects malformed keys", () => {
    expect(tenantFromApiKey("nope")).toBeNull();
    expect(tenantFromApiKey("cak_only-two-parts")).toBeNull();
  });
});

describe("embed tokens", () => {
  it("verifies a token it signed", async () => {
    const token = await signEmbedToken(SECRET, {
      tenantId: "acme",
      projectId: "deck-1",
      kind: "ppt",
      scopes: ["projects:read"],
      exp: Math.floor(Date.now() / 1000) + 60
    });
    const claims = await verifyEmbedToken(SECRET, token);
    expect(claims?.projectId).toBe("deck-1");
    expect(claims?.tenantId).toBe("acme");
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signEmbedToken(SECRET, {
      tenantId: "acme",
      projectId: "deck-1",
      kind: "ppt",
      scopes: [],
      exp: Math.floor(Date.now() / 1000) + 60
    });
    expect(await verifyEmbedToken("other-secret", token)).toBeNull();
  });

  it("rejects a token whose claims were edited after signing", async () => {
    const token = await signEmbedToken(SECRET, {
      tenantId: "acme",
      projectId: "deck-1",
      kind: "ppt",
      scopes: ["projects:read"],
      exp: Math.floor(Date.now() / 1000) + 60
    });
    const [, signature] = token.split(".");
    const forgedPayload = btoa(
      JSON.stringify({
        tenantId: "victim",
        projectId: "deck-1",
        kind: "ppt",
        scopes: ["admin"],
        exp: Math.floor(Date.now() / 1000) + 60
      })
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(await verifyEmbedToken(SECRET, `${forgedPayload}.${signature}`)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await signEmbedToken(SECRET, {
      tenantId: "acme",
      projectId: "deck-1",
      kind: "ppt",
      scopes: [],
      exp: Math.floor(Date.now() / 1000) + 30
    });
    expect(await verifyEmbedToken(SECRET, token, Date.now() + 31_000)).toBeNull();
  });
});

describe("scopes", () => {
  it("grants admin every scope", () => {
    expect(hasScope(principal({ scopes: ["admin"] }), "workflows:run")).toBe(true);
  });

  it("does not grant unheld scopes", () => {
    expect(hasScope(principal({ scopes: ["projects:read"] }), "projects:write")).toBe(false);
  });

  it("lets an api-key principal reach any project", () => {
    expect(canAccessProject(principal(), "ppt", "anything")).toBe(true);
  });

  it("pins an embed principal to its own project", () => {
    const embed = principal({ via: "embed-token", projectId: "deck-1", kind: "ppt" });
    expect(canAccessProject(embed, "ppt", "deck-1")).toBe(true);
    expect(canAccessProject(embed, "ppt", "deck-2")).toBe(false);
    // Same id, different kind, is a different document.
    expect(canAccessProject(embed, "canvas", "deck-1")).toBe(false);
  });
});

describe("timing-safe comparison", () => {
  it("matches equal strings and rejects differing ones", () => {
    expect(timingSafeEqualUtf8("secret", "secret")).toBe(true);
    expect(timingSafeEqualUtf8("secret", "secrez")).toBe(false);
    expect(timingSafeEqualUtf8("secret", "secretlonger")).toBe(false);
  });
});

describe("tenant isolation", () => {
  it("puts the tenant first so one tenant cannot address another's object", () => {
    expect(projectObjectName("acme", "ppt", "deck-1")).toBe("acme:ppt:deck-1");
    expect(projectObjectName("acme", "ppt", "deck-1")).not.toBe(projectObjectName("other", "ppt", "deck-1"));
  });
});

describe("workflow registry", () => {
  it("agrees with the asset-kind registry in both directions", () => {
    expect(() => assertRegistriesConsistent()).not.toThrow();
  });

  it("exposes each workflow only to the kinds it accepts", () => {
    expect(workflowsForKind("ppt").map((workflow) => workflow.id)).toEqual(["ppt-build"]);
    expect(workflowsForKind("canvas").map((workflow) => workflow.id)).toEqual(["canvas-variants"]);
    expect(workflowsForKind("nope")).toEqual([]);
  });

  it("advertises parameters for every workflow so integrators can build forms", () => {
    for (const workflow of listWorkflows()) {
      expect(workflow.params.length).toBeGreaterThan(0);
      for (const param of workflow.params) expect(param.description).not.toBe("");
    }
  });

  it("rejects a start request missing a required parameter", () => {
    const workflow = getWorkflow("ppt-build");
    expect(workflow).toBeDefined();
    const result = validateWorkflowParams(workflow!, { audience: "execs" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors).toContain("brief is required");
  });

  it("rejects a parameter of the wrong type", () => {
    const result = validateWorkflowParams(getWorkflow("ppt-build")!, { brief: "x", slideCount: "seven" });
    expect(result.ok === false && result.errors).toContain("slideCount must be a number");
  });

  it("accepts a valid request without the optional fields", () => {
    expect(validateWorkflowParams(getWorkflow("ppt-build")!, { brief: "Quarterly review" }).ok).toBe(true);
  });
});

describe("artifact key ownership", () => {
  it("accepts a key whose project segment carries the tenant", () => {
    expect(artifactKeyBelongsToTenant("ppt/acme:ppt:deck-1/revision-3.pptx", "acme")).toBe(true);
  });

  it("rejects another tenant's key", () => {
    expect(artifactKeyBelongsToTenant("ppt/globex:ppt:deck-1/revision-3.pptx", "acme")).toBe(false);
  });

  it("rejects a tenant that is only a prefix of the owning tenant", () => {
    // "acme" must not match "acme-corp:…" — the separator is part of the test.
    expect(artifactKeyBelongsToTenant("ppt/acme-corp:ppt:deck-1/x.pptx", "acme")).toBe(false);
  });

  it("rejects demo-plane keys, which carry no tenant segment", () => {
    expect(artifactKeyBelongsToTenant("ppt/ppt-demo/revision-1.pptx", "acme")).toBe(false);
  });

  it("rejects traversal and foreign prefixes before checking ownership", () => {
    expect(artifactKeyBelongsToTenant("ppt/acme:ppt:d/../../secret", "acme")).toBe(false);
    expect(artifactKeyBelongsToTenant("secrets/acme:ppt:d/x", "acme")).toBe(false);
  });
});

describe("credential presentation", () => {
  const request = (url: string, headers?: Record<string, string>) => new Request(url, { headers });

  it("reads a bearer header", () => {
    expect(bearerToken(request("https://x/v1/whoami", { authorization: "Bearer cak_abc_def" }))).toBe("cak_abc_def");
  });

  it("ignores a credential in the query string", () => {
    // Query strings are recorded in access logs, Referer headers and history.
    // The embedded editor receives its token over postMessage instead, so no
    // caller needs this and accepting it would only widen exposure.
    expect(bearerToken(request("https://x/v1/assets?token=embed.sig"))).toBeNull();
  });

  it("ignores an empty bearer header", () => {
    expect(bearerToken(request("https://x/v1/me", { authorization: "Bearer   " }))).toBeNull();
  });

  it("returns null when no credential is presented", () => {
    expect(bearerToken(request("https://x/v1/whoami"))).toBeNull();
  });
});

describe("webhook signing", () => {
  const SECRET = "whsec_test";

  it("produces a verifiable signature over timestamp and body", async () => {
    const body = JSON.stringify({ type: "run.succeeded" });
    const header = await signPayload(SECRET, body, 1_700_000_000);
    const [timestamp, signature] = header.split(",");
    expect(timestamp).toBe("t=1700000000");
    expect(signature?.startsWith("v1=")).toBe(true);
    // A receiver recomputes over "<t>.<body>"; the same inputs must reproduce it.
    expect(await signPayload(SECRET, body, 1_700_000_000)).toBe(header);
  });

  it("changes when the body changes", async () => {
    const a = await signPayload(SECRET, JSON.stringify({ n: 1 }), 1_700_000_000);
    const b = await signPayload(SECRET, JSON.stringify({ n: 2 }), 1_700_000_000);
    expect(a).not.toBe(b);
  });

  it("changes when the timestamp changes, so a capture cannot be replayed later", async () => {
    const body = JSON.stringify({ n: 1 });
    expect(await signPayload(SECRET, body, 1_700_000_000)).not.toBe(
      await signPayload(SECRET, body, 1_700_000_060)
    );
  });

  it("changes with the secret", async () => {
    const body = JSON.stringify({ n: 1 });
    expect(await signPayload(SECRET, body, 1_700_000_000)).not.toBe(
      await signPayload("whsec_other", body, 1_700_000_000)
    );
  });

  it("issues a distinct secret each time", () => {
    expect(generateWebhookSecret()).not.toBe(generateWebhookSecret());
    expect(generateWebhookSecret().startsWith("whsec_")).toBe(true);
  });
});

describe("webhook retry schedule", () => {
  it("backs off and then gives up rather than retrying forever", () => {
    const delays = Array.from({ length: MAX_ATTEMPTS }, (_, index) => nextAttemptDelaySeconds(index + 1));
    expect(delays.at(-1)).toBeNull();
    const scheduled = delays.filter((value): value is number => value !== null);
    expect(scheduled).toEqual([...scheduled].sort((a, b) => a - b));
    expect(scheduled[0]).toBeLessThanOrEqual(30);
  });

  it("only accepts events it actually emits", () => {
    expect(isWebhookEvent("run.succeeded")).toBe(true);
    expect(isWebhookEvent("asset.deleted")).toBe(false);
  });
});
