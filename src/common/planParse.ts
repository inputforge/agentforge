/**
 * Turns a plan-mode plan into units of work.
 *
 * Claude Code's plan mode delivers its plan as markdown, via `ExitPlanMode`. It does *not*
 * emit ACP `plan` updates: those come only from `TodoWrite` (see acp-agent.js), and
 * TodoWrite is not in the tool set — verified against a live session, in both `plan` and
 * `default` mode. So a structured plan array is never populated (AcpAgentState carried one
 * for this reason and it has since been removed) and markdown is the only source.
 *
 * This is not "parsing arbitrary prose". We own the planning prompt, so we ask for the
 * shape below and parse exactly that. A real session, asked to decompose work into
 * independently reviewable pieces, produced it unprompted-as-to-format:
 *
 *     # OS notifications, Dock badge, and deep-linking
 *     ## Context
 *     ...
 *     ## Unit 1 — Backend: emit a notification when an agent dies
 *     ...
 *     ## Unit 3 — Deep-link: notification click opens the ticket
 *     **Depends on Unit 2** (needs a notification to click)
 *     ## Non-goals
 *     ...
 *
 * Only `## Unit N — Title` sections become tickets. Everything else (Context, Verification,
 * Non-goals) is framing, and is returned separately rather than silently dropped.
 *
 * A zero-unit result is the caller's signal to fall back to an LLM structuring pass: the
 * format drifted, the model changed, or the prompt was not followed. Deterministic first,
 * inference only when needed.
 */

/** One unit of work: becomes one ticket, one agent, one worktree, one review. */
export interface ParsedUnit {
  /** The N in `## Unit N`. Referenced by other units' `dependsOn`, so it is kept as-is. */
  number: number;
  title: string;
  /** Everything under the heading, up to the next `##`. Becomes the ticket description. */
  body: string;
  /** Unit numbers this one needs landed first. May reference a number that does not exist. */
  dependsOn: number[];
}

export interface ParsedPlan {
  /** The `# ` heading, if any. */
  title: string | null;
  /** The `## Context` section body — shared framing every unit's agent needs. */
  context: string | null;
  units: ParsedUnit[];
}

/**
 * `## Unit 3 — Deep-link: notification click opens the ticket`
 *
 * Accepts em dash, en dash, hyphen or plain whitespace as the separator: the prompt asks for
 * one, but a model choosing a different dash is not a reason to drop the unit. The title is
 * required — a bare `## Unit 3` names no work and is not a ticket.
 */
const UNIT_HEADING = /^##\s+Unit\s+(\d+)\s*(?:[—–-]|:)?\s*(.+?)\s*$/i;

/** Any `##`/`###`… heading — the boundary that ends a unit's body. */
const ANY_HEADING = /^#{1,6}\s/;

/** `# Title` — the document heading, not a section. */
const DOC_HEADING = /^#\s+(.+?)\s*$/;

/** `## Context` (any case), with or without trailing parenthetical. */
const CONTEXT_HEADING = /^##\s+Context\b/i;

/**
 * The `depends on unit(s)` phrase itself. Bold markers are not matched here — they are just
 * characters before/after the phrase, and trying to absorb them into one regex is what broke
 * the first attempt at this (`**Depends on Unit 2** (needs…)` matched nothing, because the
 * terminator could not span `** (`).
 */
const DEPENDS_PHRASE = /depends\s+on\s+units?\s+/gi;

/**
 * A list of unit numbers, anchored at the start: `2`, `1 and 3`, `1, 2 and 3`.
 *
 * Deliberately anchored and greedy so it consumes the whole list and stops at the first
 * thing that is not part of one. A lazy match stopped at the first comma and read
 * "Units 1, 2 and 3" as just unit 1 — silently dropping two edges of a dependency graph,
 * which would start work on a base missing its prerequisite.
 */
const NUMBER_LIST = /^(\d+(?:\s*(?:,|and)\s*\d+)*)/;

/**
 * Which units this body says must land first.
 *
 * Bold markers and plurals are tolerated because this is a semantic edge in a dependency
 * graph: missing one silently builds work on a base that lacks its prerequisite, which is
 * far worse than over-matching. Note that "independent of Unit 3" does not match — it has no
 * `depends on` phrase — which matters, because a real plan said exactly that about a unit it
 * had explicitly called out as parallel.
 */
function extractDependsOn(body: string, selfNumber: number): number[] {
  const found = new Set<number>();

  for (const phrase of body.matchAll(DEPENDS_PHRASE)) {
    const rest = body.slice(phrase.index + phrase[0].length);
    const list = NUMBER_LIST.exec(rest);
    if (!list) {
      continue;
    }
    for (const digits of list[1]!.matchAll(/\d+/g)) {
      const n = Number.parseInt(digits[0], 10);
      // A unit depending on itself is a model slip, not a cycle worth propagating.
      if (n !== selfNumber) {
        found.add(n);
      }
    }
  }

  // `.sort()` mutates, but `[...found]` is a fresh array with no other reference — nothing
  // to alias. `.toSorted()` would need an ES2023 lib bump not otherwise justified here.
  // oxlint-disable-next-line unicorn/no-array-sort
  return [...found].sort((a, b) => a - b);
}

/** Split into `## `-delimited sections, keeping each heading with its body. */
function sections(lines: string[]): { heading: string; body: string }[] {
  const out: { heading: string; body: string }[] = [];
  let current: { heading: string; body: string[] } | null = null;

  for (const line of lines) {
    if (ANY_HEADING.test(line) && !DOC_HEADING.test(line)) {
      if (current) {
        out.push({ body: current.body.join("\n").trim(), heading: current.heading });
      }
      current = { body: [], heading: line };
      continue;
    }
    current?.body.push(line);
  }
  if (current) {
    out.push({ body: current.body.join("\n").trim(), heading: current.heading });
  }
  return out;
}

export function parsePlan(markdown: string): ParsedPlan {
  const lines = markdown.split(/\r?\n/);

  const docHeading = lines.find((line) => DOC_HEADING.test(line) && !line.startsWith("##"));
  const title = docHeading ? (DOC_HEADING.exec(docHeading)?.[1] ?? null) : null;

  const parts = sections(lines);

  const contextPart = parts.find((p) => CONTEXT_HEADING.test(p.heading));
  const context = contextPart?.body || null;

  const units: ParsedUnit[] = [];
  for (const part of parts) {
    const match = UNIT_HEADING.exec(part.heading);
    if (!match) {
      continue;
    }
    const number = Number.parseInt(match[1]!, 10);
    units.push({
      body: part.body,
      dependsOn: extractDependsOn(part.body, number),
      number,
      title: match[2]!,
    });
  }

  return { context, title, units };
}
