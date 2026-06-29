---
name: mission-control-theming
description: Use when adding, creating, editing, or restyling a visual theme/skin in the agents-mission-control repo (this repo's `packages/web` RPG "party board" dashboard) — a new palette, light mode, CRT/retro look, or changed fonts/atmosphere. Repo-specific; does not apply to other projects.
---

# Mission Control Theming

> **Scope: this repository only.** Specific to `agents-mission-control` — the
> exact files, token names, and class names below exist only in this repo's
> `packages/web`. It is a project skill (committed under `.claude/skills/`) so it
> loads only here. Do NOT apply it to any other project's frontend.

## Overview

A theme is BOTH a **palette** and a **language**. Two pieces:
- **Look** — `styles.css` is token-driven; one CSS custom-property block under `[data-skin="<id>"]` re-themes the whole app (palette, frames, bars, glows, buttons). Glows derive from color tokens via `color-mix`, so you only set base colors.
- **Words** — `lexicon.ts` holds per-skin terminology; components render terms from the active lexicon (via `useLex()`), so switching themes re-words the UI (FF "heroes/quests/gil/In battle" ↔ Terminal "processes/jobs/credits/RUNNING"). Never hardcode flavor words in a component.

The active skin is `document.documentElement.dataset.skin`, driven by the `skin` user pref (persisted in `localStorage["mc.prefs"]`, switchable in the ⚙ Options drawer).

## The 5 edit points

To add a skin `<id>`:

1. **`packages/web/src/prefs.ts`** — add the id to the `Skin` union and a `{ id, label }` entry to `SKINS`.
2. **`packages/web/src/styles.css`** — add a `[data-skin="<id>"] { … }` token block (copy the `[data-skin="ff"]` block, change values). All tokens below are required.
3. **`packages/web/src/lexicon.ts`** — add a `Lexicon` object and register it in `LEXICONS[<id>]` (copy the `ff` lexicon, reword every term in your theme's voice). `LEXICONS` is typed `Record<Skin, Lexicon>` so a missing entry is a type error; `lexicon.test.ts` also fails if any term is missing.
4. **`packages/web/src/styles.css`** (optional) — add `[data-skin="<id>"] body::before` / `body::after` for the page backdrop (stars, scanlines, vignette). Atmosphere is per-skin; omit for a flat background.
5. **`packages/web/src/index.html`** (only if using new fonts) — add the family (with the weights the UI uses) to the Google Fonts `<link>` href.

Then `bun run build:web` (required — the server serves the built bundle).

## Token reference (all required)

| Token | Role |
|---|---|
| `--bg0`, `--bg1` | page background base / secondary |
| `--ink`, `--ink-dim`, `--ink-faint` | text: primary / secondary / tertiary |
| `--gold`, `--gold-deep`, `--gold-glow` | accent (level, gil/cost, selection cursor). MUST contrast the card bg |
| `--win-top`, `--win-bot` | card/panel gradient (the "window") |
| `--win-edge` | inner edge + chip/control borders; glows derive from it |
| `--frame`, `--frame-dark` | card border / outer ring + shadow tone |
| `--hp`, `--hp-low`, `--mp` | HP bar (full/low) and XP bar fill |
| `--battle`, `--awaiting`, `--ko`, `--resting` | status colors (in-battle / awaiting orders / KO / resting). Card glows are `color-mix`ed from these |
| `--btn-top`, `--btn-bot` | raised control gradient (nav, icon-btn, cmd) |
| `--chip-bg` | facet chip background |
| `--overlay` | modal/drawer backdrop (darkening veil) |
| `--sunken` | recessed surfaces: bar grooves, inputs, quest strip, chips-in-card |
| `--radius` | corner radius (FF=8px; sharper retro=4px) |
| `--font-pixel` | **logo only** (`.brand`) — may be a display/pixel face |
| `--font-display` | headings, labels, stat numbers (rendered 600–700 weight) |
| `--font-body` | everything else |

## Keep the metaphor intact

Colors carry meaning — pick them semantically, not just prettily:
- HP = remaining **context** headroom (drains as a session nears its window). `--hp` should read "healthy", `--hp-low` "danger".
- XP bar = level progress from **tools used + quests**; `--mp` is its fill.
- `--gold` = gil (cost) and level — the "treasure" accent.
- Status: `--battle` active/processing, `--awaiting` blocked-on-user (also the pulsing glow), `--ko` errored, `--resting` idle.

## Readability rules (do not skip)

- **`--font-pixel` is logo-only.** Decorative/pixel fonts are unreadable on data; `--font-display`/`--font-body` must be legible at 11–15px. Reserve novelty for `.brand`.
- **Contrast:** `--ink` on the `--win-top`→`--win-bot` gradient, and `--gold` on it, must be clearly readable. Check the dim/faint inks too.
- **Light themes:** the default dark grooves live in `--sunken`/`--overlay`. A light skin MUST override both to a *translucent dark tint* (e.g. `--sunken: rgba(74,52,19,.1)`, `--overlay: rgba(40,30,14,.5)`) or inputs/bars become muddy black patches. Also pick a dark `--frame`/`--frame-dark` so card borders show on a light bg.
- **Glow visibility on light backgrounds:** card glows and the awaiting pulse are `color-mix(... , transparent)` of the status colors — on a pale `--win-top` they wash out. For light skins, make `--battle`/`--awaiting`/`--ko` deeper and more *saturated* than you would on black so the glows still read. Verify the awaiting pulse is visible on an actual card.
- **Fonts:** when adding a family to the `index.html` link, request the weights the UI uses — headings render at **600–700** (e.g. `Spectral:wght@400;500;600;700`), or they'll fall back. `--radius` is a free style choice (FF 8px, sharp/retro 4px).
- Honor motion: the awaiting pulse already respects `prefers-reduced-motion`; don't add box-shadow keyframe animations (they repaint/flicker — use opacity on an overlay).

## Verify (required)

1. `bun run build:web`
2. With the dev server up (`bun run dev`, port 7777), switch to the new skin via the ⚙ Options drawer, or set it directly:
   `localStorage["mc.prefs"]` → set `"skin":"<id>"`, reload.
3. Eyeball **desktop and mobile (≤640px)**: text readable everywhere, bars/glows visible, frames contrast the bg, no muddy patches. Confirm the **wording** changed too (nav, stat labels, status tags, search placeholder) — not just colors. Screenshot if reviewing with the user.

## Worked example: the `terminal` skin (green-phosphor CRT)

Shipped reference — read `[data-skin="terminal"]` in `styles.css` and the `terminal` lexicon in `lexicon.ts`. It demonstrates everything: a full palette swap (blue→green, white frame→phosphor green, gold→amber), `--radius: 4px`, a different `--font-pixel` (`VT323`, added to the `index.html` font link), a custom atmosphere (green vignette on `body::before` + CRT **scanlines** via `repeating-linear-gradient` on `body::after`), AND a full re-wording (party→processes, hero→process, quest→job, gil→credits, In battle→RUNNING, Sage→Daemon, HP→CTX). Registered in both `SKINS` (`prefs.ts`) and `LEXICONS` (`lexicon.ts`). That is the entire diff for a new theme.

## Common mistakes

| Mistake | Fix |
|---|---|
| Forgot to register in `prefs.ts` | Skin won't appear in Options; add to `Skin` union + `SKINS` |
| Theme only recolors, words stay FF | You didn't add a `LEXICONS[<id>]` entry in `lexicon.ts` (or a component hardcodes a flavor word instead of `useLex()`) |
| `lexicon.test.ts` fails | Your lexicon is missing a term — copy the `ff` lexicon and reword every field |
| Edited source but UI unchanged | Run `bun run build:web` — server serves `dist/` |
| New font not showing | Add the family to the `index.html` Google Fonts `<link>` |
| Light theme looks muddy | Override `--sunken` and `--overlay` (default to dark) |
| Unreadable headings | You put a display/pixel face in `--font-display`/`--font-body`; keep those legible, pixel only in `--font-pixel` |
| Glows look wrong color | They `color-mix` from `--battle/--awaiting/--ko/--win-edge/--mp` — fix those base tokens, not the component |
