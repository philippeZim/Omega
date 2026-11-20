import { describe, expect, test } from "vitest";
import { resolvePath } from "./livePreview";

describe("resolvePath", () => {
  const from = "/home/me/notes/index.md";

  test("relative paths resolve against the file's folder", () => {
    expect(resolvePath("other.md", from)).toBe("/home/me/notes/other.md");
    expect(resolvePath("./sub/a.md", from)).toBe("/home/me/notes/sub/a.md");
    expect(resolvePath("../x/./y.png", from)).toBe("/home/me/x/y.png");
  });

  test(".. never climbs above the root", () => {
    expect(resolvePath("../../../../../a.md", from)).toBe("/a.md");
    expect(resolvePath("a.md", "/top.md")).toBe("/a.md");
  });

  test("absolute paths ignore fromPath (and work without one)", () => {
    expect(resolvePath("/etc//hosts", null)).toBe("/etc/hosts");
    expect(resolvePath("/a/../b", from)).toBe("/b");
  });

  test("strips the #fragment", () => {
    expect(resolvePath("other.md#Heading", from)).toBe("/home/me/notes/other.md");
  });

  test("decodes percent escapes", () => {
    expect(resolvePath("my%20file.md", from)).toBe("/home/me/notes/my file.md");
  });

  test("Windows drive paths keep their drive and use /", () => {
    expect(resolvePath("C:\\Users\\me\\a.md", null)).toBe("C:/Users/me/a.md");
    expect(resolvePath("D:/x/../y.md", from)).toBe("D:/y.md");
    expect(resolvePath("..\\img\\p.png", "C:/proj/docs/readme.md")).toBe("C:/proj/img/p.png");
  });

  test("URLs with a scheme are not file paths", () => {
    expect(resolvePath("https://example.com/a.md", from)).toBeNull();
    expect(resolvePath("mailto:me@example.com", from)).toBeNull();
    expect(resolvePath("file:///tmp/a", from)).toBeNull();
  });

  test("relative link from an unsaved file has no target", () => {
    expect(resolvePath("a.md", null)).toBeNull();
  });

  // #26: decodeURI threw URIError on a lone "%" (e.g. "100%.md"), so the link handler / image widget threw.
  test("a literal % that is not an escape does not throw", () => {
    expect(resolvePath("100%.md", from)).toBe("/home/me/notes/100%.md");
    expect(resolvePath("img/50% off.png", from)).toBe("/home/me/notes/img/50% off.png");
    expect(resolvePath("100%.md#Top", from)).toBe("/home/me/notes/100%.md");
  });
});
