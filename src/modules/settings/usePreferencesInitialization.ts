import { useEffect } from "react";
import { usePreferencesStore } from "./preferences";

/** Initialize per webview, then allow recovery on a later window activation. */
export function usePreferencesInitialization(): void {
  const init = usePreferencesStore((state) => state.init);
  useEffect(() => {
    let active = true;
    const initialize = () => {
      void init().catch(() => {
        if (active) {
          // Avoid logging preference values or backend errors that may include
          // user configuration. Direct init callers still receive the error.
          console.error(
            "Preferences initialization failed; refocus the window to retry.",
          );
        }
      });
    };
    window.addEventListener("focus", initialize);
    initialize();
    return () => {
      active = false;
      window.removeEventListener("focus", initialize);
    };
  }, [init]);
}
