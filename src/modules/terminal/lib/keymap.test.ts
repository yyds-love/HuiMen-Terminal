import { describe, expect, it } from "vitest";
import {
  codexAltScreenWheelSequence,
  isTerminalCopyShortcut,
  isTerminalPasteShortcut,
  type TerminalKeyEvent,
  terminalDeleteSequence,
  terminalLineNavigationSequence,
  terminalModifiedKeyInput,
  terminalWordNavigationSequence,
} from "./keymap";

const evt = (partial: Partial<TerminalKeyEvent>): TerminalKeyEvent => ({
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  key: "",
  code: "",
  ...partial,
});

describe("terminalWordNavigationSequence", () => {
  it("maps Option+Left to readline word-left", () => {
    expect(
      terminalWordNavigationSequence(
        evt({ altKey: true, key: "ArrowLeft", code: "ArrowLeft" }),
      ),
    ).toBe("\x1bb");
  });

  it("maps Option+Right to readline word-right", () => {
    expect(
      terminalWordNavigationSequence(
        evt({ altKey: true, key: "ArrowRight", code: "ArrowRight" }),
      ),
    ).toBe("\x1bf");
  });

  it("does not remap plain arrows", () => {
    expect(
      terminalWordNavigationSequence(
        evt({ key: "ArrowLeft", code: "ArrowLeft" }),
      ),
    ).toBeNull();
  });
});

describe("terminalLineNavigationSequence", () => {
  it("maps Cmd+Left to readline line-start on macOS", () => {
    expect(
      terminalLineNavigationSequence(
        evt({ metaKey: true, key: "ArrowLeft", code: "ArrowLeft" }),
        { isMac: true },
      ),
    ).toBe("\x01");
  });

  it("maps Cmd+Right to readline line-end on macOS", () => {
    expect(
      terminalLineNavigationSequence(
        evt({ metaKey: true, key: "ArrowRight", code: "ArrowRight" }),
        { isMac: true },
      ),
    ).toBe("\x05");
  });

  it("does not remap Cmd+Arrow off macOS", () => {
    expect(
      terminalLineNavigationSequence(
        evt({ metaKey: true, key: "ArrowLeft", code: "ArrowLeft" }),
        { isMac: false },
      ),
    ).toBeNull();
  });

  it("does not remap Cmd+Option+Arrow (selection-style combos pass through)", () => {
    expect(
      terminalLineNavigationSequence(
        evt({
          metaKey: true,
          altKey: true,
          key: "ArrowLeft",
          code: "ArrowLeft",
        }),
        { isMac: true },
      ),
    ).toBeNull();
  });
});

describe("terminalDeleteSequence", () => {
  it("maps Cmd+Backspace to kill-to-line-start on macOS", () => {
    expect(
      terminalDeleteSequence(
        evt({ metaKey: true, key: "Backspace", code: "Backspace" }),
        { isMac: true },
      ),
    ).toBe("\x15");
  });

  it("maps Option+Backspace to kill-word-backward on macOS", () => {
    expect(
      terminalDeleteSequence(
        evt({ altKey: true, key: "Backspace", code: "Backspace" }),
        { isMac: true },
      ),
    ).toBe("\x17");
  });

  it("maps Ctrl+Backspace to kill-word-backward off macOS", () => {
    expect(
      terminalDeleteSequence(
        evt({ ctrlKey: true, key: "Backspace", code: "Backspace" }),
        { isMac: false },
      ),
    ).toBe("\x17");
  });

  it("does not remap Ctrl+Backspace on macOS (reserved for native readline binding)", () => {
    expect(
      terminalDeleteSequence(
        evt({ ctrlKey: true, key: "Backspace", code: "Backspace" }),
        { isMac: true },
      ),
    ).toBeNull();
  });

  it("does not remap Cmd+Backspace off macOS", () => {
    expect(
      terminalDeleteSequence(
        evt({ metaKey: true, key: "Backspace", code: "Backspace" }),
        { isMac: false },
      ),
    ).toBeNull();
  });

  it("does not remap plain Backspace", () => {
    expect(
      terminalDeleteSequence(evt({ key: "Backspace", code: "Backspace" }), {
        isMac: true,
      }),
    ).toBeNull();
  });
});

