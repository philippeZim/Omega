import { RangeSetBuilder, StateEffect, type Extension, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { invoke } from "@tauri-apps/api/core";
import type { Mode } from "../modes";

export type SpellLang = "de" | "en" | "fr";
export const SPELL_LANGS: { id: SpellLang; label: string }[] = [
  { id: "de", label: "Deutsch" },
  { id: "en", label: "English" },
  { id: "fr", label: "Français" },
];

// ---------------------------------------------------------------- service (Rust backend)

/** lang -> word -> correct? */
const cache = new Map<string, Map<string, boolean>>();
const ignored = new Set<string>();

function langCache(lang: string) {
  let c = cache.get(lang);
  if (!c) cache.set(lang, (c = new Map()));
  return c;
}

async function checkWords(lang: string, words: string[]) {
  const c = langCache(lang);
  const unknown = [...new Set(words.filter((w) => !c.has(w)))];
  if (!unknown.length) return false;
  for (const w of unknown) c.set(w, true); // optimistic, avoids duplicate requests
  const bad = await invoke<string[]>("spell_check", { lang, words: unknown });
  for (const w of bad) c.set(w, false);
  return bad.length > 0;
}

export async function suggest(lang: string, word: string): Promise<string[]> {
  return invoke<string[]>("spell_suggest", { lang, word });
}

export function addToDictionary(lang: string, word: string) {
  langCache(lang).set(word, true);
  invoke("spell_add", { lang, word });
}

export function ignoreWord(word: string) {
  ignored.add(word);
}

// ---------------------------------------------------------------- word extraction

const WORD = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu;
const refresh = StateEffect.define<null>();

interface Word {
  from: number;
  to: number;
  text: string;
}

/** Commands whose arguments are not prose. */
const LATEX_NONPROSE =
  /\\(?:begin|end|label|ref|eqref|autoref|cref|pageref|cite\w*|usepackage|RequirePackage|documentclass|includegraphics|input|include|url|bibliography\w*|addbibresource|newcommand|renewcommand|newenvironment|setlength|setcounter|pagestyle|thispagestyle|hypersetup|geometry|definecolor|color|textcolor)\*?(?:\[[^\]]*\])*(?:\{[^{}]*\})+/g;
const LATEX_MATH =
  /\$\$[\s\S]*?\$\$|\$(?:\\.|[^$\\])+\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\\begin\{(equation|align|gather|multline|eqnarray|math|displaymath|tikzpicture|lstlisting|verbatim|minted)\*?\}[\s\S]*?\\end\{\1\*?\}/g;
const LATEX_CMD = /\\[a-zA-Z@]+\*?/g;

