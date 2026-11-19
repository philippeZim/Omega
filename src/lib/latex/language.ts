import { StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { autocompletion, snippetCompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { StateField, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, showTooltip, type Tooltip } from "@codemirror/view";
import { lintGutter } from "@codemirror/lint";
import { codeHighlight } from "../theme";
import { renderMath } from "../markdown/widgets";
import { fsApi } from "../api";

export const latexLanguage = StreamLanguage.define(stex);

// ------------------------------------------------------------------ completion data

const COMMANDS: [string, string][] = [
  // structure
  ["section{#{}}", "Abschnitt"], ["subsection{#{}}", "Unterabschnitt"], ["subsubsection{#{}}", "Unter-Unterabschnitt"],
  ["chapter{#{}}", "Kapitel"], ["part{#{}}", "Teil"], ["paragraph{#{}}", "Paragraph"], ["section*{#{}}", "Abschnitt ohne Nummer"],
  ["title{#{}}", "Titel"], ["author{#{}}", "Autor"], ["date{#{}}", "Datum"], ["maketitle", "Titel setzen"],
  ["tableofcontents", "Inhaltsverzeichnis"], ["listoffigures", "Abbildungsverzeichnis"], ["listoftables", "Tabellenverzeichnis"],
  ["appendix", "Anhang"], ["newpage", "Neue Seite"], ["clearpage", "Seite leeren"], ["documentclass{#{article}}", "Dokumentklasse"],
  ["usepackage{#{}}", "Paket laden"], ["usepackage[#{}]{#{}}", "Paket mit Optionen"], ["input{#{}}", "Datei einbinden"], ["include{#{}}", "Datei einbinden (neue Seite)"],
  // text
  ["textbf{#{}}", "Fett"], ["textit{#{}}", "Kursiv"], ["emph{#{}}", "Hervorheben"], ["underline{#{}}", "Unterstrichen"],
  ["texttt{#{}}", "Schreibmaschine"], ["textsc{#{}}", "Kapitälchen"], ["textsf{#{}}", "Serifenlos"], ["textrm{#{}}", "Serif"],
  ["footnote{#{}}", "Fußnote"], ["url{#{}}", "URL"], ["href{#{}}{#{}}", "Link"], ["label{#{}}", "Label"],
  ["ref{#{}}", "Verweis"], ["eqref{#{}}", "Gleichungsverweis"], ["pageref{#{}}", "Seitenverweis"], ["autoref{#{}}", "Auto-Verweis"], ["cref{#{}}", "Cleveref"],
  ["cite{#{}}", "Zitat"], ["citep{#{}}", "Zitat (Klammer)"], ["citet{#{}}", "Zitat (Text)"], ["caption{#{}}", "Beschriftung"],
  ["includegraphics[width=#{\\linewidth}]{#{}}", "Bild"], ["centering", "Zentrieren"], ["item ", "Listenpunkt"],
  ["tiny", "Größe"], ["small", "Größe"], ["normalsize", "Größe"], ["large", "Größe"], ["Large", "Größe"], ["LARGE", "Größe"], ["huge", "Größe"],
  ["hspace{#{}}", "Horizontaler Abstand"], ["vspace{#{}}", "Vertikaler Abstand"], ["noindent", "Kein Einzug"], ["linebreak", "Zeilenumbruch"],
  ["hline", "Tabellenlinie"], ["toprule", "booktabs oben"], ["midrule", "booktabs Mitte"], ["bottomrule", "booktabs unten"], ["multicolumn{#{}}{#{}}{#{}}", "Mehrspaltig"],
  ["bibliography{#{}}", "Literatur (BibTeX)"], ["bibliographystyle{#{plain}}", "Literaturstil"], ["addbibresource{#{}}", "Literatur (biblatex)"], ["printbibliography", "Literatur ausgeben"],
  ["newcommand{\\#{name}}[#{1}]{#{}}", "Neuer Befehl"], ["renewcommand{\\#{name}}{#{}}", "Befehl ersetzen"],
  ["textwidth", "Textbreite"], ["linewidth", "Zeilenbreite"], ["today", "Heutiges Datum"], ["LaTeX", "LaTeX-Logo"],
  // math
  ["frac{#{}}{#{}}", "Bruch"], ["dfrac{#{}}{#{}}", "Bruch (groß)"], ["sqrt{#{}}", "Wurzel"], ["sqrt[#{n}]{#{}}", "n-te Wurzel"],
  ["sum_{#{i=1}}^{#{n}}", "Summe"], ["prod_{#{i=1}}^{#{n}}", "Produkt"], ["int_{#{a}}^{#{b}}", "Integral"], ["iint", "Doppelintegral"], ["oint", "Kurvenintegral"],
  ["lim_{#{x \\to \\infty}}", "Limes"], ["infty", "Unendlich"], ["partial", "Partiell"], ["nabla", "Nabla"], ["cdot", "Mal-Punkt"], ["times", "Kreuz"],
  ["leq", "≤"], ["geq", "≥"], ["neq", "≠"], ["approx", "≈"], ["equiv", "≡"], ["sim", "∼"], ["pm", "±"], ["mp", "∓"],
  ["in", "∈"], ["notin", "∉"], ["subset", "⊂"], ["subseteq", "⊆"], ["cup", "∪"], ["cap", "∩"], ["emptyset", "∅"], ["forall", "∀"], ["exists", "∃"],
  ["rightarrow", "→"], ["leftarrow", "←"], ["Rightarrow", "⇒"], ["Leftrightarrow", "⇔"], ["mapsto", "↦"], ["to", "→"],
  ["mathbb{#{R}}", "Doppelstrich"], ["mathcal{#{}}", "Kalligraphisch"], ["mathbf{#{}}", "Fett (Mathe)"], ["mathrm{#{}}", "Aufrecht (Mathe)"], ["text{#{}}", "Text in Mathe"],
  ["vec{#{}}", "Vektor"], ["hat{#{}}", "Hut"], ["bar{#{}}", "Strich"], ["dot{#{}}", "Punkt"], ["overline{#{}}", "Überstrich"], ["underbrace{#{}}_{#{}}", "Unterklammer"],
  ["left( #{} \\right)", "Klammern (skaliert)"], ["left[ #{} \\right]", "Eckige Klammern (skaliert)"], ["left\\{ #{} \\right\\}", "Geschweifte (skaliert)"],
  ["alpha", "α"], ["beta", "β"], ["gamma", "γ"], ["delta", "δ"], ["epsilon", "ε"], ["varepsilon", "ε"], ["zeta", "ζ"], ["eta", "η"], ["theta", "θ"],
  ["lambda", "λ"], ["mu", "μ"], ["nu", "ν"], ["xi", "ξ"], ["pi", "π"], ["rho", "ρ"], ["sigma", "σ"], ["tau", "τ"], ["phi", "φ"], ["varphi", "φ"],
  ["chi", "χ"], ["psi", "ψ"], ["omega", "ω"], ["Gamma", "Γ"], ["Delta", "Δ"], ["Theta", "Θ"], ["Lambda", "Λ"], ["Sigma", "Σ"], ["Phi", "Φ"], ["Omega", "Ω"],
  ["sin", "Sinus"], ["cos", "Kosinus"], ["tan", "Tangens"], ["log", "Logarithmus"], ["ln", "Ln"], ["exp", "Exp"], ["max", "Max"], ["min", "Min"],
  ["quad", "Abstand"], ["qquad", "Doppelabstand"], ["ldots", "…"], ["cdots", "⋯"], ["binom{#{n}}{#{k}}", "Binomialkoeffizient"],
];

const ENVIRONMENTS: [string, string, string][] = [
  ["itemize", "\\item #{}", "Aufzählung"], ["enumerate", "\\item #{}", "Nummerierte Liste"], ["description", "\\item[#{}] #{}", "Beschreibungsliste"],
  ["equation", "#{}", "Gleichung (nummeriert)"], ["equation*", "#{}", "Gleichung"], ["align", "#{} &= #{}", "Ausgerichtete Gleichungen"], ["align*", "#{} &= #{}", "Ausgerichtet ohne Nummer"],
  ["gather", "#{}", "Zentrierte Gleichungen"], ["cases", "#{} & #{}", "Fallunterscheidung"],
  ["matrix", "#{}", "Matrix"], ["pmatrix", "#{a} & #{b} \\\\\\\\ #{c} & #{d}", "Matrix (runde Klammern)"], ["bmatrix", "#{}", "Matrix (eckige Klammern)"],
  ["figure", "\\centering\n\t\\includegraphics[width=\\linewidth]{#{}}\n\t\\caption{#{}}\n\t\\label{fig:#{}}", "Abbildung"],
  ["table", "\\centering\n\t\\begin{tabular}{#{lll}}\n\t\t#{}\n\t\\end{tabular}\n\t\\caption{#{}}", "Tabelle"],
  ["tabular", "#{}", "Tabelle (tabular)"], ["center", "#{}", "Zentriert"], ["minipage", "#{}", "Minipage"],
  ["abstract", "#{}", "Zusammenfassung"], ["quote", "#{}", "Zitat"], ["verbatim", "#{}", "Wörtlich"], ["lstlisting", "#{}", "Code-Listing"],
  ["theorem", "#{}", "Satz"], ["proof", "#{}", "Beweis"], ["lemma", "#{}", "Lemma"], ["definition", "#{}", "Definition"], ["document", "#{}", "Dokument"],
  ["frame", "\\frametitle{#{}}\n\t#{}", "Beamer-Folie"], ["tikzpicture", "#{}", "TikZ-Grafik"],
];

const commandCompletions: Completion[] = COMMANDS.map(([tpl, info]) =>
  snippetCompletion("\\" + tpl, { label: "\\" + tpl.replace(/#\{[^}]*\}/g, "").replace(/[{[].*$/, ""), detail: info, type: "keyword" }),
);
const envCompletions: Completion[] = ENVIRONMENTS.map(([name, body, info]) =>
  snippetCompletion(`\\begin{${name}}\n\t${body}\n\\end{${name}}`, { label: `\\begin{${name}}`, detail: info, type: "class", boost: 2 }),
);
const envNameCompletions = (closing: boolean): Completion[] =>
  ENVIRONMENTS.map(([name, body, info]) =>
    closing ? { label: name, detail: info, type: "class" } : snippetCompletion(`${name}}\n\t${body}\n\\end{${name}}`, { label: name, detail: info, type: "class" }),
  );

// ------------------------------------------------------------------ labels & citations

function labels(state: EditorState): Completion[] {
  const out = new Map<string, Completion>();
  for (const m of state.doc.toString().matchAll(/\\label\{([^}]+)\}/g)) out.set(m[1], { label: m[1], type: "variable", detail: "Label" });
  return [...out.values()];
}

async function citations(state: EditorState, path: string | null): Promise<Completion[]> {
  const text = state.doc.toString();
  const keys = new Map<string, Completion>();
  for (const m of text.matchAll(/\\bibitem(?:\[[^\]]*\])?\{([^}]+)\}/g)) keys.set(m[1], { label: m[1], type: "text", detail: "bibitem" });
  if (path) {
    const dir = path.replace(/\/[^/]*$/, "");
    const files = [...text.matchAll(/\\(?:bibliography|addbibresource)\{([^}]+)\}/g)].flatMap((m) => m[1].split(",").map((s) => s.trim()));
    for (const f of files) {
      const p = `${dir}/${f.endsWith(".bib") ? f : f + ".bib"}`;
      try {
        const bib = await fsApi.readFile(p);
        for (const m of bib.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,([\s\S]*?)(?=\n@|$)/g)) {
          const title = /title\s*=\s*[{"]([^}"]+)/i.exec(m[2])?.[1];
          keys.set(m[1], { label: m[1], type: "text", detail: title?.slice(0, 50) ?? "BibTeX" });
        }
      } catch {
        /* missing .bib */
      }
    }
  }
  return [...keys.values()];
}

