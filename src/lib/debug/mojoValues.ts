// lldb-dap joins an LLDB value and its summary into one string. For Mojo scalars the value is the
// raw little-endian bytes ("5600000000000000  86"), and SIMD values have no usable text at all.
// LLDB's Mojo plugin already computes the real values, so these helpers only pick them out.

export interface DapValue {
  value: string;
  type?: string;
  ref: number;
}

type Children = (ref: number) => Promise<{ value: string }[]>;

const SCALAR = /^(?:__mlir_type\.)?`?!kgen\.scalar<(\w+)>`?$/;
const SIMD = /^(?:__mlir_type\.)?`?!kgen\.simd<(\d+),\s*(\w+)>`?$/;
const RAW_THEN_SUMMARY = /^(?:0x)?[0-9a-fA-F]+\s+(\S.*)$/s;
const SIMD_SHOWN = 16;

/** The Mojo name of an MLIR element type, or null for one we don't know. */
function elementName(e: string): string | null {
  if (e === "index") return "Int";
  if (e === "uindex") return "UInt";
  if (e === "bool") return "Bool";
  const m = /^(si|ui|f)(\d+)$/.exec(e);
  if (!m) return null;
  return `${m[1] === "si" ? "Int" : m[1] === "ui" ? "UInt" : "Float"}${m[2]}`;
}

function list(items: string[]): string {
  const shown = items.slice(0, SIMD_SHOWN);
  if (items.length > SIMD_SHOWN) shown.push("…");
  return `[${shown.join(", ")}]`;
}

/** The value to show for a Mojo variable. Anything it can't read stays exactly as it came. */
export async function mojoValue(v: DapValue, children: Children): Promise<DapValue> {
  const type = v.type ?? "";
  const scalar = SCALAR.exec(type);
  if (scalar) {
    const shownType = elementName(scalar[1]) ?? type;
    const summary = RAW_THEN_SUMMARY.exec(v.value)?.[1];
    if (summary) return { value: summary, type: shownType, ref: 0 };
    // No summary: the only child is the same scalar, decoded by LLDB.
    const kids = v.ref ? await children(v.ref).catch(() => []) : [];
    if (kids.length !== 1) return { ...v, type: shownType };
    const only = kids[0].value;
    if (scalar[1] !== "bool") return { value: only, type: shownType, ref: 0 };
    const bool = only === "1" ? "True" : only === "0" ? "False" : null;
    return bool ? { value: bool, type: shownType, ref: 0 } : { ...v, type: shownType };
  }
  const simd = SIMD.exec(type);
  if (simd) {
    const element = elementName(simd[2]);
    const shownType = element ? `SIMD[${element}, ${simd[1]}]` : type;
    if (simd[2] === "bool") {
      // The children of a bool vector read the wrong memory (5, 85, 255 …), so they are never shown.
      // The value text holds the right elements.
      const items = [...v.value.matchAll(/\[\d+\] = (True|False)\b/g)].map((x) => x[1]);
      return items.length === Number(simd[1]) ? { value: list(items), type: shownType, ref: 0 } : { ...v, type: shownType, ref: 0 };
    }
    const kids = v.ref ? await children(v.ref).catch(() => []) : [];
    if (!kids.length) return { ...v, type: shownType };
    return { value: list(kids.map((k) => k.value)), type: shownType, ref: v.ref };
  }
  // An element of an expanded SIMD value.
  const element = /^__mlir_type\.(\w+)$/.exec(type);
  const name = element && elementName(element[1]);
  return name ? { ...v, type: name } : v;
}

/** Mojo's runtime starts one idle worker per core. Lists the stopped thread first, without them. */
export function mojoThreads<T extends { id: number; name: string }>(threads: T[], stopped: number | null | undefined): T[] {
  const own = threads.filter((t) => t.id === stopped || !/^🔥 Thread\d+$/.test(t.name));
  return [...own.filter((t) => t.id === stopped), ...own.filter((t) => t.id !== stopped)];
}
