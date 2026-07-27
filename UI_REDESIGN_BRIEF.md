# UI/UX Redesign — Brief for the design pass

**Status:** awaiting a design plan. Written 2026-07-27 after Terry rejected the
Phase 9 pass as "almost exactly the same, slightly different layout."

That judgement is correct and this document exists so the next attempt does not
repeat the mistake.

---

## 1. What went wrong the first time

Phase 9 of `IMPROVEMENT_PLAN.md` was executed as literally specified: dark mode,
design tokens, mobile resource cards, sticky section nav, emoji removal, one
overlay primitive. Every item was delivered and verified.

**None of it was design.** It was hygiene. The app has the same visual language
it had before — the same flat cards, the same uniform spacing, the same absence
of hierarchy — only tidier. Tidier is not the same as designed.

The brief was "make it look better." The items under it were structural. Nobody
made a decision about how this thing should *look*, so it still looks like
nobody did.

---

## 2. The root cause — read this before proposing anything

```
1,078   inline style={{ }} objects
   31   components containing them
    3   shared UI components (Sheet, ConfirmProvider, NavigationGuard)
  114   CSS classes total
```

Every card, gap, radius, font size and border in this app is re-decided at the
call site. There is no component layer. Consequences:

- **There is nothing to restyle.** A new visual direction cannot be applied
  centrally, because no two cards are built the same way.
- **Consistency cannot be maintained.** It was never enforced by structure, only
  by whoever wrote each block remembering what the last one looked like.
- **A design plan is unbuildable as written** unless it accounts for this. Handing
  over "use 12px radius and a 4px baseline grid" means editing a thousand style
  objects by hand, and the drift returns with the next feature.

**Any credible plan must sequence the component layer first, or simultaneously.**
Extract real `<Card>`, `<Button>`, `<Field>`, `<Table>`, `<Stack>` primitives that
own their own styling, migrate the call sites to them, and *then* the visual
direction becomes a change in a handful of files instead of a thousand.

This is the single highest-value thing to get right. Skip it and the third
attempt will land where the second one did.

---

## 3. What the app is, and who uses it

A daily field-reporting app for a **Resident Engineer on a City of San Diego
water/sewer construction project** (Morena Conveyance North, job C-346).

The user is one person: Terry. He is not a casual user — he lives in this app
daily and knows exactly what he wants out of it. The output is a formal document
that goes to the City, so the app's own presentation is read as a proxy for the
seriousness of the work.

**Conditions it is used in:**
- Night shifts — crews work 6:30 PM to 5:00 AM. Screen glare is a real problem,
  not a preference.
- Outdoors, one-handed, sometimes with gloves on.
- Phone in the field, desktop for the heavy editing, Android APK as well as web.

**What he actually does in it:** dictates a report by voice, corrects what the AI
produced, enters crews and equipment into tables, exports to Word, and pushes
data into PMWeb. Plus the new Backfill wizard for rebuilding missed days from
scanned timesheets.

**His stated goal, in his words:** stop it looking like "a programming student's
latest project" and make it look like it was built by "a super smart super
talented web designer with 20 years of experience designing web apps and websites
for large companies."

---

## 4. What exists that is worth keeping

Do not throw these away; they are sound foundations, just not a design.

| Thing | Where | Note |
|---|---|---|
| Design token set | `index.css` `:root` | Full palette, shadows, radii, spacing, type. Values are debatable, the structure is right. |
| Dark theme | `index.css` `:root[data-theme="dark"]` | Complete parallel token set. |
| Theme switch | `lib/theme.ts`, `components/layout/ThemeToggle.tsx` | Light/Dark/Auto, pre-paint, no flash. Keep the mechanism whatever the palette becomes. |
| `Sheet` primitive | `components/ui/Sheet.tsx` | Bottom sheet on mobile, centred card on desktop. The one real component. |
| Confirm + toast | `components/ui/ConfirmProvider.tsx` | `useConfirm()` / `useToast()`. No browser dialogs remain anywhere. |
| Colour tokenisation | throughout | 140 hardcoded hexes were replaced with tokens. Both themes now work from one source. |
| lucide-react icons | throughout | Already the icon set. Monochrome, inherits currentColor. |

---

## 5. Hard constraints

- **React 19 + Vite + TypeScript.** No component library is installed. Adding one
  (shadcn, Radix, Mantine…) is a legitimate proposal — say so explicitly and
  account for bundle size; the bundle is already ~610 KB and warns at build.
- **Tailwind v4 is imported** (`@import "tailwindcss"`) but essentially unused —
  the app is inline styles plus hand-written CSS. Deciding whether to commit to
  Tailwind or drop it is a real fork in the road; do not leave it ambiguous.
- **Three surfaces from one build**: web, desktop (PyWebView shell loading the
  same URL), and an Android APK via Capacitor. Nothing may assume a mouse.
- **No click-outside-to-close on overlays.** Deliberate and non-negotiable —
  these hold half-entered field data.
- **44px minimum touch targets**, and inputs at 16px+ or iOS zooms the page on
  focus.
- `npm run build` must stay at zero TypeScript errors.
- The Word export (`backend/app/services/word.py`) defines the report's printed
  format. It is not part of this and must not change.

---

## 6. What the plan needs to actually decide

Phase 9 failed because it listed tasks instead of making decisions. This plan
should take a position on:

1. **Component architecture** — which primitives, what their API is, migration
   order. See §2; this is the load-bearing decision.
2. **Typography** — a real scale with intent. Currently Inter at a few ad-hoc
   sizes with no rhythm.
3. **Density and spatial system** — this is a data-entry tool used at speed. How
   dense? Where does whitespace earn its place?
4. **Hierarchy** — right now every card carries identical visual weight, so
   nothing looks more important than anything else. What leads?
5. **Colour with a point of view** — the current palette is a generic blue accent
   on grey. What should this *feel* like?
6. **The tables** — resource entry is the heart of the app and the hardest
   surface. Solve this specifically, not generically.
7. **What "professional" means concretely here** — name reference points.

---

## 7. Handing back for the build

Write the plan to `UI_REDESIGN_PLAN.md` in this directory. Then switch back and
say "build the UI redesign plan."

For the build to go well the plan should carry: the component inventory with
props, the token values, migration order with checkpoints that keep the app
shippable in between, and the specific screens that prove it worked.

Current state is committed and deployed on
`claude/daily-reports-app-review-pipd8j`. The Phase 9 work does not need
reverting — the token and theme infrastructure is reusable regardless of visual
direction — but that is the plan's call to make.