function latexCompletions(path: string | null) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const before = ctx.state.sliceDoc(Math.max(0, ctx.pos - 200), ctx.pos);

    const ref = /\\(?:ref|eqref|pageref|autoref|cref|Cref|vref)\{([^}]*)$/.exec(before);
    if (ref) return { from: ctx.pos - ref[1].length, options: labels(ctx.state), validFor: /^[^}]*$/ };

    const cite = /\\(?:cite|citep|citet|parencite|textcite|autocite)\w*(?:\[[^\]]*\])*\{(?:[^}]*,)?\s*([^,}]*)$/.exec(before);
    if (cite) return { from: ctx.pos - cite[1].length, options: await citations(ctx.state, path), validFor: /^[^,}]*$/ };

    const env = /\\(begin|end)\{([\w*]*)$/.exec(before);
    if (env) return { from: ctx.pos - env[2].length, options: envNameCompletions(env[1] === "end"), validFor: /^[\w*]*$/ };

    const cmd = ctx.matchBefore(/\\[a-zA-Z]*/);
    if (cmd && (cmd.from < cmd.to || ctx.explicit)) {
      return { from: cmd.from, options: [...envCompletions, ...commandCompletions], validFor: /^\\[a-zA-Z]*$/ };
    }
    return null;
  };
}

