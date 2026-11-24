import { IS_LINUX } from "@/lib/platform";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useRef, useState } from "react";
import { checkLinuxRelease } from "./linuxRelease";
import { installUpdate } from "./native";
import { getReleaseRepository } from "./releaseConfig";

const LAST_CHECK_KEY = "xuya:updater:last-check";
const CHECK_INTERVAL_MS = 30 * 60 * 1000;

export interface ManualUpdateInfo {
  version: string;
  currentVersion: string;
  body: string;
  releaseUrl: string;
}
export type UpdaterStatus =
  | { kind: "idle" | "unconfigured" | "checking" | "uptodate" | "installing" }
  | { kind: "available"; update: Update }
  | { kind: "manual-available"; info: ManualUpdateInfo }
  | { kind: "downloading"; downloaded: number; contentLength: number | null }
  | { kind: "ready"; message?: string }
  | { kind: "error"; message: string; retryInstall?: boolean };

async function closeUpdate(update: Update | null): Promise<void> {
  try {
    await update?.close();
  } catch {
    console.error("Failed to release an update resource.");
  }
}
function recentlyChecked(): boolean {
  try {
    const elapsed =
      Date.now() - Number(localStorage.getItem(LAST_CHECK_KEY) ?? 0);
    return elapsed >= 0 && elapsed < CHECK_INTERVAL_MS;
  } catch {
    return false;
  }
}
function recordCheck(): void {
  try {
    localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
  } catch {
    /* Optional throttle must not prevent updates. */
  }
}

export function useUpdater({ autoCheck = true }: { autoCheck?: boolean } = {}) {
  const [status, setStatus] = useState<UpdaterStatus>({ kind: "idle" });
  const mounted = useRef(true);
  const operation = useRef<Promise<void> | null>(null);
  const update = useRef<Update | null>(null);
  const installed = useRef(false);
  const publish = useCallback((next: UpdaterStatus) => {
    if (mounted.current) setStatus(next);
  }, []);
  const runCheck = useCallback(
    ({ manual = false }: { manual?: boolean } = {}): Promise<void> => {
      if (operation.current) return operation.current;
      if (installed.current) return Promise.resolve();
      const repository = getReleaseRepository();
      if (!repository) {
        publish({ kind: "unconfigured" });
        return Promise.resolve();
      }
      if (!manual && recentlyChecked()) return Promise.resolve();
      publish({ kind: "checking" });
      operation.current = (async () => {
        const previous = update.current;
        update.current = null;
        await closeUpdate(previous);
        try {
          if (IS_LINUX) {
            const info = await checkLinuxRelease(
              repository,
              await getVersion(),
            );
            if (mounted.current)
              publish(
                info
                  ? { kind: "manual-available", info }
                  : { kind: "uptodate" },
              );
          } else {
            const result = await check({ timeout: 20_000 });
            if (!mounted.current) {
              await closeUpdate(result);
              return;
            }
            update.current = result;
            publish(
              result
                ? { kind: "available", update: result }
                : { kind: "uptodate" },
            );
          }
          recordCheck();
        } catch (error) {
          publish({ kind: "error", message: String(error) });
        }
      })().finally(() => {
        operation.current = null;
      });
      return operation.current;
    },
    [publish],
  );

  const install = useCallback((): Promise<void> => {
    if (operation.current) return operation.current;
    const selected = update.current;
    if (!installed.current && !selected) return Promise.resolve();
    operation.current = (async () => {
      if (!installed.current && selected) {
        let total: number | null = null;
        let downloaded = 0;
        publish({ kind: "downloading", downloaded, contentLength: total });
        try {
          await installUpdate(selected, (event) => {
            if (event.event === "Started") {
              total = event.data.contentLength ?? null;
              downloaded = 0;
            } else if (event.event === "Progress") {
              downloaded += event.data.chunkLength;
            } else if (event.event === "Finished") {
              publish({ kind: "installing" });
              return;
            }
            publish({ kind: "downloading", downloaded, contentLength: total });
          });
          installed.current = true;
          update.current = null;
          await closeUpdate(selected);
        } catch (error) {
          publish({
            kind: "error",
            message: String(error),
            retryInstall: true,
          });
          if (!mounted.current) {
            update.current = null;
            await closeUpdate(selected);
          }
          return;
        }
      }
      publish({ kind: "ready" });
      try {
        await relaunch();
      } catch (error) {
        publish({ kind: "ready", message: String(error) });
      }
    })().finally(() => {
      operation.current = null;
    });
    return operation.current;
  }, [publish]);
  const dismiss = useCallback(() => {
    if (operation.current || installed.current) return;
    const previous = update.current;
    update.current = null;
    void closeUpdate(previous);
    publish({ kind: "idle" });
  }, [publish]);
  useEffect(() => {
    mounted.current = true;
    if (autoCheck) void runCheck();
    return () => {
      mounted.current = false;
      if (!operation.current) {
        const previous = update.current;
        update.current = null;
        void closeUpdate(previous);
      }
    };
  }, [autoCheck, runCheck]);
  return { status, check: runCheck, install, dismiss };
}
