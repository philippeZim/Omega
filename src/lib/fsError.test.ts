// #33: file errors from the backend come as codes and are shown translated, naming the file.
import { afterEach, describe, expect, test } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
import { fsApi } from "./api";
import { fsErrorText } from "./fsError";
import { setLocale } from "./i18n/index.svelte";

afterEach(() => setLocale("en"));

describe("fsErrorText (#33)", () => {
  test("codes become translated messages naming the file", () => {
    setLocale("en");
    expect(fsErrorText("fs:not_utf8", "/p/data.bin")).toBe('"data.bin" is not a UTF-8 text file');
    expect(fsErrorText("fs:exists", "/p/sub/a.txt")).toBe('"a.txt" already exists');
    setLocale("fr");
    expect(fsErrorText("fs:not_utf8", "/p/data.bin")).toBe("« data.bin » n’est pas un fichier texte UTF-8");
    setLocale("de");
    expect(fsErrorText("fs:not_found", "C:\\p\\x.txt")).toBe("„x.txt“ existiert nicht");
  });
  test("other errors pass through unchanged", () => {
    expect(fsErrorText("Disk on fire", "/p/a")).toBe("Disk on fire");
    expect(fsErrorText("fs:unknown_code", "/p/a")).toBe("fs:unknown_code");
  });
});

describe("fsApi translates backend codes (#33)", () => {
  test("readFile of a binary file", async () => {
    setLocale("en");
    mockIPC(() => Promise.reject("fs:not_utf8"));
    await expect(fsApi.readFile("/p/data.bin")).rejects.toBe('"data.bin" is not a UTF-8 text file');
  });
  test("rename names the target when it exists, else the source", async () => {
    setLocale("en");
    mockIPC(() => Promise.reject("fs:exists"));
    await expect(fsApi.rename("/p/a.txt", "/p/sub/b.txt")).rejects.toBe('"b.txt" already exists');
    mockIPC(() => Promise.reject("fs:outside_project"));
    await expect(fsApi.rename("/p/a.txt", "/p/ext/b.txt")).rejects.toBe('"b.txt" would be created outside the project through a linked folder');
    mockIPC(() => Promise.reject("fs:not_found"));
    await expect(fsApi.rename("/p/a.txt", "/p/sub/b.txt")).rejects.toBe("\"a.txt\" doesn't exist");
  });
});