// ------------------------------------------------------------------ math preview tooltip

const MATH_RE =
  /\$\$([\s\S]+?)\$\$|\$((?:\\.|[^$\\])+?)\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\\begin\{(equation\*?|align\*?|gather\*?|multline\*?|displaymath|math)\}([\s\S]*?)\\end\{\5\}/g;

function mathAt(state: EditorState, pos: number): { from: number; tex: string; display: boolean } | null {
  const start = Math.max(0, pos - 4000);
  const text = state.sliceDoc(start, Math.min(state.doc.length, pos + 4000));
  MATH_RE.lastIndex = 0;
  for (let m; (m = MATH_RE.exec(text)); ) {
    const from = start + m.index, to = from + m[0].length;
    if (from > pos) break;
    if (pos < from || pos > to) continue;
    let tex = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[6] ?? "";
    const env = m[5];
    tex = tex.replace(/\\label\{[^}]*\}/g, "").replace(/\\nonumber|\\notag/g, "");
    if (env?.startsWith("align")) tex = `\\begin{aligned}${tex}\\end{aligned}`;
    else if (env?.startsWith("gather")) tex = `\\begin{gathered}${tex}\\end{gathered}`;
    return { from, tex: tex.trim(), display: !m[2] && !m[4] };
  }
  return null;
}

