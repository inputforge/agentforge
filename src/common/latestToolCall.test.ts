import { describe, expect, it } from "vitest";

import { latestToolCall } from "./latestToolCall.ts";
import type { AcpToolCall } from "./types.ts";

function call(over: Partial<AcpToolCall> & Pick<AcpToolCall, "id">): AcpToolCall {
  return {
    inputSummary: null,
    kind: "execute",
    location: null,
    resultSummary: null,
    status: "running",
    title: "t",
    ...over,
  };
}

describe("latestToolCall", () => {
  it("returns undefined for an empty list", () => {
    expect(latestToolCall([])).toBeUndefined();
  });

  it("returns the only call when there is one", () => {
    const only = call({ id: "a", seq: 1 });
    expect(latestToolCall([only])).toBe(only);
  });

  it("picks the highest seq, regardless of array order", () => {
    const early = call({ id: "a", seq: 1 });
    const late = call({ id: "b", seq: 5 });
    const middle = call({ id: "c", seq: 3 });

    expect(latestToolCall([early, late, middle])?.id).toBe("b");
    expect(latestToolCall([late, early, middle])?.id).toBe("b");
  });

  it("does not favor the most recently updated call over the most recently started one", () => {
    // tool_call_update never bumps seq, so a call that STARTED earlier but finished later
    // must not win — seq order reflects start order, and that is the intended ranking.
    const startedFirst = call({ id: "a", seq: 1, status: "completed" });
    const startedSecond = call({ id: "b", seq: 2, status: "running" });

    expect(latestToolCall([startedFirst, startedSecond])?.id).toBe("b");
  });

  it("treats a missing seq as 0, so a real seq always wins", () => {
    const noSeq = call({ id: "a" });
    const withSeq = call({ id: "b", seq: 1 });

    expect(latestToolCall([noSeq, withSeq])?.id).toBe("b");
  });

  it("breaks a tie by preferring the later array entry", () => {
    const first = call({ id: "a", seq: 2 });
    const second = call({ id: "b", seq: 2 });

    expect(latestToolCall([first, second])?.id).toBe("b");
  });
});
