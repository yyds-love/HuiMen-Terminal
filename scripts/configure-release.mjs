import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { validatePublicKey, validateRepository } from "./release-config.mjs";

function replaceFile(path, content) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

try {
  const { values } = parseArgs({ options: { repository: { type: "string" }, "public-key": { type: "string" } } });
  const repository = validateRepository(values.repository);
  const publicPath = values["public-key"];
  if (!publicPath?.endsWith(".pub")) throw new Error("--public-key must point to the generated .pub public-key file; never pass a private key.");
  const pubkey = validatePublicKey(readFileSync(publicPath, "utf8").trim());
  const configPath = "src-tauri/tauri.conf.json";
  const packagePath = "package.json";
  const previousConfig = readFileSync(configPath, "utf8");
  const previousPackage = readFileSync(packagePath, "utf8");
  const config = JSON.parse(previousConfig);
  const pkg = JSON.parse(previousPackage);
  const url = `https://github.com/${repository}`;
  config.bundle ??= {};
  config.bundle.createUpdaterArtifacts = true;
  config.plugins ??= {};
  config.plugins.updater = { ...config.plugins.updater, pubkey, endpoints: [`${url}/releases/latest/download/latest.json`] };
  pkg.homepage = url;
  pkg.repository = { type: "git", url: `${url}.git` };
  replaceFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  try { replaceFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`); }
  catch (error) { replaceFile(configPath, previousConfig); throw error; }
  console.log(`Release channel configured for ${repository}. Run pnpm release:check before building.`);
} catch (error) {
  console.error(`Release configuration failed: ${error.message}`);
  process.exitCode = 1;
}
