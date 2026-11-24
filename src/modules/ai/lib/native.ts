import { currentWorkspaceEnv, type WorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";

export type ReadResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

export type DirEntry = {
  name: string;
  kind: "file" | "dir" | "symlink";
  size: number;
  mtime: number;
};

export type CommandOutput = {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  truncated: boolean;
};

export type GrepHit = {
  path: string;
  rel: string;
  line: number;
  text: string;
};

export type GrepResponse = {
  hits: GrepHit[];
  truncated: boolean;
  files_scanned: number;
};

export type GlobHit = { path: string; rel: string };
export type GlobResponse = { hits: GlobHit[]; truncated: boolean };

export type GitRepoInfo = {
  repoRoot: string;
  branch: string;
  upstream: string | null;
  isDetached: boolean;
};

export type GitChangedFile = {
  path: string;
  originalPath: string | null;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  statusLabel: string;
};

export type GitStatusSnapshot = {
  repoRoot: string;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  isDetached: boolean;
  truncated: boolean;
  changedFiles: GitChangedFile[];
};

export type GitDiffResult = {
  diffText: string;
  truncated: boolean;
};

export type GitDiffContentResult = {
  originalContent: string;
  modifiedContent: string;
  isBinary: boolean;
  fallbackPatch: string;
  truncated: boolean;
};

export type GitCommitResult = {
  commitSha: string;
  summary: string;
};

export type GitPushResult = {
  remote: string | null;
  branch: string | null;
  pushed: boolean;
};

export type GitLogEntry = {
  sha: string;
  shortSha: string;
  author: string;
  authorEmail: string;
  timestampSecs: number;
  parents: string[];
  subject: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
};

export type GitCommitFileChange = {
  path: string;
  originalPath: string | null;
  status: string;
  statusLabel: string;
  added: number;
  removed: number;
  isBinary: boolean;
};

export type GitPanelSnapshot = {
  repo: GitRepoInfo | null;
  status: GitStatusSnapshot | null;
};

export type GitDiscardEntry = {
  path: string;
  untracked: boolean;
};

// Keep canonical host identities in guards/caches; translate only IPC inputs.
// This prevents WSL double translation without merging files across distros.
function workspacePath(path: string, workspace: WorkspaceEnv): string {
  if (workspace.kind === "local") return path;
  const normalized = path
    .replace(/\\/g, "/")
    .replace(/^\/\/\?\/UNC\//i, "//")
    .replace(/^\/\/\?\//, "");
  const drive = /^([a-z]):\/(.*)$/i.exec(normalized);
  if (drive) return `/mnt/${drive[1].toLowerCase()}/${drive[2]}`;
  const unc = /^\/\/(?:wsl\.localhost|wsl\$)\/([^/]+)(\/.*)?$/i.exec(
    normalized,
  );
  if (unc && unc[1].toLowerCase() === workspace.distro.toLowerCase()) {
    return unc[2] || "/";
  }
  if (normalized.startsWith("/") && !normalized.startsWith("//")) {
    return normalized;
  }
  throw new Error("无法将真实路径映射到当前 WSL 工作区。");
}

export const native = {
  workspaceCurrentDir: () => invoke<string>("workspace_current_dir"),
  workspaceAuthorize: (path: string) =>
    invoke<string>("workspace_authorize", {
      path,
      workspace: currentWorkspaceEnv(),
    }),
  readFile: async (path: string, workspace = currentWorkspaceEnv()) =>
    invoke<ReadResult>("fs_read_file", {
      path: workspacePath(path, workspace),
      workspace,
    }),
  writeFile: async (
    path: string,
    content: string,
    workspace = currentWorkspaceEnv(),
  ) =>
    invoke<void>("fs_write_file", {
      path: workspacePath(path, workspace),
      content,
      workspace,
    }),
  canonicalize: async (path: string, workspace = currentWorkspaceEnv()) =>
    invoke<string>("fs_canonicalize", {
      path: workspacePath(path, workspace),
      workspace,
    }),
  createFile: async (path: string, workspace = currentWorkspaceEnv()) =>
    invoke<void>("fs_create_file", {
      path: workspacePath(path, workspace),
      workspace,
    }),
  createDir: async (path: string, workspace = currentWorkspaceEnv()) =>
    invoke<void>("fs_create_dir", {
      path: workspacePath(path, workspace),
      workspace,
    }),
  // AI tooling never sees dot-prefixed entries regardless of the user's
  // explorer preference — keeps .git / .env / .ssh out of agent context.
  readDir: async (path: string, workspace = currentWorkspaceEnv()) =>
    invoke<DirEntry[]>("fs_read_dir", {
      path: workspacePath(path, workspace),
      showHidden: false,
      workspace,
    }),
  grep: async (
    params: {
      pattern: string;
      root: string;
      glob?: string[];
      caseInsensitive?: boolean;
      maxResults?: number;
    },
    workspace = currentWorkspaceEnv(),
  ) =>
    invoke<GrepResponse>("fs_grep", {
      pattern: params.pattern,
      root: workspacePath(params.root, workspace),
      glob: params.glob ?? null,
      caseInsensitive: params.caseInsensitive ?? null,
      maxResults: params.maxResults ?? null,
      workspace,
    }),
  glob: async (
    params: { pattern: string; root: string; maxResults?: number },
    workspace = currentWorkspaceEnv(),
  ) =>
    invoke<GlobResponse>("fs_glob", {
      pattern: params.pattern,
      root: workspacePath(params.root, workspace),
      maxResults: params.maxResults ?? null,
      workspace,
    }),
  runCommand: (command: string, cwd?: string | null, timeoutSecs?: number) =>
    invoke<CommandOutput>("shell_run_command", {
      command,
      cwd: cwd ?? null,
      timeoutSecs: timeoutSecs ?? null,
      workspace: currentWorkspaceEnv(),
    }),

  shellSessionOpen: (cwd?: string | null) =>
    invoke<number>("shell_session_open", {
      cwd: cwd ?? null,
      workspace: currentWorkspaceEnv(),
    }),
  shellSessionRun: (
    id: number,
    command: string,
    cwd?: string | null,
    timeoutSecs?: number,
  ) =>
    invoke<{
      stdout: string;
      stderr: string;
      exit_code: number | null;
      timed_out: boolean;
      truncated: boolean;
      cwd_after: string;
    }>("shell_session_run", {
      id,
      command,
      cwd: cwd ?? null,
      timeoutSecs: timeoutSecs ?? null,
      workspace: currentWorkspaceEnv(),
    }),
  shellSessionClose: (id: number) =>
    invoke<void>("shell_session_close", { id }),
  shellBgSpawn: (command: string, cwd?: string | null) =>
    invoke<number>("shell_bg_spawn", {
      command,
      cwd: cwd ?? null,
      workspace: currentWorkspaceEnv(),
    }),
  shellBgLogs: (handle: number, sinceOffset?: number) =>
    invoke<{
      bytes: string;
      next_offset: number;
      dropped: number;
      exited: boolean;
      exit_code: number | null;
    }>("shell_bg_logs", { handle, sinceOffset: sinceOffset ?? null }),
  shellBgKill: (handle: number) => invoke<void>("shell_bg_kill", { handle }),
  shellBgList: () =>
    invoke<
      {
        handle: number;
        command: string;
        cwd: string | null;
        started_at_ms: number;
        exited: boolean;
        exit_code: number | null;
      }[]
    >("shell_bg_list"),
  gitResolveRepo: (cwd: string) =>
    invoke<GitRepoInfo | null>("git_resolve_repo", {
      cwd,
      workspace: currentWorkspaceEnv(),
    }),
  gitPanelSnapshot: (cwd: string) =>
    invoke<GitPanelSnapshot>("git_panel_snapshot", {
      cwd,
      workspace: currentWorkspaceEnv(),
    }),
  gitStatus: (repoRoot: string) =>
    invoke<GitStatusSnapshot>("git_status", {
      repoRoot,
      workspace: currentWorkspaceEnv(),
    }),
  gitDiff: (repoRoot: string, path: string | null, staged: boolean) =>
    invoke<GitDiffResult>("git_diff", {
      repoRoot,
      path,
      staged,
      workspace: currentWorkspaceEnv(),
    }),
  gitDiffContent: (
    repoRoot: string,
    path: string,
    staged: boolean,
    originalPath?: string | null,
  ) =>
    invoke<GitDiffContentResult>("git_diff_content", {
      repoRoot,
      path,
      staged,
      originalPath: originalPath ?? null,
      workspace: currentWorkspaceEnv(),
    }),
  gitStage: (repoRoot: string, paths: string[]) =>
    invoke<void>("git_stage", {
      repoRoot,
      paths,
      workspace: currentWorkspaceEnv(),
    }),
  gitUnstage: (repoRoot: string, paths: string[]) =>
    invoke<void>("git_unstage", {
      repoRoot,
      paths,
      workspace: currentWorkspaceEnv(),
    }),
  gitDiscard: (repoRoot: string, entries: GitDiscardEntry[]) =>
    invoke<void>("git_discard", {
      repoRoot,
      entries,
      workspace: currentWorkspaceEnv(),
    }),
  gitCommit: (repoRoot: string, message: string) =>
    invoke<GitCommitResult>("git_commit", {
      repoRoot,
      message,
      workspace: currentWorkspaceEnv(),
    }),
  gitFetch: (repoRoot: string) =>
    invoke<void>("git_fetch", {
      repoRoot,
      workspace: currentWorkspaceEnv(),
    }),
  gitPullFfOnly: (repoRoot: string) =>
    invoke<void>("git_pull_ff_only", {
      repoRoot,
      workspace: currentWorkspaceEnv(),
    }),
  gitPush: (repoRoot: string) =>
    invoke<GitPushResult>("git_push", {
      repoRoot,
      workspace: currentWorkspaceEnv(),
    }),
  gitLog: (
    repoRoot: string,
    options?: { limit?: number; beforeSha?: string },
  ) =>
    invoke<GitLogEntry[]>("git_log", {
      repoRoot,
      limit: options?.limit ?? null,
      beforeSha: options?.beforeSha ?? null,
      workspace: currentWorkspaceEnv(),
    }),
  gitShowCommit: (repoRoot: string, sha: string) =>
    invoke<GitDiffResult>("git_show_commit", {
      repoRoot,
      sha,
      workspace: currentWorkspaceEnv(),
    }),
  gitCommitFiles: (repoRoot: string, sha: string) =>
    invoke<GitCommitFileChange[]>("git_commit_files", {
      repoRoot,
      sha,
      workspace: currentWorkspaceEnv(),
    }),
  gitCommitFileDiff: (
    repoRoot: string,
    sha: string,
    path: string,
    originalPath?: string | null,
  ) =>
    invoke<GitDiffContentResult>("git_commit_file_diff", {
      repoRoot,
      sha,
      path,
      originalPath: originalPath ?? null,
      workspace: currentWorkspaceEnv(),
    }),
  gitRemoteUrl: (repoRoot: string, name?: string) =>
    invoke<string | null>("git_remote_url", {
      repoRoot,
      name: name ?? null,
      workspace: currentWorkspaceEnv(),
    }),
};
