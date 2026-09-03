import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import { pickNarrowestAllow } from "./AcpClientManager.ts";

type Options = RequestPermissionRequest["options"];

/**
 * The exact option list a live claude-agent-acp session offers for `ExitPlanMode`,
 * captured verbatim from a real run against `claude` on PATH. Order is load-bearing:
 * `bypassPermissions` is unshifted to index 0 for any non-root user, which is precisely
 * why "find the first allow option" was the wrong rule.
 */
const EXIT_PLAN_MODE_OPTIONS: Options = [
  { kind: "allow_always", name: "Yes, and bypass permissions", optionId: "bypassPermissions" },
  { kind: "allow_always", name: 'Yes, and use "auto" mode', optionId: "auto" },
  { kind: "allow_always", name: "Yes, and auto-accept edits", optionId: "acceptEdits" },
  { kind: "allow_once", name: "Yes, and manually approve edits", optionId: "default" },
  { kind: "reject_once", name: "No, keep planning", optionId: "plan" },
];

describe("pickNarrowestAllow", () => {
  it("never selects bypassPermissions, even when it is the first allow option", () => {
    const picked = pickNarrowestAllow(EXIT_PLAN_MODE_OPTIONS);

    expect(picked?.optionId).not.toBe("bypassPermissions");
    // `default` is the only non-mode-escalating allow on offer.
    expect(picked?.optionId).toBe("default");
  });

  it("rejects the mode-escalating allows even though they are allow_always", () => {
    const picked = pickNarrowestAllow(EXIT_PLAN_MODE_OPTIONS);

    expect(picked?.optionId).not.toBe("acceptEdits");
    expect(picked?.optionId).not.toBe("auto");
  });

  it("prefers allow_once over allow_always so authority does not persist", () => {
    const options: Options = [
      { kind: "allow_always", name: "Always allow Bash(git status:*)", optionId: "always" },
      { kind: "allow_once", name: "Allow once", optionId: "once" },
    ];

    expect(pickNarrowestAllow(options)?.optionId).toBe("once");
  });

  it("falls back to allow_always when that is the only grant offered", () => {
    const options: Options = [
      { kind: "allow_always", name: "Always allow", optionId: "always" },
      { kind: "reject_once", name: "No", optionId: "no" },
    ];

    expect(pickNarrowestAllow(options)?.optionId).toBe("always");
  });

  it("returns null when every allow option is a mode escalation", () => {
    const options: Options = [
      { kind: "allow_always", name: "Yes, and bypass permissions", optionId: "bypassPermissions" },
      { kind: "reject_once", name: "No, keep planning", optionId: "plan" },
    ];

    // Caller must reject rather than escalate — the old `?? options[0]` fallback is
    // exactly what handed out bypassPermissions.
    expect(pickNarrowestAllow(options)).toBeNull();
  });

  it("returns null rather than inventing a grant when no allow option exists", () => {
    const options: Options = [{ kind: "reject_once", name: "No", optionId: "no" }];

    expect(pickNarrowestAllow(options)).toBeNull();
  });

  it("handles the ordinary single-tool-call case", () => {
    const options: Options = [
      { kind: "allow_once", name: "Allow", optionId: "allow" },
      { kind: "reject_once", name: "Reject", optionId: "reject" },
    ];

    expect(pickNarrowestAllow(options)?.optionId).toBe("allow");
  });
});
