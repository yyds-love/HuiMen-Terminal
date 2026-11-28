export function validateRepository(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value)) {
    throw new Error("Repository must be OWNER/REPOSITORY, without a URL or .git suffix.");
  }
  if (value.endsWith(".git")) throw new Error("Repository must not include .git.");
  return value;
}

function decodeBase64(value) {
  if (typeof value !== "string" || !value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error("Invalid updater public key encoding.");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error("Invalid updater public key encoding.");
  return decoded;
}

export function validatePublicKey(value) {
  const lines = decodeBase64(value).toString("utf8").trim().split(/\r?\n/);
  if (lines.length !== 2 || !/^untrusted comment: .*public key(?::| |$)/.test(lines[0])) {
    throw new Error("Expected a complete Tauri updater public key, never a private key.");
  }
  const bytes = decodeBase64(lines[1]);
  if (bytes.length !== 42 || bytes.subarray(0, 2).toString("ascii") !== "Ed") {
    throw new Error("Invalid minisign updater public key.");
  }
  return value;
}

export function repositoryFromEndpoint(endpoint) {
  const match = typeof endpoint === "string" && /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/latest\/download\/latest\.json$/.exec(endpoint);
  if (!match) throw new Error("Updater endpoint must be the HTTPS GitHub latest.json release URL.");
  return validateRepository(match[1]);
}

export function repositoryFromGitHubUrl(value) {
  const match = typeof value === "string" && /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(value);
  if (!match) throw new Error("Package source URLs must point to a GitHub repository.");
  return validateRepository(match[1]);
}
