// @vitest-environment happy-dom
import {
  deferred,
  type Entry,
  preferencesFixture,
} from "@/modules/settings/__tests__/tauri";
import { clearMocks } from "@tauri-apps/api/mocks";
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Custom-theme storage has its own lifecycle; exercise preferences and the
// actual provider rendering while keeping that unrelated native resource out.
vi.mock("./customThemes", () => ({
  listCustomThemes: vi.fn(async () => []),
  onCustomThemesChange: vi.fn(async () => () => {}),
}));

let theme: typeof import("./ThemeProvider");
let preferences: typeof import("../settings/preferences");
let fixture: ReturnType<typeof preferencesFixture>;
let current: ReturnType<typeof theme.useTheme>;
const roots = new Set<Root>();

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  document.documentElement.removeAttribute("style");
  fixture = preferencesFixture();
  preferences = await import("../settings/preferences");
  theme = await import("./ThemeProvider");
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
    current = theme.useTheme();
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.add(root);
  await act(async () => {
    const provider = createElement(
      theme.ThemeProvider,
      null,
      createElement(Probe),
    );
    root.render(strict ? createElement(StrictMode, null, provider) : provider);
  });
  return async () => {
    await act(async () => root.unmount());
    roots.delete(root);
  };
}
const reads = () =>
  fixture.invoke.mock.calls.filter(
    ([command]) => command === "plugin:store|entries",
  );

describe("theme preference initialization", () => {
  it("uses the already hydrated shared store without reading another snapshot", async () => {
    fixture.entries = [["theme", "dark"]];
    await preferences.usePreferencesStore.getState().init();
    // A separate native read must not override the authoritative shared state.
    fixture.entries = [["theme", "light"]];
    await mount();
    expect(current.mode).toBe("dark");
    expect(reads()).toHaveLength(1);
    expect(fixture.subscriptions).toHaveLength(2);
  });

  it("shares StrictMode initialization and keeps one preference subscription pair", async () => {
    fixture.entries = [["theme", "dark"]];
    await mount(true);
    expect(reads()).toHaveLength(1);
    expect(fixture.subscriptions).toHaveLength(2);
    expect(preferences.usePreferencesStore.getState().hydrated).toBe(true);
    expect(current.mode).toBe("dark");
  });

  it("handles failure and retries when the window receives focus", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.openFailure = new Error("native store temporarily unavailable");
    await mount();
    expect(preferences.usePreferencesStore.getState().hydrated).toBe(false);
    expect(error).toHaveBeenCalled();
    fixture.entries = [
      ["theme", "dark"],
      ["terminalFontSize", 20],
    ];
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(preferences.usePreferencesStore.getState()).toMatchObject({
      hydrated: true,
      terminalFontSize: 20,
    });
    expect(current.mode).toBe("dark");
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(reads()).toHaveLength(1);
    expect(
      fixture.subscriptions.filter((subscription) => !subscription.stopped),
    ).toHaveLength(2);
  });

  it("keeps the fast theme until hydration and applies later cross-window changes", async () => {
    const pending = deferred<Entry[]>();
    fixture.pendingRead = pending;
    window.localStorage.setItem("terax-ui-theme-shadow", "light");
    await mount();
    expect(current.mode).toBe("light");
    expect(preferences.usePreferencesStore.getState().hydrated).toBe(false);
    await act(async () => pending.resolve([["theme", "dark"]]));
    expect(current.mode).toBe("dark");
    expect(window.localStorage.getItem("terax-ui-theme-shadow")).toBe("dark");
    await act(async () =>
      fixture.emit("terax://prefs-changed", { key: "theme", value: "light" }),
    );
    expect(current.mode).toBe("light");
    expect(document.documentElement.classList.contains("light")).toBe(true);
  });

  it("preserves optimistic theme selection while a snapshot is pending", async () => {
    const pending = deferred<Entry[]>();
    fixture.pendingRead = pending;
    await mount();
    await act(async () => current.setMode("dark"));
    expect(current.mode).toBe("dark");
    await act(async () => pending.resolve([["theme", "light"]]));
    expect(current.mode).toBe("dark");
    expect(preferences.usePreferencesStore.getState().theme).toBe("dark");
  });

  it("keeps previews transient and preserves persisted theme selection", async () => {
    fixture.entries = [["theme", "dark"]];
    await mount();
    const calls = fixture.invoke.mock.calls.length;
    await act(async () => current.previewThemeId("nord"));
    expect(current.themeId).toBe("terax-default");
    expect(
      document.documentElement.style.getPropertyValue("--background"),
    ).toBe("#2e3440");
    expect(fixture.invoke.mock.calls).toHaveLength(calls);
    await act(async () => current.previewThemeId(null));
    expect(
      document.documentElement.style.getPropertyValue("--background"),
    ).toBe("");
    await act(async () => current.setThemeId("nord"));
    expect(current.themeId).toBe("nord");
    expect(preferences.usePreferencesStore.getState().themeId).toBe("nord");
    expect(
      fixture.invoke.mock.calls.some(
        ([command, args]) =>
          command === "plugin:store|set" &&
          args?.key === "themeId" &&
          args?.value === "nord",
      ),
    ).toBe(true);
  });

  it("removes the focus retry handler on unmount", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.openFailure = new Error("unavailable");
    const unmount = await mount();
    await unmount();
    const count = fixture.invoke.mock.calls.length;
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(fixture.invoke.mock.calls).toHaveLength(count);
  });

  it.each([
    "theme",
    "themeId",
  ])("restores the authoritative %s after an optimistic save fails", async (key) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.entries = [["theme", "dark"]];
    await mount();
    fixture.writeFailures.set(key, new Error("synthetic save failure"));
    await act(async () => {
      if (key === "theme") current.setMode("light");
      else current.setThemeId("nord");
    });
    const expected = key === "theme" ? "dark" : "terax-default";
    await act(async () =>
      fixture.emit("terax://prefs-changed", { key, value: expected }),
    );
    expect(key === "theme" ? current.mode : current.themeId).toBe(expected);
    expect(error).toHaveBeenCalled();
    expect(
      window.localStorage.getItem(
        key === "theme" ? "terax-ui-theme-shadow" : "terax-ui-theme-id-shadow",
      ),
    ).toBe(expected);
  });

  it.each([
    "theme",
    "themeId",
  ])("does not undo a newer %s choice when an older save fails late", async (key) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.entries = [["theme", "dark"]];
    await mount();
    const pending = deferred<void>();
    const older = key === "theme" ? "light" : "nord";
    const newer = key === "theme" ? "system" : "catppuccin";
    fixture.beforeWrite = async (writtenKey, value) => {
      if (writtenKey === key && value === older) await pending.promise;
    };
    await act(async () => {
      if (key === "theme") current.setMode("light");
      else current.setThemeId(older);
    });
    await act(async () => {
      if (key === "theme") current.setMode("system");
      else current.setThemeId(newer);
    });
    expect(key === "theme" ? current.mode : current.themeId).toBe(newer);
    await act(async () => pending.reject(new Error("late failure")));
    expect(key === "theme" ? current.mode : current.themeId).toBe(newer);
    expect(
      preferences.usePreferencesStore.getState()[
        key === "theme" ? "theme" : "themeId"
      ],
    ).toBe(newer);
  });
});
