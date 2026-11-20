/** Cheat-sheet content per mode (and per language in code mode), in English, German and French. */
import { i18n, type Locale } from "./i18n/index.svelte";
import { codeSheets } from "./help-code";

export interface Sheet {
  title: string;
  sections: { title: string; rows: [string, string][] }[];
}

/**
 * Authoring format: a text is either the same in every language or an `[en, de, fr]` triple.
 * A row is `[code, description]` or `[code, en, de, fr]`. Plain-string code columns are written with
 * English key names (Ctrl, Home, End, Space, Click), which `keyNames` converts per locale.
 */
export type Tx = string | [en: string, de: string, fr: string];
export type RawRow = [code: Tx, desc: string] | [code: Tx, en: string, de: string, fr: string];
export interface RawSheet {
  title: Tx;
  sections: { title: Tx; rows: RawRow[] }[];
}

const IDX: Record<Locale, number> = { en: 0, de: 1, fr: 2 };
const KEY_NAMES: Record<Locale, Record<string, string>> = {
  en: {},
  de: { Ctrl: "Strg", Home: "Pos1", End: "Ende", Space: "Leertaste", Click: "Klick" },
  fr: { Home: "Début", End: "Fin", Space: "Espace", Click: "clic" },
};

function keyNames(s: string, l: Locale): string {
  const map = KEY_NAMES[l];
  return s.replace(/\b(Ctrl|Home|End|Space|Click)\b/g, (m) => map[m] ?? m);
}

const tx = (v: Tx, l: Locale) => (typeof v === "string" ? v : v[IDX[l]]);

function localize(raw: RawSheet, l: Locale): Sheet {
  return {
    title: tx(raw.title, l),
    sections: raw.sections.map((sec) => ({
      title: tx(sec.title, l),
      rows: sec.rows.map(([code, ...desc]): [string, string] => [
        typeof code === "string" ? keyNames(code, l) : code[IDX[l]],
        desc.length === 3 ? desc[IDX[l]] : desc[0],
      ]),
    })),
  };
}

