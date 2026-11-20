import { describe, expect, test } from "vitest";
import { detectEol, fromDisk, stripBom, toDisk } from "./eol";

// #121: a UTF-8 BOM is not part of the editor text, but survives a save.
describe("byte order mark", () => {
  const raw = "﻿BOM file line1\r\nline2\r\n";

  test("is removed from the editor text", () => {
    expect(fromDisk(raw)).toBe("BOM file line1\nline2\n");
    expect(stripBom("﻿abc")).toBe("abc");
    expect(stripBom("abc")).toBe("abc");
  });

  test("is remembered with the line ending and written back", () => {
    expect(detectEol(raw)).toBe("﻿\r\n");
    expect(detectEol("﻿a\nb")).toBe("﻿\n");
    expect(toDisk(fromDisk(raw), detectEol(raw))).toBe(raw);
    expect(toDisk("a\n", detectEol("﻿a\n"))).toBe("﻿a\n");
  });

  test("files without a BOM don't get one", () => {
    expect(toDisk("a\nb", detectEol("a\r\nb"))).toBe("a\r\nb");
    expect(toDisk("a\nb", detectEol("a\nb"))).toBe("a\nb");
  });
});
