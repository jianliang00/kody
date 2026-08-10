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
- Settings owns one global Model Provider for future Turns. Composer drafts carry the selected model, reasoning effort, Speedy preference, and Turn permission mode; completed Turns retain the settings they were started with.
- Placeholder Thread titles are replaced after the first completed Turn by a provider-extensible title generator with a deterministic local fallback.

## Layout

Desktop uses four regions:

1. Workbench rail (approximately 13.5rem): a macOS source list with the native window-control gutter, new-draft action, mutually exclusive New Progress/Continue Later/In Progress/Processed Thread views, an All Threads view, Project filters, settings, update state, and server status. Counts and status groups reflect durable workflow state; In Progress is derived only from a real active Turn. Selecting a Project narrows the Thread list to Threads whose default references include that Project; it never adds the Project as context or changes reference ownership.
2. Thread list (approximately 17rem): scoped search and the durable Threads that match the selected Workbench view or Project filter.
3. Conversation workspace (fluid): Thread title/status, linear messages, live agent activity, composer.
4. Inspector (approximately 20rem): one independently scrollable column of disclosure sections for Current Thread Context, Workspace, changed files, and execution timeline. Context is the canonical summary; its Referenced Threads, Referenced Projects, and Runtime rows open focused detail dialogs instead of duplicating those categories as additional sidebar sections. The reusable Projects source list appears only in the leading Workbench.

The unified title bar spans the complete detail region above both the conversation and persistent Inspector. The conversation/Inspector split begins below that toolbar, so toolbar actions stay in one uninterrupted window-level command surface. When the Inspector becomes a responsive drawer, the title bar spans the remaining main content and the drawer overlays it as a modal surface.

Thread to-do state is durable and independent from runtime execution state. A newly created idle Thread starts in Continue Later; completing, failing, or cancelling a Turn moves it to New Progress; explicit user actions move an idle Thread to Continue Later, Processed, or back to New Progress. A running Thread cannot be reclassified. The leading circle is a direct Processed toggle, the trailing action menu exposes every valid classification, and the unified title bar repeats the frequent Mark as Processed/Restore action for the active Thread. Moving a Thread out of the selected view never closes its already-open conversation.

The Context card summarizes effective Thread/Project references using the same last-reference-wins semantics as the runtime. Runtime operations and pending approvals are shown separately from real Process Manager records; ordinary blocking shell tools must never be mislabeled as background processes. The summary shows at most two active managed processes, while the Runtime detail dialog owns the complete lifecycle list and output controls. Reference detail dialogs separate default, history, and pending context. Dialogs trap focus, close with Escape, restore focus to the exact originating row, and temporarily supersede a responsive Inspector drawer as the sole modal surface. The four sidebar sections expand independently through native disclosure buttons, preserve mounted content while hidden, and persist their state locally. The conversation title bar has a separate control for the entire right sidebar. The Workbench and Thread list collapse independently on desktop and persist those choices. At narrow widths they combine into one navigation drawer, while the Inspector remains a separate drawer. Only one responsive drawer may be open at a time, and its scrim must sit above the background but below the active drawer. The conversation must remain usable at 320 CSS pixels.

## Visual direction

Use native macOS desktop hierarchy: a darker translucent source-list Workbench, white Thread list and inspector surfaces, a quiet gray toolbar, compact controls, thin split separators, and system typography. Warm gold-orange is Kody's application tint for New Thread, the selected Thread, the active user-message rule, primary controls, menu selection, and focus. Permanent regions stay flat. Rounded containers and shadows are limited to the selected Thread, menus, dialogs, and the composer; ordinary controls use flat tonal fills rather than raised gradients.

Typography is intentionally scoped by role. Conversation copy and ordinary form/action controls use `body` (14px); compact toolbar controls, menu rows, source-list titles, and the primary Thread-list empty state use `caption` (13px). Supporting metadata and secondary sidebar empty states use 12px, while timestamps, counts, status capsules, and source-list section labels use 11px. Dialog titles are 17px semibold, Settings section titles are 15px semibold, and card titles are 14px semibold. The toolbar title is compact; the active Thread receives its real heading and status hierarchy in the document header below it. Workbench section and column headings use medium 500, right-rail disclosure titles use 14px semibold 600, Context group headings and detail-dialog group headings use 12px medium 500 in secondary color, Thread row titles use semibold 600, and navigation labels and metadata remain regular 400. Empty-state copy never outranks the content it replaces: the Thread-list empty state is centered in its available list region, while compact sidebar and inspector empty states remain aligned with their content columns. The composer starts at two text rows, keeps one hierarchical Model menu plus context tools in the bottom action area, and may resize vertically up to its bounded maximum; Provider selection belongs only in Settings. The Model menu exposes Model and Effort submenus and a Speedy check item only when the selected catalog model advertises the priority tier. Its collapsed trigger has no leading status icon while Fast mode is off or unavailable, then adds a filled secondary-neutral lightning icon when Fast mode is on.

All ordinary form and action controls use one shared macOS control layer. Single-line text fields and searches are compact 24px wells with an 8px corner radius, a one-pixel separator-colored edge, and a restrained one-pixel application-tint focus ring; multiline fields inherit the same surface while growing to their content role. Standard text buttons are 24px high with 6px corners, 14px regular-weight copy, and a flat tonal face; compact toolbar controls use 13px regular-weight copy. Composer Model and permission pop-up buttons use borderless solid tonal faces without gradients, including a borderless disclosure well; pointer-open state changes the solid fill without adding a focus halo. Full access remains borderless and communicates its elevated permission through restrained red text and icon on the neutral resting face, adding only a very light red tint while hovered or open. Dialog action buttons are at least 80px wide. Primary controls use a bright gold fill with black text; destructive controls may use a restrained semantic solid tint, while borderless, compact, and disabled variants preserve the common geometry and interaction treatment instead of defining independent surfaces in feature CSS.

