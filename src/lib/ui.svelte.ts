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
  disabled?: boolean;
  /** Tooltip, e.g. why the entry is disabled. */
  title?: string;
}

interface DialogState {
  title: string;
  message?: string;
  options: ChoiceOption[];
  input?: { value: string; placeholder?: string; selectUntil?: number; suggest?: Suggest; multiline?: boolean };
  resolve: (v: string | null, input?: string) => void;
}

/** Dialogs waiting for the open one to close. */
const queue: DialogState[] = [];

/**
 * Shows a dialog. If one is already open, the new one waits in a queue and is shown once the open
 * one closes: a background question (e.g. "changed on disk") must not cancel a prompt the user is
 * typing into, and every caller still gets an answer.
 */
function openDialog(d: DialogState) {
  if (ui.dialog) queue.push(d);
  else ui.dialog = d;
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

  /** Closes the open dialog with the chosen option (null: dismissed) and shows the next queued one. */
  closeDialog(value: string | null, input?: string) {
    const d = ui.dialog;
    ui.dialog = queue.shift() ?? null;
    d?.resolve(value, input);
  },

  openMenu(e: MouseEvent, items: MenuItem[]) {
    e.preventDefault();
    e.stopPropagation();
    ui.menu = { x: e.clientX, y: e.clientY, items };
  },
});
