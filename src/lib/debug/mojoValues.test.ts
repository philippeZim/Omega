import { describe, expect, test, vi } from "vitest";
import { limited, mojoThreads, mojoValue } from "./mojoValues";

const none = async () => [];
const scalar = (e: string) => `__mlir_type.\`!kgen.scalar<${e}>\``;
const simd = (n: number, e: string) => `__mlir_type.\`!kgen.simd<${n}, ${e}>\``;

describe("mojoValue", () => {
  // Strings are what Mojo 1.2's lldb-dap really sends.
  test.each([
    ["5600000000000000  86", "index", "86", "Int"],
    ["d6ffffffffffffff  -42", "index", "-42", "Int"],
    ["5600000000000000  86", "uindex", "86", "UInt"],
    ["fb -5", "si8", "-5", "Int8"],
    ["fa 250", "ui8", "250", "UInt8"],
    ["d4fe  -300", "si16", "-300", "Int16"],
    ["00286bee  4000000000", "ui32", "4000000000", "UInt32"],
    ["ffffffffffffffff  18446744073709551615", "ui64", "18446744073709551615", "UInt64"],
    ["00000000000000000000000000000080  -170141183460469231731687303715884105728", "si128", "-170141183460469231731687303715884105728", "Int128"],
    ["0038  0.5", "f16", "0.5", "Float16"],
    ["0000c03f  1.5", "f32", "1.5", "Float32"],
    ["0000000000000ac0  -3.25", "f64", "-3.25", "Float64"],
    ["000000000000f87f  NaN", "f64", "NaN", "Float64"],
    ["000080ff  -Inf", "f32", "-Inf", "Float32"],
    ["01 True", "bool", "True", "Bool"],
    ["00 False", "bool", "False", "Bool"],
  ])("%s as %s", async (raw, e, value, type) => {
    expect(await mojoValue({ value: raw, type: scalar(e), ref: 4 }, none)).toEqual({ value, type, ref: 0 });
  });

  test("a scalar without a summary takes LLDB's decoded child, never its own bytes", async () => {
    const kids = async () => [{ value: "42" }];
    expect(await mojoValue({ value: "0x2a", type: scalar("index"), ref: 4 }, kids)).toEqual({ value: "42", type: "Int", ref: 0 });
    const bool = async () => [{ value: "1" }];
    expect((await mojoValue({ value: "01", type: scalar("bool"), ref: 4 }, bool)).value).toBe("True");
  });

  test("a scalar it can't decode keeps its text", async () => {
    const failing = async () => {
      throw new Error("gone");
    };
    expect(await mojoValue({ value: "0x2a", type: scalar("index"), ref: 4 }, failing)).toEqual({ value: "0x2a", type: "Int", ref: 4 });
  });

  test("SIMD shows its elements and stays expandable", async () => {
    const kids = async () => ["1", "-2", "3", "-4"].map((value) => ({ value }));
    expect(await mojoValue({ value: simd(4, "si32"), type: simd(4, "si32"), ref: 9 }, kids)).toEqual({ value: "[1, -2, 3, -4]", type: "SIMD[Int32, 4]", ref: 9 });
  });

  const boolText = (items: string[]) => `{\n${items.map((x, i) => `  (bool) [${i}] = ${x}`).join("\n")}\n}`;
  const bytes = (...b: (number | string)[]) => async () => b.map((x) => ({ value: String(x) }));

  test("a bool SIMD decodes its packed bits", async () => {
    const value = boolText(["True", "False", "True", "False"]);
    expect(await mojoValue({ value, type: simd(4, "bool"), ref: 9 }, bytes(5, 85, 255, 1))).toEqual({ value: "[True, False, True, False]", type: "SIMD[Bool, 4]", ref: 0 });
  });

  test("a bool SIMD past 8 elements ignores LLDB's wrong text", async () => {
    // Real case: all 16 are True, LLDB's text says the last 8 are False.
    const value = boolText([...Array(8).fill("True"), ...Array(8).fill("False")]);
    const r = await mojoValue({ value, type: simd(16, "bool"), ref: 9 }, bytes(255, 255, ...Array(14).fill(0)));
    expect(r.value).toBe(`[${Array(16).fill("True").join(", ")}]`);
  });

  test("a bool SIMD shows no elements when bytes and text disagree or bytes are unusable", async () => {
    const value = boolText(["True", "False"]);
    const wide = boolText(Array(16).fill("True"));
    for (const kids of [bytes(2, 255), bytes("x", 0), bytes(300, 0), bytes()])
      expect(await mojoValue({ value: wide, type: simd(16, "bool"), ref: 9 }, kids)).toEqual({ value: "SIMD[Bool, 16]", type: "SIMD[Bool, 16]", ref: 0 });
    expect((await mojoValue({ value, type: simd(2, "bool"), ref: 9 }, bytes(2, 0))).value).toBe("[True, False]");
  });

  test("a bool scalar never shows a child that isn't 0 or 1", async () => {
    const wrong = async () => [{ value: "85" }];
    expect(await mojoValue({ value: "55", type: scalar("bool"), ref: 4 }, wrong)).toEqual({ value: "55", type: "Bool", ref: 4 });
  });

  test("an expanded SIMD element gets its Mojo type name", async () => {
    expect(await mojoValue({ value: "-2", type: "__mlir_type.si32", ref: 0 }, none)).toEqual({ value: "-2", type: "Int32", ref: 0 });
  });

  test("a long SIMD is cut off visibly", async () => {
    const kids = async () => Array.from({ length: 32 }, () => ({ value: "7" }));
    const { value } = await mojoValue({ value: simd(32, "si64"), type: simd(32, "si64"), ref: 9 }, kids);
    expect(value.split(", ")).toHaveLength(17);
    expect(value.endsWith("…]")).toBe(true);
  });

  test("strings, lists, structs and pointers are left alone", async () => {
    for (const v of [
      { value: '"hello"', type: "String", ref: 2 },
      { value: "(size 3)[1, 2, 3]", type: "List", ref: 3 },
      { value: "Point", type: "Point", ref: 4 },
      { value: "0x00005555555970a0 104", type: "__mlir_type.`!kgen.pointer<scalar<ui8>>`", ref: 5 },
    ])
      expect(await mojoValue(v, none)).toEqual(v);
  });
});

