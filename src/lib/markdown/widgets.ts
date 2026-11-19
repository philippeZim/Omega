import { WidgetType, type EditorView } from "@codemirror/view";
import katex from "katex";
import "katex/dist/katex.min.css";
import { t } from "../i18n/index.svelte";

const mathCache = new Map<string, string>();

export function renderMath(tex: string, display: boolean): string {
  const key = (display ? "D" : "I") + tex;
  let html = mathCache.get(key);
  if (html === undefined) {
    try {
      html = katex.renderToString(tex, { displayMode: display, throwOnError: false, output: "html", strict: "ignore" });
    } catch (e) {
      html = `<span class="md-math-error">${String(e)}</span>`;
    }
    if (mathCache.size > 500) mathCache.clear();
    mathCache.set(key, html);
  }
  return html;
}

export class MathWidget extends WidgetType {
  constructor(readonly tex: string, readonly display: boolean) {
    super();
  }
  eq(o: MathWidget) {
    return o.tex === this.tex && o.display === this.display;
  }
  toDOM() {
    const el = document.createElement(this.display ? "div" : "span");
    el.className = this.display ? "md-math-block" : "md-math-inline";
    el.innerHTML = renderMath(this.tex, this.display);
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

export class BulletWidget extends WidgetType {
  constructor(readonly depth: number) {
    super();
  }
  eq(o: BulletWidget) {
    return o.depth === this.depth;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "md-bullet";
    el.textContent = ["•", "◦", "▪"][this.depth % 3];
    return el;
  }
}

export class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(o: CheckboxWidget) {
    return o.checked === this.checked;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("span");
    el.className = "md-checkbox" + (this.checked ? " checked" : "");
    el.setAttribute("role", "checkbox");
    el.setAttribute("aria-checked", String(this.checked));
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const pos = view.posAtDOM(el);
      // The widget replaces "[ ]" / "[x]"; toggle the character between the brackets.
      view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: this.checked ? " " : "x" } });
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

export class HrWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "md-hr";
    return el;
  }
}

export class ImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string) {
    super();
  }
  eq(o: ImageWidget) {
    return o.src === this.src && o.alt === this.alt;
  }
  toDOM() {
    const img = document.createElement("img");
    img.className = "md-image";
    img.src = this.src;
    img.alt = this.alt;
    img.title = this.alt;
    img.onerror = () => img.classList.add("broken");
    return img;
  }
  ignoreEvent() {
    return false;
  }
}

export class CodeHeaderWidget extends WidgetType {
  constructor(readonly lang: string, readonly code: string) {
    super();
  }
  eq(o: CodeHeaderWidget) {
    return o.lang === this.lang && o.code === this.code;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "md-code-header";
    const label = document.createElement("span");
    label.textContent = this.lang;
    const copy = document.createElement("button");
    copy.textContent = t("commands.md.copy");
    copy.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      navigator.clipboard.writeText(this.code);
      copy.textContent = t("commands.md.copied");
      setTimeout(() => (copy.textContent = t("commands.md.copy")), 1200);
    });
    el.append(label, copy);
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

export class EmptyWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    return document.createElement("span");
  }
}
