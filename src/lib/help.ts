/** Cheat-sheet content per mode (and per language in code mode). */
export interface Sheet {
  title: string;
  sections: { title: string; rows: [string, string][] }[];
}

export const sheets: Record<string, Sheet> = {
  text: {
    title: "Text-Editor",
    sections: [
      {
        title: "Bearbeiten",
        rows: [
          ["Strg C / X / V", "Kopieren / Ausschneiden / Einfügen"],
          ["Strg Z", "Rückgängig"],
          ["Strg Y · Strg ⇧ Z", "Wiederholen"],
          ["Strg A", "Alles auswählen"],
          ["Strg D", "Nächstes Vorkommen auswählen"],
          ["Alt ↑ / ↓", "Zeile verschieben"],
          ["⇧ Alt ↑ / ↓", "Zeile duplizieren"],
          ["Strg ⇧ K", "Zeile löschen"],
          ["Strg ]  /  Strg [", "Einrücken / Ausrücken"],
          ["Alt + Ziehen", "Rechteck-Auswahl"],
        ],
      },
      {
        title: "Navigation & Suche",
        rows: [
          ["Strg F", "Suchen"],
          ["Strg H", "Ersetzen"],
          ["F3 · ⇧ F3", "Nächster / vorheriger Treffer"],
          ["Strg G", "Gehe zu Zeile"],
          ["Strg Pos1 / Ende", "Dokumentanfang / -ende"],
          ["Strg ← / →", "Wortweise springen"],
        ],
      },
      {
        title: "Dateien & Fenster",
        rows: [
          ["Strg N", "Neue Datei"],
          ["Strg O", "Ordner öffnen"],
          ["Strg S", "Speichern"],
          ["Strg ⇧ S", "Speichern unter"],
          ["Strg W", "Tab schließen"],
          ["Strg Tab", "Nächster Tab"],
          ["Strg B", "Seitenleiste ein/aus"],
          ["Strg 1 – 4", "Text / Markdown / LaTeX / Code"],
          ["F1", "Dieses Cheat Sheet"],
        ],
      },
      {
        title: "Rechtschreibung",
        rows: [
          ["F7", "Rechtschreibprüfung ein/aus"],
          ["Rechtsklick auf Wort", "Vorschläge · Hinzufügen · Ignorieren"],
          ["Statusleiste „DE“", "Sprache wählen (DE / EN / FR), pro Datei"],
        ],
      },
    ],
  },
};

sheets.markdown = {
  title: "Markdown",
  sections: [
    {
      title: "Text",
      rows: [
        ["**fett**", "Fett · Strg B"],
        ["*kursiv*  _kursiv_", "Kursiv · Strg I"],
        ["~~durch~~", "Durchgestrichen · Strg ⇧ X"],
        ["==markiert==", "Hervorheben · Strg ⇧ H"],
        ["`code`", "Inline-Code · Strg E"],
        ["\\*", "Zeichen escapen"],
      ],
    },
    {
      title: "Struktur",
      rows: [
        ["# Titel … ###### Titel", "Überschrift Ebene 1–6"],
        ["> Zitat", "Zitat"],
        ["---", "Trennlinie"],
        ["Leerzeile", "Neuer Absatz"],
        ["Zwei Leerzeichen am Ende", "Zeilenumbruch"],
      ],
    },
    {
      title: "Listen",
      rows: [
        ["- Punkt", "Aufzählung (Enter setzt fort)"],
        ["1. Punkt", "Nummerierte Liste"],
        ["- [ ] Aufgabe", "Checkbox (anklickbar)"],
        ["- [x] Erledigt", "Abgehakte Checkbox"],
        ["Tab / ⇧ Tab", "Ein- / Ausrücken"],
      ],
    },
    {
      title: "Links & Bilder",
      rows: [
        ["[Text](https://…)", "Link · Strg K (Klick öffnet)"],
        ["[Text](notiz.md)", "Link auf lokale Datei"],
        ["<https://…>", "Automatischer Link"],
        ["![Alt](bild.png)", "Bild (relativ zur Datei)"],
      ],
    },
    {
      title: "Code",
      rows: [
        ["```python\n…\n```", "Code-Block mit Highlighting"],
        ["Einrückung 4 Leerz.", "Code-Block ohne Sprache"],
      ],
    },
    {
      title: "Tabellen",
      rows: [
        ["| A | B |\n| - | - |\n| 1 | 2 |", "Tabelle"],
        ["| :-- | :-: | --: |", "Links / zentriert / rechts"],
        ["Klick in Zelle", "Direkt bearbeiten"],
        ["Tab / ⇧ Tab", "Nächste / vorherige Zelle"],
        ["Tab in letzter Zelle", "Neue Zeile"],
        ["Enter · Esc", "Zelle darunter · Tabelle verlassen"],
      ],
    },
    {
      title: "Mathe (KaTeX)",
      rows: [
        ["$E = mc^2$", "Inline-Formel"],
        ["$$\n\\int_0^1 x\\,dx\n$$", "Block-Formel"],
        ["\\frac{a}{b}  \\sqrt{x}", "Bruch, Wurzel"],
        ["x^2  x_i", "Hoch-, Tiefgestellt"],
        ["\\alpha \\beta \\pi", "Griechische Buchstaben"],
        ["\\sum_{i=1}^n  \\int_a^b", "Summe, Integral"],
      ],
    },
    {
      title: "Live Preview",
      rows: [
        ["Cursor auf Element", "Zeigt dessen Markdown-Syntax"],
        ["Cursor in Zeile", "Zeigt # bzw. > der Zeile"],
        ["Cursor in Tabelle/$$", "Zeigt den Quelltext des Blocks"],
      ],
    },
  ],
};

