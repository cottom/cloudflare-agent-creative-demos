# Demo flows

## PPT Project Agent

### Direct human edit

```text
Inspector edit
→ POST ProjectMutation(baseRevision, commandId)
→ PPT Project DO transaction
→ revision + 1
→ Computer Workspace snapshot
→ UI poll observes new revision
```

### Immediate Agent edit

```text
User message + selected slide ID
→ Think durable submission
→ dynamic Project context
→ update_ppt_slide tool
→ revision-safe Project command
→ Agent response
```

### Durable rebuild

```text
User or Agent starts PPT_BUILD_WORKFLOW
→ Workers AI generates structured plan
→ ProjectInteraction(ppt_plan_review)
→ Workflow waits up to 7 days
→ user edits theme/direction and approves
→ Workers AI generates PresentationDocument
→ deterministic Project replacement command
→ PptxGenJS renders real PPTX
→ R2 + Computer Workspace
```

## Media Canvas Agent

### Direct manipulation

```text
Pointer drag / inspector edit / duplicate
→ Canvas Project command
→ revision + 1
→ durable workspace snapshot
```

### Selection-aware Agent

```text
User selects node
→ EditorAwareness(activeId)
→ Think Project context contains full selected node
→ Agent can interpret “this” without guessing
→ semantic canvas command
```

### Real image variants

```text
User or Agent starts CANVAS_VARIANTS_WORKFLOW
→ Workers AI LLM creates distinct prompts
→ ProjectInteraction(canvas_variant_review)
→ user edits prompts and approves
→ placeholder nodes committed
→ for each prompt:
     Workers AI FLUX image generation
     → R2 JPEG
     → Computer Workspace JPEG
     → artifact index
     → attach asset key to node
→ final Project revision returned
```

## Session behavior

| Action | Conversation | Session memory | Project asset | Project workspace |
|---|---:|---:|---:|---:|
| Clear chat | cleared | retained unless model updates it | retained | retained |
| New session | new | new | retained | retained |
| Agent tool edit | retained | retained | new revision | new snapshot |
| Workflow edit | retained | retained | new revision | new snapshot/artifact |

## Suggested acceptance test

1. Load both demos and confirm `/project/project.json` exists in each Workspace panel.
2. Edit PPT slide 1 manually; note revision increases.
3. Clear chat; verify slide 1 remains changed.
4. Create a new Agent session; ask it to inspect the deck; verify it sees the changed title.
5. Start PPT rebuild; verify it waits at a plan review card.
6. Approve; verify the Project changes and a real PPTX appears under exports.
7. Move and duplicate a Canvas node; confirm both persist after reload.
8. Start image variants; verify editable prompt review appears before image calls.
9. Approve; verify placeholders appear and real images attach one by one.
10. Create/clear Canvas Agent sessions; verify the generated nodes remain.
