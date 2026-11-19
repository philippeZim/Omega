/** Syntax cheat sheets per programming language (shown in Code mode for the active file). Format: see `RawSheet` in help.ts. */
import type { RawSheet } from "./help";

type Section = RawSheet["sections"][number];

const editor: Section = {
  title: ["Editor & Project", "Editor & Projekt", "Éditeur et projet"],
  rows: [
    ["Ctrl Space", "Completion", "Vervollständigung", "Complétion"],
    ["F12 · Ctrl Click", "Go to definition", "Gehe zu Definition", "Aller à la définition"],
    ["⇧ Alt F", "Format document", "Dokument formatieren", "Formater le document"],
    [["Hover a symbol", "Maus über Symbol", "Survol d'un symbole"], "Type & documentation", "Typ & Dokumentation", "Type et documentation"],
    ["⇧ F10", "Run", "Ausführen", "Exécuter"],
    ["Ctrl F9", "Build", "Bauen", "Compiler"],
    ["Ctrl F2", "Stop (Ctrl+C to the program)", "Stopp (Strg+C ans Programm)", "Arrêter (Ctrl+C au programme)"],
    ["Ctrl ^", "Focus terminal", "Terminal fokussieren", "Activer le terminal"],
    ["Ctrl ⇧ C / V", "Copy / Paste in terminal", "Kopieren / Einfügen im Terminal", "Copier / Coller dans le terminal"],
  ],
};

const debugging: Section = {
  title: ["Debugger (PyCharm keys)", "Debugger (PyCharm-Tasten)", "Débogueur (touches PyCharm)"],
  rows: [
    [["Click left of line number · Ctrl F8", "Klick links der Zeilennr. · Strg F8", "Clic à gauche du n° de ligne · Ctrl F8"], "Toggle breakpoint", "Breakpoint setzen/entfernen", "Ajouter/retirer un point d'arrêt"],
    [["Right-click breakpoint gutter", "Rechtsklick auf Breakpoint-Rand", "Clic droit sur la marge des points d'arrêt"], "Set condition", "Bedingung festlegen", "Définir une condition"],
    ["⇧ F9", "Start debugging", "Debuggen starten", "Démarrer le débogage"],
    ["F8", "Step Over"],
    ["F7", "Step Into"],
    ["⇧ F8", "Step Out"],
    ["F9", "Resume", "Fortsetzen", "Reprendre"],
    ["Ctrl F2", "Stop debugging", "Debuggen beenden", "Arrêter le débogage"],
    [["Hover a variable", "Maus über Variable", "Survol d'une variable"], "Show current value", "Aktuellen Wert anzeigen", "Afficher la valeur actuelle"],
    [["Double-click a variable", "Doppelklick auf Variable", "Double-clic sur une variable"], "Change value", "Wert ändern", "Modifier la valeur"],
    [["Debug console (bottom)", "Debug-Konsole (unten)", "Console de débogage (en bas)"], "Evaluate expressions", "Ausdrücke auswerten", "Évaluer des expressions"],
  ],
};

const basics: Tx3 = ["Basics", "Grundlagen", "Bases"];
const errors: Tx3 = ["Errors", "Fehler", "Erreurs"];
const types: Tx3 = ["Types", "Typen", "Types"];
type Tx3 = [string, string, string];

