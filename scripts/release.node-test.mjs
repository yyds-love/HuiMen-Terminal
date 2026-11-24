import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const scripts = fileURLToPath(new URL("./", import.meta.url));
const repo = "example/terminal";
const url = `https://github.com/${repo}`;
// Synthetic, structurally valid public key; no private key exists for this fixture.
const keyBytes = Buffer.alloc(42, 1);
keyBytes.write("Ed");
const publicKey = Buffer.from(`untrusted comment: minisign public key\n${keyBytes.toString("base64")}\n`).toString("base64");

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "xuya-release-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "src-tauri"));
  const config = { version: "1.0.7", bundle: { createUpdaterArtifacts: true }, plugins: { updater: { pubkey: publicKey, endpoints: [`${url}/releases/latest/download/latest.json`] } } };
  const pkg = { name: "xuya-terminal", version: "1.0.7", homepage: url, repository: { type: "git", url: `${url}.git` } };
  function json(path, value) { writeFileSync(join(directory, path), `${JSON.stringify(value, null, 2)}\n`); }
  json("package.json", pkg);
  json("src-tauri/tauri.conf.json", config);
  writeFileSync(join(directory, "Cargo.toml"), '[workspace.package]\nversion = "1.0.7"\n');
  writeFileSync(join(directory, "src-tauri/Cargo.toml"), '[package]\nname = "xuya-terminal"\nversion = "1.0.7"\n');
  writeFileSync(join(directory, "Cargo.lock"), '[[package]]\nname = "xuya-terminal"\nversion = "1.0.7"\n');
  const pubPath = join(directory, "release.pub"); writeFileSync(pubPath, publicKey);
  function run(script, args = [], extra = {}) {
    return spawnSync(process.execPath, [join(scripts, script), ...args], { cwd: directory, encoding: "utf8", env: { ...process.env, GITHUB_REPOSITORY: repo, GITHUB_REF_NAME: "v1.0.7", ...extra } });
  }
  return { directory, config, pkg, pubPath, json, run };
}

test("accepts a consistent signed release and matching GitHub tag", (t) => {
  const f = fixture(t); const result = f.run("check-release.mjs");
  assert.equal(result.status, 0, result.stderr);
});
for (const file of ["package.json", "src-tauri/tauri.conf.json", "Cargo.toml", "src-tauri/Cargo.toml", "Cargo.lock"]) {
  test(`rejects version drift in ${file}`, (t) => {
    const f = fixture(t); const path = join(f.directory, file);
    writeFileSync(path, readFileSync(path, "utf8").replaceAll("1.0.7", "1.0.8"));
    const result = f.run("check-release.mjs");
    assert.notEqual(result.status, 0); assert.match(result.stderr, /version/i);
  });
}
for (const scenario of ["disabled artifacts", "empty key", "private key", "wrong repository", "insecure endpoint", "wrong package URL"]) {
  test(`rejects ${scenario}`, (t) => {
    const f = fixture(t);
    if (scenario === "disabled artifacts") f.config.bundle.createUpdaterArtifacts = false;
    if (scenario === "empty key") f.config.plugins.updater.pubkey = "";
    if (scenario === "private key") f.config.plugins.updater.pubkey = Buffer.from("untrusted comment: encrypted secret key\nAAAA").toString("base64");
    if (scenario === "wrong repository") f.config.plugins.updater.endpoints = ["https://github.com/other/terminal/releases/latest/download/latest.json"];
    if (scenario === "insecure endpoint") f.config.plugins.updater.endpoints[0] = f.config.plugins.updater.endpoints[0].replace("https:", "http:");
    if (scenario === "wrong package URL") f.pkg.homepage = "https://github.com/other/terminal";
    f.json("src-tauri/tauri.conf.json", f.config); f.json("package.json", f.pkg);
    assert.notEqual(f.run("check-release.mjs").status, 0);
  });
}
test("rejects a tag which differs from the package version", (t) => {
  const f = fixture(t); const result = f.run("check-release.mjs", [], { GITHUB_REF_NAME: "v1.0.8" });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /tag/i);
});
test("configures public release identity consistently without touching versions", (t) => {
  const f = fixture(t); f.config.bundle.createUpdaterArtifacts = false; f.config.plugins.updater = { pubkey: "", endpoints: [] };
  f.json("src-tauri/tauri.conf.json", f.config);
  const result = f.run("configure-release.mjs", ["--repository", repo, "--public-key", f.pubPath]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.run("check-release.mjs").status, 0);
  assert.equal(JSON.parse(readFileSync(join(f.directory, "package.json"))).version, "1.0.7");
});
test("invalid input leaves both release configuration files unchanged", (t) => {
  const f = fixture(t); const configPath = join(f.directory, "src-tauri/tauri.conf.json"); const pkgPath = join(f.directory, "package.json");
  const before = [readFileSync(configPath, "utf8"), readFileSync(pkgPath, "utf8")];
  const result = f.run("configure-release.mjs", ["--repository", "../bad", "--public-key", f.pubPath]);
  assert.notEqual(result.status, 0);
  assert.deepEqual([readFileSync(configPath, "utf8"), readFileSync(pkgPath, "utf8")], before);
});
test("refuses private-key file paths before trying to read them", (t) => {
  const f = fixture(t);
  const result = f.run("configure-release.mjs", ["--repository", repo, "--public-key", join(f.directory, "do-not-read.key")]);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /\.pub/);
});
