# Cody Desktop UI specification

## Product model

The UI must preserve the framework's original domain model rather than copying Codex App navigation:

- Threads are durable linear conversations and are listed independently.
- Projects are reusable code assets and are listed independently, never as parents that own Threads.
- Every Thread owns an ephemeral Workspace shown in the inspector.
- A composer can mention any number of Threads and Projects. Mentions become structured `references` on the next user message.
- Project references expose an explicit read-only/read-write access choice.
- Thread references expose summary/full/artifacts modes.

## Layout

Desktop uses three regions:

1. Asset rail (approximately 17rem): global actions, search, independent Thread and Project lists.
2. Conversation workspace (fluid): title/status, linear messages, live agent activity, composer.
3. Context inspector (approximately 20rem): Workspace, active/default references, changed files and execution timeline.

At narrow widths, the inspector becomes a drawer and the asset rail can collapse. The conversation must remain usable at 320 CSS pixels.

## Visual direction

Borrow only broad traits from the Codex desktop aesthetic: quiet neutral surfaces, compact information density, precise typography, thin borders and restrained status color. Cody's own signature is the “context constellation”: Thread references use violet nodes, Project references use cyan nodes, and Workspace uses a warm amber node. Avoid cloning Codex icons, spacing, exact sidebar hierarchy or component layout.

## Essential flows

1. First launch / disconnected state with a readable server status and retry affordance.
2. Create standalone Thread or create one from a selected folder (auto-import Project).
3. Import Project through native directory picker.
4. Select a Thread and load its durable snapshot.
5. Type `@` or press the context button to search Threads/Projects; add/remove/toggle reference modes.
6. Start a Turn, stream events, stop a running Turn and refresh durable history at terminal event.
7. Show Shell approval inline with command/reason and explicit Allow/Deny actions.
8. Inspect Workspace path, default references, draft references and changed-file events.

## Accessibility

- Semantic landmarks and native buttons/inputs.
- Visible labels (not placeholder-only), skip link and status live region.
- Full keyboard operation for lists, dialogs and mention palette.
- Minimum 44px primary touch targets; dense secondary rows may use a larger invisible hit area.
- WCAG AA contrast in light/dark themes.
- Respect reduced motion and system color scheme.
