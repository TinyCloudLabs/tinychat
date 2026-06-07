# Settings / More page (`/chat/settings`) — Implementation Spec

Status: draft / not implemented. Branch: `feature/settings-page` (off `main` @ `4d42bf9`).

All file:line references below are against the tree as read while writing this spec. Line
numbers will drift as tasks land — treat them as anchors, not contracts.

---

## 1. Overview & goals

The chat header (`frontend/src/App.tsx` lines 440–514) has accreted controls: on mobile
(`<640px`) a signed-in user sees a sidebar hamburger, the "T" badge, the model picker, a
usage chip, a Memory brain button, a theme toggle, a connection-details `<details>`, and a
sign-out button — eight interactive elements crammed onto one row, several of which open
their own popovers/modals. It is cramped and hard to thumb-reach.

Goals:

1. **Header breathing room.** Move low-frequency controls off the header into a dedicated
   settings page so the header carries only what users touch on every turn.
2. **Mobile-first.** The signed-in mobile header collapses to exactly three controls:
   sidebar hamburger, model picker, settings gear. Everything else moves into the settings
   page, which is a single scrollable column that works at 390px.
3. **Stop cramming modals into the header.** Memory becomes an inline settings section
   instead of a header popover. Import/Billing dialogs stay dialogs but are *triggered* from
   settings sections, not from header buttons or the thread-list header.
4. **Preserve all current behavior.** No logic in the runtime, store, billing, memory, or
   import modules changes. The 402 paywall auto-open, `?billing=` redirect handling, and
   matchMedia sidebar auto-close all stay exactly as they are. Chat state stays mounted when
   navigating to settings and back.

Non-goals: no backend changes, no new dependencies, no redesign of the chat surface itself,
no change to the desktop (`≥768px`) chat grid layout beyond swapping the header right-group.

---

## 2. Current state (inventory with file:line refs)

### Router (`frontend/src/main.tsx`)
- Lines 11–15: `/` → `LandingPage`, `/chat/*` → `App`, `*` → redirect to `/`.
- `App` therefore already owns the entire `/chat/*` subtree. The settings route lives
  **inside** `App`, not as a new top-level route — this keeps it under the same auth state
  and (via nested routing) the `AssistantRuntimeProvider`.

### Header chrome (`frontend/src/App.tsx`)
- Lines 440–514: the `<header>`. Left group (441–469): mobile hamburger `PanelLeftIcon`
  (`md:hidden`, 443–452), "T" badge + title (453–458, title `hidden sm:inline`), `ModelPicker`
  (459–468). Right group (470–513): `UsageIndicator` (paywall-gated, 471–477), `MemoryPopover`
  brain button (478–487), `ThemeToggle` (488), `ConnectionDetails` `<details>` (489–495),
  sign-in/try-again button (496–500), sign-out button (501–512).
- `MemoryPopover` component: lines 570–675 (brain button + click-outside/focus-trap host that
  renders `MemoryPanel` in an absolute popover).
- `UsageIndicator` component: lines 683–773 (desktop chip + hover popover; click → `openPricing`).
- `ModelPicker` component: lines 801–1084.
- `ConnectionDetails` component: lines 1219–1251 (status dot + `<details>` showing Address /
  DID / Space rows + error).
- `Row` helper: 1253–1262. `stateLabel`: 1264–1274.

### App-root state the relocated controls depend on (`frontend/src/App.tsx`)
- Auth/session: `state` (85), `address` (86), `did` (87), `spaceId` (88), `tcw` (89),
  `error` (92). `isReady = state === "ready" && tcw !== null` (436).
- Memory: `memoryRef` (83), `memoryPanelOpen` (93), `hasMemory` (137–140), `onMemoryUpdated`
  (134–136).
- Billing: `billingRef` (101–103), `billingConfig` (104), `billingStatus` (105),
  `pricingOpen` (106), `ratesOpen` (107), `paywallEnabled` (109), `openRates` (110),
  `refreshBillingStatus` (112–119), `openPricing` (339–342).
- Import: `onImported` (126–129), `importRefreshKey` (125) used as `key` on `ChatWorkspace`
  (519).
- Sidebar: `sidebarOpen` (94), `setSidebarOpen`; matchMedia auto-close effect (211–220).
- 402 handler auto-opening pricing: lines 307–312 (**must stay untouched**).
- `?billing=` redirect handling: lines 317–337 (**must stay untouched**).
- `signOut`: lines 408–434. `signIn`: 369–406.

### Dialogs (stay dialogs)
- `ImportDialog` (`frontend/src/chat/ImportDialog.tsx`): self-contained `Dialog` with its own
  `DialogTrigger` button (lines 280–288: an `Import` button styled like the sidebar's
  "New chat"). Props: `{ tcw, onImported? }` (57–65). Today rendered inside `ThreadList`.
- `ThreadList` (`frontend/src/chat/ThreadList.tsx`): renders `<ImportDialog tcw onImported />`
  at line 90, between the "New chat" button and the scroll list.
- `PricingDialog` (`frontend/src/chat/PricingDialog.tsx`): controlled `Dialog`, props include
  `{ open, onOpenChange, config, status, billing, onOpenRates }`.
