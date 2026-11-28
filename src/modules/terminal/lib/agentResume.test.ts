import { describe, expect, it } from "vitest";
import { agentBareCommand, agentResumeCommand } from "./agentResume";

describe("Codex session commands", () => {
  it("uses inline mode with the compatible terminal scrollback strategy", () => {
    expect(agentBareCommand("codex", true)).toBe("codex --no-alt-screen");
    expect(agentResumeCommand("codex", "session-id", true)).toBe(
      "codex resume --no-alt-screen 'session-id'",
    );
    expect(agentResumeCommand("codex", undefined, true)).toBe(
      "codex resume --no-alt-screen --last",
    );
  });

  it("lets Codex choose its default screen mode in other sessions", () => {
    expect(agentBareCommand("codex")).toBe("codex");
    expect(agentResumeCommand("codex", "session-id")).toBe(
      "codex resume 'session-id'",
    );
    expect(agentResumeCommand("codex")).toBe("codex resume --last");
  });

  it("preserves other agent commands", () => {
    expect(agentBareCommand("claude", true)).toBe("claude");
    expect(agentResumeCommand("claude", "session-id", true)).toBe(
      "claude --resume 'session-id'",
    );
    expect(agentBareCommand("opencode", true)).toBe("opencode");
    expect(agentResumeCommand("opencode", "session-id", true)).toBe(
      "opencode --session 'session-id'",
    );
  });
});
