// @vitest-environment happy-dom
import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred, type Entry, preferencesFixture } from "./__tests__/tauri";

let preferences: typeof import("./preferences");
let fixture: ReturnType<typeof preferencesFixture>;

beforeEach(async () => {
  vi.resetModules();
  window.localStorage.clear();
  fixture = preferencesFixture();
  preferences = await import("./preferences");
});
afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
});

const state = () => preferences.usePreferencesStore.getState();
const reads = () =>
  fixture.invoke.mock.calls.filter(
    ([command]) => command === "plugin:store|entries",
  );

describe("preferences initialization", () => {
  it("shares a pending initialization until the snapshot is ready", async () => {
    const pending = deferred<Entry[]>();
    fixture.pendingRead = pending;
    const first = state().init();
    const second = state().init();
    let completed = false;
    void second.then(() => {
      completed = true;
    });
    try {
      await vi.waitFor(() => expect(reads()).toHaveLength(1));
      expect(second).toBe(first);
      expect(completed).toBe(false);
      expect(state().hydrated).toBe(false);
    } finally {
      pending.resolve([["terminalFontSize", 18]]);
      await Promise.all([first, second]);
    }
    expect(state().terminalFontSize).toBe(18);
    expect(state().hydrated).toBe(true);
  });

  it("retries after a snapshot read failure without publishing partial state", async () => {
    fixture.readFailure = new Error("snapshot unavailable");
    preferences.usePreferencesStore.setState({ terminalFontSize: 19 });
    await expect(state().init()).rejects.toThrow("snapshot unavailable");
    expect(state()).toMatchObject({ hydrated: false, terminalFontSize: 19 });
    fixture.readFailure = undefined;
    fixture.entries = [["terminalFontSize", 21]];
    await state().init();
    expect(state()).toMatchObject({ hydrated: true, terminalFontSize: 21 });
    expect(reads()).toHaveLength(2);
    expect(
      fixture.invoke.mock.calls.filter(
        ([command]) => command === "plugin:store|load",
      ),
    ).toHaveLength(1);
  });

  it("recovers when the native store could not initially be opened", async () => {
    fixture.openFailure = new Error("store unavailable");
    await expect(state().init()).rejects.toThrow("store unavailable");
    fixture.entries = [["theme", "dark"]];
    await state().init();
    expect(state()).toMatchObject({ hydrated: true, theme: "dark" });
  });

  it("waits for both subscriptions before reporting readiness", async () => {
    const ready = deferred<void>();
    fixture.pendingEvent = { event: "terax://prefs-changed", ready };
    const pending = state().init();
    let completed = false;
    void pending.then(() => {
      completed = true;
    });
    try {
      await vi.waitFor(() => expect(fixture.subscriptions).toHaveLength(2));
      expect(state().hydrated).toBe(false);
      expect(completed).toBe(false);
    } finally {
      ready.resolve();
      await pending;
    }
    expect(state().hydrated).toBe(true);
  });

  it.each([
    "store://change",
    "terax://prefs-changed",
  ])("retries after %s registration fails", async (event) => {
    fixture.failedEvent = event;
    await expect(state().init()).rejects.toThrow("listener unavailable");
    expect(state().hydrated).toBe(false);
    expect(
      fixture.subscriptions.every((subscription) => subscription.stopped),
    ).toBe(true);
    fixture.failedEvent = undefined;
    await state().init();
    expect(state().hydrated).toBe(true);
    expect(
      fixture.subscriptions.filter((subscription) => !subscription.stopped),
    ).toHaveLength(2);
  });

  it("cleans failed attempts and ignores their queued callbacks", async () => {
    fixture.readFailure = new Error("read unavailable");
    window.localStorage.setItem("terax-ui-bg-kind-shadow", "image");
    window.localStorage.setItem("terax-ui-bg-image-shadow", "existing-image");
    await expect(state().init()).rejects.toThrow("read unavailable");
    expect(fixture.subscriptions).toHaveLength(2);
    expect(
      fixture.subscriptions.every((subscription) => subscription.stopped),
    ).toBe(true);
    for (const subscription of fixture.subscriptions) {
      subscription.callback({
        payload: { resourceId: 7, key: "theme", value: "dark", exists: true },
      });
    }
    expect(state().theme).toBe("system");
    expect(preferences.readBgFastPath()).toEqual({
      active: true,
      imageId: "existing-image",
    });
    fixture.readFailure = undefined;
    await state().init();
    expect(state().hydrated).toBe(true);
  });

  it("retains changes received while an older snapshot is loading", async () => {
    const pending = deferred<Entry[]>();
    fixture.pendingRead = pending;
    const initialization = state().init();
    await vi.waitFor(() => expect(reads()).toHaveLength(1));
    fixture.emit("terax://prefs-changed", { key: "theme", value: "dark" });
    fixture.emit("store://change", {
      resourceId: 7,
      key: "terminalFontSize",
      value: 20,
      exists: true,
    });
    fixture.emit("terax://prefs-changed", {
      key: "backgroundKind",
      value: "image",
    });
    fixture.emit("terax://prefs-changed", {
      key: "backgroundImageId",
      value: "latest-image",
    });
    pending.resolve([
      ["theme", "light"],
      ["terminalFontSize", 12],
    ]);
    await initialization;
    expect(state()).toMatchObject({
      hydrated: true,
      theme: "dark",
      terminalFontSize: 20,
    });
    expect(preferences.readBgFastPath()).toEqual({
      active: true,
      imageId: "latest-image",
    });
  });

  it("hydrates existing settings once and preserves idempotent success", async () => {
    fixture.entries = [
      ["theme", "dark"],
      ["terminalFontFamily", "Fira Code"],
      ["terminalFontSize", 18],
      ["editorAutoSave", true],
      ["editorAutoSaveDelay", 1500],
    ];
    await state().init();
    await Promise.all([state().init(), state().init()]);
    expect(state()).toMatchObject({
      hydrated: true,
      theme: "dark",
      terminalFontFamily: "Fira Code",
      terminalFontSize: 18,
      editorAutoSave: true,
      editorAutoSaveDelay: 1500,
    });
    expect(reads()).toHaveLength(1);
    expect(fixture.subscriptions).toHaveLength(2);
  });

  it("applies local and cross-window updates after initialization", async () => {
    await state().init();
    const settings = await import("./store");
    await settings.setTerminalFontSize(18);
    fixture.emit("terax://prefs-changed", { key: "vimMode", value: true });
    fixture.emit("terax://prefs-changed", {
      key: "backgroundKind",
      value: "image",
    });
    fixture.emit("terax://prefs-changed", {
      key: "backgroundImageId",
      value: "new-image",
    });
    expect(state()).toMatchObject({ terminalFontSize: 18, vimMode: true });
    expect(preferences.readBgFastPath()).toEqual({
      active: true,
      imageId: "new-image",
    });
    fixture.emit("terax://prefs-changed", {
      key: "backgroundImageId",
      value: null,
    });
    expect(preferences.readBgFastPath()).toEqual({
      active: false,
      imageId: null,
    });
  });

  it("still initializes if the optional background shadow cannot be saved", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage full");
    });
    await expect(state().init()).resolves.toBeUndefined();
    expect(state().hydrated).toBe(true);
  });
});
