// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UpdaterDialog } from "./UpdaterDialog";
import type { UpdaterStatus } from "./useUpdater";

const fixture = vi.hoisted(() => ({
  status: { kind: "idle" } as UpdaterStatus,
  install: vi.fn(),
  dismiss: vi.fn(),
  openUrl: vi.fn(),
}));
vi.mock("./useUpdater", () => ({ useUpdater: () => fixture }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: fixture.openUrl }));
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  await act(async () => {
    for (const root of roots) root.unmount();
  });
  roots.length = 0;
  document.body.innerHTML = "";
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
async function render(status: UpdaterStatus) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.status = status;
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  roots.push(root);
  await act(async () => root.render(createElement(UpdaterDialog)));
}
describe("update dialog recovery", () => {
  it("shows an error if the Linux release page cannot be opened", async () => {
    fixture.openUrl.mockRejectedValueOnce(new Error("opener denied"));
    await render({
      kind: "manual-available",
      info: {
        version: "1.0.8",
        currentVersion: "1.0.7",
        body: "",
        releaseUrl: "https://github.com/example/terminal/releases/tag/v1.0.8",
      },
    });
    const button = [...document.querySelectorAll("button")].find((el) =>
      el.textContent?.includes("下载安装包"),
    );
    await act(async () => button?.click());
    expect(document.body.textContent).toContain("opener denied");
  });
  it("keeps an installation failure visible and offers retry", async () => {
    await render({
      kind: "error",
      message: "Signature verification failed",
      retryInstall: true,
    });
    expect(document.body.textContent).toContain(
      "Signature verification failed",
    );
    const button = [...document.querySelectorAll("button")].find((el) =>
      el.textContent?.includes("重试安装"),
    );
    expect(button).toBeDefined();
    await act(async () => button?.click());
    expect(fixture.install).toHaveBeenCalledOnce();
  });
  it("shows installation separately from download completion", async () => {
    await render({ kind: "installing" });
    expect(document.body.textContent).toContain("正在安装");
  });
  it("offers restart after automatic relaunch fails", async () => {
    await render({ kind: "ready", message: "restart denied" });
    const button = [...document.querySelectorAll("button")].find((el) =>
      el.textContent?.includes("立即重启"),
    );
    expect(button).toBeDefined();
    await act(async () => button?.click());
    expect(fixture.install).toHaveBeenCalledOnce();
  });
});