export const codeSheets: Record<string, RawSheet> = {
  python: {
    title: "Python",
    sections: [
      { title: basics, rows: [
        ["x = 5  ·  name: str = \"a\"", "Variable (optionally typed)", "Variable (optional mit Typ)", "Variable (type facultatif)"],
        [["print(f\"Value: {x}\")", "print(f\"Wert: {x}\")", "print(f\"Valeur : {x}\")"], "Output with f-string", "Ausgabe mit f-String", "Affichage avec f-string"],
        ["if x > 0: … elif …: … else: …", "Condition", "Bedingung", "Condition"],
        ["for i in range(10):", "Loop 0..9", "Schleife 0..9", "Boucle 0..9"],
        ["for i, v in enumerate(xs):", "With index", "Mit Index", "Avec indice"],
        ["while cond:  ·  break · continue", "While loop", "While-Schleife", "Boucle while"],
        ["match cmd:\n    case \"a\": …\n    case _: …", "Pattern matching", "Pattern Matching", "Filtrage par motif"],
      ] },
      { title: ["Data structures", "Datenstrukturen", "Structures de données"], rows: [
        ["xs = [1, 2, 3]  ·  xs.append(4)", "List", "Liste", "Liste"],
        ["d = {\"k\": 1}  ·  d.get(\"k\", 0)", "Dictionary", "Dictionary", "Dictionnaire"],
        ["s = {1, 2}  ·  t = (1, 2)", "Set · Tuple", "Set · Tupel", "Ensemble · Tuple"],
        ["[x * 2 for x in xs if x > 1]", "List comprehension", "List Comprehension", "Liste en compréhension"],
        ["xs[1:3]  ·  xs[::-1]", "Slicing · Reverse", "Slicing · Umkehren", "Découpage · Inverser"],
      ] },
      { title: ["Functions & Classes", "Funktionen & Klassen", "Fonctions et classes"], rows: [
        ["def f(a: int, b: int = 2) -> int:", "Function with default", "Funktion mit Default", "Fonction avec valeur par défaut"],
        ["lambda x: x + 1", "Lambda"],
        ["def f(*args, **kwargs):", "Variadic arguments", "Variable Argumente", "Arguments variables"],
        ["class A:\n    def __init__(self, x): self.x = x", "Class", "Klasse", "Classe"],
        ["@dataclass\nclass P: x: int; y: int", "Dataclass"],
        ["if __name__ == \"__main__\":", "Entry point", "Einstiegspunkt", "Point d'entrée"],
      ] },
      { title: ["Errors & Files", "Fehler & Dateien", "Erreurs et fichiers"], rows: [
        ["try: … except ValueError as e: … finally: …", "Exceptions", "Ausnahmen", "Exceptions"],
        ["raise ValueError(\"msg\")", "Raise an exception", "Ausnahme werfen", "Lever une exception"],
        ["with open(\"f.txt\") as f: data = f.read()", "Read a file", "Datei lesen", "Lire un fichier"],
      ] },
      { title: "uv", rows: [
        ["uv init name", "New project", "Neues Projekt", "Nouveau projet"],
        ["uv add requests", "Dependency", "Abhängigkeit", "Dépendance"],
        ["uv run main.py", "Run", "Ausführen", "Exécuter"],
        ["uv run pytest", "Tests"],
      ] },
      editor,
      debugging,
    ],
  },
  c: {
    title: "C",
    sections: [
      { title: basics, rows: [
        ["#include <stdio.h>", "Include a header", "Header einbinden", "Inclure un en-tête"],
        ["int main(void) { return 0; }", "Entry point", "Einstiegspunkt", "Point d'entrée"],
        ["int x = 5; double d = 1.5; char c = 'a';", "Variables", "Variablen", "Variables"],
        ["printf(\"%d %f %s\\n\", i, d, s);", "Output", "Ausgabe", "Affichage"],
        ["scanf(\"%d\", &x);", "Input", "Eingabe", "Saisie"],
        ["for (int i = 0; i < n; i++) { }", "Loop", "Schleife", "Boucle"],
        ["switch (x) { case 1: …; break; default: … }", "Switch"],
      ] },
      { title: ["Pointers & Memory", "Zeiger & Speicher", "Pointeurs et mémoire"], rows: [
        ["int *p = &x;  *p = 7;", "Pointer, address, dereference", "Zeiger, Adresse, Dereferenz", "Pointeur, adresse, déréférencement"],
        ["int a[10];  a[0] = 1;", "Array", "Array", "Tableau"],
        ["int *m = malloc(n * sizeof *m); free(m);", "Heap memory", "Heap-Speicher", "Mémoire du tas"],
        [["char s[] = \"Hello\";  strlen(s)", "char s[] = \"Hallo\";  strlen(s)", "char s[] = \"Bonjour\";  strlen(s)"], "String (string.h)", "String (string.h)", "Chaîne (string.h)"],
        ["void f(int *out)", "Output parameter", "Ausgabeparameter", "Paramètre de sortie"],
      ] },
      { title: types, rows: [
        ["struct P { int x, y; };", "Struct"],
        ["typedef struct { int x; } P;", "Typedef"],
        [["enum Color { RED, GREEN };", "enum Farbe { ROT, GRUEN };", "enum Couleur { ROUGE, VERT };"], "Enum"],
        ["const int N = 10;  #define MAX 100", "Constants", "Konstanten", "Constantes"],
      ] },
      { title: "CMake", rows: [
        ["add_executable(app src/main.c)", "Executable", "Programm", "Exécutable"],
        ["target_link_libraries(app m)", "Link a library", "Bibliothek linken", "Lier une bibliothèque"],
      ] },
      editor,
      debugging,
    ],
  },
  cpp: {
    title: "C++",
    sections: [
      { title: basics, rows: [
        ["#include <iostream>", "Input/output", "Ein-/Ausgabe", "Entrée/sortie"],
        ["std::cout << x << '\\n';", "Output", "Ausgabe", "Affichage"],
        ["std::cin >> x;", "Input", "Eingabe", "Saisie"],
        ["auto x = 5;  const auto& r = v;", "Type inference, reference", "Typinferenz, Referenz", "Inférence de type, référence"],
        ["for (const auto& e : vec) { }", "Range-for", "Range-for", "Boucle sur plage"],
        ["if (auto it = m.find(k); it != m.end())", "if with initializer", "if mit Init", "if avec initialisation"],
      ] },
      { title: ["Standard library", "Standardbibliothek", "Bibliothèque standard"], rows: [
        ["std::vector<int> v{1, 2}; v.push_back(3);", "Dynamic array", "Dynamisches Array", "Tableau dynamique"],
        ["std::string s = \"a\"; s += \"b\";", "String", "String", "Chaîne"],
        ["std::map<std::string, int> m; m[\"k\"] = 1;", "Map (ordered)", "Map (geordnet)", "Map (ordonnée)"],
        ["std::unordered_map<K, V>", "Hash map", "Hash-Map", "Table de hachage"],
        ["std::sort(v.begin(), v.end());", "Sort (<algorithm>)", "Sortieren (<algorithm>)", "Trier (<algorithm>)"],
        ["std::optional<int>  std::variant<A, B>", "Optional, variant", "Optional, Variant", "Optional, variant"],
      ] },
      { title: ["Classes & Memory", "Klassen & Speicher", "Classes et mémoire"], rows: [
        ["class A { public: A(int x) : x_(x) {} private: int x_; };", "Class with initializer list", "Klasse mit Init-Liste", "Classe avec liste d'initialisation"],
        ["virtual void f() = 0;  void f() override;", "Abstract, override", "Abstrakt, Override", "Abstrait, redéfinition"],
        ["auto p = std::make_unique<A>(1);", "Unique pointer", "Unique Pointer", "Pointeur unique"],
        ["auto s = std::make_shared<A>(1);", "Shared pointer", "Shared Pointer", "Pointeur partagé"],
        ["template <typename T> T max(T a, T b)", "Template", "Template", "Modèle"],
        ["[&](int x) { return x * 2; }", "Lambda"],
      ] },
      editor,
      debugging,
    ],
  },
  java: {
    title: "Java",
    sections: [
      { title: basics, rows: [
        ["public static void main(String[] args)", "Entry point", "Einstiegspunkt", "Point d'entrée"],
        ["System.out.println(\"x = \" + x);", "Output", "Ausgabe", "Affichage"],
        ["var list = new ArrayList<String>();", "Type inference", "Typinferenz", "Inférence de type"],
        ["for (var s : list) { }", "For-each"],
        ["switch (x) { case 1 -> …; default -> … }", "Switch expression", "Switch-Ausdruck", "Expression switch"],
        ["String s = \"\"\"\n  Text\n  \"\"\";", "Text block", "Textblock", "Bloc de texte"],
      ] },
      { title: ["Classes", "Klassen", "Classes"], rows: [
        ["public class A { private int x; }", "Class", "Klasse", "Classe"],
        ["public A(int x) { this.x = x; }", "Constructor", "Konstruktor", "Constructeur"],
        ["record Point(int x, int y) {}", "Record"],
        ["interface Shape { double area(); }", "Interface"],
        ["class B extends A implements I", "Inheritance", "Vererbung", "Héritage"],
        [["enum Color { RED, GREEN }", "enum Farbe { ROT, GRUEN }", "enum Couleur { ROUGE, VERT }"], "Enum"],
      ] },
      { title: ["Collections & Streams", "Collections & Streams", "Collections et streams"], rows: [
        ["List.of(1, 2)  Map.of(\"k\", 1)", "Immutable collections", "Unveränderliche Collections", "Collections immuables"],
        ["new HashMap<String, Integer>()", "Hash map", "Hash-Map", "Table de hachage"],
        ["list.stream().filter(x -> x > 1).map(x -> x * 2).toList()", "Stream"],
        ["Optional.ofNullable(x).orElse(0)", "Optional"],
      ] },
      { title: errors, rows: [
        ["try { } catch (IOException e) { } finally { }", "Exceptions", "Ausnahmen", "Exceptions"],
        ["try (var r = new FileReader(f)) { }", "Try-with-resources"],
        ["throw new IllegalArgumentException(\"…\");", "Throw", "Werfen", "Lever"],
      ] },
      editor,
      debugging,
    ],
  },
  javascript: {
    title: "JavaScript",
    sections: [
      { title: basics, rows: [
        ["const x = 1;  let y = 2;", "Constant, variable", "Konstante, Variable", "Constante, variable"],
        [["console.log(`Value: ${x}`);", "console.log(`Wert: ${x}`);", "console.log(`Valeur : ${x}`);"], "Template string", "Template-String", "Gabarit de chaîne"],
        ["x ?? 0  ·  obj?.a?.b", "Nullish, optional chaining", "Nullish, Optional Chaining", "Nullish, chaînage optionnel"],
        ["for (const v of arr) { }", "Over values", "Über Werte", "Sur les valeurs"],
        ["for (const k in obj) { }", "Over keys", "Über Schlüssel", "Sur les clés"],
        ["a === b  ·  a !== b", "Strict comparison", "Strikter Vergleich", "Comparaison stricte"],
      ] },
      { title: ["Functions & Objects", "Funktionen & Objekte", "Fonctions et objets"], rows: [
        ["const f = (a, b = 2) => a + b;", "Arrow function", "Arrow-Funktion", "Fonction fléchée"],
        ["const { a, b } = obj;  const [x, y] = arr;", "Destructuring", "Destrukturierung", "Déstructuration"],
        ["{ ...obj, c: 3 }  ·  [...arr, 4]", "Spread", "Spread", "Décomposition"],
        ["class A extends B { #priv = 1; constructor() { super(); } }", "Class", "Klasse", "Classe"],
        ["export function f() {}  ·  import { f } from \"./m.js\";", "Modules", "Module", "Modules"],
      ] },
      { title: "Arrays", rows: [
        ["arr.map(x => x * 2)", "Map", "Abbilden", "Transformer"],
        ["arr.filter(x => x > 1)", "Filter", "Filtern", "Filtrer"],
        ["arr.reduce((s, x) => s + x, 0)", "Reduce", "Reduzieren", "Réduire"],
        ["arr.find(x => x.id === 1)", "Find", "Suchen", "Rechercher"],
      ] },
      { title: ["Async", "Asynchron", "Asynchrone"], rows: [
        ["async function f() { const r = await fetch(url); }", "async / await"],
        ["await Promise.all([a(), b()])", "Parallel", "Parallel", "En parallèle"],
        ["try { await f() } catch (e) { }", "Errors", "Fehler", "Erreurs"],
      ] },
      editor,
      debugging,
    ],
  },
  typescript: {
    title: "TypeScript",
    sections: [
      { title: types, rows: [
        ["let n: number; let s: string; let b: boolean;", "Primitives", "Primitive", "Primitifs"],
        ["let xs: number[]  ·  Array<string>", "Arrays", "Arrays", "Tableaux"],
        ["type Id = string | number;", "Union"],
        ["interface User { id: number; name?: string }", "Interface, optional", "Interface, optional", "Interface, facultatif"],
        ["type P = { readonly x: number }", "Readonly"],
        ["\"a\" | \"b\"  ·  as const", "Literal types", "Literal-Typen", "Types littéraux"],
      ] },
      { title: ["Functions & Generics", "Funktionen & Generics", "Fonctions et génériques"], rows: [
        ["function f(a: number): string { }", "Signature", "Signatur", "Signature"],
        ["function id<T>(x: T): T { return x; }", "Generic", "Generic", "Générique"],
        ["<T extends { id: number }>", "Constraint", "Constraint", "Contrainte"],
        ["(x: unknown) => x is string", "Type guard", "Type Guard", "Garde de type"],
      ] },
      { title: ["Utility types", "Utility-Typen", "Types utilitaires"], rows: [
        ["Partial<T>  Required<T>", "All optional / required", "Alles optional / Pflicht", "Tout facultatif / obligatoire"],
        ["Pick<T, \"a\">  Omit<T, \"b\">", "Pick / omit", "Auswählen / Weglassen", "Sélectionner / omettre"],
        ["Record<string, number>", "Map type", "Map-Typ", "Type dictionnaire"],
        ["ReturnType<typeof f>  keyof T", "Derived types", "Abgeleitete Typen", "Types dérivés"],
      ] },
      { title: "pnpm", rows: [
        ["pnpm add zod  ·  pnpm add -D vitest", "Dependency", "Abhängigkeit", "Dépendance"],
        ["pnpm dlx tsx file.ts", "Run TS directly", "TS direkt ausführen", "Exécuter du TS directement"],
        ["pnpm exec tsc --noEmit", "Type check", "Typprüfung", "Vérification des types"],
      ] },
      editor,
      debugging,
    ],
  },
  rust: {
    title: "Rust",
    sections: [
      { title: basics, rows: [
        ["let x = 5;  let mut y = 1;", "Immutable / mutable", "Unveränderlich / veränderlich", "Immuable / mutable"],
        ["println!(\"{x} {}\", y);", "Output", "Ausgabe", "Affichage"],
        ["fn add(a: i32, b: i32) -> i32 { a + b }", "Function", "Funktion", "Fonction"],
        ["for i in 0..10 { }  ·  0..=10", "Range (excl./incl.)", "Bereich (exkl./inkl.)", "Intervalle (excl./incl.)"],
        ["loop { break; }  ·  while c { }", "Loops", "Schleifen", "Boucles"],
        ["match x { 1 => …, 2 | 3 => …, _ => … }", "Pattern matching", "Pattern Matching", "Filtrage par motif"],
        ["if let Some(v) = opt { }", "if let"],
      ] },
      { title: "Ownership", rows: [
        ["&x  ·  &mut x", "Borrow / borrow mutably", "Leihen / veränderlich leihen", "Emprunt / emprunt mutable"],
        ["s.clone()", "Deep copy", "Tiefe Kopie", "Copie profonde"],
        ["fn f<'a>(s: &'a str) -> &'a str", "Lifetime", "Lifetime", "Durée de vie"],
        ["Box<T>  Rc<T>  Arc<T>  RefCell<T>", "Smart pointers", "Smart Pointer", "Pointeurs intelligents"],
      ] },
      { title: types, rows: [
        ["struct P { x: i32, y: i32 }", "Struct"],
        ["impl P { fn new() -> Self { … } }", "Methods", "Methoden", "Méthodes"],
        ["enum E { A, B(i32), C { x: i32 } }", "Enum with data", "Enum mit Daten", "Enum avec données"],
        ["trait T { fn f(&self); }  impl T for P { }", "Trait"],
        ["#[derive(Debug, Clone, PartialEq)]", "Derive"],
        ["Vec<T>  HashMap<K, V>  String  &str", "Collections, strings", "Collections, Strings", "Collections, chaînes"],
      ] },
      { title: errors, rows: [
        ["Option<T>: Some(v) / None", "Optional value", "Optionaler Wert", "Valeur facultative"],
        ["Result<T, E>: Ok(v) / Err(e)", "Result", "Ergebnis", "Résultat"],
        ["let v = f()?;", "Propagate errors", "Fehler weiterreichen", "Propager l'erreur"],
        ["x.unwrap_or(0)  ·  .expect(\"msg\")", "Unwrap", "Auspacken", "Déballer"],
      ] },
      { title: "cargo", rows: [
        ["cargo new name  ·  cargo add serde", "Project, dependency", "Projekt, Abhängigkeit", "Projet, dépendance"],
        ["cargo run  ·  cargo test", "Run, tests", "Ausführen, Tests", "Exécuter, tests"],
        ["cargo clippy  ·  cargo fmt", "Linter, format", "Linter, Formatieren", "Linter, formater"],
      ] },
      editor,
      debugging,
    ],
  },
};
