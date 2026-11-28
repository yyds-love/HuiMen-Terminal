import { quoteShellArg } from "@/lib/shellQuote";

export type AgentType = "claude" | "codex" | "opencode";

/** Command used to start a brand-new agent session. */
export function agentBareCommand(
  agent: AgentType,
  codexInlineScrollback = false,
): string {
  return agent === "codex" && codexInlineScrollback
    ? "codex --no-alt-screen"
    : agent;
}

/**
 * Resume command for reopening an agent tab. With a captured session id the
 * exact conversation is restored; without one we fall back to the agent's
 * own "resume most recent" behavior.
 *
 * Flags verified against current CLIs: `claude --resume <id>` / `--continue`,
 * `codex resume <id>` / `resume --last`, `opencode --session <id>` / `--continue`.
 */
export function agentResumeCommand(
  agent: AgentType,
  sessionId?: string,
  codexInlineScrollback = false,
): string {
  const id = sessionId ? quoteShellArg(sessionId) : "";
  switch (agent) {
    case "claude":
      return sessionId ? `claude --resume ${id}` : "claude --continue";
    case "codex":
      return `codex resume${codexInlineScrollback ? " --no-alt-screen" : ""} ${sessionId ? id : "--last"}`;
    case "opencode":
      return sessionId ? `opencode --session ${id}` : "opencode --continue";
  }
}
