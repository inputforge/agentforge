/**
 * Tests for the decision to interrupt the user with an OS notification.
 *
 * The gate is the whole feature: notify when you are away, stay quiet when you are not.
 * Getting it wrong in either direction is the failure — silence defeats the batch model,
 * and a banner over a focused window duplicates the in-app toast.
 *
 * `electron` is mocked wholesale: importing it outside an Electron process yields the
 * executable path, not the API. That is also why this is the first test under src/electron.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NotificationPayload } from "../common/types.ts";

const shown: { body: string; title: string }[] = [];
const clickHandlers: (() => void)[] = [];
let supported = true;

class FakeNotification {
  private options: { body: string; title: string };

  constructor(options: { body: string; title: string }) {
    this.options = options;
  }

  static isSupported(): boolean {
    return supported;
  }

  on(event: string, handler: () => void): this {
    if (event === "click") {
      clickHandlers.push(handler);
    }
    return this;
  }

  show(): void {
    shown.push(this.options);
  }
}

vi.mock("electron", () => ({
  Notification: FakeNotification,
  app: { getPath: () => "/tmp/agentforge-test" },
}));

const { notifyIfUnfocused } = await import("./osNotifications.ts");

/** Minimal stand-in for the bits of BrowserWindow the gate reads. */
function fakeWindow(state: { destroyed?: boolean; focused: boolean }) {
  return {
    isDestroyed: () => state.destroyed ?? false,
    isFocused: () => state.focused,
  } as unknown as Parameters<typeof notifyIfUnfocused>[1];
}

function payload(over: Partial<NotificationPayload> = {}): NotificationPayload {
  return { message: 'Agent on "Fix auth" finished', type: "agent-done", ...over };
}

describe("notifyIfUnfocused", () => {
  beforeEach(() => {
    shown.length = 0;
    clickHandlers.length = 0;
    supported = true;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("notifies when the window is unfocused", () => {
    notifyIfUnfocused(payload(), fakeWindow({ focused: false }), vi.fn());

    expect(shown).toHaveLength(1);
    expect(shown[0]!.title).toBe("Agent finished");
    expect(shown[0]!.body).toContain("Fix auth");
  });

  it("stays silent when the window is focused", () => {
    // The in-app toast already said it. A banner on top is what users file bugs about.
    notifyIfUnfocused(payload(), fakeWindow({ focused: true }), vi.fn());

    expect(shown).toHaveLength(0);
  });

  it("notifies when there is no window at all", () => {
    // The backend starts before the window exists, so a resumed agent can fail this early.
    // No window is the most unfocused a window can be.
    notifyIfUnfocused(payload(), null, vi.fn());

    expect(shown).toHaveLength(1);
  });

  it("notifies when the window is destroyed", () => {
    notifyIfUnfocused(payload(), fakeWindow({ destroyed: true, focused: true }), vi.fn());

    expect(shown).toHaveLength(1);
  });

  it("titles a failure differently from a completion", () => {
    notifyIfUnfocused(
      payload({ message: "Agent failed (exit 1)", type: "error" }),
      fakeWindow({ focused: false }),
      vi.fn(),
    );

    expect(shown[0]!.title).toBe("Agent failed");
  });

  it("ignores info chatter", () => {
    notifyIfUnfocused(payload({ type: "info" }), fakeWindow({ focused: false }), vi.fn());

    expect(shown).toHaveLength(0);
  });

  it("ignores merge-conflict", () => {
    // Emitted by the renderer when the user clicks MERGE, so they are present by
    // definition. It never reaches main's send, but the filter is explicit anyway.
    notifyIfUnfocused(payload({ type: "merge-conflict" }), fakeWindow({ focused: false }), vi.fn());

    expect(shown).toHaveLength(0);
  });

  it("does nothing when the OS does not support notifications", () => {
    supported = false;

    notifyIfUnfocused(payload(), fakeWindow({ focused: false }), vi.fn());

    expect(shown).toHaveLength(0);
  });

  it("routes a click to the payload's ticket", () => {
    const onClick = vi.fn();

    notifyIfUnfocused(payload({ ticketId: "t-42" }), fakeWindow({ focused: false }), onClick);
    expect(clickHandlers).toHaveLength(1);
    clickHandlers[0]!();

    expect(onClick).toHaveBeenCalledWith("t-42");
  });

  it("registers no click handler when there is no ticket to open", () => {
    // A notification with nowhere to go must not present itself as clickable.
    notifyIfUnfocused(payload(), fakeWindow({ focused: false }), vi.fn());

    expect(shown).toHaveLength(1);
    expect(clickHandlers).toHaveLength(0);
  });
});
