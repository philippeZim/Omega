import { t } from "./i18n/index.svelte";
import type { Suggest } from "./code/packages";

export interface ChoiceOption {
  label: string;
  value: string;
  primary?: boolean;
  danger?: boolean;
}

export interface MenuItem {
  label: string;
  action?: () => void;
  danger?: boolean;
  shortcut?: string;
  separator?: boolean;
}

interface DialogState {
  title: string;
  message?: string;
  options: ChoiceOption[];
  input?: { value: string; placeholder?: string; selectUntil?: number; suggest?: Suggest; multiline?: boolean };
  resolve: (v: string | null, input?: string) => void;
}

/**
 * Shows a dialog. A dialog that is still open gets cancelled (resolved with null) first, so its
 * caller is never left waiting forever.
 */
function openDialog(d: DialogState) {
  const old = ui.dialog;
  ui.dialog = null;
  old?.resolve(null);
  ui.dialog = d;
}

export const ui = $state({
  toasts: [] as { id: number; text: string; kind: "info" | "error" }[],
  dialog: null as DialogState | null,
  menu: null as { x: number; y: number; items: MenuItem[] } | null,
  help: false,

  toast(text: string, kind: "info" | "error" = "info") {
    const id = Date.now() + Math.random();
    ui.toasts.push({ id, text, kind });
    setTimeout(() => (ui.toasts = ui.toasts.filter((t) => t.id !== id)), 4000);
  },

  choose(title: string, message: string, options: ChoiceOption[]): Promise<string | null> {
    return new Promise((resolve) => {
      openDialog({ title, message, options, resolve: (v) => resolve(v) });
    });
  },

  /** `multiline`: wide dialog with a wrapping field for long values (e.g. shell commands); Enter still confirms. */
  prompt(title: string, value = "", placeholder = "", selectUntil?: number, suggest?: Suggest, multiline = false): Promise<string | null> {
    return new Promise((resolve) => {
      openDialog({
        title,
        options: [
          { label: t("common.cancel"), value: "cancel" },
          { label: t("common.ok"), value: "ok", primary: true },
        ],
        input: { value, placeholder, selectUntil, suggest, multiline },
        resolve: (v, input) => resolve(v === "ok" && input?.trim() ? input.replace(/\s*\n\s*/g, " ").trim() : null),
      });
    });
  },

  async confirm(title: string, message: string, confirmLabel = t("common.ok"), danger = false) {
    const r = await ui.choose(title, message, [
      { label: t("common.cancel"), value: "cancel" },
      { label: confirmLabel, value: "ok", primary: !danger, danger },
    ]);
    return r === "ok";
  },

  openMenu(e: MouseEvent, items: MenuItem[]) {
    e.preventDefault();
    e.stopPropagation();
    ui.menu = { x: e.clientX, y: e.clientY, items };
  },
});
