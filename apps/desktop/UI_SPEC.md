# Kody Desktop UI specification

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
- Every composer draft carries a Turn permission mode: read-only, ask for commands, or full access. The last mode used in a Thread becomes that Thread's next composer default.
- Placeholder Thread titles are replaced after the first completed Turn by a provider-extensible title generator with a deterministic local fallback.

## Layout

Desktop uses three regions:

1. Asset rail (approximately 17rem): a dedicated macOS window-control gutter above the Kody identity, new-draft action, search, durable Thread list, settings, update state, and server status.
2. Conversation workspace (fluid): Thread title/status, linear messages, live agent activity, composer.
3. Context rail (approximately 20rem): a persistent Current Thread context card at the upper-right, the detailed Thread inspector below it, and a separate Project shelf anchored at the bottom-right.

The context card summarizes effective Thread/Project references using the same last-reference-wins semantics as the runtime. Runtime operations and pending approvals are shown separately from real Process Manager records; ordinary blocking shell tools must never be mislabeled as background processes. It shows at most two active managed processes while the inspector owns the complete lifecycle list. The context card and `Context & activity` header own the detailed inspector's expand/collapse controls; they never appear in the conversation title bar. The conversation title bar has a separate control for the entire right sidebar. At narrow widths, that control opens the inspector as a drawer. The asset rail can collapse, and the conversation must remain usable at 320 CSS pixels.

## Visual direction

Borrow only broad traits from the Codex desktop aesthetic: quiet neutral surfaces, compact information density, precise typography, thin borders and restrained status color. Kody's own signature is the “context constellation”: Thread references use violet nodes, Project references use cyan nodes, and Workspace uses a warm amber node. Avoid cloning Codex icons, spacing, exact sidebar hierarchy or component layout.

Typography uses one shared semantic scale across the conversation, asset rail, context rail, and settings surfaces. Normal UI copy and controls use `body` (14px), while secondary metadata, compact labels, badges, and monospace output use `caption` (13px). Only genuine headings use the 17px, 19px, 21px, or display heading tokens. UI copy uses regular 400 weight, controls and local emphasis use medium 500, and headings/status badges use semibold 600 at most. New components must use these semantic roles instead of introducing arbitrary sizes or weights. The composer starts at two text rows and may resize vertically up to its bounded maximum; its measured dock height remains authoritative for timeline and floating-shelf clearance.

All visible select controls use the shared Kody select primitive rather than a platform-native popup. Field, toolbar, permission, and reference-chip variants may change trigger density, but their popup surface, typography, selection indicator, focus treatment, disabled state, collision handling, and keyboard behavior remain consistent.

The Current Thread card uses `body` consistently for every visible text element—including its eyebrow, metrics, group labels, empty states, metadata, runtime rows, and Workspace path—so the dense right rail does not look scaled down from the rest of the application. Card headings add hierarchy through weight rather than a different size. Settings and update state belong to the bottom of the asset rail rather than the Thread title bar. Updates use a compact, single-line capsule sized to its content; availability and progress use restrained semantic color without changing the underlying update action. On macOS, the Kody brand row begins below the native traffic-light gutter instead of sharing its horizontal band.

The app shell is viewport-bound. Long Thread histories scroll only inside the conversation timeline; the title bar, composer, asset rail, and context rail remain fixed. Automatic bottom-following must scroll the timeline element directly and must not use viewport-level `scrollIntoView` behavior.

## Essential flows

1. First launch shows a ready composer without creating any durable entity; disconnected state has a readable status and retry affordance.
2. Optionally stage a working directory inside the draft composer, then create Thread/Workspace/Project/first Turn on the first Send.
3. Import and reference reusable Projects from the independent bottom-right Project shelf.
4. Select a Thread and load its durable snapshot.
5. Type `@` or press the context button to search Threads/Projects; add/remove/toggle reference modes.
6. Start a Turn, stream events, stop a running Turn and refresh durable history at terminal event.
7. Choose the next Turn's permission mode inside the composer; show command-execution approval inline with command/reason and explicit Allow/Deny actions in ask mode.
8. Inspect Workspace path, default references, draft references and changed-file events.
9. Replace the placeholder title after the first completed Turn and reflect it in both title bar and Thread list.
10. Keep the upper-right Current Thread card synchronized with effective references, pending next-message context, active operations, approvals and managed background-process state.
11. Inspect every managed process, read its bounded stdout/stderr stream by byte cursor, and stop active processes through the explicit Process Manager RPC.

Process events use an independent stream because they may outlive their originating Turn. Lifecycle events refresh the authoritative Thread snapshot; output events update only the latest observed cursor and bytes are read through `process/read-output`. Process output is never appended to the Turn timeline or held as an unbounded renderer log.

## Accessibility

- Semantic landmarks and native buttons/inputs.
- Visible labels (not placeholder-only), skip link and status live region.
- Full keyboard operation for lists, dialogs and mention palette.
- The inspector is modal only when rendered as a narrow drawer, with a dynamic focus trap and focus restoration. Process output uses a bounded `role="log"` region with live announcements disabled.
- Minimum 44px primary touch targets; dense secondary rows may use a larger invisible hit area.
- WCAG AA contrast in light/dark themes.
- Respect reduced motion and system color scheme.
