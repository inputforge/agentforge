# Design Guidelines

## Product Direction

**AgentForge** is a local control surface for spawning AI coding agents in isolated git worktrees. The interface should feel like an operations console: dense, direct, terminal-native, and built for repeated use while agents run.

The design avoids marketing-page patterns, decorative hero sections, rounded cards, large illustrative art, purple gradients, and generic SaaS softness. The first screen is the working kanban board.

---

## Aesthetic Direction

**Terminal Forge**: a dark industrial monospace UI with sharp rectangular panels, compact controls, cold cyan highlights, and semantic status colors. The product is a tool, not a landing page.

Core principles:

- Keep information dense but scannable.
- Prefer explicit panel boundaries over spacious page sections.
- Use icons for compact actions and text labels for commands that need clarity.
- Make running state, branch context, and agent output visible without navigation friction.
- Preserve the terminal feel across board, modals, agent views, and diff views.

---

## Color

Design tokens live in `src/frontend/index.css` under `@theme`. Use Tailwind utilities generated from these tokens (`bg-forge-black`, `text-forge-accent`, `border-forge-border`, etc.) instead of hard-coded colors in components.

| Token                          | Hex       | Use                                      |
| ------------------------------ | --------- | ---------------------------------------- |
| `--color-forge-black`          | `#080706` | App background and deep terminal areas   |
| `--color-forge-dark`           | `#0f0e0c` | Column drop zones and dark containers    |
| `--color-forge-panel`          | `#0f0e0c` | Headers, fixed bars, modal shells        |
| `--color-forge-surface`        | `#1a1918` | Cards, inputs, selectable blocks         |
| `--color-forge-surface-bright` | `#201f1d` | Hover and active surface states          |
| `--color-forge-border`         | `#1f1e1c` | Standard borders and dividers            |
| `--color-forge-border-bright`  | `#2e2d2b` | Higher-emphasis borders                  |
| `--color-forge-accent`         | `#67e8f9` | Brand, primary actions, focus, selection |
| `--color-forge-accent-dim`     | `#0e3a40` | Dim accent backgrounds                   |
| `--color-forge-text`           | `#ede8df` | Primary text                             |
| `--color-forge-text-bright`    | `#f5f0e8` | High-emphasis text                       |
| `--color-forge-text-dim`       | `#6e6860` | Secondary labels and metadata            |
| `--color-forge-text-muted`     | `#3d3a36` | Disabled, empty, and low-emphasis text   |

Semantic colors:

| Token                 | Use                       |
| --------------------- | ------------------------- |
| `--color-forge-blue`  | Running agents            |
| `--color-forge-amber` | Waiting, setup, attention |
| `--color-forge-green` | Done, live, additions     |
| `--color-forge-red`   | Error, offline, deletions |

Do not substitute similar Tailwind palette utilities (`text-blue-400`, `bg-red-500`) unless a third-party renderer requires it and no token hook exists.

---

## Typography

All interface text uses JetBrains Mono from `@fontsource/jetbrains-mono`. The app does not use separate display, serif, or proportional UI fonts.

| Role             | Class pattern                                    | Use                                  |
| ---------------- | ------------------------------------------------ | ------------------------------------ |
| Product wordmark | `text-[13px] uppercase tracking-tight font-mono` | Header brand                         |
| Panel labels     | `text-xs uppercase tracking-widest`              | Headers, metadata, tabs, status      |
| Body/UI text     | `text-xs` or `text-sm`                           | Cards, modal content, controls       |
| Descriptions     | `text-xs leading-relaxed text-forge-text-dim`    | Ticket descriptions and setup detail |
| Button text      | `text-xs uppercase tracking-widest`              | Command buttons                      |

Keep type compact. Do not introduce hero-scale type inside the app shell. Avoid negative letter spacing.

---

## Layout

The app is full-height and panel-based:

- Root app: `h-full flex flex-col bg-forge-black overflow-hidden`
- Header: fixed `h-10`, `bg-forge-panel`, bottom border
- Kanban board: horizontal scroll, `flex gap-3`, `px-4 py-3`
- Kanban columns: `min-w-[280px] max-w-[320px]`, bordered header plus bordered drop zone
- Agent detail route: full-height split workbench with fixed top command bar
- Modals: centered fixed overlay with `bg-black/70`, compact max width, no rounded corners

Prefer fixed, stable dimensions for operational surfaces. Hover states must not resize cards, buttons, columns, terminals, or headers.

---

## Logo

The wordmark is typographic in `src/frontend/components/layout/Header.tsx`.

```text
AGENT  -> forge text
FORGE  -> forge accent
▍      -> forge accent, blink animation
```

Use all caps, JetBrains Mono, `text-[13px]`, `tracking-tight`. Do not replace it with an image unless the entire brand system changes.

---

## Core Components

Shared component classes live in `src/frontend/index.css`.

### Panels

Use `.forge-panel` for fixed bars and modal shells:

```css
bg-forge-panel border border-forge-border
```

Use `.forge-surface` for cards, launcher options, inputs grouped as blocks, and selected content surfaces:

```css
bg-forge-surface border border-forge-border
```

### Buttons

All buttons are rectangular, monospace, uppercase, and compact.

