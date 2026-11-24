// @vitest-environment happy-dom

import { deferred } from "@/modules/settings/__tests__/tauri";
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUpdater } from "./useUpdater";

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  relaunch: vi.fn(),
  getVersion: vi.fn(),
  config: { repository: "sample/terminal" as string | null },
}));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));
vi.mock("./native", () => ({
  installUpdate: (
    selected: { downloadAndInstall: (callback: unknown) => Promise<void> },
    callback: unknown,
  ) => selected.downloadAndInstall(callback),
}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: mocks.getVersion }));
vi.mock("@/lib/platform", () => ({ IS_LINUX: false }));
vi.mock("./releaseConfig", () => ({
  getReleaseRepository: () => mocks.config.repository,
}));

let current: ReturnType<typeof useUpdater>;
const roots = new Set<Root>();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  mocks.check.mockReset().mockResolvedValue(null);
  mocks.relaunch.mockReset().mockResolvedValue(undefined);
  mocks.getVersion.mockReset().mockResolvedValue("1.0.7");
  mocks.config.repository = "sample/terminal";
});
afterEach(async () => {
  await act(async () => {
    for (const root of roots) root.unmount();
    roots.clear();
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function mount(autoCheck = false, strict = false) {
  function Probe() {
    current = useUpdater({ autoCheck });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  roots.add(root);
  await act(async () =>
    root.render(
      strict
        ? createElement(StrictMode, null, createElement(Probe))
        : createElement(Probe),
    ),
  );
  return async () => {
    await act(async () => root.unmount());
    roots.delete(root);
  };
}
function update() {
  return {
    version: "1.0.8",
    body: "Synthetic release",
    close: vi.fn(async () => {}),
    downloadAndInstall: vi.fn(
      async (_progress: (event: unknown) => void) => {},
    ),
  };
}
async function available() {
  const next = update();
  mocks.check.mockResolvedValue(next);
  await mount();
  await act(async () => current.check({ manual: true }));
  return next;
}

describe("native updater lifecycle", () => {
  it("coalesces overlapping manual checks", async () => {
    const pending = deferred<null>();
    mocks.check.mockReturnValue(pending.promise);
    await mount();
    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => {
      first = current.check({ manual: true });
      second = current.check({ manual: true });
    });
    expect(mocks.check).toHaveBeenCalledOnce();
    await act(async () => {
      pending.resolve(null);
      await Promise.all([first, second]);
    });
    expect(current.status.kind).toBe("uptodate");
  });
  it("ignores unavailable localStorage for both automatic check and result", async () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
    });
    await mount();
    await act(async () => current.check());
    expect(mocks.check).toHaveBeenCalledOnce();
    expect(current.status.kind).toBe("uptodate");
  });
  it("checks only once during StrictMode startup", async () => {
    const pending = deferred<null>();
    mocks.check.mockReturnValue(pending.promise);
    await mount(true, true);
    expect(mocks.check).toHaveBeenCalledOnce();
    await act(async () => pending.resolve(null));
  });
  it("does not check an unconfigured release channel", async () => {
    mocks.config.repository = null;
    await mount();
    await act(async () => current.check({ manual: true }));
    expect(mocks.check).not.toHaveBeenCalled();
    expect(current.status.kind).toBe("unconfigured");
  });
  it("treats download Finished as installing until the native install resolves", async () => {
    const next = await available();
    const pending = deferred<void>();
    next.downloadAndInstall.mockImplementation(async (progress) => {
      progress({ event: "Finished" });
      await pending.promise;
    });
    let installing!: Promise<void>;
    await act(async () => {
      installing = current.install();
    });
    expect(current.status.kind).toBe("installing");
    expect(mocks.relaunch).not.toHaveBeenCalled();
    await act(async () => {
      pending.resolve();
      await installing;
    });
    expect(mocks.relaunch).toHaveBeenCalledOnce();
  });
  it("prevents double installation and ignores checks/dismiss while busy", async () => {
    const next = await available();
    const pending = deferred<void>();
    next.downloadAndInstall.mockImplementation(async () => pending.promise);
    const install = current.install;
    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => {
      first = install();
      second = install();
      current.dismiss();
      void current.check({ manual: true });
    });
    expect(next.downloadAndInstall).toHaveBeenCalledOnce();
    expect(mocks.check).toHaveBeenCalledOnce();
    expect(current.status.kind).toBe("downloading");
    await act(async () => {
      pending.resolve();
      await Promise.all([first, second]);
    });
  });
  it("releases a dismissed update resource", async () => {
    const next = await available();
    await act(async () => current.dismiss());
    expect(next.close).toHaveBeenCalledOnce();
    expect(current.status.kind).toBe("idle");
  });
  it("releases a check result arriving after unmount", async () => {
    const pending = deferred<ReturnType<typeof update>>();
    mocks.check.mockReturnValue(pending.promise);
    const unmount = await mount();
    let checking!: Promise<void>;
    await act(async () => {
      checking = current.check({ manual: true });
    });
    await unmount();
    const next = update();
    await act(async () => {
      pending.resolve(next);
      await checking;
    });
    expect(next.close).toHaveBeenCalledOnce();
  });
  it("does not reinstall a downloaded update when restart fails", async () => {
    const next = await available();
    mocks.relaunch.mockRejectedValueOnce(new Error("restart denied"));
    await act(async () => current.install());
    expect(current.status.kind).toBe("ready");
    await act(async () => current.install());
    expect(next.downloadAndInstall).toHaveBeenCalledOnce();
    expect(mocks.relaunch).toHaveBeenCalledTimes(2);
  });
  it("retains the native resource after failure and installs on explicit retry", async () => {
    const next = await available();
    next.downloadAndInstall.mockRejectedValueOnce(
      new Error("signature verification failed"),
    );
    await act(async () => current.install());
    expect(current.status).toMatchObject({ kind: "error", retryInstall: true });
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(next.close).not.toHaveBeenCalled();
    await act(async () => current.install());
    expect(next.downloadAndInstall).toHaveBeenCalledTimes(2);
    expect(next.close).toHaveBeenCalledOnce();
    expect(mocks.relaunch).toHaveBeenCalledOnce();
  });
  it("releases the update when an installation rejects after unmount", async () => {
    const pending = deferred<void>();
    const next = update();
    next.downloadAndInstall.mockImplementation(() => pending.promise);
    mocks.check.mockResolvedValue(next);
    const unmount = await mount();
    await act(async () => current.check({ manual: true }));
    let installing!: Promise<void>;
    await act(async () => {
      installing = current.install();
    });
    await unmount();
    await act(async () => {
      pending.reject(new Error("download failed"));
      await installing;
    });
    expect(next.close).toHaveBeenCalledOnce();
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });
  it("throttles automatic checks but permits manual checks", async () => {
    window.localStorage.setItem("xuya:updater:last-check", String(Date.now()));
    await mount(true);
    expect(mocks.check).not.toHaveBeenCalled();
    await act(async () => current.check({ manual: true }));
    expect(mocks.check).toHaveBeenCalledOnce();
  });
});
