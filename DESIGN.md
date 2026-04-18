# Design Guidelines

## Aesthetic Direction

**Terminal Forge** — a dark, industrial aesthetic built entirely on monospace type. Every element reinforces precision and intentionality: bitmap display type at large sizes, fixed-width body text, sharp rectangular UI, and a cold arc of ice blue on near-black.

The design avoids: rounded corners, purple gradients, Inter/system fonts, generic "developer tool" aesthetics.

---

## Color

Defined in `src/app/globals.css` under `@theme inline`. Reference via Tailwind utilities (`bg-background`, `text-accent`, `border-border`) or CSS variables (`var(--color-accent)`).

| Token                | Hex       | Use                                                  |
| -------------------- | --------- | ---------------------------------------------------- |
| `--color-background` | `#080706` | Page background — warm near-black                    |
| `--color-surface`    | `#0f0e0c` | Elevated surfaces (sections, cards)                  |
| `--color-foreground` | `#ede8df` | Primary text — warm off-white                        |
| `--color-muted`      | `#6e6860` | Secondary text, labels, inactive states              |
| `--color-border`     | `#1f1e1c` | Borders, dividers, decorative elements               |
| `--color-accent`     | `#67e8f9` | Ice blue — interactive elements, highlights, cursors |

**Background vs Surface**: `background` is the page base; `surface` is used for alternating sections and card interiors to create subtle depth without contrast shifts.

---

## Typography

All type is monospace. No serif or sans-serif fonts.

| Role      | Font           | Tailwind class | Use                                                       |
| --------- | -------------- | -------------- | --------------------------------------------------------- |
| Display   | Departure Mono | `font-display` | Section headings, hero headlines — **4xl and above only** |
| Body / UI | JetBrains Mono | `font-mono`    | All body copy, labels, nav, buttons, captions             |

**Font loading**: Departure Mono is a local font (`public/fonts/DepartureMono-Regular.woff2`) loaded via `next/font/local`. JetBrains Mono is loaded from Google Fonts via `next/font/google`. Both inject CSS variables (`--font-departure-mono`, `--font-jetbrains-mono`) referenced in `@theme inline`.

**Why `font-display` works**: `@theme inline { --font-display: ... }` causes Tailwind to inline the font stack directly into the generated utility class, avoiding a runtime CSS variable lookup that would fail since `@theme inline` doesn't emit `:root` custom properties.

### Type scale

- **Hero headline**: `text-[clamp(3rem,8vw,7rem)]` — fluid, fills available width
- **Section heading**: `text-4xl` to `text-5xl` — Departure Mono, uppercase
- **Decorative number**: `text-[7rem]` — faded section counter, `text-[var(--color-border)]`
- **Body**: `text-sm` (0.875rem) — JetBrains Mono, `leading-relaxed`
- **Labels / caps**: `text-[10px] uppercase tracking-[0.25em]` — prefixed with `//`
- **Buttons**: `text-xs uppercase tracking-[0.12em]`

---

## Layout

- Max content width: `max-w-6xl` with `px-6` horizontal padding
- Section vertical rhythm: `py-24` standard, `py-28 md:py-40` for hero
- Grid system: Tailwind grid utilities; cards use `md:grid-cols-2`, kanban uses `lg:grid-cols-4`

### Section structure

Every section follows the same header pattern:

```
// label text          ← font-mono, 10px, uppercase, tracked, muted, prefixed //
SECTION HEADING        ← font-display, 4xl+, uppercase
```

The decorative section counter (`01`, `02`, …) sits at the far right of the header row — `text-[7rem]`, `text-[var(--color-border)]`, `aria-hidden`, hidden on mobile.

---

## Logo

The wordmark is `src/components/logo.tsx` — a shared component used in Nav and Footer.

```
INPUT  ← Departure Mono, foreground (#ede8df)
FORGE  ← Departure Mono, accent (#67e8f9)
▍      ← Departure Mono, accent, .cursor-blink animation
```

All caps, `font-display`, `text-[13px]`, `tracking-tight`. No image — purely typographic.

The SVG logo asset lives at `public/logo.svg` (svgo-optimized). The source with Inkscape metadata is at `../logo.svg` (repo root, one level up from the website).

---

## Components

### Buttons