const markdown: RawSheet = {
  title: "Markdown",
  sections: [
    {
      title: "Text",
      rows: [
        [["**bold**", "**fett**", "**gras**"], "Bold · Ctrl B", "Fett · Strg B", "Gras · Ctrl B"],
        [["*italic*  _italic_", "*kursiv*  _kursiv_", "*italique*  _italique_"], "Italic · Ctrl I", "Kursiv · Strg I", "Italique · Ctrl I"],
        [["~~strike~~", "~~durch~~", "~~barré~~"], "Strikethrough · Ctrl ⇧ X", "Durchgestrichen · Strg ⇧ X", "Barré · Ctrl ⇧ X"],
        [["==marked==", "==markiert==", "==surligné=="], "Highlight · Ctrl ⇧ H", "Hervorheben · Strg ⇧ H", "Surligner · Ctrl ⇧ H"],
        ["`code`", "Inline code · Ctrl E", "Inline-Code · Strg E", "Code en ligne · Ctrl E"],
        ["\\*", "Escape a character", "Zeichen escapen", "Échapper un caractère"],
      ],
    },
    {
      title: ["Structure", "Struktur", "Structure"],
      rows: [
        [["# Title … ###### Title", "# Titel … ###### Titel", "# Titre … ###### Titre"], "Heading level 1–6", "Überschrift Ebene 1–6", "Titre de niveau 1 à 6"],
        [["> Quote", "> Zitat", "> Citation"], "Blockquote", "Zitat", "Citation"],
        ["---", "Horizontal rule", "Trennlinie", "Ligne de séparation"],
        [["Blank line", "Leerzeile", "Ligne vide"], "New paragraph", "Neuer Absatz", "Nouveau paragraphe"],
        [["Two spaces at line end", "Zwei Leerzeichen am Ende", "Deux espaces en fin de ligne"], "Line break", "Zeilenumbruch", "Saut de ligne"],
      ],
    },
    {
      title: ["Lists", "Listen", "Listes"],
      rows: [
        [["- Item", "- Punkt", "- Élément"], "Bullet list (Enter continues it)", "Aufzählung (Enter setzt fort)", "Liste à puces (Entrée la prolonge)"],
        [["1. Item", "1. Punkt", "1. Élément"], "Numbered list", "Nummerierte Liste", "Liste numérotée"],
        [["- [ ] Task", "- [ ] Aufgabe", "- [ ] Tâche"], "Checkbox (clickable)", "Checkbox (anklickbar)", "Case à cocher (cliquable)"],
        [["- [x] Done", "- [x] Erledigt", "- [x] Fait"], "Checked checkbox", "Abgehakte Checkbox", "Case cochée"],
        ["Tab / ⇧ Tab", "Indent / Outdent", "Ein- / Ausrücken", "Indenter / Désindenter"],
      ],
    },
    {
      title: ["Links & Images", "Links & Bilder", "Liens et images"],
      rows: [
        [["[Text](https://…)", "[Text](https://…)", "[Texte](https://…)"], "Link · Ctrl K (click opens)", "Link · Strg K (Klick öffnet)", "Lien · Ctrl K (un clic l'ouvre)"],
        [["[Text](note.md)", "[Text](notiz.md)", "[Texte](note.md)"], "Link to a local file", "Link auf lokale Datei", "Lien vers un fichier local"],
        ["<https://…>", "Automatic link", "Automatischer Link", "Lien automatique"],
        [["![Alt](image.png)", "![Alt](bild.png)", "![Alt](image.png)"], "Image (relative to the file)", "Bild (relativ zur Datei)", "Image (relative au fichier)"],
      ],
    },
    {
      title: ["Callouts", "Callouts", "Encadrés (callouts)"],
      rows: [
        [["> [!tip] Title\n> Text", "> [!tip] Titel\n> Text", "> [!tip] Titre\n> Texte"], "Callout box (title optional)", "Hinweis-Box (Titel optional)", "Encadré (titre facultatif)"],
        [["> [!question]- Title", "> [!question]- Titel", "> [!question]- Titre"], "Foldable, starts collapsed", "Einklappbar, startet zu", "Repliable, fermé au départ"],
        [["> [!note]+ Title", "> [!note]+ Titel", "> [!note]+ Titre"], "Foldable, starts open", "Einklappbar, startet offen", "Repliable, ouvert au départ"],
        ["note · info · todo", "Blue", "Blau", "Bleu"],
        ["tip · abstract", "Cyan (hint, important · summary, tldr)", "Türkis (hint, important · summary, tldr)", "Cyan (hint, important · summary, tldr)"],
        ["success", "Green (check, done)", "Grün (check, done)", "Vert (check, done)"],
        ["question · warning", "Orange (help, faq · caution, attention)", "Orange (help, faq · caution, attention)", "Orange (help, faq · caution, attention)"],
        ["failure · danger · bug", "Red (fail, missing · error)", "Rot (fail, missing · error)", "Rouge (fail, missing · error)"],
        ["example · quote", "Purple · Grey (cite)", "Lila · Grau (cite)", "Violet · Gris (cite)"],
      ],
    },
    {
      title: "Code",
      rows: [
        ["```python\n…\n```", "Code block with highlighting", "Code-Block mit Highlighting", "Bloc de code avec coloration"],
        [["4-space indent", "Einrückung 4 Leerz.", "Retrait de 4 espaces"], "Code block without language", "Code-Block ohne Sprache", "Bloc de code sans langage"],
      ],
    },
    {
      title: ["Tables", "Tabellen", "Tableaux"],
      rows: [
        ["| A | B |\n| - | - |\n| 1 | 2 |", "Table", "Tabelle", "Tableau"],
        ["| :-- | :-: | --: |", "Left / center / right", "Links / zentriert / rechts", "Gauche / centré / droite"],
        [["Click in a cell", "Klick in Zelle", "Clic dans une cellule"], "Edit in place", "Direkt bearbeiten", "Modifier directement"],
        ["Tab / ⇧ Tab", "Next / previous cell", "Nächste / vorherige Zelle", "Cellule suivante / précédente"],
        [["Tab in last cell", "Tab in letzter Zelle", "Tab dans la dernière cellule"], "New row", "Neue Zeile", "Nouvelle ligne"],
        [["Enter · Esc", "Enter · Esc", "Entrée · Échap"], "Cell below · Leave table", "Zelle darunter · Tabelle verlassen", "Cellule en dessous · Quitter le tableau"],
      ],
    },
    {
      title: ["Math (KaTeX)", "Mathe (KaTeX)", "Maths (KaTeX)"],
      rows: [
        ["$E = mc^2$", "Inline formula", "Inline-Formel", "Formule en ligne"],
        ["$$\n\\int_0^1 x\\,dx\n$$", "Block formula", "Block-Formel", "Formule en bloc"],
        ["\\frac{a}{b}  \\sqrt{x}", "Fraction, root", "Bruch, Wurzel", "Fraction, racine"],
        ["x^2  x_i", "Superscript, subscript", "Hoch-, Tiefgestellt", "Exposant, indice"],
        ["\\alpha \\beta \\pi", "Greek letters", "Griechische Buchstaben", "Lettres grecques"],
        ["\\sum_{i=1}^n  \\int_a^b", "Sum, integral", "Summe, Integral", "Somme, intégrale"],
      ],
    },
    {
      title: ["Live Preview", "Live Preview", "Aperçu en direct"],
      rows: [
        [["Cursor on element", "Cursor auf Element", "Curseur sur un élément"], "Shows its Markdown syntax", "Zeigt dessen Markdown-Syntax", "Affiche sa syntaxe Markdown"],
        [["Cursor in line", "Cursor in Zeile", "Curseur dans la ligne"], "Shows the line's # or >", "Zeigt # bzw. > der Zeile", "Affiche le # ou > de la ligne"],
        [["Cursor in table/$$", "Cursor in Tabelle/$$", "Curseur dans tableau/$$"], "Shows the block's source", "Zeigt den Quelltext des Blocks", "Affiche la source du bloc"],
      ],
    },
  ],
};