import { codeSheets } from "./help-code";

sheets.shortcuts = {
  title: "Shortcuts",
  sections: [
    {
      title: "Allgemein",
      rows: [
        ["Strg 1 / 2 / 3 / 4", "Text / Markdown / LaTeX / Code"],
        ["F1", "Hilfe ein/aus"],
        ["Strg ,", "Einstellungen (Syntax-Theme)"],
        ["Esc", "Hilfe / Dialog schließen"],
        ["Strg B", "Seitenleiste ein/aus (in Markdown: fett)"],
        ["F7", "Rechtschreibprüfung ein/aus"],
      ],
    },
    {
      title: "Dateien & Tabs",
      rows: [
        ["Strg N", "Neue Datei"],
        ["Strg O", "Ordner öffnen"],
        ["Strg S", "Speichern (passiert automatisch)"],
        ["Strg ⇧ S", "Speichern unter"],
        ["Strg W", "Tab schließen"],
        ["Strg Tab · Strg ⇧ Tab", "Nächster / vorheriger Tab"],
        ["Mittelklick auf Tab", "Tab schließen"],
      ],
    },
    {
      title: "Bearbeiten",
      rows: [
        ["Strg C / X / V", "Kopieren / Ausschneiden / Einfügen"],
        ["Strg Z · Strg Y", "Rückgängig · Wiederholen"],
        ["Strg A", "Alles auswählen"],
        ["Strg D", "Nächstes Vorkommen mit auswählen"],
        ["Alt ↑ / ↓", "Zeile verschieben"],
        ["⇧ Alt ↑ / ↓", "Zeile duplizieren"],
        ["Strg ⇧ K", "Zeile löschen"],
        ["Strg /", "Zeile auskommentieren"],
        ["Tab · ⇧ Tab", "Einrücken · Ausrücken"],
        ["Alt + Ziehen", "Rechteck-Auswahl"],
      ],
    },
    {
      title: "Suchen",
      rows: [
        ["Strg F", "Suchen"],
        ["Strg H", "Ersetzen"],
        ["F3 · ⇧ F3", "Nächster / vorheriger Treffer"],
        ["Strg Alt G", "Gehe zu Zeile"],
      ],
    },
    {
      title: "Markdown",
      rows: [
        ["Strg B · Strg I", "Fett · Kursiv"],
        ["Strg E", "Inline-Code"],
        ["Strg K", "Link einfügen"],
        ["Strg ⇧ X · Strg ⇧ H", "Durchgestrichen · Markiert"],
        ["Enter in Liste", "Liste fortsetzen"],
      ],
    },
    {
      title: "LaTeX",
      rows: [
        ["Strg J", "Cursor-Stelle im PDF zeigen"],
        ["Doppelklick ins PDF", "Zur Quellzeile springen"],
        ["Strg Leertaste", "Vervollständigung"],
      ],
    },
    {
      title: "Code",
      rows: [
        ["Strg Leertaste", "Vervollständigung"],
        ["F12 · Strg Klick", "Gehe zu Definition"],
        ["⇧ Alt F", "Formatieren"],
        ["⇧ F10", "Ausführen"],
        ["Strg F9", "Bauen"],
        ["Strg F2", "Stopp"],
      ],
    },
    {
      title: "Debugger",
      rows: [
        ["⇧ F9", "Debuggen starten"],
        ["Strg F8", "Breakpoint setzen/entfernen"],
        ["F8 · F7 · ⇧ F8", "Step Over · Into · Out"],
        ["F9", "Fortsetzen"],
        ["Strg F2", "Debuggen beenden"],
      ],
    },
    {
      title: "Terminal",
      rows: [
        ["Strg ^", "Terminal öffnen & fokussieren"],
        ["Strg ⇧ C / V", "Kopieren / Einfügen"],
        ["Strg C", "Laufendes Programm abbrechen"],
      ],
    },
  ],
};

/** All sheets in display order, for the chips in the help view. */
export function allSheets(): { id: string; label: string; sheet: Sheet }[] {
  const order: [string, Sheet | undefined][] = [
    ["shortcuts", sheets.shortcuts], ["markdown", sheets.markdown], ["latex", sheets.latex],
    ["python", codeSheets.python], ["c", codeSheets.c], ["cpp", codeSheets.cpp], ["java", codeSheets.java],
    ["javascript", codeSheets.javascript], ["typescript", codeSheets.typescript], ["rust", codeSheets.rust],
  ];
  return order.filter(([, s]) => s).map(([id, s]) => ({ id, label: s!.title, sheet: s! }));
}

