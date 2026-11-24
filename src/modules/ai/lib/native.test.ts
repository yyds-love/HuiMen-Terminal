import type { WorkspaceEnv } from "@/modules/workspace";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../tools/context";
import { buildEditTools } from "../tools/edit";
import { buildFsTools } from "../tools/fs";
import { buildSearchTools } from "../tools/search";
import { native } from "./native";

const mocks = vi.hoisted(() => ({
  invoke:
    vi.fn<
      (command: string, args?: Record<string, unknown>) => Promise<unknown>
    >(),
  workspace: { kind: "wsl", distro: "Ubuntu" } as WorkspaceEnv,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => mocks.workspace,
}));
const ctx: ToolContext = {
  getCwd: () => "/home/me/repo",
  getWorkspaceRoot: () => "/home/me/repo",
  getTerminalContext: () => null,
  isActiveTerminalPrivate: () => false,
  injectIntoActivePty: () => false,
  openPreview: () => false,
  spawnAgent: () => null,
  readAgentOutput: () => null,
  readCache: new Map(),
  getSessionId: () => null,
};
const options = { toolCallId: "test", messages: [] };
beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.workspace = { kind: "wsl", distro: "Ubuntu" };
  ctx.readCache.clear();
});

describe("AI native canonical path round-trip", () => {
  it.each([
    [
      "//wsl.localhost/Ubuntu/home/me/repo/src/main.ts",
      "/home/me/repo/src/main.ts",
    ],
    ["//wsl$/Ubuntu/home/me/repo", "/home/me/repo"],
    ["\\\\?\\UNC\\wsl.localhost\\Ubuntu\\home\\me\\repo", "/home/me/repo"],
    ["D:/Projects/repo/main.ts", "/mnt/d/Projects/repo/main.ts"],
    ["D:/", "/mnt/d/"],
    ["//wsl.localhost/Ubuntu/", "/"],
    ["/home/me/repo/main.ts", "/home/me/repo/main.ts"],
  ])("translates canonical input %s to workspace payload %s", async (canonical, expected) => {
    mocks.invoke.mockResolvedValue(canonical);
    expect(await native.canonicalize("/source")).toBe(canonical);
    await native.readFile(canonical);
    expect(mocks.invoke).toHaveBeenLastCalledWith("fs_read_file", {
      path: expected,
      workspace: mocks.workspace,
    });
  });

  it("leaves local canonical spelling unchanged", async () => {
    mocks.workspace = { kind: "local" };
    mocks.invoke.mockResolvedValue("D:/Projects/repo/main.ts");
    expect(await native.canonicalize("D:/link/main.ts")).toBe(
      "D:/Projects/repo/main.ts",
    );
  });

  it("rejects a canonical UNC target in another WSL distribution", async () => {
    mocks.invoke.mockResolvedValue("//wsl.localhost/Debian/home/me/alias");
    await expect(
      native.readFile("//wsl.localhost/Debian/home/me/alias"),
    ).rejects.toThrow();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("workspace-bound AI read/search execution", () => {
  it("keeps WSL normal reads working after host-path canonicalization", async () => {
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === "fs_canonicalize")
        return "//wsl.localhost/Ubuntu/home/me/repo/main.ts";
      if (command === "fs_read_file" && args?.path === "/home/me/repo/main.ts")
        return { kind: "text", content: "safe", size: 4 };
      throw new Error("incorrect workspace path");
    });
    const tool = buildFsTools(ctx).read_file;
    if (!tool.execute) throw new Error("Missing executor");
    expect(await tool.execute({ path: "main.ts" }, options)).toMatchObject({
      content: "safe",
    });
  });

  it("keeps grep roots and result checks in workspace path form", async () => {
    const hit = {
      path: "/home/me/repo/main.ts",
      rel: "main.ts",
      line: 1,
      text: "safe",
    };
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === "fs_canonicalize")
        return `//wsl.localhost/Ubuntu${args?.path}`;
      if (command === "fs_grep" && args?.root === "/home/me/repo")
        return { hits: [hit], truncated: false, files_scanned: 1 };
      throw new Error("incorrect workspace path");
    });
    const tool = buildSearchTools(ctx).grep;
    if (!tool.execute) throw new Error("Missing executor");
    expect(await tool.execute({ pattern: "safe" }, options)).toMatchObject({
      hits: [hit],
    });
  });

  it("does not read after a WSL alias resolves into protected credentials", async () => {
    mocks.invoke.mockResolvedValue(
      "//wsl.localhost/Ubuntu/home/me/.codex/auth.json",
    );
    const tool = buildFsTools(ctx).read_file;
    if (!tool.execute) throw new Error("Missing executor");
    expect(await tool.execute({ path: "alias.txt" }, options)).toHaveProperty(
      "error",
    );
    expect(
      mocks.invoke.mock.calls.every(
        ([command]) => command === "fs_canonicalize",
      ),
    ).toBe(true);
  });

  it("uses the original workspace if the user switches while a read is being checked", async () => {
    const workspace = mocks.workspace;
    mocks.invoke.mockImplementation(async (command) => {
      if (command === "fs_canonicalize") {
        mocks.workspace = { kind: "wsl", distro: "Debian" };
        return "//wsl.localhost/Ubuntu/home/me/repo/main.ts";
      }
      return { kind: "text", content: "safe", size: 4 };
    });
    const tool = buildFsTools(ctx).read_file;
    if (!tool.execute) throw new Error("Missing executor");
    await tool.execute({ path: "main.ts" }, options);
    expect(mocks.invoke).toHaveBeenCalledWith("fs_read_file", {
      path: "/home/me/repo/main.ts",
      workspace,
    });
  });

  it("uses one workspace for the root, native search and all result checks", async () => {
    const workspace = mocks.workspace;
    const hit = {
      path: "/home/me/repo/main.ts",
      rel: "main.ts",
      line: 1,
      text: "safe",
    };
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === "fs_canonicalize")
        return `//wsl.localhost/Ubuntu${args?.path}`;
      if (command === "fs_grep") {
        mocks.workspace = { kind: "wsl", distro: "Debian" };
        return { hits: [hit], truncated: false, files_scanned: 1 };
      }
      throw new Error("unexpected command");
    });
    const tool = buildSearchTools(ctx).grep;
    if (!tool.execute) throw new Error("Missing executor");
    expect(await tool.execute({ pattern: "safe" }, options)).toMatchObject({
      hits: [hit],
    });
    for (const [, args] of mocks.invoke.mock.calls)
      expect(args?.workspace).toEqual(workspace);
  });
});

