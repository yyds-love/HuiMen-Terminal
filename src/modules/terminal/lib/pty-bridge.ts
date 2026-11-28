import { IS_WINDOWS_1809 } from "@/lib/platform";
import { currentWorkspaceEnv } from "@/modules/workspace";
import {
  currentTerminalAppearance,
  type TerminalAppearance,
} from "@/styles/terminalTheme";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { AgentType } from "./agentResume";
import type { WindowsConsoleKey } from "./keymap";

const textEncoder = new TextEncoder();

export type PtyHandlers = {
  onData: (bytes: Uint8Array) => void;
  onExit?: (code: number) => void;
};

export type PtySession = {
  id: number;
  codexInlineScrollback: boolean;
  write: (data: string, consoleKey?: WindowsConsoleKey) => Promise<void>;
  resize: (cols: number, rows: number) => Promise<void>;
  setAppearance: (appearance?: TerminalAppearance) => Promise<void>;
  close: () => Promise<void>;
};

export async function openPty(
  cols: number,
  rows: number,
  handlers: PtyHandlers,
  cwd?: string,
  blocks?: boolean,
  agentType?: AgentType,
  appearance: TerminalAppearance = currentTerminalAppearance(),
): Promise<PtySession> {
  // Raw bytes — no base64/JSON round-trip; messages arrive as ArrayBuffer.
  const onData = new Channel<ArrayBuffer>();
  const onExit = new Channel<number>();

  let released = false;
  const noop = () => {};
  const releaseHandlers = () => {
    if (released) return;
    released = true;
    onData.onmessage = noop;
    onExit.onmessage = noop;
  };

  onData.onmessage = (buf) => handlers.onData(new Uint8Array(buf));
  onExit.onmessage = (code) => {
    handlers.onExit?.(code);
    releaseHandlers();
  };

  const workspace = currentWorkspaceEnv();
  const codexInlineScrollback =
    IS_WINDOWS_1809 && workspace.kind === "local" && agentType === "codex";
  const id = await invoke<number>("pty_open", {
    cols,
    rows,
    cwd: cwd ?? null,
    workspace,
    blocks: blocks ?? false,
    agentType: agentType ?? null,
    appearance,
    onData,
    onExit,
  });

  let closed = false;
  const headers = { "x-pty-id": String(id) };

  return {
    id,
    codexInlineScrollback,
    // Raw bytes + id header: no JSON round-trip on the per-keystroke path.
    write: (data, consoleKey) =>
      invoke("pty_write", textEncoder.encode(data), {
        headers: consoleKey
          ? { ...headers, "x-pty-console-key": consoleKey }
          : headers,
      }),
    resize: (c, r) => invoke("pty_resize", { id, cols: c, rows: r }),
    setAppearance: (next = currentTerminalAppearance()) =>
      invoke("pty_set_appearance", { id, appearance: next }),
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await invoke("pty_close", { id });
      } finally {
        releaseHandlers();
      }
    },
  };
}
