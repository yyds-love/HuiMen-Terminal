vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
}));

import { beforeEach, describe, expect, it, vi } from "vitest";
import { type GrepHit, native } from "../lib/native";
import type { ToolContext } from "./context";
import { buildSearchTools } from "./search";

vi.mock("../lib/native", () => ({
  native: { canonicalize: vi.fn(), grep: vi.fn(), glob: vi.fn() },
}));
let workspace: string | null;
let cwd: string | null;
const ctx: ToolContext = {
  getCwd: () => cwd,
  getWorkspaceRoot: () => workspace,
  getTerminalContext: () => null,
  isActiveTerminalPrivate: () => false,
  injectIntoActivePty: () => false,
  openPreview: () => false,
  spawnAgent: () => null,
  readAgentOutput: () => null,
  readCache: new Map(),
  getSessionId: () => null,
};
const tools = buildSearchTools(ctx);
const options = { toolCallId: "test", messages: [] };
async function grep(input: {
  pattern: string;
  root?: string;
  max_results?: number;
  glob?: string[];
}) {
  if (!tools.grep.execute) throw new Error("Missing grep executor");
  return tools.grep.execute(input, options);
}
async function glob(input: { pattern: string; root?: string }) {
  if (!tools.glob.execute) throw new Error("Missing glob executor");
  return tools.glob.execute(input, options);
}
function hit(path: string, text = "SYNTHETIC_SECRET", line = 1): GrepHit {
  return { path, rel: path.slice("/repo/".length), line, text };
}
beforeEach(() => {
  vi.resetAllMocks();
  workspace = "/repo";
  cwd = "/repo/work";
  vi.mocked(native.canonicalize).mockImplementation(async (path) => path);
  vi.mocked(native.grep).mockResolvedValue({
    hits: [],
    truncated: false,
    files_scanned: 0,
  });
  vi.mocked(native.glob).mockResolvedValue({ hits: [], truncated: false });
});

