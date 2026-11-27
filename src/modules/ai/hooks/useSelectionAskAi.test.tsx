// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSelectionAskAi } from "./useSelectionAskAi";

let root: Root | undefined;
let current: ReturnType<typeof useSelectionAskAi>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mount() {
  function Harness() {
    current = useSelectionAskAi({
      captureActiveSelection: () => "selected text",
      askFromSelection: () => {},
    });
    return null;
  }

  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () => {
    root?.render(createElement(Harness));
  });
}

async function releaseMouseOn(className: string) {
  const area = document.createElement("div");
  area.className = className;
  const target = document.createElement("span");
  area.append(target);
  document.body.append(area);

  await act(async () => {
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    target.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        clientX: 80,
        clientY: 40,
      }),
    );
    await vi.runOnlyPendingTimersAsync();
  });
}

describe("useSelectionAskAi", () => {
  it("does not open the Ask AI popup for terminal selections", async () => {
    await mount();

    await releaseMouseOn("xterm");

    expect(current.askPopup).toBeNull();
  });

  it("keeps the Ask AI popup for editor selections", async () => {
    await mount();

    await releaseMouseOn("cm-editor");

    expect(current.askPopup).toEqual({ x: 80, y: 40 });
  });
});
