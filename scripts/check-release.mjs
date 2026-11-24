import { readFileSync } from "node:fs";
import { repositoryFromEndpoint, validatePublicKey, validateRepository } from "./release-config.mjs";

function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
function sectionVersion(path, section) {
  const content = readFileSync(path, "utf8");
  const block = content.split(/^\[/m).find((item) => item.startsWith(`${section}]`));
  const version = block && /^version\s*=\s*"([^"]+)"/m.exec(block)?.[1];
  if (!version) throw new Error(`Missing explicit version in ${path} [${section}].`);
  return version;
}

try {
  const pkg = readJson("package.json");
  const config = readJson("src-tauri/tauri.conf.json");
  const version = pkg.version;
  // Stable releases only. Keep prereleases out of GitHub's latest stable channel.
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error("Release version must be a stable MAJOR.MINOR.PATCH version.");
  }
  const lock = readFileSync("Cargo.lock", "utf8").split("[[package]]").find((block) => /^name = "xuya-terminal"$/m.test(block));
  const lockVersion = lock && /^version = "([^"]+)"/m.exec(lock)?.[1];
  const versions = {
    "Tauri config": config.version,
    "workspace": sectionVersion("Cargo.toml", "workspace.package"),
    "native package": sectionVersion("src-tauri/Cargo.toml", "package"),
    "Cargo.lock": lockVersion,
  };
  for (const [label, actual] of Object.entries(versions)) {
    if (actual !== version) throw new Error(`Release version mismatch: ${label} must match package.json (${version}).`);
  }
  if (process.env.GITHUB_REF_NAME && process.env.GITHUB_REF_NAME !== `v${version}`) {
    throw new Error(`Release tag must be v${version}.`);
  }
  if (config.bundle?.createUpdaterArtifacts !== true) throw new Error("Signed updater artifacts must be enabled before release.");
  const updater = config.plugins?.updater;
  validatePublicKey(updater?.pubkey);
  if (!Array.isArray(updater.endpoints) || updater.endpoints.length !== 1) throw new Error("Configure exactly one updater endpoint.");
  const repository = repositoryFromEndpoint(updater.endpoints[0]);
  if (process.env.GITHUB_REPOSITORY && repository.toLowerCase() !== validateRepository(process.env.GITHUB_REPOSITORY).toLowerCase()) {
    throw new Error("Updater repository differs from the GitHub Actions repository.");
  }
  const url = `https://github.com/${repository}`;
  if (pkg.homepage !== url || pkg.repository?.url !== `${url}.git`) throw new Error("Package source URLs differ from the updater repository. Run release:configure.");
  console.log(`Release preflight passed: v${version}, ${repository}.`);
} catch (error) {
  console.error(`Release preflight failed: ${error.message}`);
  process.exitCode = 1;
}
