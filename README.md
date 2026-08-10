# Cloudflare Creative Agent Demos

Two end-to-end, Cloudflare-native demos for **project-owned, continuously editable assets**:

1. **PPT Project Agent** — a long-lived presentation can be edited directly, edited by an Agent, substantially rebuilt by a durable human-reviewed Workflow, and exported as a real `.pptx`.
2. **Media Canvas Agent** — a long-lived creative canvas can be edited and rearranged by the user, manipulated by an Agent, and populated by a durable human-reviewed Workflow that calls a real Workers AI image model.

There are **no mocked model, workflow, storage, or export providers** in the runtime path. The demo uses Workers AI, Durable Objects, Cloudflare Workflows, Cloudflare Computer Workspace, R2, and PptxGenJS.

## What this demonstrates

- The **Project**, not the chat, owns the editable asset.
- Each Project can have multiple independent Agent sessions.
- **New session** and **Clear chat** do not reset the PPT or Canvas.
- Agent context is rebuilt from the latest Project revision plus the current editor selection.
- User edits, Agent tools, and Workflow commits use one revision-safe command bus.
- Expensive or multi-step work is delegated to durable Workflows.
- Human-in-the-loop interactions render as structured UI and durably resume the Workflow.
- Project files, revision snapshots, generated images, and exports are stored in a Project-scoped Cloudflare Computer Workspace.
- Binary artifacts are stored in R2.

## Runtime stack

| Layer | Implementation |
|---|---|
| Web app | React 19 + Vite + Cloudflare Vite plugin |
| API | Cloudflare Worker |
| Project authority | SQLite-backed Durable Object per Project |
| Agent session | `@cloudflare/think` Durable Object per Project session |
| Agent SDK | Cloudflare Agents SDK + Think + AI SDK tools |
| Durable jobs | Cloudflare Workflows through `AgentWorkflow` |
| Human loop | Workflow approval metadata + Project Interaction records |
| Project filesystem | `@cloudflare/computer` `withWorkspace` / `getWorkspace` |
| LLM | Workers AI `@cf/moonshotai/kimi-k2.6` |
| Image generation | Workers AI `@cf/black-forest-labs/flux-1-schnell` |
| Binary artifacts | R2 |
| PPTX export | PptxGenJS, saved to R2 and Computer Workspace |

## Prerequisites

- Node.js 24+
- pnpm 10+
- A Cloudflare account with Workers AI enabled
- Wrangler authenticated to that account

No OpenAI, Anthropic, Replicate, or other external API key is required.

## Run locally

```bash
corepack enable
pnpm install
pnpm cf:login
pnpm dev
```

Open the Vite URL shown in the terminal, normally `http://localhost:5173`.

The Workers AI binding is configured with `remote: true`, so local development uses the real Cloudflare model endpoint. Durable Objects, Workflows, assets, and R2 use Wrangler/Vite development bindings.

### First actions to try

In the PPT demo:

1. Edit a slide in the inspector and save it.
2. Start a new Agent session; confirm the deck is unchanged.
3. Ask: `Make the selected slide more decisive.`
4. Ask: `Rebuild this as an 8-slide investor deck with approval.`
5. Edit the returned review card, approve it, and download the generated `.pptx`.

In the Canvas demo:

1. Drag a node and save another field in the inspector.
2. Duplicate the selected node manually or ask the Agent to do it.
3. Ask: `Generate four premium 4:5 launch concepts with approval.`
4. Edit the returned prompts and approve them.
5. Watch real Workers AI images appear incrementally on the persistent canvas.

## Deploy

Create the production R2 bucket once:

```bash
pnpm setup:r2
```

Then deploy:

```bash
pnpm deploy
```

After dependencies are installed, regenerate authoritative binding types whenever `wrangler.jsonc` changes:

```bash
pnpm types
```

## Configuration

The defaults live in `wrangler.jsonc`:

```jsonc
{
  "vars": {
    "LLM_MODEL": "@cf/moonshotai/kimi-k2.6",
    "IMAGE_MODEL": "@cf/black-forest-labs/flux-1-schnell"
  }
}
```

Change these to another compatible Workers AI language or image model without changing the domain layer.

## Project model

```text
Project Durable Object
├── canonical PPT or Canvas document
├── revision number
├── idempotent command ledger
├── Agent session index
├── pending interactions
├── Workflow run index
├── artifact index
└── Cloudflare Computer Workspace
    ├── /project/project.json
    ├── /project/revisions/000001.json ...
    ├── /assets/generated/...
    ├── /exports/latest.pptx
    └── /scratch/*.md

Agent session Durable Object
├── durable conversation history
├── session-only memory
├── current editor awareness
├── project tools
└── workflow tools
```

The command contract is:

```ts
type ProjectMutation = {
  commandId: string;       // idempotency identity
  baseRevision: number;    // optimistic concurrency
  actor: ActorRef;         // user, agent, or workflow
  summary: string;
  commands: ProjectCommand[];
};
```

A command identity cannot be reused with a different payload. Revision conflicts are not ledgered, so the same logical command can safely retry against the latest revision. Successful commands are ledgered so retrying after a lost response cannot repeat the side effect.

## Repository map

```text
src/shared/
  types.ts                 Project schemas and command contracts
  reducers.ts              Pure mutation/revision logic
  seeds.ts                 Two initial demo projects

src/worker/
  project/project-do.ts    Project authority + Computer Workspace mixin
  studio-agent.ts          Think Agent, tools, sessions, workflow routing
  workflows/               Durable PPT and Canvas workflows
  lib/ai.ts                Real Workers AI structured/image generation
  lib/pptx.ts              Real PPTX rendering
  lib/artifacts.ts         R2 + Workspace artifact persistence
  index.ts                 Worker API and Agent routing

src/client/
  components/PptStudio.tsx
  components/CanvasStudio.tsx
  components/AgentPanel.tsx
  components/InteractionCard.tsx
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/DEMO-FLOWS.md`](docs/DEMO-FLOWS.md) for the detailed execution model.

## Validation

```bash
pnpm check
```

This runs TypeScript checking, unit tests, and the production build. The pure Project reducer is also intentionally isolated from Cloudflare packages so it can be validated deterministically.

## Demo scope versus production hardening

This is a runnable reference implementation, not a production multi-tenant SaaS shell. Before exposing it publicly, add your normal authentication, tenant authorization, quotas/credits, abuse controls, upload scanning, content moderation, rate limits, audit export, and retention policies. Those concerns are deliberately outside these two focused demos; none of the core project/session/workflow boundaries need to change when they are added.
