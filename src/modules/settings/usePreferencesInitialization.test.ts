// @vitest-environment happy-dom
import { clearMocks } from "@tauri-apps/api/mocks";
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred, type Entry, preferencesFixture } from "./__tests__/tauri";

let fixture: ReturnType<typeof preferencesFixture>;
let useInitialization: typeof import("./usePreferencesInitialization").usePreferencesInitialization;
let preferences: typeof import("./preferences");
const roots = new Set<Root>();

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture = preferencesFixture();
  preferences = await import("./preferences");
  useInitialization = (await import("./usePreferencesInitialization"))
    .usePreferencesInitialization;
});
afterEach(async () => {
  await act(async () => {
    for (const root of roots) root.unmount();
    roots.clear();
  });
  document.body.replaceChildren();
  clearMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(strict = false) {
  function Probe() {
    useInitialization();
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.add(root);
  await act(async () => {
    const child = createElement(Probe);
    root.render(strict ? createElement(StrictMode, null, child) : child);
  });
  return async () => {
    await act(async () => root.unmount());
    roots.delete(root);
  };
}

describe("preferences recovery hook", () => {
  it("coalesces StrictMode, multiple mounts and focus while initialization is pending", async () => {
    const pending = deferred<Entry[]>();
    fixture.pendingRead = pending;
    await mount(true);
    await mount();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
    });
    expect(
      fixture.invoke.mock.calls.filter(
        ([command]) => command === "plugin:store|entries",
      ),
    ).toHaveLength(1);
    expect(fixture.subscriptions).toHaveLength(2);
    expect(preferences.usePreferencesStore.getState().hydrated).toBe(false);
    await act(async () => pending.resolve([["terminalFontSize", 22]]));
    expect(preferences.usePreferencesStore.getState()).toMatchObject({
      hydrated: true,
      terminalFontSize: 22,
    });
  });

  it("handles an initial failure and retries once on focus without a retry loop", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.openFailure = new Error("unavailable synthetic secret");
    await mount(true);
    expect(preferences.usePreferencesStore.getState().hydrated).toBe(false);
    expect(error.mock.calls).toEqual([
      ["Preferences initialization failed; refocus the window to retry."],
    ]);
    expect(fixture.invoke).toHaveBeenCalledTimes(1);
    fixture.entries = [["theme", "dark"]];
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(preferences.usePreferencesStore.getState()).toMatchObject({
      hydrated: true,
      theme: "dark",
    });
  });

  it("does not retry on focus after unmount or leave a pending rejection unhandled", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const pending = deferred<Entry[]>();
    fixture.pendingRead = pending;
    const unmount = await mount();
    await unmount();
    await act(async () => pending.reject(new Error("read unavailable")));
    expect(error).not.toHaveBeenCalled();
    expect(
      fixture.subscriptions.every((subscription) => subscription.stopped),
    ).toBe(true);
    const count = fixture.invoke.mock.calls.length;
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(fixture.invoke.mock.calls).toHaveLength(count);
  });
});