- `RatesDialog` (`frontend/src/chat/RatesDialog.tsx`): controlled `Dialog`, props
  `{ open, onOpenChange, billing }`.

### Design-system primitives available
- `frontend/src/components/ui/`: `button.tsx`, `dialog.tsx`, `alert-dialog.tsx`, `sheet.tsx`,
  `tooltip.tsx`. **No `card.tsx`** — section "cards" are plain `div`s with the established
  `rounded-lg border border-border bg-card` idiom (see ImportDialog trigger line 283,
  ThreadList "New chat" line 84–85).
- `Button` variants: `default | destructive | outline | secondary | ghost | link`. Sizes:
  `default | sm | lg | icon`. (`frontend/src/components/ui/button.tsx`.)
- `cn` helper: `frontend/src/lib/utils.ts` line 4.
- `ThemeToggle`: `frontend/src/components/theme-toggle.tsx` — owns its own `localStorage`
  theme state under `xyz.tinycloud.tinychat:theme`; multiple instances stay in sync because
  each reads the same key on mount and writes the `dark` class on `document.documentElement`.
  (Note: two mounted toggles will not live-update each other's *icon* on click, since each
  holds independent `useState`. See §5 Appearance for the chosen approach.)
- `lucide-react` icons already used: `PanelLeftIcon`, `BrainIcon`, `LogOutIcon`, `ChevronDownIcon`,
  `LockIcon`, `MoonIcon`, `SunIcon`, `UploadIcon`, `PlusIcon`, `Trash2Icon`. New icons this
  feature may use: `SettingsIcon` (gear), `ArrowLeftIcon` (back), `UserIcon`, `DatabaseIcon`,
  `CreditCardIcon` — all from `lucide-react`, no new dep.

### Billing data shapes (`frontend/src/lib/billingApi.ts`)
- `BillingConfig { paywallEnabled, tiers }` (19–22).
- `BillingStatus { tier, usage, subscription }` (38–42).
- `BillingUsage { used, limit, resetsAt }` (24–29).
- `BillingSubscription { status, interval, ... }` (31–...).
- `formatCredits` is already imported into App (line 27).

### Build / lint / test entry points (`package.json`)
- Build frontend: `bun --bun run build:frontend` (delegates to `bun run --cwd frontend build`).
- Lint: `bun run lint` (`eslint .`).
- Real-auth Playwright: `bun run test:real-auth` (`bun run --cwd test real-auth`).

### gitignore (`/.gitignore`)
- Already ignores transient audit dirs: `.memory-audit/`, `.credits-audit/`, `.weekly-audit/`,
  `.responsive-audit/`, `.fresh-history-audit/`, `.stream-audit/` (under the "Smithers
  memory-feature audit artifacts (transient)" block). The new `.settings-audit/` line goes in
  this same block (T6).

---

## 3. Target design

### 3.1 Settings page layout

A single scrollable column rendered into `<main>` (replacing the `ChatWorkspace` slot while
the settings route is active — see §4 routing). Structure, outer-to-inner:

- Page scroll container: `h-full overflow-y-auto`.
- Centered content column: `mx-auto w-full max-w-2xl px-4 py-6 sm:px-6` — comfortable at
  390px (full-bleed minus padding) and at 1280px (capped at `max-w-2xl`, ~672px, centered).
- **Top bar (back affordance):** a row at the top of the column with a back control on the
  left and the page title "Settings". Back is an `outline`/`ghost` `Button size="sm"` with an
  `ArrowLeftIcon` + visible "Back to chat" label (icon-only at `<sm` is acceptable but the
  button MUST keep an accessible name via `aria-label="Back to chat"`). Clicking it runs the
  back handler (§4).
- **Section cards:** each section is a `<section>` rendered as a card:
  `rounded-lg border border-border bg-card p-4` (matches the existing card idiom; dark+light
  via CSS vars). Each card has a header row: an `h2` (`text-sm font-semibold tracking-tight`)
  with a leading lucide icon (`text-muted-foreground`), optional one-line muted subtitle, then
  the section body. Vertical rhythm between cards: `space-y-4` (or `flex flex-col gap-4`).
- Sections render top-to-bottom in this order: **Account → Memory → Data → Plan & Usage →
  Appearance**. Plan & Usage renders only when `paywallEnabled` (see §3.4).

The page matches the existing visual language: shadcn-ish cards, existing `Button` variants,
lucide icons, CSS-var-driven colors (so dark mode is automatic). No new colors, no new
spacing scale.

### 3.2 Section contents & where each relocated control lands

**Account** (icon `UserIcon`)
- Connection details, surfaced *inline* (not a `<details>` popover): a small status row
  (the colored dot + `stateLabel(state)` text from the existing `stateLabel` helper) followed
  by three labeled rows — Address, DID, Space — reusing the `Row` look (label left, mono
  truncated value right). The current `error` string renders below in `text-destructive` when
  present. These come from App state `address / did / spaceId / state / error`.
- **Sign out** button (`outline`, with `LogOutIcon` + "Sign out" label) at the bottom of the
  card, calling App's `signOut`. Keep the `aria-label="Sign out"`.
- After `signOut` the app transitions to `unauthenticated`; the settings route then guards and
  redirects to `/chat` (§4 signed-out guard), so the user lands back on the boot/sign-in surface.

**Memory** (icon `BrainIcon`)
- The existing `MemoryPanel` rendered **inline** in this card (no popover host). MemoryPanel's
  logic is reused verbatim; only its *outer container styling* is made variant-aware so the
  inline copy is not a floating `bg-popover` panel with its own border/shadow but instead fills
  the card. See §5 for the exact refactor (a `variant` / `inline` prop — do NOT fork the file).
- Props passed: `tcw`, `memoryRef`, `onMemoryUpdated`. The popover-only props (`onClose`,
  `onDirtyChange`) are omitted/no-op inline — without `onClose`, MemoryPanel already hides its
  "Close" button (line 244 `{onClose && ...}`), which is correct for an always-open inline panel.
- The header **brain button (`MemoryPopover`) is removed** from the header. The `memoryPanelOpen`
  state and the `MemoryPopover` component become dead and are deleted (T3).

**Data** (icon `DatabaseIcon` or `UploadIcon`)
- The **Import trigger moves here** from `ThreadList`. `ImportDialog` is rendered in this card
  with `{ tcw, onImported }`. Its self-contained `DialogTrigger` button shows here as the entry
  point; the dialog itself opens as a modal (unchanged). A one-line muted description
  ("Bring your Claude conversation history into this space.") sits above it.
- `ThreadList` no longer renders `ImportDialog` (T4). `ThreadList`'s `onImported` prop becomes
  unused by the list itself; App keeps passing `onImported` down to the settings page instead.
  (The `key={importRefreshKey}` remount on `ChatWorkspace` still works: `onImported` lives in
  App, above the route boundary — see §5.)

**Plan & Usage** (icon `CreditCardIcon`) — **only when `paywallEnabled`**
- Inline tier + usage: current tier label (`capitalize(status.tier)`), and when
  `usage.limit > 0`, a `used / limit` line (use `formatCredits(usage.limit)` to match the
  existing popover format, lines 748–749) plus a thin progress bar (same `bg-primary` /
  `bg-destructive` near-limit treatment as `UsageIndicator`) and a "Resets <date>" line via
  the existing `formatResetsAt` logic (move it to a shared spot or duplicate the tiny helper —
  it is pure formatting, not store logic, so duplication is allowed; see §7).
- Two buttons: **"Manage plan"** → App's `openPricing` (opens `PricingDialog`, which refreshes
  status first — line 339–342). **"How credits work"** → App's `openRates` (opens `RatesDialog`).
