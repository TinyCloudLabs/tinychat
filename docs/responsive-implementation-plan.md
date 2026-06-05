# TinyChat Responsive UI — Implementation Plan

## Why

The chat app shell has zero responsive handling (the landing pages under
`frontend/src/landing/` already use breakpoints and are NOT in scope):

1. The thread-list sidebar is a hard-coded, always-visible 260px grid column
   (`ChatWorkspace` in `frontend/src/App.tsx`) — on a 375px phone the chat
   area gets ~115px.
2. The header is a single non-wrapping flex row (logo + model picker + usage
   chip + Memory + theme + connection details + sign out) that overflows
   horizontally on narrow screens.
3. Header popovers have fixed widths (`w-72`, `w-64`) that can extend past the
   viewport edge. (`MemoryPanel.tsx` already clamps correctly with
   `w-[min(420px,90vw)]` — the others don't.)
4. The root container uses `h-screen`, which hits the mobile-Safari 100vh bug
   (composer hidden behind browser chrome).

## Ground rules (apply to every task)

- **Breakpoints**: sidebar collapses below `md` (768px); header de-clutters
  below `sm` (640px).
- **Desktop (≥ `md`) must be visually identical to today.** These are
  mobile-only additions; never change desktop layout/spacing/behavior.
- **No new dependencies.** `@radix-ui/react-dialog`, `lucide-react`,
  `tailwindcss-animate` are already installed. Tailwind is **v3.4** — only use
  classes valid there (`h-dvh` IS valid in 3.4).
- Match the existing design language and code conventions (see
  `frontend/src/components/ui/dialog.tsx` for the shadcn-style primitive
  conventions; `cn()` from `@/lib/utils`).
- Preserve every existing `aria-*` attribute; icon-only buttons keep their
  accessible names via `aria-label`/`sr-only`.
- After each task: `bun --bun run build:frontend` (tsc && vite build) must be
  green from the repo root.

---

## T1 — Sheet primitive (`frontend/src/components/ui/sheet.tsx`, NEW)

Minimal shadcn-style Sheet built on `@radix-ui/react-dialog`. Only the
`side="left"` variant is required (it may be the only variant — keep it
small). Follow `dialog.tsx` conventions exactly: same overlay styling
(`fixed inset-0 z-50 bg-black/80`, `data-[state]` fade animations), portal,
forwardRef pattern, `cn()` merging.

`SheetContent` (left side):
- `fixed inset-y-0 left-0 z-50 h-full w-[280px] max-w-[85vw] border-r border-border bg-background p-0 shadow-lg`
- Slide animations via tailwindcss-animate:
  `data-[state=open]:animate-in data-[state=open]:slide-in-from-left data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left`
  plus the standard duration/ease classes dialog.tsx uses.
- Include a close affordance consistent with `dialog.tsx` (X button with
  `<span className="sr-only">Close</span>`), since drawer users may not know
  to tap the backdrop.
- Export: `Sheet`, `SheetTrigger` (optional), `SheetContent`, `SheetTitle`
  (needed for Radix a11y — can be visually hidden via `sr-only`),
  `SheetDescription` if needed to silence Radix warnings.

Acceptance:
- Typechecks; no console warnings from Radix about missing Title/Description
  when used.
- No other file changed in this task.

## T2 — ThreadList `onNavigate` (`frontend/src/chat/ThreadList.tsx`)

Add an optional `onNavigate?: () => void` prop to `ThreadListProps`, called
whenever the user picks a thread or starts a new chat — the mobile drawer
(T3) uses it to close itself. Desktop passes nothing; behavior must be
unchanged when the prop is absent.

Implementation constraint: `ThreadListItem` is a module-level component passed
via `components={{ ThreadListItem }}`, so it cannot receive props. Use a
module-level React context:

```tsx
const ThreadListNavigateContext = createContext<(() => void) | undefined>(undefined);
```

- `ThreadList` wraps its tree in the provider with the `onNavigate` value.
- `ThreadListItemPrimitive.Trigger` gets `onClick={() => onNavigate?.()}` —
  assistant-ui primitives compose user onClick with their own behavior, so
  thread switching still works.
- `ThreadListPrimitive.New` gets the same `onClick`.
- Do NOT call it from the delete button / AlertDialog flow.

Acceptance:
- With no `onNavigate`, rendered DOM and behavior are identical to before.
- Typechecks.

## T3 — Responsive shell (`frontend/src/App.tsx`)

The core fix. In `ChatWorkspace`:
- Grid: `grid h-full grid-cols-[260px_1fr]` → `grid h-full grid-cols-1 md:grid-cols-[260px_1fr]`.
- Desktop `<aside>`: add `hidden md:block` (keep everything else).
- Mobile drawer: render a `Sheet` (from T1) controlled by state lifted to
  `App` (`sidebarOpen` / `setSidebarOpen`). Inside `SheetContent side="left"`,
  render a second `<ThreadList tcw={...} onImported={...} onNavigate={() => setSidebarOpen(false)} />`.
  Both ThreadList instances live under the same `AssistantRuntimeProvider`,
  so they share state for free. Add a visually-hidden `SheetTitle`
  ("Chats").
- The drawer must also close after `onImported` fires (import dialog lives in
  the ThreadList) — closing on navigate is the priority; if import flows
  remount the workspace (`importRefreshKey`), let that happen naturally and
  default `sidebarOpen` to false on mount.

In `App`:
- Add `const [sidebarOpen, setSidebarOpen] = useState(false)`.
- Hamburger button in the header, leftmost position, only when `isReady`:
  `PanelLeftIcon` (lucide), `md:hidden`, `aria-label="Open chat list"`,
  styled like the other small outline header buttons.
- Pass `sidebarOpen`/`setSidebarOpen` (or an `onCloseSidebar` callback) down
  to `ChatWorkspace`.
- Root container: `flex h-screen flex-col` → `flex h-dvh flex-col`.

Acceptance:
- ≥`md`: sidebar inline, hamburger hidden, layout identical to before.
- <`md`: sidebar hidden, hamburger visible, tapping it opens the left drawer
  with the thread list; picking a thread or "New chat" closes it.
- Typechecks.

## T4 — Header de-clutter (`frontend/src/App.tsx` header)

All changes apply ONLY below `sm` — at `sm` and above the header must render
exactly as today.

- "TinyCloud Chat" title text next to the T logo: wrap in
  `<span className="hidden sm:inline">` (logo square always visible).
- `ModelPicker` trigger label: `max-w-[12rem]` → `max-w-[7rem] sm:max-w-[12rem]`.
- `MemoryPopover` trigger: hide the "Memory" text below `sm`
  (`<span className="hidden sm:inline">Memory</span>`); the existing
  `aria-label` already covers icon-only mode; keep the has-memory dot.
- `UsageIndicator` chip: hide the compact usage numbers and the progress bar
  below `sm` (`hidden sm:inline` / `hidden sm:inline-flex`); the tier label
  stays as the touch target.
- `ConnectionDetails` summary: hide the state label text below `sm`, keep the
  status dot (give the dot an `aria-label`/`sr-only` text so the control still
  has a name).
- Gaps/padding — **the original desktop value is always the `sm:` value**
  (PRECEDENCE: if any class suggestion here conflicts with the
  "desktop identical" ground rule, the ground rule wins):
  - Header container: `gap-3 … px-4 py-2.5` → `gap-1.5 sm:gap-3 px-3 sm:px-4 py-2.5`.
  - Left group (logo + model picker), originally `gap-3` → `gap-1.5 sm:gap-3`.
  - Right group (usage/memory/theme/connection/sign-out), originally `gap-2` →
    `gap-1.5 sm:gap-2`.
- If the header still overflows at 375px with ALL items rendered (signed-in,
  paywall on: hamburger + logo + model picker + usage chip + memory + theme +
  connection + sign out), it is acceptable to additionally (mobile-only, below
  `sm`): reduce the ModelPicker trigger to `max-w-[5.5rem]`, hide the
  UsageIndicator tier label leaving a compact icon-sized chip, and/or reduce
  button horizontal padding (`px-1.5 sm:px-2.5`). Desktop must not change.

Acceptance:
- At 375px wide with all header items rendered (signed-in, paywall on), the
  header fits on one row with no horizontal overflow.
- At ≥640px the header is unchanged from today.
- Typechecks.

## T5 — Polish: popover clamps, safe area, viewport meta

- `frontend/src/App.tsx`:
  - Model listbox popup (`w-72` in `ModelPicker`): add `max-w-[calc(100vw-2rem)]`.
  - Usage hover popover (`w-64` in `UsageIndicator`): add `max-w-[calc(100vw-2rem)]`.
  - ConnectionDetails dropdown panel (`w-72`): add `max-w-[calc(100vw-2rem)]`.
- `frontend/src/chat/Thread.tsx`: composer sticky footer `pb-4` →
  `pb-[max(1rem,env(safe-area-inset-bottom))]`.
- `frontend/index.html`: viewport meta →
  `content="width=device-width, initial-scale=1.0, viewport-fit=cover"`.

Acceptance:
- Popovers never extend past the viewport at 375px.
- Typechecks; production build green.

---

## Out of scope

- Landing pages (`frontend/src/landing/`) — already responsive.
- `PricingDialog`, `RatesDialog`, `ImportDialog`, `AlertDialog` — shadcn
  responsive defaults already handle mobile.
- Backend, manifest, packages/* — untouched.

## Verification commands

```bash
bun --bun run build:frontend   # tsc && vite build
bun run lint                   # eslint .
```

Browser spot-checks (dev server, signed-out reachable without a wallet):
- 375×812: no horizontal scroll anywhere; BootSurface centered; header fits.
- 768×1024: inline sidebar (when signed in), no hamburger.
- 1280×800: identical to the pre-change layout.
