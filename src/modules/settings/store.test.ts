// @vitest-environment happy-dom
import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preferencesFixture } from "./__tests__/tauri";

let settings: typeof import("./store");
let fixture: ReturnType<typeof preferencesFixture>;

beforeEach(async () => {
  vi.resetModules();
  fixture = preferencesFixture();
  settings = await import("./store");
});
afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
});

describe("preference resource recovery", () => {
  it("retries a failed initial resource open without writing defaults", async () => {
    const failure = new Error("store unavailable");
    fixture.openFailure = failure;
    await expect(settings.loadPreferences()).rejects.toBe(failure);
    await expect(settings.loadPreferences()).resolves.toEqual(
      settings.DEFAULT_PREFERENCES,
    );
    expect(
      fixture.invoke.mock.calls.filter(
        ([command]) => command === "plugin:store|load",
      ),
    ).toHaveLength(2);
    expect(
      fixture.invoke.mock.calls.some(
        ([command]) =>
          command === "plugin:store|set" || command === "plugin:store|save",
      ),
    ).toBe(false);
  });

  it("shares concurrent resource opens and retains existing store options", async () => {
    await Promise.all([settings.loadPreferences(), settings.loadPreferences()]);
    expect(
      fixture.invoke.mock.calls.filter(
        ([command]) => command === "plugin:store|load",
      ),
    ).toEqual([
      [
        "plugin:store|load",
        {
          path: "terax-settings.json",
          options: { defaults: {}, autoSave: 200 },
        },
      ],
    ]);
  });

  it("preserves setter ordering and the cross-window payload", async () => {
    await settings.setTerminalFontSize(18);
    expect(fixture.invoke.mock.calls.map(([command]) => command)).toEqual([
      "plugin:store|load",
      "plugin:store|set",
      "plugin:store|save",
      "plugin:event|emit",
    ]);
    expect(fixture.invoke).toHaveBeenCalledWith("plugin:store|set", {
      rid: 7,
      key: "terminalFontSize",
      value: 18,
    });
    expect(fixture.invoke).toHaveBeenLastCalledWith("plugin:event|emit", {
      event: "terax://prefs-changed",
      payload: { key: "terminalFontSize", value: 18 },
    });
  });
});

describe("preference subscriptions", () => {
  it("releases the first listener if the second registration fails", async () => {
    const changed = vi.fn();
    fixture.failedEvent = "terax://prefs-changed";
    await expect(settings.onPreferencesChange(changed)).rejects.toThrow(
      "listener unavailable",
    );
    expect(fixture.subscriptions).toHaveLength(1);
    expect(fixture.subscriptions[0].cleanupCalls).toBe(1);
    fixture.subscriptions[0].callback({
      payload: { resourceId: 7, key: "theme", value: "dark", exists: true },
    });
    expect(changed).not.toHaveBeenCalled();
    fixture.failedEvent = undefined;
    const stop = await settings.onPreferencesChange(changed);
    await stop();
    expect(
      fixture.subscriptions.every(
        (subscription) => subscription.cleanupCalls === 1,
      ),
    ).toBe(true);
  });

  it("maps local and cross-window changes and ignores unknown keys", async () => {
    const changed = vi.fn();
    const stop = await settings.onPreferencesChange(changed);
    fixture.emit("store://change", {
      resourceId: 7,
      key: "terminalFontSize",
      value: 18,
      exists: true,
    });
    fixture.emit("terax://prefs-changed", { key: "theme", value: "dark" });
    fixture.emit("terax://prefs-changed", {
      key: "not-a-preference",
      value: "ignored",
    });
    expect(changed.mock.calls).toEqual([
      ["terminalFontSize", 18],
      ["theme", "dark"],
    ]);
    await stop();
  });

  it("cleans both listeners and ignores callbacks after cleanup", async () => {
    const changed = vi.fn();
    const stop = await settings.onPreferencesChange(changed);
    await stop();
    await stop();
    expect(
      fixture.subscriptions.map((subscription) => subscription.cleanupCalls),
    ).toEqual([1, 1]);
    fixture.subscriptions[1].callback({
      payload: { key: "theme", value: "light" },
    });
    expect(changed).not.toHaveBeenCalled();
  });

  it("observes asynchronous cleanup failure and still attempts both listeners", async () => {
    const warning = vi.spyOn(console, "error").mockImplementation(() => {});
    const stop = await settings.onPreferencesChange(vi.fn());
    fixture.subscriptions[0].cleanupFailure = new Error("cleanup unavailable");
    await stop();
    expect(fixture.subscriptions[1].cleanupCalls).toBe(1);
    expect(warning).toHaveBeenCalled();
  });
});
