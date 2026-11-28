import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { validateRepository } from "./release-config.mjs";

try {
  const [manifestPath, sourceValue, updaterValue, version] = process.argv.slice(2);
  if (!manifestPath || !sourceValue || !updaterValue || !version) {
    throw new Error(
      "Usage: node rewrite-updater-manifest.mjs <latest.json> <source-repository> <updater-repository> <version>",
    );
  }

  const sourceRepository = validateRepository(sourceValue);
  const updaterRepository = validateRepository(updaterValue);
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error("Version must be a stable MAJOR.MINOR.PATCH version.");
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.version !== version) {
    throw new Error(`Updater manifest version must be ${version}.`);
  }
  if (!manifest.platforms || typeof manifest.platforms !== "object") {
    throw new Error("Updater manifest platforms must be an object.");
  }

  const sourcePrefix =
    `/${sourceRepository}/releases/download/v${version}/`.toLowerCase();
  const updatesBaseUrl =
    `https://github.com/${updaterRepository}/releases/download/v${version}/`;
  const platforms = Object.entries(manifest.platforms);
  if (platforms.length === 0) {
    throw new Error("Updater manifest must contain at least one platform.");
  }

  for (const [platformName, platform] of platforms) {
    if (!platform || typeof platform !== "object" || typeof platform.signature !== "string" || !platform.signature) {
      throw new Error(`Updater signature is missing for platform ${platformName}.`);
    }

    let assetUrl;
    try {
      assetUrl = new URL(platform.url);
    } catch {
      throw new Error(`Updater asset URL is invalid for platform ${platformName}.`);
    }
    const assetPath = assetUrl.pathname.toLowerCase();
    if (
      assetUrl.protocol !== "https:" ||
      assetUrl.hostname !== "github.com" ||
      !assetPath.startsWith(sourcePrefix)
    ) {
      throw new Error(`Updater asset URL is outside the expected source release for ${platformName}.`);
    }

    const assetName = assetUrl.pathname.slice(sourcePrefix.length);
    if (!assetName || assetName.includes("/")) {
      throw new Error(`Updater asset filename is invalid for platform ${platformName}.`);
    }
    platform.url = `${updatesBaseUrl}${assetName}`;
  }

  const temporaryPath = `${manifestPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
    });
    renameSync(temporaryPath, manifestPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  console.log(`Updater URLs rewritten for ${updaterRepository} v${version}.`);
} catch (error) {
  console.error(`Updater manifest rewrite failed: ${error.message}`);
  process.exitCode = 1;
}
