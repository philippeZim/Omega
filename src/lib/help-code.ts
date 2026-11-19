/** Syntax cheat sheets per programming language (shown in Code mode for the active file). */
import type { Sheet } from "./help";

const editor: Sheet["sections"][number] = {
  title: "Editor & Projekt",
  rows: [
    ["Strg Leertaste", "Vervollständigung"],
    ["F12 · Strg Klick", "Gehe zu Definition"],
    ["⇧ Alt F", "Dokument formatieren"],
    ["Maus über Symbol", "Typ & Dokumentation"],
    ["⇧ F10", "Ausführen"],
    ["Strg F9", "Bauen"],
    ["Strg F2", "Stopp (Strg+C ans Programm)"],
    ["Strg ^", "Terminal fokussieren"],
    ["Strg ⇧ C / V", "Kopieren / Einfügen im Terminal"],
  ],
};

const debugging: Sheet["sections"][number] = {
  title: "Debugger (PyCharm-Tasten)",
  rows: [
    ["Klick links der Zeilennr. · Strg F8", "Breakpoint setzen/entfernen"],
    ["Rechtsklick auf Breakpoint-Rand", "Bedingung festlegen"],
    ["⇧ F9", "Debuggen starten"],
    ["F8", "Step Over"],
    ["F7", "Step Into"],
    ["⇧ F8", "Step Out"],
    ["F9", "Fortsetzen"],
    ["Strg F2", "Debuggen beenden"],
    ["Maus über Variable", "Aktuellen Wert anzeigen"],
    ["Doppelklick auf Variable", "Wert ändern"],
    ["Debug-Konsole (unten)", "Ausdrücke auswerten"],
  ],
};

