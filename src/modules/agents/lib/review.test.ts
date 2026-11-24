// @vitest-environment happy-dom

import { AgentRunBridge } from "@/modules/ai/components/AgentRunBridge";
import { chats, useChatStore } from "@/modules/ai/store/chatStore";
import { Chat } from "@ai-sdk/react";
import type { UIMessage, UIMessageChunk } from "ai";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/modules/ai/store/chatRuntime";
import { useManagedAgentsStore } from "../store/managedAgentsStore";
import {
  firePendingReviewForSession,
  maybeTriggerManagedReview,
} from "./review";

vi.mock("@tauri-apps/api/event", () => ({
  listen: async () => () => {},
}));
vi.mock("@/modules/ai/lib/sessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/ai/lib/sessions")>()),
  saveMessages: async () => {},
}));

let streams: ReadableStreamDefaultController<UIMessageChunk>[];
let requests: UIMessage[][];
let root: Root | undefined;

function makeChat(id = "session", hold = false) {
  const chat = new Chat<UIMessage>({
    id,
    transport: {
      async sendMessages({ messages }) {
        requests.push(messages);
        return new ReadableStream<UIMessageChunk>({
          start(controller) {
            if (hold) streams.push(controller);
            else controller.close();
          },
        });
      },
      async reconnectToStream() {
        return null;
      },
    },
  });
  chats.set(id, chat);
  return chat;
}

function register(leafId = 1, sessionId = "session") {
  useManagedAgentsStore.getState().register({
    leafId,
    tabId: leafId,
    sessionId,
    task: `Task ${leafId}`,
    cwd: "/repo",
  });
  useManagedAgentsStore.getState().setPhase(leafId, "working");
}

async function flushAttempt() {
  await vi.dynamicImportSettled();
}

async function mountBridge() {
  root = createRoot(document.createElement("div"));
  await act(async () => {
    root?.render(
      createElement(AgentRunBridge, {
        openAiDiffTab: () => null,
        closeAiDiffTab: () => {},
      }),
    );
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  streams = [];
  requests = [];
  chats.clear();
  useManagedAgentsStore.setState({ agents: {} });
  useChatStore.getState().resetAgentMeta();
  useChatStore.setState({ activeSessionId: "session" });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  for (const controller of streams) controller.close();
  await Promise.all([...chats.values()].map((chat) => chat.stop()));
  chats.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("managed agent review submission", () => {
  it.each([
    "approval-requested",
    "approval-responded",
  ] as const)("defers a review while a tool is %s without losing the approval", async (state) => {
    const chat = makeChat();
    chat.messages = [
      {
        id: "assistant",
        role: "assistant",
        parts: [
          state === "approval-requested"
            ? {
                type: "tool-write_file",
                toolCallId: "write",
                state,
                input: { path: "/repo/file.txt", content: "synthetic" },
                approval: { id: "approval" },
              }
            : {
                type: "tool-write_file",
                toolCallId: "write",
                state,
                input: { path: "/repo/file.txt", content: "synthetic" },
                approval: { id: "approval", approved: true },
              },
        ],
      },
    ];
    const original = JSON.stringify(chat.messages);
    register();
    maybeTriggerManagedReview(1);
    await flushAttempt();
    expect(requests).toHaveLength(0);
    expect(JSON.stringify(chat.messages)).toBe(original);
    expect(useManagedAgentsStore.getState().get(1)).toMatchObject({
      phase: "working",
      reviewedAtRound: -1,
      pendingReview: true,
    });
  });

  it("retries a busy session once after it becomes ready", async () => {
    const chat = makeChat("session", true);
    const initial = chat.sendMessage({
      role: "user",
      parts: [{ type: "text", text: "current request" }],
    });
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    register();
    maybeTriggerManagedReview(1);
    await flushAttempt();
    expect(requests).toHaveLength(1);
    expect(useManagedAgentsStore.getState().get(1)?.pendingReview).toBe(true);
    streams.shift()?.close();
    await initial;
    firePendingReviewForSession("session");
    firePendingReviewForSession("session");
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(useManagedAgentsStore.getState().get(1)).toMatchObject({
      phase: "reviewing",
      reviewedAtRound: 0,
      pendingReview: false,
    });
  });

  it("keeps a review pending if the active session changes during import", async () => {
    makeChat();
    register();
    maybeTriggerManagedReview(1);
    useChatStore.setState({ activeSessionId: "other" });
    await flushAttempt();
    expect(requests).toHaveLength(0);
    expect(useManagedAgentsStore.getState().get(1)?.pendingReview).toBe(true);
    useChatStore.setState({ activeSessionId: "session" });
    firePendingReviewForSession("session");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
  });

  it("retries pending agents in the same session after earlier agents finish", async () => {
    makeChat("session", true);
    register(1);
    register(2);
    useManagedAgentsStore.getState().markReviewed(1);
    useManagedAgentsStore.getState().setPendingReview(2, true);
    firePendingReviewForSession("session");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(JSON.stringify(requests[0])).toContain("Task 2");
    expect(useManagedAgentsStore.getState().get(2)?.pendingReview).toBe(false);
  });

  it("does not review a newer agent round from an older finished notification", async () => {
    makeChat();
    register();
    maybeTriggerManagedReview(1);
    useManagedAgentsStore.getState().bumpRound(1);
    await flushAttempt();
    expect(requests).toHaveLength(0);
    expect(useManagedAgentsStore.getState().get(1)?.reviewedAtRound).toBe(-1);
  });

  it("retries a pending review when the lifecycle bridge returns to idle", async () => {
    const chat = makeChat("session", true);
    const initial = chat.sendMessage({
      role: "user",
      parts: [{ type: "text", text: "current request" }],
    });
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    register();
    maybeTriggerManagedReview(1);
    await flushAttempt();
    expect(useManagedAgentsStore.getState().get(1)?.pendingReview).toBe(true);
    await mountBridge();
    await flushAttempt();
    await act(async () => {
      streams.shift()?.close();
      await initial;
    });
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(useManagedAgentsStore.getState().get(1)?.pendingReview).toBe(false);
  });

  it("notices a pending review even when a short request leaves bridge status idle", async () => {
    const chat = makeChat("session", true);
    register();
    await mountBridge();
    await act(async () => {
      const initial = chat.sendMessage({
        role: "user",
        parts: [{ type: "text", text: "short request" }],
      });
      maybeTriggerManagedReview(1);
      await flushAttempt();
      expect(useManagedAgentsStore.getState().get(1)?.pendingReview).toBe(true);
      streams.shift()?.close();
      await initial;
    });
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(useManagedAgentsStore.getState().get(1)?.pendingReview).toBe(false);
  });
});
