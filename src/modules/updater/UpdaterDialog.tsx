import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { openUrl } from "@tauri-apps/plugin-opener";
import { lazy, Suspense, useState } from "react";

// Lazy-loaded so streamdown (a heavy markdown renderer) stays out of the
// startup eager bundle (see src/app/eager-budget.test.ts). Only pays the cost
// when the release-notes region actually renders.
const Streamdown = lazy(() =>
  import("streamdown").then((m) => ({ default: m.Streamdown })),
);

import { useUpdater } from "./useUpdater";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function UpdaterDialog() {
  const { status, install, dismiss } = useUpdater();
  const [linkError, setLinkError] = useState("");
  const installError = status.kind === "error" && status.retryInstall;
  const open =
    status.kind === "available" ||
    status.kind === "manual-available" ||
    status.kind === "downloading" ||
    status.kind === "installing" ||
    status.kind === "ready" ||
    !!installError;

  if (!open) return null;

  const update = status.kind === "available" ? status.update : null;
  const manual = status.kind === "manual-available" ? status.info : null;
  const downloading = status.kind === "downloading";
  const installing = status.kind === "installing";
  const ready = status.kind === "ready";
  const progress =
    downloading && status.contentLength
      ? Math.min(100, (status.downloaded / status.contentLength) * 100)
      : null;

  const visitRelease = async (url: string) => {
    setLinkError("");
    try {
      await openUrl(url);
    } catch (error) {
      setLinkError(String(error));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (
          !o &&
          (status.kind === "available" ||
            status.kind === "manual-available" ||
            installError)
        )
          dismiss();
      }}
    >
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>
            {installError
              ? "更新安装失败"
              : installing
                ? "正在安装更新..."
                : ready
                  ? "更新就绪"
                  : downloading
                    ? "下载更新中..."
                    : manual
                      ? `XuYa Terminal v${manual.version} 可用`
                      : `XuYa Terminal v${update?.version} 可用`}
          </DialogTitle>
          <DialogDescription>
            {installError
              ? "更新未完成，请检查网络和错误信息后重试。"
              : installing
                ? "下载完成，正在验证并安装更新，请稍候。"
                : ready
                  ? "安装已完成。若未自动重启，请点击立即重启。"
                  : downloading
                    ? progress !== null
                      ? `${progress.toFixed(0)}% — ${formatBytes(status.downloaded)}`
                      : formatBytes(status.downloaded)
                    : manual
                      ? `当前版本 v${manual.currentVersion}。请下载适合你的发行版和架构的安装包，退出应用后手动安装。`
                      : "安装会关闭终端会话并重启应用，请先保存文件并结束运行中的任务。"}
          </DialogDescription>
        </DialogHeader>

        {/* Release notes arrive as Markdown (Tauri updater body / GitHub release
            body). Render via Streamdown in a scrollable region so a long
            changelog can't blow up the dialog. Hidden while downloading/ready
            where only progress matters. */}
        {!ready &&
          !downloading &&
          !installing &&
          (update?.body || manual?.body) && (
            <div className="max-h-[260px] overflow-auto rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-[13px]">
              <Suspense fallback={(update?.body ?? manual?.body) as string}>
                <Streamdown className="select-text prose-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                  {(update?.body ?? manual?.body) as string}
                </Streamdown>
              </Suspense>
            </div>
          )}

        {downloading && progress !== null && (
          <Progress value={progress} className="mt-2" />
        )}
        {downloading && progress === null && (
          <Progress value={undefined} className="mt-2 animate-pulse" />
        )}

        {(status.kind === "error" || status.kind === "ready") &&
          status.message && (
            <p role="alert" className="break-all text-xs text-destructive">
              {status.message}
            </p>
          )}

        {manual && linkError && (
          <p role="alert" className="break-all text-xs text-destructive">
            {linkError}
          </p>
        )}

        <DialogFooter>
          {installError && (
            <>
              <Button variant="ghost" size="sm" onClick={dismiss}>
                稍后
              </Button>
              <Button size="sm" onClick={() => void install()}>
                重试安装
              </Button>
            </>
          )}
          {ready && (
            <Button size="sm" onClick={() => void install()}>
              立即重启
            </Button>
          )}
          {status.kind === "available" && (
            <>
              <Button variant="ghost" size="sm" onClick={dismiss}>
                稍后
              </Button>
              <Button size="sm" onClick={() => void install()}>
                安装并重启
              </Button>
            </>
          )}
          {manual && (
            <>
              <Button variant="ghost" size="sm" onClick={dismiss}>
                稍后
              </Button>
              <Button
                size="sm"
                onClick={() => void visitRelease(manual.releaseUrl)}
              >
                下载安装包
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
