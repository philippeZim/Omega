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
  input?: { value: string; placeholder?: string; selectUntil?: number };
  resolve: (v: string | null, input?: string) => void;
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
      ui.dialog = { title, message, options, resolve: (v) => resolve(v) };
    });
  },

  prompt(title: string, value = "", placeholder = "", selectUntil?: number): Promise<string | null> {
    return new Promise((resolve) => {
      ui.dialog = {
        title,
        options: [
          { label: "Abbrechen", value: "cancel" },
          { label: "OK", value: "ok", primary: true },
        ],
        input: { value, placeholder, selectUntil },
        resolve: (v, input) => resolve(v === "ok" && input?.trim() ? input.trim() : null),
      };
    });
  },

  async confirm(title: string, message: string, confirmLabel = "OK", danger = false) {
    const r = await ui.choose(title, message, [
      { label: "Abbrechen", value: "cancel" },
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