const latex: RawSheet = {
  title: "LaTeX",
  sections: [
    {
      title: ["Skeleton", "Grundgerüst", "Structure de base"],
      rows: [
        ["\\documentclass{article}", "Document class (article, report, book, beamer)", "Dokumentklasse (article, report, book, beamer)", "Classe de document (article, report, book, beamer)"],
        [["\\usepackage[english]{babel}", "\\usepackage[ngerman]{babel}", "\\usepackage[french]{babel}"], "Language hyphenation & terms", "Deutsche Silbentrennung & Begriffe", "Césure et termes français"],
        ["\\usepackage{amsmath, amssymb}", "Math extensions", "Mathe-Erweiterungen", "Extensions mathématiques"],
        ["\\usepackage{graphicx}", "Include images", "Bilder einbinden", "Insérer des images"],
        ["\\begin{document} … \\end{document}", "Document body", "Dokumentinhalt", "Corps du document"],
        ["\\title{} \\author{} \\maketitle", "Title block", "Titelei", "Page de titre"],
        [["% Comment", "% Kommentar", "% Commentaire"], "Comment line", "Kommentarzeile", "Ligne de commentaire"],
      ],
    },
    {
      title: ["Outline", "Gliederung", "Plan"],
      rows: [
        ["\\chapter{…}", "Chapter (report/book)", "Kapitel (report/book)", "Chapitre (report/book)"],
        ["\\section{…}", "Section", "Abschnitt", "Section"],
        ["\\subsection{…}", "Subsection", "Unterabschnitt", "Sous-section"],
        ["\\section*{…}", "Unnumbered", "Ohne Nummer", "Sans numéro"],
        ["\\tableofcontents", "Table of contents", "Inhaltsverzeichnis", "Table des matières"],
        ["\\label{sec:x} · \\ref{sec:x}", "Set label · reference it", "Label setzen · verweisen", "Définir une étiquette · y renvoyer"],
      ],
    },
    {
      title: ["Text", "Text", "Texte"],
      rows: [
        ["\\textbf{…} \\textit{…}", "Bold · Italic", "Fett · Kursiv", "Gras · Italique"],
        ["\\emph{…} \\underline{…}", "Emphasis · Underline", "Hervorheben · Unterstreichen", "Mise en valeur · Souligné"],
        ["\\texttt{…}", "Typewriter", "Schreibmaschine", "Machine à écrire"],
        ["\\footnote{…}", "Footnote", "Fußnote", "Note de bas de page"],
        [["\\\\  ·  blank line", "\\\\  ·  Leerzeile", "\\\\  ·  ligne vide"], "Line break · Paragraph", "Zeilenumbruch · Absatz", "Saut de ligne · Paragraphe"],
        ["\\newpage", "New page", "Neue Seite", "Nouvelle page"],
        [["\\href{url}{text}", "\\href{url}{Text}", "\\href{url}{texte}"], "Link (hyperref)", "Link (hyperref)", "Lien (hyperref)"],
      ],
    },
    {
      title: ["Lists", "Listen", "Listes"],
      rows: [
        ["\\begin{itemize} \\item …", "Bullet list", "Aufzählung", "Liste à puces"],
        ["\\begin{enumerate} \\item …", "Numbered", "Nummeriert", "Numérotée"],
        ["\\begin{description} \\item[A] …", "Description", "Beschreibung", "Description"],
      ],
    },
    {
      title: ["Math", "Mathe", "Maths"],
      rows: [
        ["$ … $", "Inline formula", "Inline-Formel", "Formule en ligne"],
        ["\\[ … \\]", "Display formula", "Abgesetzte Formel", "Formule centrée"],
        ["\\begin{equation} … \\end{equation}", "Numbered equation", "Nummerierte Gleichung", "Équation numérotée"],
        ["\\begin{align} a &= b \\\\ … \\end{align}", "Aligned (&, \\\\)", "Ausgerichtet (&, \\\\)", "Alignée (&, \\\\)"],
        ["\\frac{a}{b}  \\sqrt{x}  x^{2}  x_{i}", "Fraction, root, exponent, index", "Bruch, Wurzel, Exponent, Index", "Fraction, racine, exposant, indice"],
        ["\\sum_{i=1}^{n}  \\int_a^b  \\lim_{x\\to 0}", "Sum, integral, limit", "Summe, Integral, Limes", "Somme, intégrale, limite"],
        ["\\alpha \\beta \\pi \\Omega", "Greek", "Griechisch", "Grec"],
        ["\\leq \\geq \\neq \\approx \\in", "Relations", "Relationen", "Relations"],
        ["\\mathbb{R}  \\vec{v}  \\hat{x}", "Number sets, vector, hat", "Zahlenmengen, Vektor, Hut", "Ensembles, vecteur, chapeau"],
        ["\\left( … \\right)", "Auto-sized brackets", "Mitwachsende Klammern", "Parenthèses extensibles"],
        ["\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}", "Matrix", "Matrix", "Matrice"],
      ],
    },
    {
      title: ["Figures & Tables", "Abbildungen & Tabellen", "Figures et tableaux"],
      rows: [
        [["\\includegraphics[width=\\linewidth]{image}", "\\includegraphics[width=\\linewidth]{bild}", "\\includegraphics[width=\\linewidth]{image}"], "Image", "Bild", "Image"],
        ["\\begin{figure}[h] … \\caption{} \\end{figure}", "Floating figure", "Gleitumgebung Bild", "Figure flottante"],
        ["\\begin{tabular}{l|c|r} a & b & c \\\\ \\hline", "Table (l/c/r, &, \\\\)", "Tabelle (l/c/r, &, \\\\)", "Tableau (l/c/r, &, \\\\)"],
        ["\\begin{table}[h] … \\end{table}", "Floating table", "Gleitumgebung Tabelle", "Tableau flottant"],
      ],
    },
    {
      title: ["Bibliography", "Literatur", "Bibliographie"],
      rows: [
        ["\\cite{key}", "Cite (keys from .bib are completed)", "Zitieren (Keys aus .bib vervollständigt)", "Citer (clés du .bib complétées)"],
        ["\\bibliography{refs}", "BibTeX file refs.bib", "BibTeX-Datei refs.bib", "Fichier BibTeX refs.bib"],
        ["\\usepackage{biblatex} \\addbibresource{refs.bib}", "biblatex"],
        ["\\printbibliography", "Bibliography (biblatex)", "Literaturverzeichnis (biblatex)", "Bibliographie (biblatex)"],
      ],
    },
    {
      title: ["Editor", "Editor", "Éditeur"],
      rows: [
        [["Typing", "Tippen", "Saisie"], "Compiles automatically (~1 s pause)", "Kompiliert automatisch (~1 s Pause)", "Compile automatiquement (pause d'env. 1 s)"],
        ["Ctrl J", "Jump to cursor position in PDF", "Zur Cursor-Stelle im PDF springen", "Aller à la position du curseur dans le PDF"],
        [["Double-click in PDF", "Doppelklick ins PDF", "Double-clic dans le PDF"], "Jump to source line", "Zur Quellzeile springen", "Aller à la ligne source"],
        [["\\ + letters", "\\ + Buchstaben", "\\ + lettres"], "Complete commands & environments", "Befehle & Umgebungen vervollständigen", "Compléter commandes et environnements"],
        ["Ctrl Space", "Open completion", "Vervollständigung öffnen", "Ouvrir la complétion"],
        [["Cursor in formula", "Cursor in Formel", "Curseur dans une formule"], "Rendered preview above", "Gerenderte Vorschau darüber", "Aperçu rendu au-dessus"],
        ["% !TEX root = main.tex", "Set main file for subfiles", "Hauptdatei für Unterdateien festlegen", "Définir le fichier principal des sous-fichiers"],
      ],
    },
  ],
};

