import type { ManualUpdateInfo } from "./useUpdater";

function versionParts(value: string) {
  const match =
    /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(
      value,
    );
  if (!match) throw new Error("Invalid release version");
  const pre = match[4]?.split(".");
  if (pre?.some((part) => /^0\d+$/.test(part)))
    throw new Error("Invalid release version");
  return { numbers: match.slice(1, 4).map(BigInt), pre };
}
export function isNewerRelease(remote: string, current: string): boolean {
  const a = versionParts(remote);
  const b = versionParts(current);
  for (let index = 0; index < 3; index++) {
    if (a.numbers[index] !== b.numbers[index])
      return a.numbers[index] > b.numbers[index];
  }
  if (!a.pre) return !!b.pre;
  if (!b.pre) return false;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index++) {
    const x = a.pre[index];
    const y = b.pre[index];
    if (x === y) continue;
    if (x === undefined) return false;
    if (y === undefined) return true;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y);
    if (xn !== yn) return yn;
    return x > y;
  }
  return false;
}
export async function checkLinuxRelease(
  repository: string,
  currentVersion: string,
): Promise<ManualUpdateInfo | null> {
  const response = await fetch(
    `https://api.github.com/repos/${repository}/releases/latest`,
    {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub API ${response.status}`);
  const data = await response.json();
  if (typeof data?.tag_name !== "string" || typeof data?.html_url !== "string")
    throw new Error("Invalid release metadata");
  const releaseUrl = new URL(data.html_url);
  const releasePath = releaseUrl.pathname.split("/");
  const [owner, name] = repository.split("/");
  if (
    releaseUrl.origin !== "https://github.com" ||
    releasePath[1]?.toLowerCase() !== owner.toLowerCase() ||
    releasePath[2]?.toLowerCase() !== name.toLowerCase() ||
    releasePath[3] !== "releases" ||
    releasePath[4] !== "tag" ||
    !releasePath[5] ||
    releaseUrl.username ||
    releaseUrl.password
  )
    throw new Error("Unexpected release download URL");
  if (!isNewerRelease(data.tag_name, currentVersion)) return null;
  return {
    version: data.tag_name.replace(/^v/, ""),
    currentVersion,
    releaseUrl: releaseUrl.href,
    body: typeof data.body === "string" ? data.body : "",
  };
}
