import { create } from "zustand";
import {
  DEFAULT_PREFERENCES,
  loadPreferences,
  onPreferencesChange,
  type PrefKey,
  type Preferences,
} from "./store";

type State = Preferences & {
  hydrated: boolean;
  /** Subscribe & hydrate once per window; failed attempts may be retried. */
  init: () => Promise<void>;
};

let initialization: Promise<void> | undefined;

const FAST_BG_KIND_KEY = "terax-ui-bg-kind-shadow";
const FAST_BG_IMAGE_ID_KEY = "terax-ui-bg-image-shadow";

function mirrorBgFastPath(
  kind: Preferences["backgroundKind"],
  imageId: Preferences["backgroundImageId"],
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FAST_BG_KIND_KEY, kind);
    if (imageId) window.localStorage.setItem(FAST_BG_IMAGE_ID_KEY, imageId);
    else window.localStorage.removeItem(FAST_BG_IMAGE_ID_KEY);
  } catch {
    /* ignore */
  }
}

export function readBgFastPath(): {
  active: boolean;
  imageId: string | null;
} {
  if (typeof window === "undefined") return { active: false, imageId: null };
  try {
    const kind = window.localStorage.getItem(FAST_BG_KIND_KEY);
    const imageId = window.localStorage.getItem(FAST_BG_IMAGE_ID_KEY);
    return { active: kind === "image" && !!imageId, imageId };
  } catch {
    return { active: false, imageId: null };
  }
}

export const usePreferencesStore = create<State>((set, get) => ({
  ...DEFAULT_PREFERENCES,
  hydrated: false,
  init: () => {
    initialization ??= (async () => {
      let active = true;
      let loading = true;
      const pending = new Map<PrefKey, unknown>();
      let unlisten: Awaited<ReturnType<typeof onPreferencesChange>> | undefined;
      const mirrorBackground = () => {
        const { backgroundKind, backgroundImageId } = get();
        mirrorBgFastPath(backgroundKind, backgroundImageId);
      };
      try {
        unlisten = await onPreferencesChange((key, value) => {
          if (!active) return;
          if (loading) {
            pending.set(key, value);
            return;
          }
          set({ [key]: value } as Partial<Preferences>);
          if (key === "backgroundKind" || key === "backgroundImageId") {
            mirrorBackground();
          }
        });
        // Earlier events are already reflected in the upcoming snapshot.
        // Only changes received during its read must overlay that snapshot.
        pending.clear();
        const prefs = await loadPreferences();
        const updates = Object.fromEntries(pending);
        loading = false;
        set({ ...prefs, ...updates, hydrated: true });
        mirrorBackground();
      } catch (error) {
        active = false;
        await unlisten?.();
        throw error;
      }
    })().catch((error: unknown) => {
      initialization = undefined;
      throw error;
    });
    return initialization;
  },
}));
