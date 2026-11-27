// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { KeyBinding, ShortcutId } from "../shortcuts";
import {
  type ShortcutHandlers,
  useGlobalShortcuts,
} from "./useGlobalShortcuts";

const ctrl = { ctrlKey: true };
const ctrlShift = { ...ctrl, shiftKey: true };
const rebindings = [
  ["commandPalette.open", "p", ctrl, "K"],
  ["tab.newPrivate", "r", ctrl, "N"],
  ["tab.close", "w", ctrl, "W"],
  ["ai.askSelection", "j", ctrl, "L"],
  ["pane.focusNext", "]", ctrl, "G"],
  ["pane.focusPrev", "[", ctrl, "H"],
  ["tab.next", "Tab", ctrl, "PageDown"],
  ["tab.prev", "Tab", ctrlShift, "PageUp"],
] as const satisfies ReadonlyArray<
  readonly [ShortcutId, string, KeyboardEventInit, string]
>;

let root: Root;
let terminal: HTMLTextAreaElement;
let editor: HTMLInputElement;
const defaultShortcuts = usePreferencesStore.getState().shortcuts;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  usePreferencesStore.setState({ shortcuts: defaultShortcuts });
  root = createRoot(document.body.appendChild(document.createElement("div")));
  const xterm = document.body.appendChild(document.createElement("div"));
  xterm.className = "xterm";
  terminal = xterm.appendChild(document.createElement("textarea"));
  const codeMirror = document.body.appendChild(document.createElement("div"));
  codeMirror.className = "cm-editor";
  editor = codeMirror.appendChild(document.createElement("input"));
});

afterEach(async () => {
  await act(async () => root.unmount());
  usePreferencesStore.setState({ shortcuts: defaultShortcuts });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function mount(handlers: ShortcutHandlers) {
  function Harness() {
    useGlobalShortcuts(handlers);
    return null;
  }

  await act(async () => root.render(createElement(Harness)));
}

function press(target: HTMLElement, key: string, modifiers: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  target.dispatchEvent(event);
  return event;
}

describe("global shortcuts with terminal focus", () => {
  it.each(
    rebindings,
  )("routes %s by the pressed key and focus", async (id, key, modifiers, alternative) => {
    const handler = vi.fn();
    const receive = vi.fn();
    await mount({ [id]: handler });
    terminal.addEventListener("keydown", receive);

    const terminalEvent = press(terminal, key, modifiers);
    expect(terminalEvent.defaultPrevented).toBe(false);
    expect(receive).toHaveBeenCalledWith(terminalEvent);
    expect(handler).toHaveBeenCalledTimes(0);

    const editorEvent = press(editor, key, modifiers);
    expect(editorEvent.defaultPrevented).toBe(true);
    expect(handler).toHaveBeenCalledWith(editorEvent);

    const alternativeEvent = press(terminal, alternative, ctrlShift);
    expect(alternativeEvent.defaultPrevented).toBe(true);
    expect(handler).toHaveBeenCalledWith(alternativeEvent);
  });

  it.each([
    ["o", { ctrlKey: true }, { ctrl: true }],
    ["p", { altKey: true }, { alt: true }],
    ["Tab", { shiftKey: true }, { shift: true }],
    ["Enter", { shiftKey: true }, { shift: true }],
    ["ArrowUp", { ctrlKey: true, shiftKey: true }, { ctrl: true, shift: true }],
    ["\\", ctrl, { ctrl: true }],
  ] as const satisfies ReadonlyArray<
    readonly [string, KeyboardEventInit, Omit<KeyBinding, "key">]
  >)("protects terminal input from a custom binding for %s", async (key, modifiers, binding) => {
    const handler = vi.fn();
    usePreferencesStore.setState({
      shortcuts: {
        ...defaultShortcuts,
        "explorer.search": [{ key, ...binding }],
      },
    });
    await mount({ "explorer.search": handler });

    expect(press(terminal, key, modifiers).defaultPrevented).toBe(false);
    expect(handler).toHaveBeenCalledTimes(0);
    expect(press(editor, key, modifiers).defaultPrevented).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("keeps zoom and numeric tab jumps available in the terminal", async () => {
    const zoomIn = vi.fn();
    const zoomOut = vi.fn();
    const selectTab = vi.fn();
    await mount({
      "view.zoomIn": zoomIn,
      "view.zoomOut": zoomOut,
      "tab.selectByIndex": selectTab,
    });

    expect(press(terminal, "=", ctrl).defaultPrevented).toBe(true);
    expect(zoomIn).toHaveBeenCalledTimes(1);
    expect(press(terminal, "_", ctrlShift).defaultPrevented).toBe(true);
    expect(zoomOut).toHaveBeenCalledTimes(1);
    expect(press(terminal, "5", ctrl).defaultPrevented).toBe(true);
    expect(selectTab).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["commandPalette.open", "K"],
    ["pane.focusNext", "G"],
    ["ai.askSelection", "L"],
  ] as const)("preserves CodeMirror's binding for the %s alternative", async (id, key) => {
    const handler = vi.fn();
    const receive = vi.fn();
    await mount({ [id]: handler });
    editor.addEventListener("keydown", receive);

    const event = press(editor, key, ctrlShift);
    expect(event.defaultPrevented).toBe(false);
    expect(receive).toHaveBeenCalledWith(event);
    expect(handler).toHaveBeenCalledTimes(0);
  });

  it("keeps an existing custom binding ahead of a new default alternative", async () => {
    const search = vi.fn();
    const palette = vi.fn();
    usePreferencesStore.setState({
      shortcuts: {
        ...defaultShortcuts,
        "explorer.search": [{ key: "k", ctrl: true, shift: true }],
      },
    });
    await mount({ "explorer.search": search, "commandPalette.open": palette });

    expect(press(terminal, "K", ctrlShift).defaultPrevented).toBe(true);
    expect(press(editor, "K", ctrlShift).defaultPrevented).toBe(true);
    expect(search).toHaveBeenCalledTimes(2);
    expect(palette).toHaveBeenCalledTimes(0);
  });

  it("keeps an existing Ctrl+Shift+PageDown binding with terminal focus", async () => {
    const search = vi.fn();
    const nextTab = vi.fn();
    usePreferencesStore.setState({
      shortcuts: {
        ...defaultShortcuts,
        "explorer.search": [{ key: "PageDown", ctrl: true, shift: true }],
      },
    });
    await mount({ "explorer.search": search, "tab.next": nextTab });

    expect(press(terminal, "PageDown", ctrlShift).defaultPrevented).toBe(true);
    expect(search).toHaveBeenCalledTimes(1);
    expect(nextTab).toHaveBeenCalledTimes(0);
  });
});
