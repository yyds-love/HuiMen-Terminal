// @vitest-environment happy-dom

import type { UpdaterStatus } from "@/modules/updater/useUpdater";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AboutSection } from "./AboutSection";

const fixture = vi.hoisted(() => ({
  status: { kind: "idle" } as UpdaterStatus,
  repository: "example/terminal" as string | null,
  check: vi.fn(),
  install: vi.fn(),
  openUrl: vi.fn(),
}));
vi.mock("@/modules/updater", () => ({ useUpdater: () => fixture }));
vi.mock("@/modules/updater/releaseConfig", () => ({
  getReleaseRepository: () => fixture.repository,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: fixture.openUrl }));
vi.mock("@tauri-apps/api/app", () => ({
  getName: async () => "XuYa Terminal",
  getVersion: async () => "1.0.7",
}));
vi.mock("@tauri-apps/plugin-os", () => ({
  arch: () => "x86_64",
  platform: () => "windows",
}));
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.repository = "example/terminal";
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
async function render(status: UpdaterStatus) {
  fixture.status = status;
  await act(async () => root.render(createElement(AboutSection)));
}
function updateButton() {
  return container.querySelector("button");
}

describe("about update action", () => {
  it("opens the verified release URL for Linux manual updates", async () => {
    await render({
      kind: "manual-available",
      info: {
        version: "1.0.8",
        currentVersion: "1.0.7",
        body: "",
        releaseUrl: "https://github.com/example/terminal/releases/tag/v1.0.8",
      },
    });
    const button = [...container.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("更新至"),
    );
    await act(async () => button?.click());
    expect(fixture.openUrl).toHaveBeenCalledWith(
      "https://github.com/example/terminal/releases/tag/v1.0.8",
    );
    expect(fixture.check).not.toHaveBeenCalled();
  });
  it("permits a restart retry after installation", async () => {
    await render({ kind: "ready", message: "restart denied" });
    const button = [...container.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("重启"),
    );
    expect(button?.disabled).toBe(false);
    await act(async () => button?.click());
    expect(fixture.install).toHaveBeenCalledOnce();
  });
  it("disables checking and hides source links when no release channel is configured", async () => {
    fixture.repository = null;
    await render({ kind: "unconfigured" });
    expect(container.textContent).toContain("尚未配置更新");
    expect(updateButton()?.disabled).toBe(true);
    expect(container.textContent).not.toContain("xuya-dev");
  });
});
