# Mobile responsiveness audit — focus-zoom & keyboard overlap

Branch: `feature/mobile-responsive` (worktree off `feature/mobile-app`).

Scope: the two mobile defects reported — (1) tapping the message input zooms the
page in, (2) the on-screen keyboard then covers the input. Plus a sweep for the
same class of issue elsewhere.

The earlier `.responsive-audit` pass (Jun 5) covered the responsive *shell*
(header declutter, drawer, `h-dvh`, safe-area insets) but did **not** touch
either of these — its "composer does not fall behind chrome" note was about the
Safari URL bar, not the soft keyboard.

## Fixes

### 1. Focus-zoom on the message input
**Cause:** iOS Safari auto-zooms the page whenever a focused text field has a
computed `font-size < 16px`. The composer textarea was `text-sm` (14px).

**Fix:** `text-base sm:text-sm` on the composer textarea — 16px on mobile (no
zoom), 14px restored from the `sm` breakpoint up (desktop unchanged).
- `frontend/src/chat/Thread.tsx` (composer `ComposerPrimitive.Input`)
- `frontend/src/components/MemoryPanel.tsx` (memory textarea, same `text-xs` →
  `text-base sm:text-xs`)

Other text-entry fields were audited and need no change: `ImportDialog` only has
`type="file"`/`type="checkbox"` inputs (neither zooms); `ThreadList` and
`SettingsPage` have no text inputs; the model picker / usage chip are `<button>`s.

### 2. Keyboard overlapping the composer
**Cause:** `100dvh` (and the layout viewport) does **not** shrink when the iOS
soft keyboard opens — the keyboard is an overlay on top of the visual viewport,
so a `bottom-0` sticky composer sized to `dvh` ends up behind it.

**Fix:** size the app shell to the *visible* viewport.
- `frontend/src/lib/useVisualViewport.ts` (new) — mirrors
  `window.visualViewport.height`/`offsetTop` into CSS vars `--tc-app-height` /
  `--tc-app-offset`, coalesced to one `requestAnimationFrame` per burst, with
  listener cleanup. Falls back silently when the API is absent.
- `frontend/src/App.tsx` — calls the hook; root shell height changed from
  `h-dvh` to `style={{ height: "var(--tc-app-height, 100dvh)" }}` (CSS `dvh`
  remains the no-JS / SSR fallback).
- `frontend/index.html` — added `interactive-widget=resizes-content` to the
  viewport meta so Chrome/Android resizes the layout viewport (and `dvh`)
  natively when the keyboard opens; iOS ignores it and uses the JS hook.

When the keyboard opens, `visualViewport.height` shrinks → the hook updates
`--tc-app-height` → the flex shell (and the chat viewport / sticky composer
inside it) shrink to sit directly above the keyboard.

## Verification
- `tsc --noEmit` (frontend): clean.
- `vite build`: succeeds.
- Browser smoke at `/chat`: `--tc-app-height` resolves to the live
  `visualViewport.height`, the shell consumes it via the inline style, offset is
  `0px`, no horizontal overflow, zero console errors. (Headless Chrome can't
  raise a soft keyboard, so the keyboard *shrink* is proven by the reactive
  binding rather than an end-to-end keyboard event; the font-size fix is
  deterministic Tailwind CSS.)
