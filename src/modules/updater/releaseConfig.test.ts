import { describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  plugins: {
    updater: {
      pubkey: "public key",
      endpoints: [
        "https://github.com/example/terminal/releases/latest/download/latest.json",
      ],
    },
  },
  bundle: { createUpdaterArtifacts: true },
}));
vi.mock("../../../src-tauri/tauri.conf.json", () => ({ default: fixture }));

import { getReleaseRepository } from "./releaseConfig";

describe("shared release identity", () => {
  it("derives the repository from the native updater endpoint", () => {
    expect(getReleaseRepository()).toBe("example/terminal");
  });
  it("requires signed updater artifacts", () => {
    fixture.bundle.createUpdaterArtifacts = false;
    try {
      expect(getReleaseRepository()).toBeNull();
    } finally {
      fixture.bundle.createUpdaterArtifacts = true;
    }
  });
  it.each([
    "http://github.com/example/terminal/releases/latest/download/latest.json",
    "https://github.com/example/terminal/releases/latest/download/latest.json?redirect=1",
    "https://github.com/../terminal/releases/latest/download/latest.json",
  ])("does not enable an invalid endpoint %s", (endpoint) => {
    const previous = fixture.plugins.updater.endpoints;
    fixture.plugins.updater.endpoints = [endpoint];
    try {
      expect(getReleaseRepository()).toBeNull();
    } finally {
      fixture.plugins.updater.endpoints = previous;
    }
  });
});
