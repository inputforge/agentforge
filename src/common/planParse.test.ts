import { describe, expect, it } from "vitest";

import { parsePlan } from "./planParse.ts";

/**
 * The shape a real plan-mode session produced when asked to decompose work into
 * independently reviewable pieces. Trimmed, but the headings, the em dash separator and the
 * `**Depends on Unit 2**` line are verbatim — this is the format the parser exists for.
 */
const REAL_PLAN = `# OS notifications, Dock badge, and notification deep-linking

## Context

AgentForge is a Kanban board that spawns agents. Permission requests are auto-approved.

## Design decisions (assumptions — flag if any is wrong)

1. **Badge counts \`review\` tickets only.**

## Key existing seams to reuse (do not rebuild)

- **\`main.ts:162\` \`send(channel, ...args)\`** — the single main→renderer push path.

## Unit 1 — Backend: emit a notification when an agent dies

Add the missing else branch in \`handleAgentExit\`.

## Unit 2 — Electron: OS notification on agent finish/die, gated on unfocused

New \`src/electron/osNotifications.ts\`.

## Unit 3 — Deep-link: notification click opens the ticket

**Depends on Unit 2** (needs a notification to click). Deliberately scoped so no unemitted
event variant is ever committed.

## Unit 4 — Dock badge counting tickets needing attention

**Independently valuable and independent of Unit 3.** Reuses Unit 2's event tap.

## Verification

- \`bun run test\`

## Non-goals

- \`agentforge://\` URL scheme
`;

describe("parsePlan", () => {
  it("extracts only the Unit sections as work", () => {
    const plan = parsePlan(REAL_PLAN);

    expect(plan.units.map((u) => u.number)).toStrictEqual([1, 2, 3, 4]);
    // Context / Design decisions / Key seams / Verification / Non-goals are framing.
    expect(plan.units).toHaveLength(4);
  });

  it("reads the document title", () => {
    expect(parsePlan(REAL_PLAN).title).toBe(
      "OS notifications, Dock badge, and notification deep-linking",
    );
  });

  it("keeps the Context section as shared framing", () => {
    const { context } = parsePlan(REAL_PLAN);

    expect(context).toContain("auto-approved");
  });

  it("takes the unit title from after the em dash", () => {
    const plan = parsePlan(REAL_PLAN);

    expect(plan.units[0]!.title).toBe("Backend: emit a notification when an agent dies");
    expect(plan.units[1]!.title).toBe(
      "Electron: OS notification on agent finish/die, gated on unfocused",
    );
  });

  it("captures the body up to the next heading", () => {
    const plan = parsePlan(REAL_PLAN);

    expect(plan.units[0]!.body).toBe("Add the missing else branch in `handleAgentExit`.");
  });

  it("reads an explicit dependency", () => {
    const plan = parsePlan(REAL_PLAN);

    expect(plan.units[2]!.dependsOn).toStrictEqual([2]);
  });

  it("does not invent dependencies for independent units", () => {
    const plan = parsePlan(REAL_PLAN);

    expect(plan.units[0]!.dependsOn).toStrictEqual([]);
    expect(plan.units[1]!.dependsOn).toStrictEqual([]);
  });

  it("does not read 'independent of Unit 3' as a dependency", () => {
    // Unit 4's body says "independent of Unit 3" — the opposite of a dependency. Matching it
    // would chain work that was explicitly called out as parallel, destroying the
    // parallelism the batch model exists for.
    const plan = parsePlan(REAL_PLAN);

    expect(plan.units[3]!.dependsOn).toStrictEqual([]);
  });

  it("returns no units when the format does not match", () => {
    // The caller's signal to fall back to an LLM structuring pass.
    const plan = parsePlan("# Plan\n\nJust do the thing. No units here.\n");

    expect(plan.units).toStrictEqual([]);
    expect(plan.title).toBe("Plan");
  });

  it("returns nothing useful for an empty plan", () => {
    expect(parsePlan("")).toStrictEqual({ context: null, title: null, units: [] });
  });

  describe("separator tolerance", () => {
    it.each([
      ["em dash", "## Unit 1 — Do a thing"],
      ["en dash", "## Unit 1 – Do a thing"],
      ["hyphen", "## Unit 1 - Do a thing"],
      ["colon", "## Unit 1: Do a thing"],
      ["bare space", "## Unit 1 Do a thing"],
    ])("accepts %s", (_name, heading) => {
      const plan = parsePlan(`${heading}\n\nbody\n`);

      expect(plan.units).toHaveLength(1);
      expect(plan.units[0]!.title).toBe("Do a thing");
    });
  });

  describe("dependency forms", () => {
    it.each([
      ["bold singular", "**Depends on Unit 2**", [2]],
      ["plain singular", "Depends on Unit 2.", [2]],
      ["bold plural with and", "**Depends on Units 1 and 3**", [1, 3]],
      ["plural with comma", "Depends on Units 1, 2 and 3.", [1, 2, 3]],
      ["lowercase", "**depends on unit 2**", [2]],
    ])("reads %s", (_name, line, expected) => {
      const plan = parsePlan(`## Unit 9 — Thing\n\n${line}\n`);

      expect(plan.units[0]!.dependsOn).toStrictEqual(expected);
    });

    it("ignores a unit depending on itself", () => {
      const plan = parsePlan("## Unit 2 — Thing\n\n**Depends on Unit 2**\n");

      expect(plan.units[0]!.dependsOn).toStrictEqual([]);
    });

    it("dedupes a repeated dependency", () => {
      const plan = parsePlan(
        "## Unit 3 — Thing\n\nDepends on Unit 1.\n\nAgain: depends on Unit 1.\n",
      );

      expect(plan.units[0]!.dependsOn).toStrictEqual([1]);
    });
  });

  it("keeps non-sequential unit numbers as written", () => {
    // The numbers are referenced by dependsOn, so renumbering them would break the edges.
    const plan = parsePlan("## Unit 1 — A\n\nx\n\n## Unit 5 — B\n\n**Depends on Unit 1**\n");

    expect(plan.units.map((u) => u.number)).toStrictEqual([1, 5]);
    expect(plan.units[1]!.dependsOn).toStrictEqual([1]);
  });

  it("does not treat a deeper heading as a unit boundary mid-body", () => {
    const plan = parsePlan("## Unit 1 — A\n\nintro\n\n### Detail\n\nmore\n\n## Unit 2 — B\n\ny\n");

    expect(plan.units.map((u) => u.number)).toStrictEqual([1, 2]);
  });
});
