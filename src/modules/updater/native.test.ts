// @vitest-environment happy-dom
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { Update } from "@tauri-apps/plugin-updater";
import { afterEach, expect, it, vi } from "vitest";
import { installUpdate } from "./native";

afterEach(() => clearMocks());

it("uses the native installation coordinator and forwards download events", async () => {
  const commands: string[] = [];
  const progress = vi.fn();
  mockIPC((command, args) => {
    commands.push(command);
    expect(args).toMatchObject({ rid: 17 });
    const channel = (
      args as { onEvent: { onmessage: (data: unknown) => void } }
    ).onEvent;
    channel.onmessage({ event: "Finished" });
  });
  await installUpdate({ rid: 17 } as Update, progress);
  expect(commands).toEqual(["updater_install"]);
  expect(progress).toHaveBeenCalledWith({ event: "Finished" });
});
