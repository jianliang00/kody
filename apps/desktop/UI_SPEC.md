# Cody Desktop UI specification

## Product model

The UI must preserve the framework's original domain model rather than copying Codex App navigation:

- Threads are durable linear conversations and are listed independently.
- Projects are reusable code assets and are listed independently, never as parents that own Threads.
- Every Thread owns an ephemeral Workspace shown in the inspector.
- A composer can mention any number of Threads and Projects. Mentions become structured `references` on the next user message.
- Project references expose an explicit read-only/read-write access choice.
- Thread references expose summary/full/artifacts modes.
- A blank composer is a local draft, not a persisted Thread. The first message creates the Thread, Workspace, and first Turn as one idempotent request.
- A draft may stage a working directory; it becomes an imported Project and persistent read/write default only when the first message is sent.
- Placeholder Thread titles are replaced after the first completed Turn by a provider-extensible title generator with a deterministic local fallback.

## Layout

Desktop uses three regions:

1. Asset rail (approximately 17rem): new-draft action, search, and durable Thread list.
2. Conversation workspace (fluid): title/status, linear messages, live agent activity, composer.
3. Context rail (approximately 20rem): a persistent Current Thread context card at the upper-right, the detailed Thread inspector below it, and a separate Project shelf anchored at the bottom-right.

The context card summarizes effective Thread/Project references using the same last-reference-wins semantics as the runtime. Runtime operations and pending approvals are shown separately from managed background processes; ordinary blocking shell tools must never be mislabeled as background processes. At narrow widths, the summary collapses into the title-bar Context trigger and the inspector becomes a drawer. The asset rail can collapse, and the conversation must remain usable at 320 CSS pixels.

## Visual direction

Borrow only broad traits from the Codex desktop aesthetic: quiet neutral surfaces, compact information density, precise typography, thin borders and restrained status color. Cody's own signature is the “context constellation”: Thread references use violet nodes, Project references use cyan nodes, and Workspace uses a warm amber node. Avoid cloning Codex icons, spacing, exact sidebar hierarchy or component layout.

## Essential flows

1. First launch shows a ready composer without creating any durable entity; disconnected state has a readable status and retry affordance.
2. Optionally stage a working directory inside the draft composer, then create Thread/Workspace/Project/first Turn on the first Send.
3. Import and reference reusable Projects from the independent bottom-right Project shelf.
4. Select a Thread and load its durable snapshot.
5. Type `@` or press the context button to search Threads/Projects; add/remove/toggle reference modes.
6. Start a Turn, stream events, stop a running Turn and refresh durable history at terminal event.
7. Show Shell approval inline with command/reason and explicit Allow/Deny actions.
8. Inspect Workspace path, default references, draft references and changed-file events.
9. Replace the placeholder title after the first completed Turn and reflect it in both title bar and Thread list.
10. Keep the upper-right Current Thread card synchronized with effective references, pending next-message context, active operations, approvals and managed background-process state.

## Accessibility

- Semantic landmarks and native buttons/inputs.
- Visible labels (not placeholder-only), skip link and status live region.
- Full keyboard operation for lists, dialogs and mention palette.
- Minimum 44px primary touch targets; dense secondary rows may use a larger invisible hit area.
- WCAG AA contrast in light/dark themes.
- Respect reduced motion and system color scheme.
