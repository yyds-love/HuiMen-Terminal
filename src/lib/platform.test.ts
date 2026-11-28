import { beforeEach, describe, expect, it, vi } from "vitest";

const os = vi.hoisted(() => ({
  platform: vi.fn<() => string>(),
  version: vi.fn<() => string>(),
}));

vi.mock("@tauri-apps/plugin-os", () => os);

beforeEach(() => {
  vi.resetModules();
  os.platform.mockReset();
  os.version.mockReset();
});

describe("Windows 10 1809 detection", () => {
  it("falls back safely when the OS version is unavailable", async () => {
    os.platform.mockReturnValue("windows");
    os.version.mockImplementation(() => {
      throw new Error("OS version unavailable");
    });

    await expect(import("./platform")).resolves.toMatchObject({
      IS_WINDOWS: true,
      IS_WINDOWS_1809: false,
    });
  });

  it.each([
    ["10.0.17763", true],
    ["10.0.19045", false],
    ["10.0.22631", false],
  ])("detects build %s as affected=%s", async (osVersion, affected) => {
    os.platform.mockReturnValue("windows");
    os.version.mockReturnValue(osVersion);

    await expect(import("./platform")).resolves.toMatchObject({
      IS_WINDOWS_1809: affected,
    });
  });
});
