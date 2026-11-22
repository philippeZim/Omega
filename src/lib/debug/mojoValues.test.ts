import { describe, expect, test } from "vitest";
import { mojoThreads, mojoValue } from "./mojoValues";

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

describe("mojoThreads", () => {
  const threads = [{ id: 1, name: "v" }, { id: 2, name: "🔥 Thread0" }, { id: 3, name: "🔥 Thread1" }];

  test("hides idle runtime workers", () => {
    expect(mojoThreads(threads, 1).map((t) => t.id)).toEqual([1]);
  });

  test("keeps a worker that stopped, and lists it first", () => {
    expect(mojoThreads(threads, 3).map((t) => t.id)).toEqual([3, 1]);
  });
});
