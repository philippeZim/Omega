import { StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { autocompletion, snippetCompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { StateField, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, showTooltip, type Tooltip } from "@codemirror/view";
import { lintGutter } from "@codemirror/lint";
import { codeHighlight } from "../theme";
import { renderMath } from "../markdown/widgets";
import { fsApi } from "../api";
import { t, type Key } from "../i18n/index.svelte";

export const latexLanguage = StreamLanguage.define(stex);

// ------------------------------------------------------------------ completion data
// Details are dictionary keys ("tex.*" → "commands.tex.*") or literal symbols/names.

const COMMANDS: [string, string][] = [
  // structure
  ["section{#{}}", "tex.section"], ["subsection{#{}}", "tex.subsection"], ["subsubsection{#{}}", "tex.subsubsection"],
  ["chapter{#{}}", "tex.chapter"], ["part{#{}}", "tex.part"], ["paragraph{#{}}", "tex.paragraph"], ["section*{#{}}", "tex.sectionStar"],
  ["title{#{}}", "tex.title"], ["author{#{}}", "tex.author"], ["date{#{}}", "tex.date"], ["maketitle", "tex.maketitle"],
  ["tableofcontents", "tex.tableofcontents"], ["listoffigures", "tex.listoffigures"], ["listoftables", "tex.listoftables"],
  ["appendix", "tex.appendix"], ["newpage", "tex.newpage"], ["clearpage", "tex.clearpage"], ["documentclass{#{article}}", "tex.documentclass"],
  ["usepackage{#{}}", "tex.usepackage"], ["usepackage[#{}]{#{}}", "tex.usepackageOpt"], ["input{#{}}", "tex.input"], ["include{#{}}", "tex.include"],
  // text
  ["textbf{#{}}", "tex.bold"], ["textit{#{}}", "tex.italic"], ["emph{#{}}", "tex.emph"], ["underline{#{}}", "tex.underline"],
  ["texttt{#{}}", "tex.texttt"], ["textsc{#{}}", "tex.textsc"], ["textsf{#{}}", "tex.textsf"], ["textrm{#{}}", "tex.textrm"],
  ["footnote{#{}}", "tex.footnote"], ["url{#{}}", "URL"], ["href{#{}}{#{}}", "tex.link"], ["label{#{}}", "tex.label"],
  ["ref{#{}}", "tex.ref"], ["eqref{#{}}", "tex.eqref"], ["pageref{#{}}", "tex.pageref"], ["autoref{#{}}", "tex.autoref"], ["cref{#{}}", "Cleveref"],
  ["cite{#{}}", "tex.cite"], ["citep{#{}}", "tex.citep"], ["citet{#{}}", "tex.citet"], ["caption{#{}}", "tex.caption"],
  ["includegraphics[width=#{\\linewidth}]{#{}}", "tex.image"], ["centering", "tex.centering"], ["item ", "tex.item"],
  ["tiny", "tex.size"], ["small", "tex.size"], ["normalsize", "tex.size"], ["large", "tex.size"], ["Large", "tex.size"], ["LARGE", "tex.size"], ["huge", "tex.size"],
  ["hspace{#{}}", "tex.hspace"], ["vspace{#{}}", "tex.vspace"], ["noindent", "tex.noindent"], ["linebreak", "tex.linebreak"],
  ["hline", "tex.hline"], ["toprule", "tex.toprule"], ["midrule", "tex.midrule"], ["bottomrule", "tex.bottomrule"], ["multicolumn{#{}}{#{}}{#{}}", "tex.multicolumn"],
  ["bibliography{#{}}", "tex.bibliography"], ["bibliographystyle{#{plain}}", "tex.bibliographystyle"], ["addbibresource{#{}}", "tex.addbibresource"], ["printbibliography", "tex.printbibliography"],
  ["newcommand{\\#{name}}[#{1}]{#{}}", "tex.newcommand"], ["renewcommand{\\#{name}}{#{}}", "tex.renewcommand"],
  ["textwidth", "tex.textwidth"], ["linewidth", "tex.linewidth"], ["today", "tex.today"], ["LaTeX", "tex.latexLogo"],
  // math
  ["frac{#{}}{#{}}", "tex.frac"], ["dfrac{#{}}{#{}}", "tex.dfrac"], ["sqrt{#{}}", "tex.sqrt"], ["sqrt[#{n}]{#{}}", "tex.nthroot"],
  ["sum_{#{i=1}}^{#{n}}", "tex.sum"], ["prod_{#{i=1}}^{#{n}}", "tex.prod"], ["int_{#{a}}^{#{b}}", "tex.int"], ["iint", "tex.iint"], ["oint", "tex.oint"],
  ["lim_{#{x \\to \\infty}}", "tex.lim"], ["infty", "tex.infty"], ["partial", "tex.partial"], ["nabla", "Nabla"], ["cdot", "tex.cdot"], ["times", "tex.times"],
  ["leq", "≤"], ["geq", "≥"], ["neq", "≠"], ["approx", "≈"], ["equiv", "≡"], ["sim", "∼"], ["pm", "±"], ["mp", "∓"],
  ["in", "∈"], ["notin", "∉"], ["subset", "⊂"], ["subseteq", "⊆"], ["cup", "∪"], ["cap", "∩"], ["emptyset", "∅"], ["forall", "∀"], ["exists", "∃"],
  ["rightarrow", "→"], ["leftarrow", "←"], ["Rightarrow", "⇒"], ["Leftrightarrow", "⇔"], ["mapsto", "↦"], ["to", "→"],
  ["mathbb{#{R}}", "tex.mathbb"], ["mathcal{#{}}", "tex.mathcal"], ["mathbf{#{}}", "tex.mathbf"], ["mathrm{#{}}", "tex.mathrm"], ["text{#{}}", "tex.text"],
  ["vec{#{}}", "tex.vec"], ["hat{#{}}", "tex.hat"], ["bar{#{}}", "tex.bar"], ["dot{#{}}", "tex.dot"], ["overline{#{}}", "tex.overline"], ["underbrace{#{}}_{#{}}", "tex.underbrace"],
  ["left( #{} \\right)", "tex.leftParen"], ["left[ #{} \\right]", "tex.leftBracket"], ["left\\{ #{} \\right\\}", "tex.leftBrace"],
  ["alpha", "α"], ["beta", "β"], ["gamma", "γ"], ["delta", "δ"], ["epsilon", "ε"], ["varepsilon", "ε"], ["zeta", "ζ"], ["eta", "η"], ["theta", "θ"],
  ["lambda", "λ"], ["mu", "μ"], ["nu", "ν"], ["xi", "ξ"], ["pi", "π"], ["rho", "ρ"], ["sigma", "σ"], ["tau", "τ"], ["phi", "φ"], ["varphi", "φ"],
  ["chi", "χ"], ["psi", "ψ"], ["omega", "ω"], ["Gamma", "Γ"], ["Delta", "Δ"], ["Theta", "Θ"], ["Lambda", "Λ"], ["Sigma", "Σ"], ["Phi", "Φ"], ["Omega", "Ω"],
  ["sin", "tex.sin"], ["cos", "tex.cos"], ["tan", "tex.tan"], ["log", "tex.log"], ["ln", "Ln"], ["exp", "Exp"], ["max", "Max"], ["min", "Min"],
  ["quad", "tex.quad"], ["qquad", "tex.qquad"], ["ldots", "…"], ["cdots", "⋯"], ["binom{#{n}}{#{k}}", "tex.binom"],
];

const ENVIRONMENTS: [string, string, string][] = [
  ["itemize", "\\item #{}", "tex.env.itemize"], ["enumerate", "\\item #{}", "tex.env.enumerate"], ["description", "\\item[#{}] #{}", "tex.env.description"],
  ["equation", "#{}", "tex.env.equation"], ["equation*", "#{}", "tex.env.equationStar"], ["align", "#{} &= #{}", "tex.env.align"], ["align*", "#{} &= #{}", "tex.env.alignStar"],
  ["gather", "#{}", "tex.env.gather"], ["cases", "#{} & #{}", "tex.env.cases"],
  ["matrix", "#{}", "tex.env.matrix"], ["pmatrix", "#{a} & #{b} \\\\\\\\ #{c} & #{d}", "tex.env.pmatrix"], ["bmatrix", "#{}", "tex.env.bmatrix"],
  ["figure", "\\centering\n\t\\includegraphics[width=\\linewidth]{#{}}\n\t\\caption{#{}}\n\t\\label{fig:#{}}", "tex.env.figure"],
  ["table", "\\centering\n\t\\begin{tabular}{#{lll}}\n\t\t#{}\n\t\\end{tabular}\n\t\\caption{#{}}", "tex.env.table"],
  ["tabular", "#{}", "tex.env.tabular"], ["center", "#{}", "tex.env.center"], ["minipage", "#{}", "Minipage"],
  ["abstract", "#{}", "tex.env.abstract"], ["quote", "#{}", "tex.env.quote"], ["verbatim", "#{}", "tex.env.verbatim"], ["lstlisting", "#{}", "tex.env.lstlisting"],
  ["theorem", "#{}", "tex.env.theorem"], ["proof", "#{}", "tex.env.proof"], ["lemma", "#{}", "tex.env.lemma"], ["definition", "#{}", "tex.env.definition"], ["document", "#{}", "tex.env.document"],
  ["frame", "\\frametitle{#{}}\n\t#{}", "tex.env.frame"], ["tikzpicture", "#{}", "tex.env.tikzpicture"],
];

const detail = (d: string) => (d.startsWith("tex.") ? t(`commands.${d}` as Key) : d);

// Built per request so the details follow the UI language.
const commandCompletions = (): Completion[] =>
  COMMANDS.map(([tpl, info]) =>
    snippetCompletion("\\" + tpl, { label: "\\" + tpl.replace(/#\{[^}]*\}/g, "").replace(/[{[].*$/, ""), detail: detail(info), type: "keyword" }),
  );
const envCompletions = (): Completion[] =>
  ENVIRONMENTS.map(([name, body, info]) =>
    snippetCompletion(`\\begin{${name}}\n\t${body}\n\\end{${name}}`, { label: `\\begin{${name}}`, detail: detail(info), type: "class", boost: 2 }),
  );
const envNameCompletions = (closing: boolean): Completion[] =>
  ENVIRONMENTS.map(([name, body, info]) =>
    closing ? { label: name, detail: detail(info), type: "class" } : snippetCompletion(`${name}}\n\t${body}\n\\end{${name}}`, { label: name, detail: detail(info), type: "class" }),
  );

// ------------------------------------------------------------------ labels & citations

function labels(state: EditorState): Completion[] {
  const out = new Map<string, Completion>();
  for (const m of state.doc.toString().matchAll(/\\label\{([^}]+)\}/g)) out.set(m[1], { label: m[1], type: "variable", detail: t("commands.tex.label") });
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
      return { from: cmd.from, options: [...envCompletions(), ...commandCompletions()], validFor: /^\\[a-zA-Z]*$/ };
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

/** Body of the brace group that starts at `from` (just after its "{"), honouring nested
 *  groups and escaped braces; null if it isn't closed before a blank line or the end. */
function groupBody(text: string, from: number): string | null {
  let depth = 1;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(from, i);
    else if (c === "\n" && text[i + 1] === "\n") return null;
  }
  return null;
}

export function outline(text: string): OutlineItem[] {
  const out: OutlineItem[] = [];
  const re = /^[^%\n]*?\\(part|chapter|section|subsection|subsubsection|paragraph)\*?(?:\[[^\]]*\])?\{/gm;
  for (let m; (m = re.exec(text)); ) {
    const pos = m.index + m[0].indexOf("\\" + m[1]);
    const title = groupBody(text, m.index + m[0].length);
    if (title === null) continue;
    out.push({ level: LEVELS[m[1]], title: title.trim() || t("commands.tex.empty"), line: text.slice(0, pos).split("\n").length, pos });
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