describe("terminal clipboard shortcuts", () => {
  it("maps Cmd+C and Cmd+V on macOS", () => {
    expect(
      isTerminalCopyShortcut(evt({ metaKey: true, key: "c", code: "KeyC" }), {
        isMac: true,
      }),
    ).toBe(true);
    expect(
      isTerminalPasteShortcut(evt({ metaKey: true, key: "v", code: "KeyV" }), {
        isMac: true,
      }),
    ).toBe(true);
  });

  it("maps Ctrl+Shift+C and Ctrl+Shift+V off macOS", () => {
    expect(
      isTerminalCopyShortcut(
        evt({ ctrlKey: true, shiftKey: true, key: "c", code: "KeyC" }),
        { isMac: false },
      ),
    ).toBe(true);
    expect(
      isTerminalPasteShortcut(
        evt({ ctrlKey: true, shiftKey: true, key: "v", code: "KeyV" }),
        { isMac: false },
      ),
    ).toBe(true);
  });

  it("does not steal plain Ctrl+C or Ctrl+V from terminals off macOS", () => {
    expect(
      isTerminalCopyShortcut(evt({ ctrlKey: true, key: "c", code: "KeyC" }), {
        isMac: false,
      }),
    ).toBe(false);
    expect(
      isTerminalPasteShortcut(evt({ ctrlKey: true, key: "v", code: "KeyV" }), {
        isMac: false,
      }),
    ).toBe(false);
  });
});

describe("terminal modified keys", () => {
  it.each([
    [evt({ key: "Tab", shiftKey: true }), "\x1b[Z", "shift-tab"],
    [evt({ key: "Enter", shiftKey: true }), "\x1b\r", "shift-enter"],
    [evt({ key: "Enter", altKey: true }), "\x1b\r", "alt-enter"],
    [evt({ key: "j", ctrlKey: true }), "\n", "ctrl-j"],
  ])("sends key identity on Windows 10 1809 (%s)", (event, data, consoleKey) => {
    expect(terminalModifiedKeyInput(event, true)).toEqual({ data, consoleKey });
  });

  it.each([
    evt({ key: "Enter" }),
    evt({ key: "Enter", ctrlKey: true }),
    evt({ key: "Enter", ctrlKey: true, shiftKey: true }),
    evt({ key: "Enter", metaKey: true, shiftKey: true }),
    evt({ key: "Tab", ctrlKey: true, shiftKey: true }),
    evt({ key: "j", ctrlKey: true, shiftKey: true }),
  ])("leaves other keys to xterm (%s)", (event) => {
    expect(terminalModifiedKeyInput(event, true)).toBeNull();
  });

  it("keeps existing input handling on other operating system versions", () => {
    expect(
      terminalModifiedKeyInput(evt({ key: "Enter", shiftKey: true }), false),
    ).toEqual({ data: "\x1b\r" });
    expect(
      terminalModifiedKeyInput(evt({ key: "Tab", shiftKey: true }), false),
    ).toBeNull();
    expect(
      terminalModifiedKeyInput(evt({ key: "Enter", altKey: true }), false),
    ).toBeNull();
    expect(
      terminalModifiedKeyInput(evt({ key: "j", ctrlKey: true }), false),
    ).toBeNull();
  });
});

describe("codex alternate-screen wheel navigation", () => {
  const modes = {
    isCodex: true,
    isAlternateBuffer: true,
    mouseTrackingMode: "vt200" as const,
    applicationCursorKeysMode: false,
  };

  it("maps wheel up and down to normal cursor-key sequences", () => {
    expect(codexAltScreenWheelSequence({ deltaY: -40 }, modes)).toBe("\x1b[A");
    expect(codexAltScreenWheelSequence({ deltaY: 40 }, modes)).toBe("\x1b[B");
  });

  it("uses application cursor-key sequences when enabled", () => {
    expect(
      codexAltScreenWheelSequence(
        { deltaY: -40 },
        { ...modes, applicationCursorKeysMode: true },
      ),
    ).toBe("\x1bOA");
  });

  it.each([
    ["another agent", { ...modes, isCodex: false }],
    ["the normal buffer", { ...modes, isAlternateBuffer: false }],
    [
      "disabled mouse tracking",
      { ...modes, mouseTrackingMode: "none" as const },
    ],
  ])("leaves wheel input unchanged for %s", (_reason, otherModes) => {
    expect(codexAltScreenWheelSequence({ deltaY: 40 }, otherModes)).toBeNull();
  });

  it("ignores horizontal-only wheel events", () => {
    expect(codexAltScreenWheelSequence({ deltaY: 0 }, modes)).toBeNull();
  });
});
