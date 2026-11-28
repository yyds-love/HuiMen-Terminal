import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  workspace: { kind: "local" as const },
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: ((message: ArrayBuffer | number) => void) | null = null;
  },
  invoke: mocks.invoke,
}));
vi.mock("@tauri-apps/plugin-os", () => ({
  platform: () => "windows",
  version: () => "10.0.17763",
}));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => mocks.workspace,
}));
vi.mock("@/styles/terminalTheme", () => ({
  currentTerminalAppearance: () => ({
    colorScheme: "dark",
    foreground: "#f6f8fa",
    background: "#0d1117",
    cursor: "#f6f8fa",
  }),
}));

import { openPty } from "./pty-bridge";

describe("PTY agent compatibility options", () => {
  beforeEach(() => {
    mocks.invoke.mockReset().mockResolvedValue(17);
    mocks.workspace = { kind: "local" };
  });

  it("passes Claude identity to the native PTY on Windows 10 1809", async () => {
    await openPty(80, 24, { onData: () => {} }, undefined, false, "claude");

    expect(mocks.invoke).toHaveBeenCalledWith(
      "pty_open",
      expect.objectContaining({
        agentType: "claude",
      }),
    );
  });

  it("keeps Codex scrollback enabled and passes its identity", async () => {
    const pty = await openPty(
      80,
      24,
      { onData: () => {} },
      undefined,
      false,
      "codex",
    );

    expect(mocks.invoke).toHaveBeenCalledWith(
      "pty_open",
      expect.objectContaining({ agentType: "codex" }),
    );
    expect(pty.codexInlineScrollback).toBe(true);
  });
});
