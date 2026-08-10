# Validation record

## Deterministic checks completed for this delivery

The source bundle was checked in the artifact environment for:

- TypeScript/TSX parser validity across every source and test file.
- JSON validity for `package.json` and `wrangler.jsonc` after removing JSONC comments.
- Pure project-domain execution: seeded PPT and Canvas projects, successful revision increments, and revision-conflict behavior.
- PPTX binary generation with PptxGenJS: the generated output is a non-empty ZIP/Office Open XML payload beginning with `PK`.
- No runtime fake model provider, fake workflow engine, fake object store, or fake export adapter exists in the application path.

## Checks that require the operator's environment

A full `pnpm check` and Cloudflare deployment require:

- Node.js 24 or later.
- npm registry access for the pinned Cloudflare preview packages.
- An authenticated Cloudflare account.
- Workers AI entitlement and remote model access.
- The production R2 bucket created by `pnpm setup:r2`.

Run:

```bash
corepack enable
pnpm install
pnpm cf:login
pnpm setup:r2   # production/deploy only; safe to skip for the first local run
pnpm check
pnpm dev
```

Then validate these runtime paths:

1. `POST /api/bootstrap` creates both project Durable Objects, both Think Agent sessions, and both Computer workspaces.
2. A user edit increments the project revision and creates `/project/revisions/<revision>.json`.
3. Clearing or creating an Agent session leaves the project revision and asset unchanged.
4. PPT workflow creates a plan, pauses for approval, commits a new Presentation AST, and writes a real PPTX to R2 and `/exports`.
5. Canvas workflow creates a prompt-review interaction, pauses for approval, calls the real FLUX Workers AI model, and attaches every image to R2, the Computer workspace, and the canvas.
6. Reusing an idempotency key with the same logical command does not repeat the edit; reusing it with a different command fails closed.

## Preview dependency note

`@cloudflare/computer` is intentionally used because this repository demonstrates Project-scoped durable computer workspaces. It is currently a preview dependency. Keep the `ProjectWorkspace` access behind `src/worker/lib/project-access.ts`; that boundary is the intended replacement point for Cloudflare Sandbox/Containers if production requirements demand a generally available runtime.