describe("requests and parent values", () => {
  const counted = (kids: { value: string }[]) => {
    const fn = vi.fn(async () => kids);
    return fn;
  };

  test.each([
    ["42", "index"],
    ["-7", "si64"],
    ["1.5", "f64"],
    ["True", "bool"],
    ["NaN", "f32"],
  ])("a clean parent value %s stays, without a request", async (value, e) => {
    const kids = counted([{ value: "999" }]);
    expect(await mojoValue({ value, type: scalar(e), ref: 4 }, kids)).toMatchObject({ value, ref: 0 });
    expect(kids).not.toHaveBeenCalled();
  });

  test.each([
    ["0x2a", "index"],
    ["2a00000000000000", "index"],
    ["2a", "si8"],
  ])("raw bytes %s use the decoded child", async (value, e) => {
    const kids = counted([{ value: "42" }]);
    expect((await mojoValue({ value, type: scalar(e), ref: 4 }, kids)).value).toBe("42");
    expect(kids).toHaveBeenCalledTimes(1);
  });

  test("a short bool SIMD and an already readable SIMD need no request", async () => {
    const kids = counted([]);
    const text = "{\n  (bool) [0] = True\n  (bool) [1] = False\n}";
    expect((await mojoValue({ value: text, type: simd(2, "bool"), ref: 9 }, kids)).value).toBe("[True, False]");
    expect((await mojoValue({ value: "[1, 2]", type: simd(2, "si32"), ref: 9 }, kids)).value).toBe("[1, 2]");
    expect(kids).not.toHaveBeenCalled();
  });

  test("a SIMD whose children can't be read shows its Mojo type", async () => {
    const failing = async () => {
      throw new Error("too many");
    };
    expect(await mojoValue({ value: simd(2, "si32"), type: simd(2, "si32"), ref: 9 }, failing)).toEqual({ value: "SIMD[Int32, 2]", type: "SIMD[Int32, 2]", ref: 9 });
  });

  test("limited never runs more than its maximum", async () => {
    const limit = limited(2);
    let now = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 9 }, () =>
        limit(async () => {
          peak = Math.max(peak, ++now);
          await Promise.resolve();
          now--;
        }),
      ),
    );
    expect(peak).toBe(2);
  });
});

describe("mojoThreads", () => {
  const threads = [{ id: 1, name: "v" }, { id: 2, name: "🔥 Thread0" }, { id: 3, name: "🔥 Thread1" }, { id: 4, name: "🔥 Thread2" }];
  // Shapes from real lldb-dap output: idle workers only have deemphasized libc frames.
  const idle = [{ source: { path: "/usr/lib/libc.so.6`sym", presentationHint: "deemphasize" } }];
  const inUserCode = [...idle, { source: { path: "/p/main.mojo" } }];
  const ids = async (stopped: number, stack: (id: number) => Promise<any[]>) => (await mojoThreads(threads, stopped, stack)).map((t) => t.id);

  test("hides idle runtime workers", async () => {
    expect(await ids(1, async () => idle)).toEqual([1]);
  });

  test("keeps a worker that stopped, and lists it first", async () => {
    expect(await ids(3, async () => idle)).toEqual([3, 1]);
  });

  test("keeps every worker in user code, even inside a libc call", async () => {
    expect(await ids(3, async (id) => (id === 2 ? inUserCode : idle))).toEqual([3, 1, 2]);
  });

  test("keeps a worker whose stack can't be read", async () => {
    const stack = async (id: number) => {
      if (id === 2) throw new Error("gone");
      return id === 3 ? [] : idle;
    };
    expect(await ids(1, stack)).toEqual([1, 2, 3]);
  });
});
