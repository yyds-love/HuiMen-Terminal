vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
}));

import { beforeEach, describe, expect, it, vi } from "vitest";
import { native } from "../lib/native";
import { resolvePath, type ToolContext } from "./context";
import { buildFsTools } from "./fs";

vi.mock("../lib/native", () => ({
  native: { canonicalize: vi.fn(), readFile: vi.fn(), readDir: vi.fn() },
}));
const ctx: ToolContext = {
  getCwd: () => "/repo",
  getWorkspaceRoot: () => "/repo",
  getTerminalContext: () => null,
  isActiveTerminalPrivate: () => false,
  injectIntoActivePty: () => false,
  openPreview: () => false,
  spawnAgent: () => null,
  readAgentOutput: () => null,
  readCache: new Map(),
  getSessionId: () => null,
};
const tools = buildFsTools(ctx);
const options = { toolCallId: "test", messages: [] };
async function read(path: string) {
  if (!tools.read_file.execute) throw new Error("Missing read executor");
  return tools.read_file.execute({ path }, options);
}
beforeEach(() => {
  vi.resetAllMocks();
  ctx.readCache.clear();
  vi.mocked(native.canonicalize).mockImplementation(async (path) => path);
  vi.mocked(native.readFile).mockResolvedValue({
    kind: "text",
    content: "safe source",
    size: 11,
  });
});

describe("AI read_file safety integration", () => {
  it.each([
    "/home/me/.codex/auth.json",
    "/repo/.claude/settings.json",
    "/home/me/.xuya/agent-providers.sqlite",
  ])("does not read protected literal %s", async (path) => {
    expect(await read(path)).toHaveProperty("error");
    expect(native.readFile).not.toHaveBeenCalled();
    expect(native.canonicalize).not.toHaveBeenCalled();
  });

  it.each([
    "alias.txt",
    "src/../../.codex/auth.json",
  ])("rejects protected canonical target of %s", async (path) => {
    vi.mocked(native.canonicalize).mockResolvedValue(
      "/home/me/.codex/auth.json",
    );
    expect(await read(path)).toHaveProperty("error");
    expect(native.readFile).not.toHaveBeenCalled();
  });

  it("does not fall back to reading an unverified original path", async () => {
    vi.mocked(native.canonicalize).mockRejectedValue(new Error("failed"));
    expect(await read("alias.txt")).toHaveProperty("error");
    expect(native.readFile).not.toHaveBeenCalled();
  });

  it("preserves ordinary reads, canonical paths, and unchanged-content caching", async () => {
    vi.mocked(native.canonicalize).mockResolvedValue("/repo/src/main.ts");
    expect(await read("link.ts")).toMatchObject({
      path: "/repo/src/main.ts",
      content: "safe source",
    });
    expect(native.readFile).toHaveBeenLastCalledWith("/repo/src/main.ts", {
      kind: "local",
    });
    expect(await read("link.ts")).toMatchObject({ unchanged: true });
  });

  it("continues to allow ordinary absolute paths outside the project", async () => {
    expect(await read("/home/me/Documents/notes.txt")).toHaveProperty(
      "content",
      "safe source",
    );
  });
});

describe("list_directory canonical read policy", () => {
  it("blocks directory aliases into protected configuration", async () => {
    vi.mocked(native.canonicalize).mockResolvedValue("/home/me/.ssh");
    if (!tools.list_directory.execute) throw new Error("Missing executor");
    expect(
      await tools.list_directory.execute({ path: "alias" }, options),
    ).toHaveProperty("error");
    expect(native.readDir).not.toHaveBeenCalled();
  });

  it("does not list a directory after failed canonicalization", async () => {
    vi.mocked(native.canonicalize).mockRejectedValue(new Error("failed"));
    if (!tools.list_directory.execute) throw new Error("Missing executor");
    expect(
      await tools.list_directory.execute({ path: "alias" }, options),
    ).toHaveProperty("error");
    expect(native.readDir).not.toHaveBeenCalled();
  });

  it("preserves normal directory listings", async () => {
    vi.mocked(native.readDir).mockResolvedValue([
      { name: "main.ts", kind: "file", size: 10, mtime: 0 },
    ]);
    if (!tools.list_directory.execute) throw new Error("Missing executor");
    expect(
      await tools.list_directory.execute({ path: "src" }, options),
    ).toEqual({
      path: "/repo/src",
      entries: [{ name: "main.ts", kind: "file" }],
    });
  });
});
describe("Windows absolute path resolution", () => {
  it.each([
    "\\\\server\\share\\repo\\main.ts",
    "\\\\?\\C:\\repo\\main.ts",
    "C:\\repo\\main.ts",
    "//server/share/main.ts",
  ])("preserves absolute path %s", (path) => {
    expect(resolvePath(path, "D:\\work")).toBe(path);
    expect(resolvePath(path, null)).toBe(path);
  });
});
