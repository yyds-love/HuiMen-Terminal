import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  getBindingTokens,
  getShortcutBindings,
  SHORTCUTS,
  type ShortcutId,
} from "../shortcuts";

const BY_ID = new Map(SHORTCUTS.map((s) => [s.id, s]));

/** Display tokens for a shortcut's first binding, honoring user overrides. */
export function useShortcutLabel(
  id: ShortcutId,
  { preferTerminalAlternative = true } = {},
): string {
  const user = usePreferencesStore((s) => s.shortcuts);
  const shortcut = BY_ID.get(id);
  if (!shortcut) return "";
  const bindings = preferTerminalAlternative
    ? getShortcutBindings(shortcut, user[id])
    : (user[id] ?? shortcut.defaultBindings);
  return getBindingTokens(bindings[0]).join(" ");
}
