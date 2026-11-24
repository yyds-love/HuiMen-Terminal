import { usePreferencesStore } from "@/modules/settings/preferences";
import { currentWorkspaceEnv, type WorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type ReadResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

export type DocumentState =
  | { status: "loading" }
  | { status: "ready"; content: string; size: number }
  | { status: "binary"; size: number }
  | { status: "toolarge"; size: number; limit: number }
  | { status: "error"; message: string };

type Options = {
  path: string;
  onDirtyChange?: (dirty: boolean) => void;
};

type DocumentSession = {
  path: string;
  workspace: WorkspaceEnv;
  active: boolean;
  doc: DocumentState;
  saved: string;
  buffer: string;
  editRevision: number;
  readVersion: number;
  pendingWrites: number;
  timer: ReturnType<typeof setTimeout> | null;
};

const LOADING: DocumentState = { status: "loading" };
// Keep in-flight writes ordered even if a tab is closed and reopened.
const pendingFileWrites = new Map<string, Promise<void>>();

function fileKey({ path, workspace }: DocumentSession): string {
  return JSON.stringify([
    workspace.kind,
    workspace.kind === "wsl" ? workspace.distro : null,
    path,
  ]);
}

function isDirty(session: DocumentSession): boolean {
  // Even an undo to saved text is unsafe while another snapshot may reach disk.
  return session.buffer !== session.saved || session.pendingWrites > 0;
}

export function useDocument({ path, onDirtyChange }: Options) {
  const session = useMemo<DocumentSession>(
    () => ({
      path,
      workspace: { ...currentWorkspaceEnv() },
      active: false,
      doc: LOADING,
      saved: "",
      buffer: "",
      editRevision: 0,
      readVersion: 0,
      pendingWrites: 0,
      timer: null,
    }),
    [path],
  );
  const [state, setState] = useState({ session, doc: LOADING, dirty: false });
  const publishedRef = useRef(state);
  // Do not expose the previous file's content during a path-change render.
  const doc = state.session === session ? state.doc : LOADING;
  const dirty = state.session === session && state.dirty;
  const publish = useCallback(() => {
    if (!session.active) return;
    const nextDirty = isDirty(session);
    const previous = publishedRef.current;
    // Buffer-only changes must not rerender the editor on every keystroke.
    if (
      previous.session === session &&
      previous.doc === session.doc &&
      previous.dirty === nextDirty
    ) {
      return;
    }
    const next = { session, doc: session.doc, dirty: nextDirty };
    publishedRef.current = next;
    setState(next);
  }, [session]);

  const autoSave = usePreferencesStore((s) => s.editorAutoSave);
  const autoSaveDelay = usePreferencesStore((s) => s.editorAutoSaveDelay);
  const autoSaveRef = useRef({ autoSave, autoSaveDelay });
  autoSaveRef.current = { autoSave, autoSaveDelay };

  const clearAutoSaveTimer = useCallback(() => {
    if (session.timer !== null) {
      clearTimeout(session.timer);
      session.timer = null;
    }
  }, [session]);

  const saveNow = useCallback((): Promise<void> => {
    if (
      !session.active ||
      session.doc.status !== "ready" ||
      !isDirty(session)
    ) {
      return Promise.resolve();
    }
    const content = session.buffer;
    // A save invalidates any read started before it, including watcher reloads.
    session.readVersion += 1;
    session.pendingWrites += 1;
    publish();
    const key = fileKey(session);
    const previousWrite = pendingFileWrites.get(key) ?? Promise.resolve();
    const write = previousWrite
      .then(async () => {
        // Already-started IPC cannot be cancelled; discard only queued writes.
        if (!session.active || content === session.saved) return;
        await invoke("fs_write_file", {
          path: session.path,
          content,
          workspace: session.workspace,
          source: "editor",
        });
        if (session.active) session.saved = content;
      })
      .finally(() => {
        session.pendingWrites -= 1;
        publish();
      });
    // Recover the queue, but preserve rejection for the caller to handle.
    const tail = write.catch(() => {});
    pendingFileWrites.set(key, tail);
    void tail.then(() => {
      if (pendingFileWrites.get(key) === tail) pendingFileWrites.delete(key);
    });
    return write;
  }, [session, publish]);

  const read = useCallback(() => {
    const version = ++session.readVersion;
    const revision = session.editRevision;
    const canApply = () =>
      session.active &&
      version === session.readVersion &&
      revision === session.editRevision &&
      !isDirty(session);
    const pendingWrite = pendingFileWrites.get(fileKey(session));
    const load = async () => {
      try {
        // Reopened tabs must read after an older lifecycle's native write.
        if (pendingWrite) await pendingWrite;
        if (!canApply()) return;
        const res = await invoke<ReadResult>("fs_read_file", {
          path: session.path,
          workspace: session.workspace,
        });
        if (!canApply()) return;
        if (res.kind === "text") {
          // Duplicate watcher events must not reset CodeMirror's undo state.
          if (session.doc.status === "ready" && res.content === session.saved) {
            return;
          }
          session.saved = res.content;
          session.buffer = res.content;
          session.doc = {
            status: "ready",
            content: res.content,
            size: res.size,
          };
        } else if (res.kind === "binary") {
          session.doc = { status: "binary", size: res.size };
        } else {
          session.doc = {
            status: "toolarge",
            size: res.size,
            limit: res.limit,
          };
        }
        publish();
      } catch (error) {
        if (!canApply()) return;
        if (session.doc.status === "ready") {
          // A transient watcher/read failure must not unmount an editable view.
          console.error("[editor reload]", error);
          return;
        }
        session.doc = { status: "error", message: String(error) };
        publish();
      }
    };
    void load();
  }, [session, publish]);

  useEffect(() => {
    session.active = true;
    publish();
    read();
    return () => {
      session.active = false;
      session.readVersion += 1;
      clearAutoSaveTimer();
    };
  }, [session, publish, read, clearAutoSaveTimer]);

  const onDirtyChangeRef = useRef(onDirtyChange);
  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
  }, [onDirtyChange]);
  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);

  const reload = useCallback((): boolean => {
    if (!session.active || isDirty(session)) return false;
    read();
    return true;
  }, [session, read]);

  const save = useCallback(() => {
    clearAutoSaveTimer();
    return saveNow();
  }, [clearAutoSaveTimer, saveNow]);

  const onChange = useCallback(
    (next: string) => {
      if (!session.active || session.doc.status !== "ready") return;
      if (next !== session.buffer) session.editRevision += 1;
      session.buffer = next;
      publish();
      clearAutoSaveTimer();
      const { autoSave: active, autoSaveDelay: delay } = autoSaveRef.current;
      if (active && isDirty(session)) {
        session.timer = setTimeout(() => {
          session.timer = null;
          saveNow().catch((error) => console.error("[autosave]", error));
        }, delay);
      }
    },
    [session, publish, clearAutoSaveTimer, saveNow],
  );

  useEffect(() => {
    if (!autoSave) clearAutoSaveTimer();
  }, [autoSave, clearAutoSaveTimer]);

  return { doc, dirty, onChange, save, reload };
}
