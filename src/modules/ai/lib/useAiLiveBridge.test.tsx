// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Live } from "../store/chatStore";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  newAgentTab: vi.fn(),
  live: undefined as Live | undefined,
  managedAgents: {
    register: vi.fn(),
    remove: vi.fn(),
    setPhase: vi.fn(),
  },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/modules/agents/store/managedAgentsStore", () => ({
  useManagedAgentsStore: {
    getState: () => mocks.managedAgents,
  },
}));
vi.mock("@/modules/terminal", () => ({
  findLeafCwd: vi.fn(),
  whenSessionReady: vi.fn().mockResolvedValue(undefined),
  writeToSession: vi.fn().mockReturnValue(true),
}));

import { useAiLiveBridge } from "./useAiLiveBridge";

describe("managed Claude agent launch", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mocks.invoke.mockReset().mockResolvedValue(undefined);
    mocks.newAgentTab.mockReset().mockReturnValue({ tabId: 12, leafId: 21 });
    mocks.live = undefined;
    mocks.managedAgents.register.mockReset();
    mocks.managedAgents.remove.mockReset();
    mocks.managedAgents.setPhase.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("marks the managed Claude tab with its agent type", async () => {
    function Probe() {
      useAiLiveBridge({
        setLive: (live) => {
          mocks.live = live;
        },
        activeId: 1,
        tabs: [],
        explorerRoot: "/workspace",
        launchCwd: null,
        home: null,
        openPreviewTab: () => {},
        newAgentTab: mocks.newAgentTab,
        terminalRefs: { current: new Map() },
      });
      return null;
    }

    await act(async () => root.render(createElement(Probe)));

    const agent = mocks.live?.spawnManagedAgent(
      "Review this change",
      "session-1",
    );

    expect(agent).toEqual({ tabId: 12, leafId: 21 });
    expect(mocks.newAgentTab).toHaveBeenCalledWith(
      "/workspace",
      "claude · Review this change",
      "claude",
    );
  });
});