/** The "shortcuts" sheet is generated by HelpPanel from the command registry; this is only its chip. */
const shortcuts: RawSheet = { title: ["Shortcuts", "Shortcuts", "Raccourcis"], sections: [] };

const ORDER: [string, RawSheet | undefined][] = [
  ["shortcuts", shortcuts], ["markdown", markdown], ["latex", latex],
  ["python", codeSheets.python], ["c", codeSheets.c], ["cpp", codeSheets.cpp], ["java", codeSheets.java],
  ["javascript", codeSheets.javascript], ["typescript", codeSheets.typescript], ["rust", codeSheets.rust],
];

const cache = new Map<Locale, { id: string; label: string; sheet: Sheet }[]>();

/** All sheets in display order for the current UI language (reactive: reads `i18n.locale`). */
export function allSheets(): { id: string; label: string; sheet: Sheet }[] {
  const l = i18n.locale;
  let list = cache.get(l);
  if (!list) {
    list = ORDER.filter(([, s]) => s).map(([id, s]) => {
      const sheet = localize(s!, l);
      return { id, label: sheet.title, sheet };
    });
    cache.set(l, list);
  }
  return list;
}

export function sheetIdFor(mode: string, language: string | null): string {
  if (mode === "code") return language && codeSheets[language] ? language : "python";
  if (mode === "text") return "shortcuts";
  return mode;
}
