// @vitest-environment happy-dom
import { Chat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOrCreateChat } from "../store/chatRuntime";
import { chats, seedMessages, useChatStore } from "../store/chatStore";
import { AiComposerProvider, useComposer } from "./composer";

// The hook runs in a DOM test environment without the Tauri event bridge.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

let root: Root | undefined;
let current: ReturnType<typeof useComposer>;
let chat: Chat<UIMessage>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  chats.clear();
  seedMessages.clear();
  chat = new Chat({
    id: "session",
    transport: {
      sendMessages: vi.fn(
        async () =>
          new ReadableStream({
            start(c) {
              c.close();
            },
          }),
      ),
      reconnectToStream: async () => null,
    },
  });
  chats.set("session", chat);
  useChatStore.getState().resetAgentMeta();
  useChatStore.setState({ activeSessionId: "session", pendingSelections: [] });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  chats.clear();
  seedMessages.clear();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function mount() {
  function Harness() {
    current = useComposer();
    return null;
  }
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () => {
    root?.render(
      createElement(AiComposerProvider, null, createElement(Harness)),
    );
  });
  await act(async () => current.setValue("keep draft"));
}
function setPendingApproval() {
  chat.messages = [
    {
      id: "assistant",
      role: "assistant",
      parts: [
        {
          type: "tool-write_file",
          toolCallId: "pending",
          state: "approval-requested",
          input: { path: "/repo/file.txt", content: "synthetic" },
          approval: { id: "approval" },
        },
      ],
    },
  ];
}

describe("composer approval boundary", () => {
  it("disables submission while an approval is pending and retains the draft", async () => {
    setPendingApproval();
    useChatStore.getState().patchAgentMeta({ status: "awaiting-approval" });
    await mount();
    expect(current.canSend).toBe(false);
    await act(async () => current.submit());
    expect(current.value).toBe("keep draft");
    expect(chat.messages).toHaveLength(1);
  });

  it("checks the actual chat before clearing input when bridge status is stale", async () => {
    await mount();
    expect(current.canSend).toBe(true);
    setPendingApproval();
    await act(async () => current.submit());
    expect(current.value).toBe("keep draft");
    expect(chat.messages).toHaveLength(1);
  });

  it("still submits ordinary messages", async () => {
    await mount();
    await act(async () => current.submit());
    await vi.waitFor(() =>
      expect(chat.messages[0]).toMatchObject({
        role: "user",
        parts: [{ type: "text", text: "keep draft" }],
      }),
    );
    expect(current.value).toBe("");
  });

  it("retains the draft when the restored chat has pending approvals", async () => {
    setPendingApproval();
    seedMessages.set("session", chat.messages);
    chats.clear();
    await mount();
    await act(async () => current.submit());
    expect(current.value).toBe("keep draft");
    expect(getOrCreateChat("session").messages).toHaveLength(1);
  });
});