describe("AI grep result safety", () => {
  it("filters protected files while preserving normal hits and metadata", async () => {
    const safe = hit("/repo/src/main.ts", "export const value = 1;", 7);
    vi.mocked(native.grep).mockResolvedValue({
      hits: [
        hit("/repo/server.key"),
        safe,
        hit("/repo/secrets.json"),
        hit("/repo/.claude/settings.json"),
      ],
      truncated: false,
      files_scanned: 4,
    });
    const result = await grep({ pattern: "value" });
    expect(result).toEqual({
      root: "/repo",
      hits: [safe],
      truncated: false,
      files_scanned: 4,
    });
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_SECRET");
  });

  it("filters a seemingly safe path whose canonical target contains credentials", async () => {
    vi.mocked(native.canonicalize).mockImplementation(async (path) =>
      path === "/repo/alias.txt" ? "/home/me/.codex/auth.json" : path,
    );
    vi.mocked(native.grep).mockResolvedValue({
      hits: [hit("/repo/alias.txt")],
      truncated: false,
      files_scanned: 1,
    });
    expect(await grep({ pattern: "token" })).toMatchObject({ hits: [] });
  });

  it("filters files whose canonical path cannot be verified", async () => {
    vi.mocked(native.canonicalize).mockImplementation(async (path) => {
      if (path === "/repo/unverifiable.txt") throw new Error("unavailable");
      return path;
    });
    const safe = hit("/repo/main.ts", "safe");
    vi.mocked(native.grep).mockResolvedValue({
      hits: [hit("/repo/unverifiable.txt"), safe],
      truncated: false,
      files_scanned: 2,
    });
    expect(await grep({ pattern: "text" })).toMatchObject({ hits: [safe] });
  });

  it("checks each unique file once while preserving multiple lines in native order", async () => {
    const hits = [
      hit("/repo/main.ts", "one", 1),
      hit("/repo/other.ts", "other", 2),
      hit("/repo/main.ts", "three", 3),
    ];
    vi.mocked(native.grep).mockResolvedValue({
      hits,
      truncated: false,
      files_scanned: 2,
    });
    expect(await grep({ pattern: "." })).toMatchObject({ hits });
    expect(native.canonicalize).toHaveBeenCalledTimes(3);
    expect(native.canonicalize).toHaveBeenCalledWith("/repo/main.ts", {
      kind: "local",
    });
    expect(native.canonicalize).toHaveBeenCalledWith("/repo/other.ts", {
      kind: "local",
    });
  });

  it("does not reuse file checks across search requests", async () => {
    vi.mocked(native.grep).mockResolvedValue({
      hits: [hit("/repo/alias.ts", "first")],
      truncated: false,
      files_scanned: 1,
    });
    expect(await grep({ pattern: "." })).toMatchObject({
      hits: [{ text: "first" }],
    });
    vi.mocked(native.canonicalize).mockImplementation(async (path) =>
      path === "/repo/alias.ts" ? "/home/me/.ssh/id_rsa" : path,
    );
    expect(await grep({ pattern: "." })).toMatchObject({ hits: [] });
  });

  it("preserves truncation when an entire result batch is protected", async () => {
    vi.mocked(native.grep).mockResolvedValue({
      hits: [hit("/repo/server.key")],
      truncated: true,
      files_scanned: 1,
    });
    expect(await grep({ pattern: ".", max_results: 1 })).toMatchObject({
      hits: [],
      truncated: true,
    });
  });

  it("retains line clipping and forwards search options", async () => {
    vi.mocked(native.grep).mockResolvedValue({
      hits: [hit("/repo/main.ts", "x".repeat(170))],
      truncated: false,
      files_scanned: 1,
    });
    expect(
      await grep({ pattern: "x", glob: ["**/*.ts"], max_results: 10 }),
    ).toMatchObject({ hits: [{ text: `${"x".repeat(160)}…[+10]` }] });
    expect(native.grep).toHaveBeenCalledWith(
      {
        pattern: "x",
        root: "/repo",
        glob: ["**/*.ts"],
        caseInsensitive: undefined,
        maxResults: 10,
      },
      { kind: "local" },
    );
  });

  it.each([
    "/home/me/.ssh",
    "/home/me/.codex/auth.json",
  ])("does not run a search against protected root %s", async (root) => {
    expect(await grep({ pattern: ".", root })).toHaveProperty("error");
    expect(native.grep).not.toHaveBeenCalled();
  });

  it("denies unverified search roots before invoking native search", async () => {
    vi.mocked(native.canonicalize).mockRejectedValue(new Error("failed"));
    expect(await grep({ pattern: "." })).toHaveProperty("error");
    expect(native.grep).not.toHaveBeenCalled();
  });

  it("resolves an explicit relative root using the terminal cwd", async () => {
    expect(await grep({ pattern: ".", root: "src" })).toMatchObject({
      root: "/repo/work/src",
    });
  });

  it("handles missing context and native errors without dropping the root", async () => {
    workspace = null;
    cwd = null;
    expect(await grep({ pattern: "." })).toHaveProperty("error");
    expect(native.grep).not.toHaveBeenCalled();
    workspace = "/repo";
    vi.mocked(native.grep).mockRejectedValue(new Error("bad regex"));
    expect(await grep({ pattern: "[" })).toMatchObject({
      root: "/repo",
      error: "Error: bad regex",
    });
  });
});

describe("AI glob result safety", () => {
  it("applies the same per-file policy to names returned by glob", async () => {
    const safe = { path: "/repo/src/main.ts", rel: "src/main.ts" };
    vi.mocked(native.glob).mockResolvedValue({
      hits: [{ path: "/repo/server.key", rel: "server.key" }, safe],
      truncated: true,
    });
    expect(await glob({ pattern: "**/*" })).toEqual({
      root: "/repo",
      hits: [safe],
      truncated: true,
    });
  });

  it("does not expose aliases or unverified glob candidates", async () => {
    vi.mocked(native.canonicalize).mockImplementation(async (path) => {
      if (path === "/repo/failed.txt") throw new Error("failed");
      return path === "/repo/alias.txt"
        ? "/home/me/.claude/settings.json"
        : path;
    });
    vi.mocked(native.glob).mockResolvedValue({
      hits: ["alias.txt", "failed.txt"].map((rel) => ({
        path: `/repo/${rel}`,
        rel,
      })),
      truncated: false,
    });
    expect(await glob({ pattern: "**/*" })).toMatchObject({ hits: [] });
  });
});
