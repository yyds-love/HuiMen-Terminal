import type { UIMessage } from "ai";

// The composer loads eagerly; keep the SDK itself behind the runtime import.
export function hasPendingToolApprovals(
  messages: readonly UIMessage[],
): boolean {
  return messages.some((message) =>
    message.parts.some(
      (part) =>
        (part.type === "dynamic-tool" || part.type.startsWith("tool-")) &&
        "state" in part &&
        (part.state === "approval-requested" ||
          part.state === "approval-responded"),
    ),
  );
}

export function settleInterruptedToolApprovals(
  messages: UIMessage[],
): UIMessage[] {
  let changed = false;
  const settled = messages.map((message) => {
    let messageChanged = false;
    const parts = message.parts.map((part) => {
      if (!("state" in part) || part.state !== "approval-responded")
        return part;
      changed = true;
      messageChanged = true;
      if (!part.approval.approved) {
        return {
          ...part,
          state: "output-denied" as const,
          approval: { ...part.approval, approved: false as const },
        };
      }
      return {
        ...part,
        state: "output-error" as const,
        errorText:
          "工具执行被中断，结果未知。请先检查当前状态，再决定是否重试。",
        approval: { ...part.approval, approved: true as const },
      };
    });
    return messageChanged ? { ...message, parts } : message;
  });
  return changed ? settled : messages;
}