export function sheetIdFor(mode: string, language: string | null): string {
  if (mode === "code") return language && codeSheets[language] ? language : "python";
  if (mode === "text") return "shortcuts";
  return mode;
}

export function sheetFor(mode: string, language: string | null): Sheet | null {
  if (mode === "code") return (language && codeSheets[language]) || null;
  return sheets[mode] ?? null;
}

sheets.latex = {
  title: "LaTeX",
  sections: [
    {
      title: "Grundgerüst",
      rows: [
        ["\\documentclass{article}", "Dokumentklasse (article, report, book, beamer)"],
        ["\\usepackage[ngerman]{babel}", "Deutsche Silbentrennung & Begriffe"],
        ["\\usepackage{amsmath, amssymb}", "Mathe-Erweiterungen"],
        ["\\usepackage{graphicx}", "Bilder einbinden"],
        ["\\begin{document} … \\end{document}", "Dokumentinhalt"],
        ["\\title{} \\author{} \\maketitle", "Titelei"],
        ["% Kommentar", "Kommentarzeile"],
      ],
    },
    {
      title: "Gliederung",
      rows: [
        ["\\chapter{…}", "Kapitel (report/book)"],
        ["\\section{…}", "Abschnitt"],
        ["\\subsection{…}", "Unterabschnitt"],
        ["\\section*{…}", "Ohne Nummer"],
        ["\\tableofcontents", "Inhaltsverzeichnis"],
        ["\\label{sec:x} · \\ref{sec:x}", "Label setzen · verweisen"],
      ],
    },
    {
      title: "Text",
      rows: [
        ["\\textbf{…} \\textit{…}", "Fett · Kursiv"],
        ["\\emph{…} \\underline{…}", "Hervorheben · Unterstreichen"],
        ["\\texttt{…}", "Schreibmaschine"],
        ["\\footnote{…}", "Fußnote"],
        ["\\\\  ·  Leerzeile", "Zeilenumbruch · Absatz"],
        ["\\newpage", "Neue Seite"],
        ["\\href{url}{Text}", "Link (hyperref)"],
      ],
    },
    {
      title: "Listen",
      rows: [
        ["\\begin{itemize} \\item …", "Aufzählung"],
        ["\\begin{enumerate} \\item …", "Nummeriert"],
        ["\\begin{description} \\item[A] …", "Beschreibung"],
      ],
    },
    {
      title: "Mathe",
      rows: [
        ["$ … $", "Inline-Formel"],
        ["\\[ … \\]", "Abgesetzte Formel"],
        ["\\begin{equation} … \\end{equation}", "Nummerierte Gleichung"],
        ["\\begin{align} a &= b \\\\ … \\end{align}", "Ausgerichtet (&, \\\\)"],
        ["\\frac{a}{b}  \\sqrt{x}  x^{2}  x_{i}", "Bruch, Wurzel, Exponent, Index"],
        ["\\sum_{i=1}^{n}  \\int_a^b  \\lim_{x\\to 0}", "Summe, Integral, Limes"],
        ["\\alpha \\beta \\pi \\Omega", "Griechisch"],
        ["\\leq \\geq \\neq \\approx \\in", "Relationen"],
        ["\\mathbb{R}  \\vec{v}  \\hat{x}", "Zahlenmengen, Vektor, Hut"],
        ["\\left( … \\right)", "Mitwachsende Klammern"],
        ["\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}", "Matrix"],
      ],
    },
    {
      title: "Abbildungen & Tabellen",
      rows: [
        ["\\includegraphics[width=\\linewidth]{bild}", "Bild"],
        ["\\begin{figure}[h] … \\caption{} \\end{figure}", "Gleitumgebung Bild"],
        ["\\begin{tabular}{l|c|r} a & b & c \\\\ \\hline", "Tabelle (l/c/r, &, \\\\)"],
        ["\\begin{table}[h] … \\end{table}", "Gleitumgebung Tabelle"],
      ],
    },
    {
      title: "Literatur",
      rows: [
        ["\\cite{key}", "Zitieren (Keys aus .bib vervollständigt)"],
        ["\\bibliography{refs}", "BibTeX-Datei refs.bib"],
        ["\\usepackage{biblatex} \\addbibresource{refs.bib}", "biblatex"],
        ["\\printbibliography", "Literaturverzeichnis (biblatex)"],
      ],
    },
    {
      title: "Editor",
      rows: [
        ["Tippen", "Kompiliert automatisch (~1 s Pause)"],
        ["Strg J", "Zur Cursor-Stelle im PDF springen"],
        ["Doppelklick ins PDF", "Zur Quellzeile springen"],
        ["\\ + Buchstaben", "Befehle & Umgebungen vervollständigen"],
        ["Strg Leertaste", "Vervollständigung öffnen"],
        ["Cursor in Formel", "Gerenderte Vorschau darüber"],
        ["% !TEX root = main.tex", "Hauptdatei für Unterdateien festlegen"],
      ],
    },
  ],
};
