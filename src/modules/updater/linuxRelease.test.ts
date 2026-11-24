import { afterEach, describe, expect, it, vi } from "vitest";
import { checkLinuxRelease, isNewerRelease } from "./linuxRelease";

afterEach(() => vi.unstubAllGlobals());

describe("release version ordering", () => {
  it.each([
    ["v1.0.8", "1.0.7", true],
    ["v1.0.7", "1.0.7", false],
    ["v1.0.6", "1.0.7", false],
    ["v1.0.7", "1.0.7-rc.2", true],
    ["v1.0.7-rc.2", "1.0.7", false],
    ["1.0.7-rc.10", "1.0.7-rc.2", true],
    ["1.0.7+build.2", "1.0.7+build.1", false],
    ["9007199254740993.0.0", "9007199254740992.0.0", true],
  ])("compares %s to %s", (remote, current, expected) => {
    expect(isNewerRelease(remote, current)).toBe(expected);
  });
  it.each([
    "1.0",
    "1.0.0-01",
    "01.0.0",
    "1.0.0;echo bad",
  ])("rejects malformed version %s", (version) => {
    expect(() => isNewerRelease(version, "1.0.0")).toThrow(
      "Invalid release version",
    );
  });
});

describe("Linux manual update metadata", () => {
  function response(data: unknown, status = 200) {
    const request = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(data), { status }));
    vi.stubGlobal("fetch", request);
    return request;
  }
  const metadata = {
    tag_name: "v1.0.8",
    html_url: "https://github.com/example/terminal/releases/tag/v1.0.8",
    body: "Release notes",
  };
  it("returns release notes and uses a bounded request to the configured repository", async () => {
    const request = response(metadata);
    expect(await checkLinuxRelease("example/terminal", "1.0.7")).toEqual({
      version: "1.0.8",
      currentVersion: "1.0.7",
      releaseUrl: metadata.html_url,
      body: metadata.body,
    });
    expect(request).toHaveBeenCalledWith(
      "https://api.github.com/repos/example/terminal/releases/latest",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
  it("treats an unpublished repository as having no release", async () => {
    response({}, 404);
    expect(await checkLinuxRelease("example/terminal", "1.0.7")).toBeNull();
  });
  it("accepts the canonical URL when GitHub normalizes repository casing", async () => {
    response(metadata);
    expect(await checkLinuxRelease("Example/Terminal", "1.0.7")).toMatchObject({
      releaseUrl: metadata.html_url,
    });
  });
  it.each([
    "https://example.com/payload",
    "https://github.com/other/repo/releases/tag/v1.0.8",
    "https://user@github.com/example/terminal/releases/tag/v1.0.8",
  ])("rejects unexpected release destination %s", async (html_url) => {
    response({ ...metadata, html_url });
    await expect(
      checkLinuxRelease("example/terminal", "1.0.7"),
    ).rejects.toThrow("Unexpected release download URL");
  });
  it("surfaces rate limits instead of reporting the app as current", async () => {
    response({}, 403);
    await expect(
      checkLinuxRelease("example/terminal", "1.0.7"),
    ).rejects.toThrow("GitHub API 403");
  });
});
