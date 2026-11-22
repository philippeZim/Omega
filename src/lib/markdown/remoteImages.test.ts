import { beforeEach, describe, expect, test, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { forceParsing } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { imageSrc, livePreview } from "./livePreview";
import { ASSET_PREFIX } from "../collab/guestAssets";
import {
  allowImages,
  imagesAllowed,
  isRemoteImage,
  loadRemoteImages,
  moveImagePermissions,
  remoteImages,
  setAlwaysAllowImages,
} from "./remoteImages.svelte";

vi.mock("@tauri-apps/api/core", async (orig) => ({
  ...(await orig<typeof import("@tauri-apps/api/core")>()),
  convertFileSrc: (p: string) => `asset://localhost/${encodeURIComponent(p)}`,
}));

const KEY = "markdown.remoteImages";
const URL_A = "https://tracker.example/a.png";

function open(doc: string, path: string | null) {
  const parent = document.body.appendChild(document.createElement("div"));
  // The cursor sits on an empty last line, so no image is revealed as source.
  const text = doc + "\n\nend\n";
  const state = EditorState.create({
    doc: text,
    selection: { anchor: text.length },
    extensions: [markdown({ base: markdownLanguage }), livePreview(path)],
  });
  const view = new EditorView({ state, parent });
  forceParsing(view, view.state.doc.length, 5000);
  view.dispatch({ selection: { anchor: text.length } });
  return view;
}
const srcs = (v: EditorView) => [...v.dom.querySelectorAll("img:not(.cm-widgetBuffer)")].map((i) => i.getAttribute("src") ?? "");
const placeholders = (v: EditorView) => v.dom.querySelectorAll(".md-remote-image");
const buttons = (v: EditorView) => [...v.dom.querySelectorAll<HTMLButtonElement>(".md-remote-image button")];

beforeEach(() => {
  localStorage.removeItem(KEY);
  loadRemoteImages();
  document.body.innerHTML = "";
});

describe("what counts as remote", () => {
  test("http(s) in any spelling the browser accepts", () => {
    for (const u of ["http://x/a.png", "HTTPS://x/a.png", " https://x/a.png", "ht\ttps://x/a.png", "\nhttps://x/a.png"])
      expect(isRemoteImage(u)).toBe(true);
  });

  test("local and embedded images are not", () => {
    for (const u of ["a.png", "./img/a.png", "/home/me/a.png", "C:/a.png", "data:image/png;base64,AAAA", "asset://localhost/a.png"])
      expect(isRemoteImage(u)).toBe(false);
  });

  test("other schemes never reach the browser", () => {
    expect(imageSrc("ftp://x/a.png", "/n/a.md")).toBe(ASSET_PREFIX);
    expect(imageSrc("\tftp://x/a.png", null)).toBe(ASSET_PREFIX);
    expect(imageSrc("collab-asset:secret.png", "/n/a.md")).toBe(ASSET_PREFIX);
  });
});

describe("the preview", () => {
  test("blocks a remote image and offers to load it", () => {
    const v = open(`![pic](${URL_A})`, "/n/a.md");
    expect(srcs(v)).toEqual([]);
    expect(placeholders(v).length).toBe(1);
    expect(placeholders(v)[0].textContent).toContain("tracker.example");
    v.destroy();
  });

  test("raw HTML, reference images, srcset and CSS url() load nothing", () => {
    const doc = [
      `<img src="${URL_A}" srcset="${URL_A} 2x">`,
      `<div style="background:url(${URL_A})"></div>`,
      `<style>body{background:url(${URL_A})}</style>`,
      "",
      "![ref][r]",
      "",
      `[r]: ${URL_A}`,
      "",
      `| c |\n|---|\n| ![t](${URL_A}) |`,
    ].join("\n");
    const v = open(doc, "/n/a.md");
    expect(srcs(v)).toEqual([]);
    // All of it stays source text: no element exists that could fetch anything.
    expect(v.dom.querySelector("style, img[srcset], [style*='url(']")).toBeNull();
    v.destroy();
  });

  test("a local image next to a blocked one keeps loading", () => {
    const v = open(`![a](${URL_A})\n\n![b](pic.png)`, "/n/a.md");
    expect(srcs(v).length).toBe(1);
    expect(srcs(v)[0]).toContain("pic.png");
    v.destroy();
  });

  test("Load images allows this file and survives a restart", () => {
    const v = open(`![pic](${URL_A})`, "/n/a.md");
    buttons(v)[0].click();
    expect(srcs(v)).toEqual([URL_A]);
    loadRemoteImages();
    expect(imagesAllowed("/n/a.md")).toBe(true);
    expect(imagesAllowed("/n/b.md")).toBe(false);
    v.destroy();
  });

  test("the folder button allows the folder and what's below it, not a sibling", () => {
    const v = open(`![pic](${URL_A})`, "/n/a.md");
    buttons(v)[1].click();
    expect(srcs(v)).toEqual([URL_A]);
    expect(imagesAllowed("/n/sub/b.md")).toBe(true);
    expect(imagesAllowed("/nope/b.md")).toBe(false);
    v.destroy();
  });

  test("the setting allows everything, and turning it off blocks again", () => {
    const v = open(`![pic](${URL_A})`, "/n/a.md");
    setAlwaysAllowImages(true);
    expect(srcs(v)).toEqual([URL_A]);
    setAlwaysAllowImages(false);
    expect(srcs(v)).toEqual([]);
    v.destroy();
  });
});

describe("Code Together guests", () => {
  test("a guest's choice stays in its editor and is never stored", () => {
    const guest = open(`![pic](${URL_A})`, "collab:docs/a.md");
    expect(srcs(guest)).toEqual([]);
    expect(buttons(guest).length).toBe(1); // no folder permission for a host's folder
    buttons(guest)[0].click();
    expect(srcs(guest)).toEqual([URL_A]);
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(remoteImages.files).toEqual([]);
    expect(imagesAllowed("docs/a.md")).toBe(false);
    expect(imagesAllowed("collab:docs/a.md")).toBe(false);
    const next = open(`![pic](${URL_A})`, "collab:docs/a.md");
    expect(srcs(next)).toEqual([]);
    guest.destroy();
    next.destroy();
  });

  test("a stored permission can't be created for a shared doc", () => {
    allowImages("collab:docs/a.md", "folder");
    expect(remoteImages.folders).toEqual([]);
  });

  test("a remote URL is never sent to the host as a project image", () => {
    const src = imageSrc(URL_A, "collab:docs/a.md");
    expect(src).toBe(URL_A);
    expect(src.startsWith(ASSET_PREFIX)).toBe(false);
  });
});

describe("renames", () => {
  test("a permission follows a renamed file, folder or parent folder", () => {
    allowImages("/n/a.md", "file");
    allowImages("/n/sub/b.md", "folder");
    moveImagePermissions("/n/a.md", "/n/c.md");
    expect(imagesAllowed("/n/c.md")).toBe(true);
    expect(imagesAllowed("/n/a.md")).toBe(false);
    moveImagePermissions("/n", "/m");
    expect(imagesAllowed("/m/c.md")).toBe(true);
    expect(imagesAllowed("/m/sub/x.md")).toBe(true);
    expect(imagesAllowed("/n/sub/x.md")).toBe(false);
  });

  test("a similar name is left alone, and a deleted file loses its permission", () => {
    allowImages("/n/a.md", "file");
    allowImages("/n/a.md.bak", "file");
    moveImagePermissions("/n/a.md", null);
    expect(remoteImages.files).toEqual(["/n/a.md.bak"]);
  });
});

test("a corrupt stored value allows nothing", () => {
  localStorage.setItem(KEY, '{"always":"yes","files":[1],"folders":"/"}');
  loadRemoteImages();
  expect(imagesAllowed("/n/a.md")).toBe(false);
  localStorage.setItem(KEY, "{oops");
  loadRemoteImages();
  expect(imagesAllowed("/n/a.md")).toBe(false);
});