Two variants, both rectangular (no border-radius):

**Primary** — accent fill, inverts on hover:

```
border border-accent bg-accent text-background
hover: bg-transparent text-accent
```

**Secondary** — subtle border:

```
border border-border text-muted
hover: border-foreground/20 text-foreground
```

### Cards

```
border border-border bg-background p-8
hover: border-accent/40
```

Accent corner on hover — two absolute elements (1px horizontal line + 1px vertical line) at top-left, `opacity-0 → opacity-100` on `group-hover`.

### Section labels

Always `// label text` — lowercase, `text-[10px] uppercase tracking-[0.25em] text-[var(--color-muted)]`.

### Code blocks / install commands

```
border border-border bg-surface px-4 py-3 font-mono text-xs
```

Prefix with `$ ` in accent color, `select-none`.

### Feature lists

Bullet character: `→` in accent color. No checkmarks, no dots.

---

## Motion

All animations are CSS-only (no JS animation libraries). React Compiler is enabled — keep components free of manual memoization.

| Class              | Effect                                 | Use                               |
| ------------------ | -------------------------------------- | --------------------------------- |
| `.hero-label`      | fade-up, 0.5s, delay 0s                | Section label above hero headline |
| `.hero-line-1/2/3` | fade-up, 0.65s, delays 0.05/0.15/0.25s | Three staggered headline lines    |
| `.hero-sub`        | fade-up, 0.65s, delay 0.4s             | Divider + description paragraph   |
| `.hero-cta`        | fade-up, 0.65s, delay 0.55s            | CTA buttons                       |
| `.cursor-blink`    | step-end blink, 1.1s, infinite         | Nav logo cursor `▍`               |

Hover transitions: `transition-colors` or `transition-all duration-300` — no spring animations.

---

## Texture

A fixed SVG fractal noise grain overlay sits at `z-index: 9999`, `pointer-events: none`, `opacity: 0.04`. Applied via `body::after`.

Hero sections also use a radial dot grid background:

```css
background-image: radial-gradient(circle, #1f1e1c 1px, transparent 1px);
background-size: 28px 28px;
```

And a soft accent glow in the top-left corner:

```css
radial-gradient(circle, rgba(103,232,249,0.06) 0%, transparent 70%)
```

---

## Favicon

`src/app/icon.svg` — SVG favicon derived from `public/logo.svg`. Contains a `#080706` background rect so it renders correctly on both light and dark browser chrome. Next.js App Router serves this automatically as the primary favicon.

`src/app/favicon.ico` — multi-size ICO fallback (16×16, 32×32, 48×48), generated via Inkscape + ImageMagick from `../logo.svg` with `#080706` background.

To regenerate after logo changes:

```bash
inkscape --export-type=png --export-width=N --export-height=N --export-background='#080706' \
  --export-filename=/tmp/icon-N.png ../logo.svg   # repeat for 16, 32, 48
magick /tmp/icon-16.png /tmp/icon-32.png /tmp/icon-48.png src/app/favicon.ico
```

## Open Graph Images

Static image routes at `src/app/og/`, one per page:

| Route            | Page                    |
| ---------------- | ----------------------- |
| `/og/home`       | Input Forge homepage    |
| `/og/agentforge` | AgentForge product page |

Built with `ImageResponse` from `next/og`. All routes export `dynamic = "force-static"` — images are pre-rendered at build time. Rendered at 2400×1260 (2x) for retina sharpness; `OG_SIZE` export declares the meta tag dimensions as 1200×630.

Shared image builder: `src/lib/og.tsx`. Uses Departure Mono loaded via `fs.readFileSync` (not `fetch` — file URL fetching is not supported in Next.js build workers).

Layout per card: `INPUTFORGE▍` logo top-left · page name + label top-right · three-line headline centered · cyan divider + tagline at bottom.

---

## Architecture Notes

- Route group `(site)` contains all public pages. The shared layout at `src/app/(site)/layout.tsx` wraps every page with `<Nav>`, `<main>`, and `<Footer>` — pages export content only.
- Design tokens are in `globals.css` under `@theme inline` — edit there, not in component files.
- Tailwind v4: no `tailwind.config.*`. Use `bg-background`, `text-accent`, `border-border` etc. directly.
