# Architecture

## 1. Ownership rules

The implementation follows five hard rules:

1. **Project owns the asset.** A presentation or canvas never belongs to a chat session.
2. **Session owns conversation.** Clearing or replacing a session cannot mutate Project state.
3. **Workflow owns durable execution.** Retries, waits, approvals, and long-running generation live in Workflows.
4. **Project Durable Object owns mutations.** User, Agent, and Workflow all submit the same command contract.
5. **Computer Workspace owns operational files.** Structured state remains canonical in Project SQLite; files are durable mirrors, generated assets, notes, and exports.

## 2. Physical topology

```text
React editor + Agent UI
        │
        ▼
Cloudflare Worker API
        │
        ├──────────────► StudioAgent DO (one per Project session)
        │                    │
        │                    ├── Think session history
        │                    ├── dynamic Project context
        │                    ├── immediate edit tools
        │                    └── durable workflow tools
        │                                  │
        │                                  ▼
        │                         Cloudflare Workflows
        │                                  │
        ▼                                  ▼
Project DO ◄──────────────────── Project commands / interactions
  │
  ├── SQLite canonical document + revision + command ledger
  ├── Computer Workspace VFS
  └── R2 artifact references ──────────────► R2 object bytes
```

## 3. Project Durable Object

The PPT and Canvas implementations use separate DO classes because their document schemas differ. Both inherit the same Project kernel and are wrapped with `withWorkspace()`.

The DO provides:

- lazy, idempotent Project initialization;
- strongly ordered mutation processing;
- optimistic revision checking;
- successful-command idempotency ledger;
- conflicting command identity rejection;
- independent session, interaction, workflow, and artifact indexes;
- context projection for the Agent.

### Revision semantics

Only editable document mutations increment the Project revision. Session metadata, Workflow status, Interaction status, and artifact indexes update independently. This keeps `revision` meaningful as an asset version rather than a generic row-change counter.

### Command retry semantics

The command fingerprint excludes `baseRevision` but includes actor, summary, and command payload:

- If a request conflicts, it is not stored in the ledger. The caller can reload and retry using the same command identity.
- If a request commits but the response is lost, the retry finds the ledger entry and returns the current state without repeating the edit.
- If the identity is reused with different commands, the DO fails closed.

## 4. Studio Agent

Each Project session maps to a distinct, name-addressed `StudioAgent` Durable Object.

That choice gives each session:

- independent durable message history;
- independent session memory;
- independent clear/reset semantics;
- a stable link to one Project;
- a bounded model/tool loop.

At every turn, `configureSession()` injects a dynamic Project context block. The context is not copied when the session is created; it is read from the current Project revision. Current editor selection is stored as short-lived Agent configuration and included in that projection.

The Agent sees high-level tools rather than raw storage or model APIs:

```text
inspect_project
update_ppt_slide
add_ppt_slide
set_ppt_theme
build_presentation_workflow
update_canvas_node
add_canvas_note
duplicate_canvas_node
generate_canvas_variants_workflow
list_project_files
read_project_file
write_project_note
request_user_choice
```

## 5. Human-in-the-loop

Human input is represented by a persistent `ProjectInteraction` record. The frontend renders a typed card based on `kind`.

For Workflow interactions:

1. Workflow writes an Interaction with `workflowId`.
2. Workflow calls `waitForApproval()` and suspends durably.
3. UI submits a structured response to the origin Agent session.
4. Agent approves or rejects the Workflow with response metadata.
5. Workflow resumes from its durable checkpoint.
6. Interaction record is resolved or cancelled.

For Agent-only interactions, the same UI response is submitted back into the durable Agent session as an idempotent typed user message.

## 6. Cloudflare Computer Workspace

The Workspace is mixed into the Project DO, not the Agent DO. Therefore every Agent session and every Workflow for the Project sees one durable filesystem.

The demo intentionally uses filesystem-only mode, which does not allocate a Linux container. It demonstrates the durable source-of-truth VFS while keeping the demo inexpensive. The same Project class can later be given a Computer backend for Linux execution without changing Project ownership or paths.

Each successful document mutation writes:

```text
/project/project.json
/project/revisions/{revision}.json
/project/README.md
```

Generation and export add:

```text
/assets/generated/{workflowId}/{nodeId}.jpg
/exports/revision-{revision}.pptx
/exports/latest.pptx
/scratch/{agent-note}.md
```

## 7. PPT flow

The presentation source of truth is `PresentationDocument`, not the `.pptx` file. The editor and Agent modify the AST. PptxGenJS creates a downloadable artifact from a specific revision.

The durable rebuild Workflow has four phases:

```text
structured plan generation
→ human plan/theme review
→ structured final document generation
→ atomic Project replacement
→ PPTX render and artifact registration
```

## 8. Canvas flow

The canvas source of truth is `CanvasDocument.nodes[]`. Manual drag, inspector edits, duplication, Agent tools, placeholders, and generated images all become Project commands.

The durable generation Workflow:

```text
structured creative directions
→ editable prompt review
→ placeholder node commit
→ real Workers AI image generation with retries
→ R2 + Workspace persistence
→ per-node attachment commit
```

Placeholders are committed before generation, so the canvas exposes progress. Each image is attached independently, so partial results remain visible. A terminal image-generation failure marks the affected node as `error` before the Workflow fails.

## 9. Why no D1 is required for the demo

The demo has two fixed Projects and uses each Project DO as its own strong-consistency database. A production product should add a global D1 or PostgreSQL index for tenant/project discovery, search, billing, and cross-project reporting. That index would reference Project DO IDs; it would not replace the DO as mutation authority.
