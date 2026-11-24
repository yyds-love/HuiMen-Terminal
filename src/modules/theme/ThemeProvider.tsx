import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { usePreferencesInitialization } from "@/modules/settings/usePreferencesInitialization";
import {
  DEFAULT_THEME_ID,
  EDITOR_THEMES,
  setEditorTheme as persistEditorTheme,
  setTheme as persistTheme,
  setThemeId as persistThemeId,
  type EditorThemeId,
  type ThemePref,
} from "@/modules/settings/store";
import { applyTheme, clearTheme } from "./applyTheme";
import {
  listCustomThemes,
  onCustomThemesChange,
} from "./customThemes";
import { SurfaceLayer } from "./SurfaceLayer";
import { getBuiltinTheme, getDefaultTheme } from "./themes";
import type { Theme } from "./types";

export type { Theme };
export type ThemeModePref = ThemePref;

type ThemeProviderProps = {
  children: React.ReactNode;
  defaultMode?: ThemePref;
};

type ThemeProviderState = {
  mode: ThemePref;
  resolvedMode: "dark" | "light";
  themeId: string;
  customThemes: Theme[];
  setMode: (mode: ThemePref) => void;
  setThemeId: (id: string) => void;
  /** Apply a theme transiently without persisting; null reverts to committed. */
  previewThemeId: (id: string | null) => void;
};

const ThemeProviderContext = createContext<ThemeProviderState | null>(null);

const FAST_PATH_KEY = "terax-ui-theme-shadow";
const FAST_PATH_THEME_ID = "terax-ui-theme-id-shadow";

function readFastMode(fallback: ThemePref): ThemePref {
  if (typeof window === "undefined") return fallback;
  const v = window.localStorage.getItem(FAST_PATH_KEY);
  return v === "dark" || v === "light" || v === "system" ? v : fallback;
}

function writeFastMode(t: ThemePref): void {
  try { window.localStorage.setItem(FAST_PATH_KEY, t); } catch { /* ignore */ }
}

function readFastThemeId(): string {
  if (typeof window === "undefined") return DEFAULT_THEME_ID;
  return window.localStorage.getItem(FAST_PATH_THEME_ID) ?? DEFAULT_THEME_ID;
}

function writeFastThemeId(id: string): void {
  try { window.localStorage.setItem(FAST_PATH_THEME_ID, id); } catch { /* ignore */ }
}

function resolveTheme(id: string, custom: Theme[]): Theme {
  return custom.find((t) => t.id === id) ?? getBuiltinTheme(id) ?? getDefaultTheme();
}

export function ThemeProvider({ children, defaultMode = "system" }: ThemeProviderProps) {
  usePreferencesInitialization();
  const hydrated = usePreferencesStore((state) => state.hydrated);
  const savedMode = usePreferencesStore((state) => state.theme);
  const savedThemeId = usePreferencesStore((state) => state.themeId);
  const [mode, setModeState] = useState<ThemePref>(() => readFastMode(defaultMode));
  const [themeId, setThemeIdState] = useState<string>(() => readFastThemeId());
  const [previewId, setPreviewId] = useState<string | null>(null);
  const modeSaveSequence = useRef(0);
  const themeSaveSequence = useRef(0);
  const [customThemes, setCustomThemes] = useState<Theme[]>([]);
  const [systemDark, setSystemDark] = useState<boolean>(() =>
    typeof window === "undefined"
      ? true
      : window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  useEffect(() => {
    if (!hydrated) return;
    if (savedMode === "system" || savedMode === "light" || savedMode === "dark") {
      setModeState(savedMode);
      writeFastMode(savedMode);
    }
  }, [hydrated, savedMode]);

  useEffect(() => {
    if (!hydrated || typeof savedThemeId !== "string") return;
    setThemeIdState(savedThemeId);
    writeFastThemeId(savedThemeId);
  }, [hydrated, savedThemeId]);

  useEffect(() => {
    let alive = true;
    void listCustomThemes().then((list) => { if (alive) setCustomThemes(list); });
    const unlisten = onCustomThemesChange(() => {
      void listCustomThemes().then((list) => setCustomThemes(list));
    });
    return () => {
      alive = false;
      void unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const resolvedMode: "dark" | "light" =
    mode === "system" ? (systemDark ? "dark" : "light") : mode;

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(resolvedMode);
  }, [resolvedMode]);

  const effectiveId = previewId ?? themeId;
  const lastEditorPairRef = useRef<string | null>(null);
  useEffect(() => {
    if (effectiveId === DEFAULT_THEME_ID) {
      clearTheme();
      if (!previewId) lastEditorPairRef.current = null;
      return;
    }
    const theme = resolveTheme(effectiveId, customThemes);
    applyTheme(theme, resolvedMode);
    if (previewId) return;
    const editorPair = theme.editorTheme?.[resolvedMode];
    if (
      editorPair &&
      lastEditorPairRef.current !== editorPair &&
      (EDITOR_THEMES as readonly string[]).includes(editorPair)
    ) {
      lastEditorPairRef.current = editorPair;
      void persistEditorTheme(editorPair as EditorThemeId);
    }
  }, [effectiveId, previewId, resolvedMode, customThemes]);

  const setMode = useCallback(
    (next: ThemePref) => {
      const sequence = ++modeSaveSequence.current;
      setModeState(next);
      writeFastMode(next);
      void persistTheme(next).catch(() => {
        console.error("Failed to save the theme mode preference.");
        if (sequence !== modeSaveSequence.current) return;
        const prefs = usePreferencesStore.getState();
        const restored = prefs.hydrated ? prefs.theme : mode;
        setModeState(restored);
        writeFastMode(restored);
      });
    },
    [mode],
  );

  const setThemeId = useCallback(
    (id: string) => {
      const sequence = ++themeSaveSequence.current;
      setPreviewId(null);
      setThemeIdState(id);
      writeFastThemeId(id);
      void persistThemeId(id).catch(() => {
        console.error("Failed to save the theme selection preference.");
        if (sequence !== themeSaveSequence.current) return;
        const prefs = usePreferencesStore.getState();
        const restored = prefs.hydrated ? prefs.themeId : themeId;
        setThemeIdState(restored);
        writeFastThemeId(restored);
      });
    },
    [themeId],
  );

  const previewThemeId = useCallback((id: string | null) => {
    setPreviewId(id);
  }, []);

  const value = useMemo<ThemeProviderState>(
    () => ({
      mode,
      resolvedMode,
      themeId,
      customThemes,
      setMode,
      setThemeId,
      previewThemeId,
    }),
    [mode, resolvedMode, themeId, customThemes, setMode, setThemeId, previewThemeId],
  );

  return (
    <ThemeProviderContext.Provider value={value}>
      <SurfaceLayer />
      {children}
    </ThemeProviderContext.Provider>
  );
}

export function useTheme(): ThemeProviderState {
  const ctx = useContext(ThemeProviderContext);
  if (!ctx) throw new Error("useTheme must be used within a <ThemeProvider>");
  return ctx;
}