- When the paywall is **off** (`!paywallEnabled`), this entire section does **not render**
  (mirrors the header chip's gating). No empty card.
- The desktop usage chip (`UsageIndicator`) in the header is **unchanged** and stays
  desktop-only (`≥sm`) — see §3.3. The 402 auto-open path (App 307–312) is untouched.

**Appearance** (icon `SunIcon`/`MoonIcon`)
- A theme control mirrored for mobile users (who lose the header toggle at `<sm`). Renders a
  labeled row: "Theme" + a control that toggles light/dark. Implementation: reuse the existing
  `ThemeToggle` button (it self-syncs via localStorage + the `dark` class), placed beside a
  "Theme" label. This is intentionally redundant with the header toggle on desktop; that is
  fine and the simplest correct option. (See §7 for the live-icon-sync caveat — acceptable.)

### 3.3 Header end-states

Let `signedIn = isReady`, `signedOut = state ∈ {unauthenticated, recoverableError}`.

Left group is the same at all widths: hamburger (`md:hidden`, only when `signedIn`), "T" badge
(title `hidden sm:inline`), `ModelPicker` (only when `signedIn`).

Right group, by breakpoint:

| Width | Signed IN | Signed OUT |
|---|---|---|
| **`<640px`** (mobile) | **Settings gear only** (3 controls total with hamburger + model picker). No usage chip, no theme toggle, no brain, no connection details, no sign-out. | **Sign in / Try again button only.** (No gear, no theme toggle.) |
| **`640–767px`** (sm, `<md`) | Usage chip (if `paywallEnabled`) · theme toggle · settings gear. Hamburger still shows (`md:hidden`). No brain, no connection details, no sign-out. | Theme toggle · Sign in button. |
| **`≥768px`** (md+) | Usage chip (if `paywallEnabled`) · theme toggle · settings gear. Sidebar is inline (grid), hamburger hidden. No brain, no connection details, no sign-out. | Theme toggle · Sign in button. |

Control-by-control end-state:
- **Sidebar hamburger:** unchanged — `md:hidden`, signed-in only.
- **Model picker:** unchanged, signed-in, all widths.
- **Usage chip (`UsageIndicator`):** **desktop-only — `≥sm`.** Wrap its header render in a
  `hidden sm:flex`/`sm:block` container (or add the responsive class to the indicator root).
  Behavior unchanged: hover popover + click → `PricingDialog`. Gated on
  `isReady && paywallEnabled` as today.
- **Theme toggle:** **stays in header at `≥sm`, hidden at `<640`** (`hidden sm:inline-flex` on
  its wrapper). Mirrored into the Appearance settings section for mobile.
- **Settings gear:** **new.** Shown when `signedIn` (`isReady`). An `outline` `size="icon"`-ish
  button (`h-8 w-8 p-0`, matching the hamburger's sizing) with `SettingsIcon` and
  `aria-label="Settings"`. Navigates to `/chat/settings` (§4). Shown at **all** widths when
  signed in (it is the mobile catch-all and a convenient desktop entry too).
- **Brain / Memory popover:** **removed from header at all widths** (moves to Memory section).
- **Connection details `<details>`:** **removed from header at all widths** (moves to Account
  section).
- **Sign out:** **removed from header at all widths** (moves to Account section).
- **Sign in / Try again button:** **stays in header**, signed-out only, all widths (unchanged,
  lines 496–500).

Net mobile signed-in header = hamburger + model picker + gear = exactly 3 controls. ✔

### 3.4 Responsive & a11y notes
- Works at 390×844 and 1280×800. The settings column is `max-w-2xl` centered with side padding.
- Every icon-only button keeps an accessible name (`aria-label`): gear "Settings", back
  "Back to chat", sign-out "Sign out", theme "Toggle theme" (existing).
- Dark + light both covered by CSS vars; no literal colors introduced.
- The settings page is reachable by keyboard (gear is a `Button`); back button is focusable.

---

## 4. Routing plan

### 4.1 Nested routes inside `App`
`main.tsx` keeps `/chat/*` → `<App />` (no change). Inside `App`, replace the single
`<main>` body's content with a nested `<Routes>` so that both the chat workspace and the
settings page render **under the same providers and the same `App` component instance** — chat
state stays mounted.

Constraint: `ChatWorkspace` owns the `AssistantRuntimeProvider` (App line 1152) and the
`useChatRuntime` hook. To "stay mounted when navigating to settings and back", the runtime tree
must NOT unmount when the settings route is active. Two acceptable shapes — **the spec mandates
shape (A)**:

**(A) Keep `ChatWorkspace` always mounted; overlay settings.** Render `ChatWorkspace`
unconditionally (when `isReady`), and render the settings page as a sibling that is shown when
the path is `/chat/settings`, with the workspace hidden (not unmounted) behind it. Concretely,
use the router location to decide which is *visible*:

```tsx
// inside App <main>, when isReady && tcw:
const showSettings = useLocation().pathname === "/chat/settings"; // or endsWith
// ChatWorkspace stays mounted; toggle visibility with a wrapper class.
<div className={showSettings ? "hidden" : "contents"}>
  <ChatWorkspace ... />
</div>
{showSettings && <SettingsPage ... />}
```

This guarantees the runtime/provider and all chat state survive a settings round-trip (no
remount, no thread reload), which a `<Routes>` swap of the workspace element would not.

Rationale for (A) over a literal `<Route>` swap: a `<Routes>` that renders `ChatWorkspace` for
`/chat` and `SettingsPage` for `/chat/settings` would unmount `ChatWorkspace` (and the
`AssistantRuntimeProvider` + `useChatRuntime`) on navigation, contradicting the requirement
that "chat state stays mounted." Visibility toggling keeps it mounted. `useLocation()` requires
`App` to be inside the `BrowserRouter` (it is — `main.tsx` line 10) and is the navigation hook.

> Note: this uses `useLocation`/`useNavigate` rather than nested `<Route>` elements for the
> *workspace-vs-settings* decision, specifically to preserve mount state. This is a deliberate
> deviation from a naive "nested Routes" reading of the requirement; it satisfies the actual
> intent (same providers, chat stays mounted). If a future maintainer prefers `<Routes>`, they
> must add `<Outlet>`-based layout that keeps the runtime above the route boundary — out of
> scope here.

### 4.2 Gear navigation
The header gear calls `navigate("/chat/settings")` from `useNavigate()` (App is inside the
router). Gear renders only when `isReady`.

### 4.3 Back-to-chat
The settings page back button calls a handler that prefers history-back and falls back to an
explicit chat route:
```tsx
const navigate = useNavigate();
const backToChat = () => navigate(-1);     // history back
// If there's no in-app history entry to go back to (e.g. deep link / refresh on
// /chat/settings), fall back to /chat. Implement as:
//   if (window.history.state && window.history.idx > 0) navigate(-1); else navigate("/chat");
// or simply navigate("/chat") if keeping it dead-simple — see acceptance criteria T1.
```
Spec choice: attempt `navigate(-1)`; if the resulting location is still `/chat/settings`
(no history), fall back to `navigate("/chat")`. A pragmatic, well-supported implementation is:
guard on `window.history.state?.idx` (react-router v7 stamps an `idx`); when `idx === 0` go to
`/chat`, else `navigate(-1)`. Both back paths land on the chat surface with the thread still
mounted (per §4.1).

### 4.4 Signed-out guard
When the settings route is active but `!isReady` (signed out, booting, or error), the page must
not show. Because of shape (A), the `{showSettings && <SettingsPage/>}` branch is only reached
inside the `isReady && tcw` block — so the `BootSurface` already renders for signed-out users
regardless of path. As a belt-and-suspenders guard, `SettingsPage` itself (and/or the App-level
branch) redirects: if `!isReady` while `pathname === "/chat/settings"`, call
`navigate("/chat", { replace: true })` in an effect. This covers the post-sign-out case (user
is on settings, hits Sign out → `state` flips to `unauthenticated` → effect redirects to
`/chat`).

---

## 5. State / wiring plan

`SettingsPage` is a **new file** `frontend/src/chat/SettingsPage.tsx`. All data flows in as
props from `App` (no new global state, no context beyond what exists). This keeps `App.tsx`
from growing — the per-section JSX lives in `SettingsPage`.

### 5.1 `SettingsPage` props
```ts
interface SettingsPageProps {
  // Account
  address: string | null;
  did: string | null;
  spaceId: string | null;
  state: AppState;             // for the status dot + stateLabel
  error: string | null;
  onSignOut: () => void;       // App.signOut

  // Memory
  tcw: TinyCloudWeb;           // non-null in the signed-in branch
  memoryRef: React.MutableRefObject<string | null>;
  onMemoryUpdated: (doc: string | null) => void;

  // Data / Import
  onImported: () => void;      // App.onImported (already remounts ChatWorkspace via key)

  // Plan & Usage (paywall-gated)
  paywallEnabled: boolean;
  billingStatus: BillingStatus | null;
  onManagePlan: () => void;    // App.openPricing (refreshes status, opens PricingDialog)
  onOpenRates: () => void;     // App.openRates

  // Navigation
  onBack: () => void;          // §4.3 back handler
}
```
`AppState` and `BillingStatus` are imported from their existing sources (`AppState` is declared
in `App.tsx` — export it, or re-declare a structural type; spec choice: **export `AppState`
from `App.tsx`** so `SettingsPage` imports it). `BillingStatus` imports from
`@/lib/billingApi`.

Notes on what is NOT passed: `billingConfig`, `billingRef`, `pricingOpen/ratesOpen` stay in
`App` — the dialogs remain rendered by `App` (lines 535–550) and are merely *opened* via the
`onManagePlan` / `onOpenRates` callbacks. This keeps the 402 auto-open and `?billing=` flows in
one place, untouched.

### 5.2 App.tsx changes (per task; see §6)
- Add `useNavigate` + `useLocation` (from `react-router-dom`) in `App`.
- Add `SettingsIcon` import; remove `BrainIcon` import once `MemoryPopover` is deleted.
- Header right-group: add gear (T1), remove brain (T3), remove `ConnectionDetails` (T2), remove
  sign-out (T2), wrap usage chip + theme toggle in responsive `hidden sm:*` wrappers (T5/T6).
- `<main>`: introduce the visibility-toggle + `<SettingsPage>` render (T1, then filled in by
  later tasks).
- Delete `MemoryPopover` component + `memoryPanelOpen` state (T3). Delete `ConnectionDetails` +
  `Row` + (keep `stateLabel` — reused by Account section; move it or export it) (T2).
- Export `AppState` (T1).
- Keep `signOut`, `openPricing`, `openRates`, `onImported`, `refreshBillingStatus`,
  `memoryRef`, `onMemoryUpdated`, billing state — all reused, none deleted.

### 5.3 MemoryPanel refactor (do NOT fork logic)
Add a single presentational prop to `MemoryPanel` to support the inline (in-card) layout
without floating-popover chrome:
```ts
// MemoryPanelProps additions:
variant?: "popover" | "inline";   // default "popover" (current behavior unchanged)
```
- `variant="popover"` (default): root keeps today's classes
  (`...rounded-lg border border-border bg-popover p-3 shadow-lg ...` line 229) and
  `role="dialog" aria-modal`.
- `variant="inline"`: root drops `bg-popover`, `border`, `shadow-lg`, fixed width, and the
  `role="dialog"/aria-modal/aria-labelledby` modal semantics (it is not a modal inline); it
  fills its container (`w-full`, no max-width clamp, no `max-h ...overflow` clamp or a looser
  one). The header keeps the title + subtitle; the Close button is already conditional on
  `onClose` (line 244) so omitting `onClose` inline hides it — correct.
- All save/revert/clear/dirty logic, the budget meter, the AlertDialogs, and the
  `getMemory/setMemory/clearMemory` calls are **unchanged**. Only the root `className` and the
  modal ARIA attributes branch on `variant`. The settings Memory section renders
  `<MemoryPanel variant="inline" tcw memoryRef onMemoryUpdated />`.

This is a light, presentational refactor — `frontend/src/components/MemoryPanel.tsx` logic is
not duplicated and not behaviorally altered for the existing popover caller.

### 5.4 ThreadList change
Remove the `<ImportDialog .../>` render at `ThreadList.tsx` line 90. Leave the `onImported`
prop on `ThreadList`'s signature (now unused by the list) **or** remove it from the signature
and from both call sites in `ChatWorkspace` (App 1155, 1167–1170). Spec choice: **drop the
now-dead `onImported` from `ThreadList`'s props and its two `ChatWorkspace` call sites** to
avoid an unused-prop lint warning — but keep `App.onImported` (it is still passed to
`SettingsPage`). `ChatWorkspace` no longer needs `onImported` in its props/deps either; remove
it there too. (Verify ESLint passes after; if removing trips other usages, fall back to keeping
the prop and marking it intentionally unused.)

---

## 6. Atomic task breakdown (T1–T6)

Each task is independently buildable in order and leaves `bun --bun run build:frontend` and
`bun run lint` green. File allowlists are exhaustive — touching a file not listed is out of
scope for that task.

---

### T1 — Route + SettingsPage scaffold + gear button
**Files (allowlist):**
- `frontend/src/App.tsx`
- `frontend/src/chat/SettingsPage.tsx` (new)

**Steps:**
1. Export `AppState` from `App.tsx` (change `type AppState` → `export type AppState`).
2. Import `useNavigate`, `useLocation` from `react-router-dom`; import `SettingsIcon` from
   `lucide-react` in `App.tsx`. Add `const navigate = useNavigate()` and a `location`.
3. Create `frontend/src/chat/SettingsPage.tsx` exporting `SettingsPage` with the props from
   §5.1 (sections may be empty placeholder cards for now: render the top bar with the
   "Back to chat" button wired to `onBack`, the page title, and five empty section cards with
   their headers/icons — Account, Memory, Data, Plan & Usage [render only if `paywallEnabled`],
   Appearance). Use `max-w-2xl mx-auto px-4 py-6` column + `rounded-lg border border-border
   bg-card p-4` cards.
4. In `App`'s `<main>`, when `isReady && tcw`, keep `ChatWorkspace` mounted and add the
   visibility toggle + `{showSettings && <SettingsPage .../>}` per §4.1 shape (A).
   `showSettings = location.pathname` ends with `/chat/settings`. Pass all props (placeholders
   acceptable where sections are empty — but pass the real `onBack` and `onSignOut`,
   `paywallEnabled`).
5. Add the **settings gear** button to the header right-group, shown when `isReady`,
   `aria-label="Settings"`, `onClick={() => navigate("/chat/settings")}`,
   classes `h-8 w-8 p-0` (`outline`, `size="sm"`).
6. Implement `onBack` (§4.3: try `navigate(-1)` with `/chat` fallback on no-history).
7. Add the signed-out guard effect in `SettingsPage` (redirect to `/chat` when `!isReady` while
   on the settings path) OR rely on the App branch (since `SettingsPage` only mounts in the
   `isReady` block, add the redirect in `App` for the post-sign-out flip). Spec choice: put the
   redirect-on-`!isReady` effect in `App` guarding the settings branch.

**Acceptance:** With a signed-in session, the header shows a Settings gear; clicking it shows
the settings page (empty cards + working "Back to chat"); back returns to chat with the active
thread still mounted; signing out / loading `/chat/settings` while signed out lands on `/chat`.
Build + lint green.

---

### T2 — Account section (connection details + sign out moved out of header)
**Files (allowlist):**
- `frontend/src/App.tsx`
- `frontend/src/chat/SettingsPage.tsx`

**Steps:**
1. In `SettingsPage`, fill the Account card: status dot + `stateLabel(state)` text; Address /
   DID / Space rows (label + mono truncated value); `error` in `text-destructive` when set;
   a **Sign out** `outline` button (`LogOutIcon` + "Sign out", `aria-label="Sign out"`) →
   `onSignOut`.
2. Make `stateLabel` available to `SettingsPage`: export it from `App.tsx` (or move it into a
   tiny shared spot). Spec choice: **export `stateLabel` from `App.tsx`** and import it into
   `SettingsPage`. Reproduce the `Row` look inline in `SettingsPage` (small local helper) since
   `Row` is being removed from `App` in this task.
3. In `App.tsx` header: **remove** `<ConnectionDetails .../>` (lines ~489–495) and the
   sign-out `<Button>` (lines ~501–512). Delete the now-unused `ConnectionDetails` and `Row`
   components. Keep `stateLabel` (now exported). Keep `signOut` (passed as `onSignOut`).
4. Ensure `address/did/spaceId/state/error/signOut` are passed from `App` into `SettingsPage`.

**Acceptance:** Header no longer shows the connection-details dot/details or a sign-out button
at any width. The Account card shows status + address/DID/space + a working Sign out that
returns the user to the signed-out chat surface. Build + lint green (no unused
`ConnectionDetails`/`Row`).

---

### T3 — Memory section (MemoryPanel inline + brain button removed)
**Files (allowlist):**
- `frontend/src/App.tsx`
- `frontend/src/chat/SettingsPage.tsx`
- `frontend/src/components/MemoryPanel.tsx`

**Steps:**
1. Add the `variant?: "popover" | "inline"` prop to `MemoryPanel` (§5.3). Branch only the root
   `className` and the modal ARIA attrs on it; default `"popover"` preserves current behavior.
2. In `SettingsPage`, render `<MemoryPanel variant="inline" tcw memoryRef onMemoryUpdated />`
   inside the Memory card (no `onClose`, no `onDirtyChange`).
3. In `App.tsx`: **remove** the `<MemoryPopover .../>` from the header (lines ~478–487), delete
   the `MemoryPopover` component (lines ~570–675), delete the `memoryPanelOpen` state (line 93)
   and its setter usages (sign-out sets it at line 424 — remove that line), and remove the now-
   unused `BrainIcon` import and `hasMemory`/`memoryVersion`/`onMemoryUpdated`-only-for-the-dot
   plumbing **only if** nothing else uses them. NOTE: `onMemoryUpdated` is still needed (passed
   to `ChatWorkspace` line 525 and now to `SettingsPage`), so keep it and `bumpMemoryVersion`;
   `hasMemory`/`memoryVersion` were only for the brain dot — they may be removed if unused after
   the popover deletion. Verify with lint.

**Acceptance:** No brain/Memory button in the header at any width. The Memory card renders the
full memory editor inline (view/edit/save/revert/clear, budget meter, unsaved-changes banner),
fills the card (no floating popover chrome), and a save round-trips (reopen shows saved text).
Build + lint green.

---

### T4 — Data section (Import trigger moved from ThreadList)
**Files (allowlist):**
- `frontend/src/chat/SettingsPage.tsx`
- `frontend/src/chat/ThreadList.tsx`
- `frontend/src/App.tsx`

**Steps:**
1. In `SettingsPage`, render `<ImportDialog tcw onImported={onImported} />` inside the Data
   card, with a one-line muted description above it.
2. In `ThreadList.tsx`: remove the `<ImportDialog .../>` render (line 90) and the `ImportDialog`
   import (line 23). Per §5.4, drop the now-dead `onImported` from `ThreadList`'s props.
3. In `App.tsx` `ChatWorkspace`: remove `onImported` from the two `<ThreadList>` call sites
   (1155, 1167–1170) and from `ChatWorkspace`'s props/deps if it is no longer used by the list
   — but keep `App`-level `onImported` and `importRefreshKey` (still wired to the
   `ChatWorkspace` `key` and passed to `SettingsPage`). If removing `onImported` from
   `ChatWorkspace` props cascades awkwardly, leave the prop in place but unused — lint must stay
   green either way.

**Acceptance:** The Import entry point is gone from the thread list (sidebar) and present in the
settings Data card; importing still opens the dialog, runs, and the `onImported` callback still
remounts the workspace (imported threads appear). Build + lint green.

---

### T5 — Plan & Usage section (inline tier/usage + manage/rates buttons; usage chip desktop-only)
**Files (allowlist):**
- `frontend/src/chat/SettingsPage.tsx`
- `frontend/src/App.tsx`

**Steps:**
1. In `SettingsPage`, render the Plan & Usage card **only when `paywallEnabled`**. Show tier
   (`capitalize(status.tier)`), and when `status.usage.limit > 0`: a `used / limit` line
   (`formatCredits` for the limit), a progress bar (primary, destructive when `≥90%`), and a
   "Resets <date>" line. Add a small local `capitalize` + resets-date formatter in
   `SettingsPage` (pure formatting; do not import from store/billing logic beyond
   `formatCredits` which is already a billingApi helper). Two buttons: "Manage plan" →
   `onManagePlan`, "How credits work" → `onOpenRates`.
2. Pass `paywallEnabled`, `billingStatus`, `onManagePlan` (= `App.openPricing`),
   `onOpenRates` (= `App.openRates`) from `App` into `SettingsPage`.
3. In `App.tsx` header: make the `UsageIndicator` **desktop-only** — wrap its render in a
   `hidden sm:flex`/`sm:block` container (or add a responsive class). Behavior otherwise
   unchanged; still gated on `isReady && paywallEnabled`.
4. **Do not touch** the 402 handler (lines 307–312), `?billing=` handler (317–337),
   `PricingDialog`/`RatesDialog` renders (535–550), or `refreshBillingStatus`/`openPricing`/
   `openRates` logic.

**Acceptance:** With the paywall on, the settings Plan & Usage card shows the current tier +
usage + resets and the two buttons open the existing Pricing/Rates dialogs (status refreshes on
Manage plan). With the paywall off, the card does not render. The usage chip no longer appears
in the header below `sm`; at `≥sm` it is unchanged (hover popover + click → Pricing). The 402
auto-open still works. Build + lint green.

---

### T6 — Appearance mirror + final header declutter + polish
**Files (allowlist):**
- `frontend/src/App.tsx`
- `frontend/src/chat/SettingsPage.tsx`
- `.gitignore`

**Steps:**
1. In `SettingsPage`, fill the Appearance card: a "Theme" labeled row with a `<ThemeToggle />`
   beside it (mirror for mobile). Import `ThemeToggle` into `SettingsPage`.
2. In `App.tsx` header: make the header `<ThemeToggle />` **`≥sm` only** — wrap it in a
   `hidden sm:inline-flex` container (mobile users use the Appearance section instead).
3. Verify the final mobile (`<640`) signed-in header is exactly: hamburger + model picker +
   gear (3 controls). Verify signed-out mobile header is exactly the Sign in / Try again button.
   Adjust header `gap`/spacing classes only if needed for the reduced control count (keep the
   existing `gap-1.5 sm:gap-2` idiom).
4. Edge cases: signed-out users never see the gear (already guarded in T1); booting/error
   states render `BootSurface` (no settings). Confirm the settings column is comfortable at
   390px (no horizontal scroll) and 1280px (centered, capped).
5. Add `.settings-audit/` to `.gitignore` inside the existing "Smithers ... audit artifacts
   (transient)" block (alongside `.responsive-audit/`, `.fresh-history-audit/`, etc.).

**Acceptance:** Mobile signed-in header = exactly 3 controls; theme is switchable on mobile via
the Appearance section; theme toggle hidden in the header below `sm` and present `≥sm`; no
horizontal scroll at 390px; centered column at 1280px; `.settings-audit/` ignored. Build +
lint green.

---

## 7. Ground rules / forbidden

**Never edit the logic of (imports are fine, edits are NOT):**
- `frontend/src/chat/runtime.tsx`
- `frontend/src/lib/threadStore.ts`
- `frontend/src/lib/historyPrefetch.ts`
- `frontend/src/lib/chatApi.ts`
- `frontend/src/lib/billingApi.ts`
- `frontend/src/lib/memory.ts`
- `frontend/src/lib/claudeImport.ts`
- anything under `backend/**`

**Forbidden:**
- No new dependencies. (Gear/back/section icons come from the already-installed `lucide-react`;
  routing from the already-installed `react-router-dom` v7.16.)
- No Tailwind config changes — Tailwind v3.4 only, existing shadcn CSS vars / `dark` class.
- No changes to the desktop (`≥768`) chat grid layout (`md:grid-cols-[260px_1fr]`, sidebar
  inline) except the header right-group swap described here.
- Do not alter the 402 paywall auto-open (App 307–312), the `?billing=` redirect handler
  (317–337), or the dialog renders/props (535–550).
- Do not fork `MemoryPanel` logic — only add the presentational `variant` prop.
- Provider-agnostic copy: never name a model or provider in any settings UI string. Memory,
  Import, and Plan copy must stay generic ("the assistant", "premium models", "AI"). The
  existing `TIER_TAGLINE`/copy already follows this — do not regress it.

**Preserve (a11y + test selectors):**
- Every icon-only button keeps an accessible name (`aria-label`): gear "Settings", back
  "Back to chat", sign-out "Sign out", theme "Toggle theme".
- Preserve existing Playwright selectors that the real-auth suite relies on: composer
  placeholder **"Message TinyCloud Chat…"**, the **Send** button accessible name, the sidebar
  **New chat** / chat-row buttons, and the **Sign in** button. None of these are touched by
  this feature, but verify a grep before finishing (T6).
- Pure formatting helpers (`capitalize`, resets-date formatter) may be duplicated into
  `SettingsPage` — they are not store/business logic. `formatResetsAt`/`formatCompact` live in
  `App.tsx` today; either export the ones you reuse or re-create the trivial date formatter
  locally. Do **not** import formatting from the forbidden `lib/*` logic files beyond
  `formatCredits` (a billingApi public helper already used by App).

---

## 8. Verification plan

### 8.1 Build & lint (every task, in order)
```bash
bun --bun run build:frontend     # must succeed
bun run lint                     # eslint . — must be clean (no unused vars/props)
```
After each task T1–T6, both must pass before moving on.

### 8.2 Real-auth Playwright checks (T6 / final)
Environment (per repo convention): logged-in Chrome profile at `.auth/chrome-profile`, dev
server on `https://localhost:5186`; land on the landing page → click **"Open app"**; allow
~15s for boot/session-restore to settle before asserting.

Run at two viewports: **390×844** (mobile) and **1280×800** (desktop).

Checks:
1. **Header control count (390×844, signed in):** exactly three interactive controls in the
   header — the sidebar hamburger ("Open chat list"), the model picker ("Model"), and the
   settings gear ("Settings"). Assert no theme toggle, no usage chip, no brain/Memory, no
   connection-details, no Sign out in the header at this width.
2. **Header (1280×800, signed in):** model picker + (paywall on) usage chip + theme toggle +
   gear present; no brain/connection-details/sign-out; hamburger hidden (`md`).
3. **Gear → settings nav:** clicking the gear shows the settings page (back button + the
   section cards). URL is `/chat/settings`.
4. **Each section renders:** Account (status + address/DID/space + Sign out), Memory (inline
   editor with textarea + Save), Data (Import entry point), Plan & Usage (only if paywall on:
   tier + Manage plan + How credits work), Appearance (Theme + toggle).
5. **Memory edit round-trip:** in the Memory section, type into the textarea, Save, navigate
   back to chat and return to settings → the saved text is present (reads back from the memory
   doc).
6. **Back-to-chat preserves thread:** open a thread in chat, go to settings via the gear, click
   "Back to chat" → the same thread is still open/mounted (no reload, no thread reset).
7. **Sign out from settings:** Account → Sign out → lands on the signed-out chat surface
   (`/chat`), gear gone, "Sign in" button present in header.
8. **Import moved:** the sidebar/thread list no longer shows an Import button; the Data section
   does. (Do not run a full import in the smoke check — just assert the trigger's location.)
9. **Selector regression grep** (static, not browser): confirm the composer placeholder
   "Message TinyCloud Chat…", the Send button name, and the sign-in / new-chat selectors are
   unchanged in the source.

Manual dark/light pass: toggle theme in the Appearance section on mobile and confirm the
settings cards render correctly in both themes.