export const codeSheets: Record<string, Sheet> = {
  python: {
    title: "Python",
    sections: [
      { title: "Grundlagen", rows: [
        ["x = 5  ·  name: str = \"a\"", "Variable (optional mit Typ)"],
        ["print(f\"Wert: {x}\")", "Ausgabe mit f-String"],
        ["if x > 0: … elif …: … else: …", "Bedingung"],
        ["for i in range(10):", "Schleife 0..9"],
        ["for i, v in enumerate(xs):", "Mit Index"],
        ["while cond:  ·  break · continue", "While-Schleife"],
        ["match cmd:\n    case \"a\": …\n    case _: …", "Pattern Matching"],
      ] },
      { title: "Datenstrukturen", rows: [
        ["xs = [1, 2, 3]  ·  xs.append(4)", "Liste"],
        ["d = {\"k\": 1}  ·  d.get(\"k\", 0)", "Dictionary"],
        ["s = {1, 2}  ·  t = (1, 2)", "Set · Tupel"],
        ["[x * 2 for x in xs if x > 1]", "List Comprehension"],
        ["xs[1:3]  ·  xs[::-1]", "Slicing · Umkehren"],
      ] },
      { title: "Funktionen & Klassen", rows: [
        ["def f(a: int, b: int = 2) -> int:", "Funktion mit Default"],
        ["lambda x: x + 1", "Lambda"],
        ["def f(*args, **kwargs):", "Variable Argumente"],
        ["class A:\n    def __init__(self, x): self.x = x", "Klasse"],
        ["@dataclass\nclass P: x: int; y: int", "Dataclass"],
        ["if __name__ == \"__main__\":", "Einstiegspunkt"],
      ] },
      { title: "Fehler & Dateien", rows: [
        ["try: … except ValueError as e: … finally: …", "Ausnahmen"],
        ["raise ValueError(\"msg\")", "Ausnahme werfen"],
        ["with open(\"f.txt\") as f: data = f.read()", "Datei lesen"],
      ] },
      { title: "uv", rows: [
        ["uv init name", "Neues Projekt"],
        ["uv add requests", "Abhängigkeit"],
        ["uv run main.py", "Ausführen"],
        ["uv run pytest", "Tests"],
      ] },
      editor,
      debugging,
    ],
  },
  c: {
    title: "C",
    sections: [
      { title: "Grundlagen", rows: [
        ["#include <stdio.h>", "Header einbinden"],
        ["int main(void) { return 0; }", "Einstiegspunkt"],
        ["int x = 5; double d = 1.5; char c = 'a';", "Variablen"],
        ["printf(\"%d %f %s\\n\", i, d, s);", "Ausgabe"],
        ["scanf(\"%d\", &x);", "Eingabe"],
        ["for (int i = 0; i < n; i++) { }", "Schleife"],
        ["switch (x) { case 1: …; break; default: … }", "Switch"],
      ] },
      { title: "Zeiger & Speicher", rows: [
        ["int *p = &x;  *p = 7;", "Zeiger, Adresse, Dereferenz"],
        ["int a[10];  a[0] = 1;", "Array"],
        ["int *m = malloc(n * sizeof *m); free(m);", "Heap-Speicher"],
        ["char s[] = \"Hallo\";  strlen(s)", "String (string.h)"],
        ["void f(int *out)", "Ausgabeparameter"],
      ] },
      { title: "Typen", rows: [
        ["struct P { int x, y; };", "Struct"],
        ["typedef struct { int x; } P;", "Typedef"],
        ["enum Farbe { ROT, GRUEN };", "Enum"],
        ["const int N = 10;  #define MAX 100", "Konstanten"],
      ] },
      { title: "CMake", rows: [
        ["add_executable(app src/main.c)", "Programm"],
        ["target_link_libraries(app m)", "Bibliothek linken"],
      ] },
      editor,
      debugging,
    ],
  },
  cpp: {
    title: "C++",
    sections: [
      { title: "Grundlagen", rows: [
        ["#include <iostream>", "Ein-/Ausgabe"],
        ["std::cout << x << '\\n';", "Ausgabe"],
        ["std::cin >> x;", "Eingabe"],
        ["auto x = 5;  const auto& r = v;", "Typinferenz, Referenz"],
        ["for (const auto& e : vec) { }", "Range-for"],
        ["if (auto it = m.find(k); it != m.end())", "if mit Init"],
      ] },
      { title: "Standardbibliothek", rows: [
        ["std::vector<int> v{1, 2}; v.push_back(3);", "Dynamisches Array"],
        ["std::string s = \"a\"; s += \"b\";", "String"],
        ["std::map<std::string, int> m; m[\"k\"] = 1;", "Map (geordnet)"],
        ["std::unordered_map<K, V>", "Hash-Map"],
        ["std::sort(v.begin(), v.end());", "Sortieren (<algorithm>)"],
        ["std::optional<int>  std::variant<A, B>", "Optional, Variant"],
      ] },
      { title: "Klassen & Speicher", rows: [
        ["class A { public: A(int x) : x_(x) {} private: int x_; };", "Klasse mit Init-Liste"],
        ["virtual void f() = 0;  void f() override;", "Abstrakt, Override"],
        ["auto p = std::make_unique<A>(1);", "Unique Pointer"],
        ["auto s = std::make_shared<A>(1);", "Shared Pointer"],
        ["template <typename T> T max(T a, T b)", "Template"],
        ["[&](int x) { return x * 2; }", "Lambda"],
      ] },
      editor,
      debugging,
    ],
  },
  java: {
    title: "Java",
    sections: [
      { title: "Grundlagen", rows: [
        ["public static void main(String[] args)", "Einstiegspunkt"],
        ["System.out.println(\"x = \" + x);", "Ausgabe"],
        ["var list = new ArrayList<String>();", "Typinferenz"],
        ["for (var s : list) { }", "For-each"],
        ["switch (x) { case 1 -> …; default -> … }", "Switch-Ausdruck"],
        ["String s = \"\"\"\n  Text\n  \"\"\";", "Textblock"],
      ] },
      { title: "Klassen", rows: [
        ["public class A { private int x; }", "Klasse"],
        ["public A(int x) { this.x = x; }", "Konstruktor"],
        ["record Point(int x, int y) {}", "Record"],
        ["interface Shape { double area(); }", "Interface"],
        ["class B extends A implements I", "Vererbung"],
        ["enum Farbe { ROT, GRUEN }", "Enum"],
      ] },
      { title: "Collections & Streams", rows: [
        ["List.of(1, 2)  Map.of(\"k\", 1)", "Unveränderliche Collections"],
        ["new HashMap<String, Integer>()", "Hash-Map"],
        ["list.stream().filter(x -> x > 1).map(x -> x * 2).toList()", "Stream"],
        ["Optional.ofNullable(x).orElse(0)", "Optional"],
      ] },
      { title: "Fehler", rows: [
        ["try { } catch (IOException e) { } finally { }", "Ausnahmen"],
        ["try (var r = new FileReader(f)) { }", "Try-with-resources"],
        ["throw new IllegalArgumentException(\"…\");", "Werfen"],
      ] },
      editor,
      debugging,
    ],
  },
  javascript: {
    title: "JavaScript",
    sections: [
      { title: "Grundlagen", rows: [
        ["const x = 1;  let y = 2;", "Konstante, Variable"],
        ["console.log(`Wert: ${x}`);", "Template-String"],
        ["x ?? 0  ·  obj?.a?.b", "Nullish, Optional Chaining"],
        ["for (const v of arr) { }", "Über Werte"],
        ["for (const k in obj) { }", "Über Schlüssel"],
        ["a === b  ·  a !== b", "Strikter Vergleich"],
      ] },
      { title: "Funktionen & Objekte", rows: [
        ["const f = (a, b = 2) => a + b;", "Arrow-Funktion"],
        ["const { a, b } = obj;  const [x, y] = arr;", "Destrukturierung"],
        ["{ ...obj, c: 3 }  ·  [...arr, 4]", "Spread"],
        ["class A extends B { #priv = 1; constructor() { super(); } }", "Klasse"],
        ["export function f() {}  ·  import { f } from \"./m.js\";", "Module"],
      ] },
      { title: "Arrays", rows: [
        ["arr.map(x => x * 2)", "Abbilden"],
        ["arr.filter(x => x > 1)", "Filtern"],
        ["arr.reduce((s, x) => s + x, 0)", "Reduzieren"],
        ["arr.find(x => x.id === 1)", "Suchen"],
      ] },
      { title: "Asynchron", rows: [
        ["async function f() { const r = await fetch(url); }", "async / await"],
        ["await Promise.all([a(), b()])", "Parallel"],
        ["try { await f() } catch (e) { }", "Fehler"],
      ] },
      editor,
      debugging,
    ],
  },
  typescript: {
    title: "TypeScript",
    sections: [
      { title: "Typen", rows: [
        ["let n: number; let s: string; let b: boolean;", "Primitive"],
        ["let xs: number[]  ·  Array<string>", "Arrays"],
        ["type Id = string | number;", "Union"],
        ["interface User { id: number; name?: string }", "Interface, optional"],
        ["type P = { readonly x: number }", "Readonly"],
        ["\"a\" | \"b\"  ·  as const", "Literal-Typen"],
      ] },
      { title: "Funktionen & Generics", rows: [
        ["function f(a: number): string { }", "Signatur"],
        ["function id<T>(x: T): T { return x; }", "Generic"],
        ["<T extends { id: number }>", "Constraint"],
        ["(x: unknown) => x is string", "Type Guard"],
      ] },
      { title: "Utility-Typen", rows: [
        ["Partial<T>  Required<T>", "Alles optional / Pflicht"],
        ["Pick<T, \"a\">  Omit<T, \"b\">", "Auswählen / Weglassen"],
        ["Record<string, number>", "Map-Typ"],
        ["ReturnType<typeof f>  keyof T", "Abgeleitete Typen"],
      ] },
      { title: "pnpm", rows: [
        ["pnpm add zod  ·  pnpm add -D vitest", "Abhängigkeit"],
        ["pnpm dlx tsx file.ts", "TS direkt ausführen"],
        ["pnpm exec tsc --noEmit", "Typprüfung"],
      ] },
      editor,
      debugging,
    ],
  },
  rust: {
    title: "Rust",
    sections: [
      { title: "Grundlagen", rows: [
        ["let x = 5;  let mut y = 1;", "Unveränderlich / veränderlich"],
        ["println!(\"{x} {}\", y);", "Ausgabe"],
        ["fn add(a: i32, b: i32) -> i32 { a + b }", "Funktion"],
        ["for i in 0..10 { }  ·  0..=10", "Bereich (exkl./inkl.)"],
        ["loop { break; }  ·  while c { }", "Schleifen"],
        ["match x { 1 => …, 2 | 3 => …, _ => … }", "Pattern Matching"],
        ["if let Some(v) = opt { }", "if let"],
      ] },
      { title: "Ownership", rows: [
        ["&x  ·  &mut x", "Leihen / veränderlich leihen"],
        ["s.clone()", "Tiefe Kopie"],
        ["fn f<'a>(s: &'a str) -> &'a str", "Lifetime"],
        ["Box<T>  Rc<T>  Arc<T>  RefCell<T>", "Smart Pointer"],
      ] },
      { title: "Typen", rows: [
        ["struct P { x: i32, y: i32 }", "Struct"],
        ["impl P { fn new() -> Self { … } }", "Methoden"],
        ["enum E { A, B(i32), C { x: i32 } }", "Enum mit Daten"],
        ["trait T { fn f(&self); }  impl T for P { }", "Trait"],
        ["#[derive(Debug, Clone, PartialEq)]", "Derive"],
        ["Vec<T>  HashMap<K, V>  String  &str", "Collections, Strings"],
      ] },
      { title: "Fehler", rows: [
        ["Option<T>: Some(v) / None", "Optionaler Wert"],
        ["Result<T, E>: Ok(v) / Err(e)", "Ergebnis"],
        ["let v = f()?;", "Fehler weiterreichen"],
        ["x.unwrap_or(0)  ·  .expect(\"msg\")", "Auspacken"],
      ] },
      { title: "cargo", rows: [
        ["cargo new name  ·  cargo add serde", "Projekt, Abhängigkeit"],
        ["cargo run  ·  cargo test", "Ausführen, Tests"],
        ["cargo clippy  ·  cargo fmt", "Linter, Formatieren"],
      ] },
      editor,
      debugging,
    ],
  },
};
