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
    const value = scalar[1] === "bool" ? ({ "0": "False", "1": "True" } as Record<string, string>)[only] ?? only : only;
    return { value, type: shownType, ref: 0 };
  }
  const simd = SIMD.exec(type);
  if (simd) {
    const element = elementName(simd[2]);
    const shownType = element ? `SIMD[${element}, ${simd[1]}]` : type;
    const kids = v.ref ? await children(v.ref).catch(() => []) : [];
    if (!kids.length) return { ...v, type: shownType };
    const items = kids.slice(0, SIMD_SHOWN).map((k) => k.value);
    if (kids.length > SIMD_SHOWN) items.push("…");
    return { value: `[${items.join(", ")}]`, type: shownType, ref: v.ref };
  }
  return v;
}

/** Mojo's runtime starts one idle worker per core. Lists the stopped thread first, without them. */
export function mojoThreads<T extends { id: number; name: string }>(threads: T[], stopped: number | null | undefined): T[] {
  const own = threads.filter((t) => t.id === stopped || !/^🔥 Thread\d+$/.test(t.name));
  return [...own.filter((t) => t.id === stopped), ...own.filter((t) => t.id !== stopped)];
}
