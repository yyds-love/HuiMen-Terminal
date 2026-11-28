// @vitest-environment happy-dom

import { usePreferencesStore } from "@/modules/settings/preferences";
import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireSlot,
  configureRendererPool,
  disposeLeafSlot,
} from "./rendererPool";

const leafId = 1;

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

describe("terminal wheel input", () => {
  const input: string[] = [];
  const createSlot = () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const slot = acquireSlot({
      leafId,
      container,
      snapshot: null,
      altScreen: false,
      drainRing: () => {},
      shellExited: false,
      searchQuery: null,
      cols: 80,
      rows: 24,
      registerOsc: () => [],
      onSearchReady: () => {},
    });
    const screen =
      slot.term.element?.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) throw new Error("Terminal screen was not mounted");
    screen.style.paddingLeft = "0px";
    screen.style.paddingTop = "0px";
    return { term: slot.term, screen };
  };

  beforeEach(() => {
    input.length = 0;
    usePreferencesStore.setState({
      terminalFontFamily: "monospace",
      terminalWebglEnabled: false,
    });
    // Happy DOM has no font layout. Supply stable monospace cell dimensions.
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(256);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(16);
    configureRendererPool({
      resolveLeaf: () => ({
        writeToPty: (data) => input.push(data),
        resizePty: () => {},
        kickPty: () => {},
      }),
      evictLeaf: () => {},
      isLeafFocused: () => false,
      isLeafBlocks: () => false,
      isLeafBusy: () => false,
      isLeafVisible: () => true,
      storeSnapshot: () => {},
    });
  });

  afterEach(() => {
    disposeLeafSlot(leafId);
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("reports wheel input to a fullscreen application using SGR mouse tracking", async () => {
    const { term, screen } = createSlot();
    await write(term, "\x1b[?1049h\x1b[?1003h\x1b[?1006h");
    expect(term.buffer.active.type).toBe("alternate");
    expect(term.modes.mouseTrackingMode).toBe("any");

    for (const deltaY of [-120, 120]) {
      const event = new WheelEvent("wheel", {
        deltaY,
        bubbles: true,
        cancelable: true,
      });
      // Happy DOM's WheelEvent lacks the inherited mouse coordinates.
      Object.assign(event, { clientX: 1, clientY: 1 });
      screen.dispatchEvent(event);
    }

    expect(input).toEqual(["\x1b[<64;1;1M", "\x1b[<65;1;1M"]);
  });

  it("scrolls local history when an application uses the normal screen", async () => {
    const { term, screen } = createSlot();
    await write(term, "Restored history\r\n".repeat(term.rows * 2));
    const bottom = term.buffer.active.baseY;
    expect(bottom).toBeGreaterThan(0);
    expect(term.buffer.active.viewportY).toBe(bottom);

    screen.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: -120,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(term.buffer.active.viewportY).toBeLessThan(bottom);
    expect(input).toEqual([]);
  });
});