describe("preserving canonical identity across WSL workspaces", () => {
  it("does not reuse unchanged-content cache entries across distributions", async () => {
    mocks.invoke.mockImplementation(async (command, args) => {
      const workspace = args?.workspace as { distro: string };
      if (command === "fs_canonicalize")
        return `//wsl.localhost/${workspace.distro}/home/me/repo/main.ts`;
      if (command === "fs_read_file")
        return { kind: "text", content: "old", size: 3 };
      throw new Error("unexpected command");
    });
    const tool = buildFsTools(ctx).read_file;
    if (!tool.execute) throw new Error("Missing executor");
    expect(await tool.execute({ path: "main.ts" }, options)).toHaveProperty(
      "content",
      "old",
    );
    mocks.workspace = { kind: "wsl", distro: "Debian" };
    expect(await tool.execute({ path: "main.ts" }, options)).toHaveProperty(
      "content",
      "old",
    );
    expect(ctx.readCache.size).toBe(2);
  });

  it("requires reading the destination workspace before editing its same-named file", async () => {
    mocks.invoke.mockImplementation(async (command, args) => {
      const workspace = args?.workspace as { distro: string };
      if (command === "fs_canonicalize")
        return `//wsl.localhost/${workspace.distro}/home/me/repo/main.ts`;
      if (command === "fs_read_file")
        return { kind: "text", content: "old", size: 3 };
      if (command === "fs_write_file") return undefined;
      throw new Error("unexpected command");
    });
    const read = buildFsTools(ctx).read_file;
    if (!read.execute) throw new Error("Missing executor");
    await read.execute({ path: "main.ts" }, options);
    mocks.workspace = { kind: "wsl", distro: "Debian" };
    const edit = buildEditTools(ctx).edit;
    if (!edit.execute) throw new Error("Missing executor");
    const result = await edit.execute(
      { path: "main.ts", old_string: "old", new_string: "new" },
      options,
    );
    expect(result).toMatchObject({
      error: expect.stringContaining("read_file"),
    });
    expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === "fs_write_file",
      ),
    ).toHaveLength(0);
  });

  it("does not fall back to an unverified write for an unrepresentable canonical target", async () => {
    mocks.invoke.mockImplementation(async (command) => {
      if (command === "fs_canonicalize")
        return "//wsl.localhost/Debian/home/me/repo/main.ts";
      if (command === "fs_write_file") return undefined;
      throw new Error("unexpected command");
    });
    const write = buildFsTools(ctx).write_file;
    if (!write.execute) throw new Error("Missing executor");
    expect(
      await write.execute({ path: "main.ts", content: "new" }, options),
    ).toHaveProperty("error");
    expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === "fs_write_file",
      ),
    ).toHaveLength(0);
  });
});

describe("filesystem adapter compatibility", () => {
  const path = "//wsl.localhost/Ubuntu/home/me/repo/main.ts";
  it.each([
    ["write", "fs_write_file", () => native.writeFile(path, "safe")],
    ["create file", "fs_create_file", () => native.createFile(path)],
    ["create directory", "fs_create_dir", () => native.createDir(path)],
    ["list directory", "fs_read_dir", () => native.readDir(path)],
    ["canonicalize", "fs_canonicalize", () => native.canonicalize(path)],
    ["grep", "fs_grep", () => native.grep({ pattern: "safe", root: path })],
    ["glob", "fs_glob", () => native.glob({ pattern: "*.ts", root: path })],
  ] as const)("translates host canonical input for %s", async (_label, command, run) => {
    mocks.invoke.mockResolvedValue(undefined);
    await run();
    expect(mocks.invoke).toHaveBeenCalledWith(
      command,
      expect.objectContaining({
        [command === "fs_grep" || command === "fs_glob" ? "root" : "path"]:
          "/home/me/repo/main.ts",
        workspace: { kind: "wsl", distro: "Ubuntu" },
      }),
    );
  });

  it("continues to edit a file read in the same workspace", async () => {
    mocks.invoke.mockImplementation(async (command) => {
      if (command === "fs_canonicalize") return path;
      if (command === "fs_read_file")
        return { kind: "text", content: "old", size: 3 };
      if (command === "fs_write_file") return undefined;
      throw new Error("unexpected command");
    });
    const read = buildFsTools(ctx).read_file;
    const edit = buildEditTools(ctx).edit;
    if (!read.execute || !edit.execute) throw new Error("Missing executor");
    await read.execute({ path: "main.ts" }, options);
    expect(
      await edit.execute(
        { path: "main.ts", old_string: "old", new_string: "new" },
        options,
      ),
    ).toMatchObject({ ok: true, replacements: 1 });
    expect(mocks.invoke).toHaveBeenCalledWith("fs_write_file", {
      path: "/home/me/repo/main.ts",
      content: "new",
      workspace: mocks.workspace,
    });
  });
});