const mathTooltip = StateField.define<readonly Tooltip[]>({
  create: () => [],
  update(value, tr) {
    if (!tr.docChanged && !tr.selection) return value;
    const sel = tr.state.selection.main;
    if (!sel.empty) return [];
    const m = mathAt(tr.state, sel.head);
    if (!m || !m.tex) return [];
    return [
      {
        pos: tr.state.doc.lineAt(sel.head).from,
        above: true,
        strictSide: false,
        arrow: false,
        create: () => {
          const dom = document.createElement("div");
          dom.className = "tex-preview";
          dom.innerHTML = renderMath(m.tex, true);
          return { dom };
        },
      },
    ];
  },
  provide: (f) => showTooltip.computeN([f], (s) => s.field(f, false) ?? []),
});

// ------------------------------------------------------------------ outline

export interface OutlineItem {
  level: number;
  title: string;
  line: number;
  pos: number;
}

const LEVELS: Record<string, number> = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5 };

export function outline(text: string): OutlineItem[] {
  const out: OutlineItem[] = [];
  const re = /^[^%\n]*?\\(part|chapter|section|subsection|subsubsection|paragraph)\*?(?:\[[^\]]*\])?\{([^}]*)\}/gm;
  for (let m; (m = re.exec(text)); ) {
    const pos = m.index + m[0].indexOf("\\" + m[1]);
    out.push({ level: LEVELS[m[1]], title: m[2].trim() || "(leer)", line: text.slice(0, pos).split("\n").length, pos });
  }
  return out;
}

// ------------------------------------------------------------------ extension

const latexTheme = EditorView.baseTheme({
  ".tex-preview": { padding: "10px 16px", maxWidth: "640px", overflowX: "auto", fontSize: "15px" },
});

export function latexExtensions(path: string | null): Extension {
  return [
    latexLanguage,
    syntaxHighlighting(codeHighlight),
    autocompletion({ override: [latexCompletions(path)], icons: false }),
    mathTooltip,
    lintGutter(),
    latexTheme,
  ];
}