All visible select controls use the shared Kody select primitive rather than a platform-native popup. Field, toolbar, permission, and reference-chip variants may change trigger density, but their popup surface, typography, selection indicator, focus treatment, disabled state, collision handling, and keyboard behavior remain consistent. Closed field selects match adjacent text inputs. A standalone select is a 24px control like its neighboring actions; only a select nested inside an existing reference chip is visually unframed. Field menus use 26px rows and a 10px outer corner radius. The denser Model and permission menus embedded in the composer use 24px rows and a borderless 8px popup surface separated by shadow, with a neutral fixed disclosure well and compact insets. Highlighted menu rows use the same primary gold fill and black contrast color as the primary action buttons.

Labels have three explicit semantics. Status labels communicate workflow or runtime state and may use restrained semantic tint plus a state glyph or dot. Count labels are neutral, compact numeric indicators and never imply state. Token labels represent attached objects such as references or working directories; they use a bordered capsule, may contain a scoped select or remove action, and must not be restyled as status. Interactive capsules remain real buttons even when they share label geometry.

The shared control layer must retain the same hierarchy and affordances in dark appearance, replace translucent materials with opaque system surfaces under reduced transparency, and remain legible and operable in forced-colors mode. Focus, selection, destructive meaning, and disabled state must not depend on translucency, shadow, or color alone.

Right-rail disclosures are single-line 38–40px inspector rows with a right-facing collapsed chevron and a downward expanded chevron. Their 14px semibold titles form the primary hierarchy; 12px medium panel-group headings are muted, while 13px item titles retain ordinary content emphasis. Eyebrows remain available to assistive structure but are not rendered as a second visual line. Expanded panels form one continuous surface separated by hairlines; metric blocks, paths, and static information do not become nested cards. Settings and update state belong to the bottom of the Workbench rather than the Thread title bar. Updates use a compact, single-line capsule at the trailing edge of the local-server status row; availability and progress use restrained semantic color without changing the underlying update action. On macOS, Workbench content begins below the native traffic-light gutter instead of sharing its horizontal band.

In the desktop four-column layout, the Workbench has a fixed source-list width while the Thread-list and inspector boundaries are adjustable. Their separators use a generous invisible pointer target, expose the ARIA separator value to assistive technology, support Left/Right arrows (Shift for a larger step), Home/End bounds, and double-click reset. Committed widths persist locally while responsive layouts use the combined navigation drawer and separate inspector drawer. Width fitting always includes the Workbench and protects a usable conversation column instead of allowing saved sidebar sizes to squeeze it away.

The app shell is viewport-bound. Long Thread histories scroll only inside the conversation timeline; the title bar, composer, Workbench, Thread list, and inspector remain fixed. Automatic bottom-following must scroll the timeline element directly and must not use viewport-level `scrollIntoView` behavior.

## Essential flows

1. First launch shows a ready composer without creating any durable entity; disconnected state has a readable status and retry affordance.
2. Optionally stage a working directory inside the draft composer, then create Thread/Workspace/Project/first Turn on the first Send.
3. Import and filter by reusable Projects from the Workbench source list; reference them from the composer context palette.
4. Select a truthful status view or Project filter in the Workbench, then select a matching Thread and load its durable snapshot.
5. Type `@` or press the context button to search Threads/Projects; add/remove/toggle reference modes.
6. Start a Turn, stream events, stop a running Turn and refresh durable history at terminal event.
7. Choose the next Turn's permission mode inside the composer; show command-execution approval inline with command/reason and explicit Allow/Deny actions in ask mode.
8. Inspect Workspace path and changed-file events in their sidebar disclosures; inspect default, historical, and draft references from the corresponding Context detail dialog.
9. Replace the placeholder title after the first completed Turn and reflect it in both title bar and Thread list.
10. Keep the upper-right Current Thread card synchronized with effective references, pending next-message context, active operations, approvals and managed background-process state.
11. Open Runtime from Context to inspect every managed process, read its bounded stdout/stderr stream by byte cursor, and stop active processes through the explicit Process Manager RPC.

Process events use an independent stream because they may outlive their originating Turn. Lifecycle events refresh the authoritative Thread snapshot; output events update only the latest observed cursor and bytes are read through `process/read-output`. Process output is never appended to the Turn timeline or held as an unbounded renderer log.

## Accessibility

- Semantic landmarks and native buttons/inputs.
- Explicit accessible labels for every control, with compact icon controls using `aria-label`; skip link and status live region.
- Full keyboard operation for lists, dialogs and mention palette.
- Workbench source-list selections expose their current state, and filtering never mutates Thread references.
- Right-rail disclosures use native buttons with stable `aria-expanded`/`aria-controls` relationships; collapsed panels stay mounted but are removed from focus navigation.
- The inspector is modal only when rendered as a narrow drawer, with a dynamic focus trap and focus restoration. Process output uses a bounded `role="log"` region with live announcements disabled.
- Minimum 44px primary touch targets; dense secondary rows may use a larger invisible hit area.
- WCAG AA contrast in light/dark themes.
- Respect reduced motion and system color scheme.
