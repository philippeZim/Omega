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

/** A bool vector is stored as packed bits, lowest first, and LLDB's children are those bytes. Its
 *  text is only right for the first byte, which makes it a check on the decoding. */
function boolElements(width: number, bytes: { value: string }[], text: string): string[] | null {
  const count = Math.ceil(width / 8);
  if (bytes.length < count) return null;
  const packed = bytes.slice(0, count).map((b) => (/^\d+$/.test(b.value) ? Number(b.value) : -1));
  if (packed.some((b) => b < 0 || b > 255)) return null;
  const items = Array.from({ length: width }, (_, i) => ((packed[i >> 3] >> (i & 7)) & 1 ? "True" : "False"));
  const shown = boolsInText(text).slice(0, 8);
  return shown.every((x, i) => x === items[i]) ? items : null;
}

/** Bytes of a scalar element type, or null for one we don't know. */
function byteWidth(e: string): number | null {
  if (e === "index" || e === "uindex") return 8;
  if (e === "bool") return 1;
  const bits = /^(?:si|ui|f)(\d+)$/.exec(e)?.[1];
  return bits ? Number(bits) / 8 : null;
}

/** LLDB's undecoded form: "0x2a", or exactly the type's bytes in hex. */
function isRawBytes(value: string, e: string): boolean {
  if (/^0x[0-9a-fA-F]+$/.test(value)) return true;
  const width = byteWidth(e);
  return !!width && value.length === width * 2 && /^[0-9a-fA-F]+$/.test(value);
}

const boolsInText = (text: string) => [...text.matchAll(/\[\d+\] = (True|False)\b/g)].map((x) => x[1]);

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
    if (v.value.trim() && !isRawBytes(v.value, scalar[1])) return { value: v.value, type: shownType, ref: 0 };
    // Raw bytes without a summary: the only child is the same scalar, decoded by LLDB.
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
      // The text is right up to 8 elements, so those need no request.
      const inText = boolsInText(v.value);
      if (Number(simd[1]) <= 8 && inText.length === Number(simd[1])) return { value: list(inText), type: shownType, ref: 0 };
      const kids = v.ref ? await children(v.ref).catch(() => []) : [];
      const items = boolElements(Number(simd[1]), kids, v.value);
      // The children are packed bytes, so they are never offered for expansion.
      return { value: items ? list(items) : shownType, type: shownType, ref: 0 };
    }
    if (v.value !== type && !v.value.startsWith("{")) return { ...v, type: shownType };
    const kids = v.ref ? await children(v.ref).catch(() => []) : [];
    if (!kids.length) return { value: v.value === type ? shownType : v.value, type: shownType, ref: v.ref };
    return { value: list(kids.map((k) => k.value)), type: shownType, ref: v.ref };
  }
  // An element of an expanded SIMD value.
  const element = /^__mlir_type\.(\w+)$/.exec(type);
  const name = element && elementName(element[1]);
  return name ? { ...v, type: name } : v;
}

/** Runs at most `max` tasks at once. */
export function limited(max: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running >= max) await new Promise<void>((go) => waiting.push(go));
    else running++;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };
}

const RUNTIME_WORKER = /^🔥 Thread\d+$/;
/** Frames to look through: a worker in user code may be inside a libc call. */
export const WORKER_FRAMES = 8;

type StackFrame = { source?: { path?: string; presentationHint?: string } };
const hasUserFrame = (frames: StackFrame[]) => frames.some((f) => f.source?.path && f.source.presentationHint !== "deemphasize");

/** Mojo's runtime starts one idle worker per core. Hides those whose stack is only system code and
 *  lists the stopped thread first. A thread whose stack can't be read stays visible. */
export async function mojoThreads<T extends { id: number; name: string }>(threads: T[], stopped: number | null | undefined, stack: (id: number) => Promise<StackFrame[]>): Promise<T[]> {
  const limit = limited(8);
  const keep = await Promise.all(
    threads.map(async (t) => {
      if (t.id === stopped || !RUNTIME_WORKER.test(t.name)) return true;
      const frames = await limit(() => stack(t.id)).catch(() => null);
      return !frames?.length || hasUserFrame(frames);
    }),
  );
  const own = threads.filter((_, i) => keep[i]);
  return [...own.filter((t) => t.id === stopped), ...own.filter((t) => t.id !== stopped)];
}
