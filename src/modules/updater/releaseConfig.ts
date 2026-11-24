import config from "../../../src-tauri/tauri.conf.json";

/** Use the same release identity in the UI and the native updater. */
export function getReleaseRepository(): string | null {
  const updater = config.plugins.updater;
  if (
    !config.bundle.createUpdaterArtifacts ||
    !updater.pubkey.trim() ||
    updater.endpoints.length !== 1
  )
    return null;
  return (
    /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*)\/releases\/latest\/download\/latest\.json$/.exec(
      updater.endpoints[0],
    )?.[1] ?? null
  );
}
