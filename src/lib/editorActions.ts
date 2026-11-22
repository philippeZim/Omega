/** Per-view actions contributed by extensions (breakpoints, LSP) so global commands can call them. */
import { Facet } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

export type ViewAction = (view: EditorView) => boolean;

export const viewActions = Facet.define<Record<string, ViewAction>, Record<string, ViewAction>>({
  combine: (values) => Object.assign({}, ...values),
});

export function runViewAction(view: EditorView, id: string): boolean {
  const fn = view.state.facet(viewActions)[id];
  return fn ? fn(view) : false;
}

/** Whether a contributed action can do anything right now (e.g. the language server supports it). */
export const viewActionSupport = Facet.define<Record<string, () => boolean>, Record<string, () => boolean>>({
  combine: (values) => Object.assign({}, ...values),
});

/** null: this view has no such action. */
export function viewActionState(view: EditorView, id: string): "enabled" | "disabled" | null {
  if (!view.state.facet(viewActions)[id]) return null;
  const supported = view.state.facet(viewActionSupport)[id];
  return !supported || supported() ? "enabled" : "disabled";
}
