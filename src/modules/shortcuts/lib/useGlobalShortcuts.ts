import { useEffect, useRef } from "react";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { matchBinding, SHORTCUTS, type ShortcutId } from "../shortcuts";

export type ShortcutHandler = (e: KeyboardEvent) => void;
export type ShortcutHandlers = Partial<Record<ShortcutId, ShortcutHandler>>;

export type UseGlobalShortcutsOptions = {
  isDisabled?: (id: ShortcutId, e: KeyboardEvent) => boolean;
};

const TERMINAL_EDITING_KEYS = new Set([
  "Tab",
  "Enter",
  "Escape",
  "Backspace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
]);

// CodeMirror binds Ctrl+Shift+K/G/L to delete line, find previous, and select matches.
const EDITOR_CTRL_SHIFT_KEYS = new Set(["k", "g", "l"]);

export function isTerminalKeyTarget(event: KeyboardEvent): boolean {
  const target =
    event.target instanceof Element ? event.target : document.activeElement;
  return !!target?.closest(".xterm");
}

function isTerminalInputKey(event: KeyboardEvent): boolean {
  const { key, code, altKey, ctrlKey, metaKey, shiftKey } = event;
  if (metaKey) return false;
  if (altKey || !ctrlKey) return true;
  if (TERMINAL_EDITING_KEYS.has(key) || /^F(?:[1-9]|1[0-2])$/.test(key)) {
    return true;
  }
  // Ctrl+Shift+PageUp/PageDown may be assigned to desktop tab navigation.
  if (key === "PageUp" || key === "PageDown") return !shiftKey;
  if (key === "@") return true;
  if (shiftKey) return false;
  // Ctrl+letters, Ctrl+Space and the ASCII control brackets reach the shell.
  return (
    /^[a-z]$/i.test(key) ||
    /^Key[A-Z]$/.test(code) ||
    key === " " ||
    key === "[" ||
    key === "]" ||
    key === "\\"
  );
}

export function useGlobalShortcuts(
  handlers: ShortcutHandlers,
  options?: UseGlobalShortcutsOptions,
) {
  const latest = useRef({ handlers, options });
  latest.current = { handlers, options };

  // Access the shortcuts from the store
  const userShortcuts = usePreferencesStore((s) => s.shortcuts);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (isTerminalKeyTarget(e) && isTerminalInputKey(e)) return;

      const { handlers, options } = latest.current;
      let alternative: ShortcutId | undefined;
      for (const s of SHORTCUTS) {
        if (e.repeat && !s.allowRepeat) continue;
        const custom = userShortcuts[s.id];
        const bindings = custom ?? s.defaultBindings;
        const isMatch = bindings.some((b) => matchBinding(e, b, s.id));
        if (isMatch) {
          run(s.id);
          return;
        }
        if (
          !custom &&
          s.terminalAlternative &&
          matchBinding(e, s.terminalAlternative)
        ) {
          alternative ??= s.id;
        }
      }
      if (!alternative) return;
      if (
        EDITOR_CTRL_SHIFT_KEYS.has(e.key.toLowerCase()) &&
        e.target instanceof Element &&
        e.target.closest(".cm-editor")
      ) {
        return;
      }
      run(alternative);

      function run(id: ShortcutId) {
        const handler = handlers[id];
        if (!handler || options?.isDisabled?.(id, e)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        handler(e);
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [userShortcuts]);
}