function latexExclusions(text: string): [number, number][] {
  const out: [number, number][] = [];
  for (const re of [LATEX_MATH, LATEX_NONPROSE, LATEX_CMD]) {
    re.lastIndex = 0;
    for (let m; (m = re.exec(text)); ) out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

const SKIP_MD = /^(InlineCode|FencedCode|CodeBlock|CodeText|URL|Autolink|HTMLTag|HTMLBlock|LinkLabel|CommentBlock|InlineMath|BlockMath|Frontmatter|WikiLinkTarget)$/;
const CODE_PROSE = /Comment|String|Docstring|Heredoc|Template/i;

function isProseInCode(state: EditorState, pos: number) {
  for (let n: any = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (CODE_PROSE.test(n.type.name)) return true;
  }
  return false;
}

function skippedInMarkdown(state: EditorState, pos: number) {
  for (let n: any = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (SKIP_MD.test(n.type.name)) return true;
  }
  return false;
}

function collect(view: EditorView, mode: Mode, lang: SpellLang): Word[] {
  const words: Word[] = [];
  const { state } = view;
  for (const { from: vf, to: vt } of view.visibleRanges) {
    const from = state.doc.lineAt(vf).from;
    const to = state.doc.lineAt(vt).to;
    const text = state.sliceDoc(from, to);
    const excl = mode === "latex" ? latexExclusions(text) : [];
    WORD.lastIndex = 0;
    for (let m; (m = WORD.exec(text)); ) {
      const start = m.index, end = start + m[0].length;
      const before = text[start - 1] ?? " ", after = text[end] ?? " ";
      // Skip identifiers, numbers, paths, URLs and e-mail addresses.
      if (/[\w\\/@]/.test(before) || (before === "." && /\w/.test(text[start - 2] ?? ""))) continue;
      if (/[\w@]/.test(after) || (after === "." && /\w/.test(text[end + 1] ?? ""))) continue;
      if (/\d|_/.test(m[0]) || m[0].length < 2) continue;
      if (/\p{Lu}/u.test(m[0].slice(1)) && /\p{Ll}/u.test(m[0])) continue; // camelCase
      if (excl.some(([a, b]) => start >= a && start < b)) continue;
      const pos = from + start;
      if (mode === "code" && !isProseInCode(state, pos)) continue;
      if (mode === "markdown" && skippedInMarkdown(state, pos)) continue;
      let w = m[0].replace(/’/g, "'");
      let wFrom = pos;
      if (lang === "fr") {
        // French elision: l'homme, qu'il, jusqu'à -> check the word after the apostrophe.
        const i = w.indexOf("'");
        if (i > 0 && i <= 6) {
          wFrom += i + 1;
          w = w.slice(i + 1);
        }
      }
      words.push({ from: wFrom, to: from + end, text: w });
    }
  }
  return words;
}

// ---------------------------------------------------------------- extension

const misspelled = Decoration.mark({ class: "cm-misspelled" });

export function spellcheck(lang: SpellLang, mode: Mode): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      timer: number | undefined;
      /** End position of the word currently being typed; it isn't flagged until the user moves on. */
      typing = -1;
      constructor(readonly view: EditorView) {
        this.schedule(0);
      }
      update(u: ViewUpdate) {
        if (u.docChanged) this.decorations = this.decorations.map(u.changes);
        if (u.docChanged && u.transactions.some((t) => t.isUserEvent("input.type"))) this.typing = u.state.selection.main.head;
        else if (u.selectionSet) this.typing = -1;
        if (u.docChanged || u.viewportChanged || u.selectionSet || u.transactions.some((t) => t.effects.some((e) => e.is(refresh)))) {
          this.decorations = this.build();
          if (u.docChanged || u.viewportChanged) this.schedule(250);
        }
      }
      schedule(ms: number) {
        clearTimeout(this.timer);
        this.timer = window.setTimeout(async () => {
          const words = collect(this.view, mode, lang);
          const changed = await checkWords(lang, words.map((w) => w.text));
          if (changed || this.decorations === Decoration.none) this.view.dispatch({ effects: refresh.of(null) });
        }, ms);
      }
      build() {
        const c = langCache(lang);
        const b = new RangeSetBuilder<Decoration>();
        for (const w of collect(this.view, mode, lang)) {
          if (c.get(w.text) !== false || ignored.has(w.text)) continue;
          // Don't flag the word that is being typed right now.
          if (w.to === this.typing) continue;
          b.add(w.from, w.to, misspelled);
        }
        return b.finish();
      }
      destroy() {
        clearTimeout(this.timer);
      }
    },
    { decorations: (v) => v.decorations },
  );
  return [
    plugin,
    EditorView.contentAttributes.of({ spellcheck: "false", lang }),
    EditorView.baseTheme({
      ".cm-misspelled": {
        textDecoration: "underline wavy #df7067",
        textDecorationSkipInk: "none",
        textUnderlineOffset: "3px",
        textDecorationThickness: "1.2px",
      },
    }),
  ];
}

/** Finds a misspelled word at `pos` (if any) so the context menu can offer suggestions. */
export function misspelledAt(view: EditorView, pos: number): { from: number; to: number; word: string } | null {
  let hit: { from: number; to: number; word: string } | null = null;
  view.state.facet(EditorView.decorations).forEach((d) => {
    const set = typeof d === "function" ? d(view) : d;
    set.between(pos, pos, (from, to, val) => {
      if ((val.spec as any).class === "cm-misspelled") {
        hit = { from, to, word: view.state.sliceDoc(from, to).replace(/’/g, "'") };
        return false;
      }
    });
  });
  return hit;
}

/** Re-runs the check (after adding a word to the dictionary or ignoring it). */
export function refreshSpell(view: EditorView) {
  view.dispatch({ effects: refresh.of(null) });
}