| Class                | Use                                      |
| -------------------- | ---------------------------------------- |
| `.forge-btn-primary` | Primary creation or confirmation actions |
| `.forge-btn-ghost`   | Header controls and secondary commands   |
| `.forge-btn-danger`  | Destructive or kill/discard actions      |

Button icons should come from `lucide-react` when available. Keep icon sizes around `10-15px` in dense controls.

### Inputs

Use `.forge-input` for text inputs, selects, and terminal-adjacent form controls:

```css
bg-forge-surface border border-forge-border text-forge-text
focus:border-forge-accent
```

Inputs should be full-width by default. Use explicit compact widths only in headers or branch selectors.

### Labels

Use `.forge-label` for small uppercase panel labels. Labels should be terse: `CREATE TICKET`, `SELECT AGENT`, `DIFF`, `TERMINAL`, `TICKET`.

---

## Kanban Board

The board is the primary workspace. It should remain visible and usable as the first screen.

Columns:

- Order is defined by `COLUMN_ORDER`.
- Column metadata is defined by `COLUMN_META`.
- Each column header uses an icon, uppercase label, count, and dashed divider.
- Empty columns display `EMPTY` centered in muted text.

Ticket cards:

- Use `.forge-surface`, no rounded corners.
- Title is bright, description is dim, IDs are muted.
- Card actions appear on hover to reduce noise.
- Running tickets require a confirm step before discard.
- Agent status badges use semantic border/text color plus a status dot.

Drag behavior:

- Mouse drag activates after 8px movement.
- Touch drag uses a short hold.
- Drag overlays may rotate slightly, but should keep the same card proportions.

---

## Agent Workbench

The agent detail view is a full-screen workbench, not a drawer layered over the board.

Header requirements:

- Show `AGENT`, branch or ticket title, and status badge.
- Keep branch selector, commit/rebase/merge/relaunch/close actions compact.
- Use semantic status colors consistently.

Content requirements:

- Agent output and shell tabs should preserve terminal readability.
- Diff panel should use the dark renderer theme and file-level collapses for large diffs.
- Generated-file diffs should remain visually distinct from normal source diffs.
- Resizable panels must preserve stable minimum sizes and avoid overlap.

Agent launcher:

- Center the ticket context and agent choices in a narrow column.
- Show Codex setup state before enabling Codex launch.
- Custom commands should be explicit and compact.

---

## Terminal And Diff

Terminal surfaces use `xterm.js`. Global scrollbars are 6px, but `.xterm .xterm-viewport` overrides its scrollbar width to avoid terminal measurement drift.

Diff rendering uses `@pierre/diffs` with:

- `theme: "pierre-dark"`
- `diffStyle: "unified"`
- file headers supplied by AgentForge, not the renderer
- lazy expansion for large files

Use green for additions and red for deletions. Keep file paths monospace, truncated when needed.

---

## Motion

Animations are CSS-only and defined in `src/frontend/index.css`.

| Animation                 | Use                                 |
| ------------------------- | ----------------------------------- |
| `animate-blink`           | Header cursor and offline indicator |
| `animate-fade-in`         | Modal/overlay entry                 |
| `animate-slide-in-right`  | Agent launcher/workbench entry      |
| `animate-slide-in-bottom` | Bottom sheets or terminal overlays  |
| `animate-status-blink`    | Running and waiting status dots     |
| `.codex-*` keyframes      | Codex panel thinking/final states   |

Keep transitions short: `duration-100` for controls, `duration-300` only where a larger panel state benefits from it.

---

## Texture

The app uses a fixed SVG grain overlay in `body::after`:

- `position: fixed`
- `pointer-events: none`
- `opacity: 0.04`
- `z-index: 9999`

Do not add decorative orbs, bokeh blobs, gradients, or background illustrations. The visual texture should stay subtle and should never interfere with terminal text.

---

## Icons

Use `lucide-react` for interface icons:

- Header: `Plug`, `TerminalSquare`, `Plus`
- Columns: `Inbox`, `CirclePlay`, `Eye`, `Check`
- Cards/actions: `Play`, `Trash2`, `ChevronRight`
- Agent workbench: branch, commit, merge, terminal, refresh, close

Use `@icons-pack/react-simple-icons` only for brand/integration marks such as GitHub and Linear.

---

## Architecture Notes

- Frontend entry: `src/frontend/main.tsx`
- App routes: `src/frontend/App.tsx`
- Board components: `src/frontend/components/kanban-board/`
- Agent route: `src/frontend/pages/AgentPage.tsx`
- Agent workbench: `src/frontend/components/AgentDetailPanel.tsx`
- Global styles and Tailwind v4 theme: `src/frontend/index.css`
- Shared state: `src/frontend/store/`
- API client: `src/frontend/lib/api.ts`

Tailwind v4 is configured through CSS, not a `tailwind.config.*` file. Add or modify design tokens in `src/frontend/index.css`; do not scatter local color constants through components.

---

## Implementation Rules

- Maintain rectangular geometry: no rounded cards, pills, or soft containers.
- Keep the palette dark and warm with cyan as the only brand accent.
- Use semantic colors only for state, risk, and diffs.
- Prefer compact icon buttons for obvious actions and text+icon buttons for commands.
- Keep UI text short and operational.
- Do not add explanatory feature copy inside the app shell.
- Preserve keyboard/terminal ergonomics when changing panels or overlays.
- Verify dense views at narrow widths before shipping changes to headers, cards, modals, or split panels.
