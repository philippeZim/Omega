/**
 * "Report a problem": the user writes a short description (plus optional screenshots); we open
 * GitHub's "new issue" form pre-filled with it and the app version / OS / recent errors. GitHub's
 * URL can't carry images: a single screenshot goes to the clipboard (Ctrl+V in the form uploads it),
 * several are saved to a folder that we open, so they can be dragged into the form together.
 */
import { openUrl, revealItemInDir } from "./native";
import { downloadDir } from "@tauri-apps/api/path";
import { writeImage } from "@tauri-apps/plugin-clipboard-manager";
import { getVersion } from "@tauri-apps/api/app";
import { platform } from "./platform";
import { recentErrors } from "./ai/control.svelte";
import { app } from "./state.svelte";
import { t } from "./i18n/index.svelte";
import { fsApi, joinPath } from "./api";

export const REPO = "philippeZim/Omega";

export const report = $state({ open: false });

export type ReportKind = "bug" | "idea";

/** GitHub rejects very long URLs (~8 KB); keep the encoded body well below that. */
const MAX_URL = 7000;

/** Converts any image blob to PNG bytes (the clipboard plugin only decodes PNG). */
export async function toPngBytes(blob: Blob): Promise<Uint8Array> {
  if (blob.type === "image/png") return new Uint8Array(await blob.arrayBuffer());
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext("2d")!.drawImage(bmp, 0, 0);
  const png = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("PNG"))), "image/png"));
  return new Uint8Array(await png.arrayBuffer());
}

async function environment(withErrors: boolean) {
  const [version, p] = await Promise.all([getVersion().catch(() => "?"), platform().catch(() => null)]);
  const lines = [`- Omega: ${version}`, `- OS: ${p ? `${p.os} (${p.arch})` : navigator.userAgent}`, `- Mode: ${app.mode}`];
  let errors = "";
  if (withErrors) {
    const home = p?.home;
    const list = recentErrors(5).map((e) => `[${e.time}] ${e.text.slice(0, 600)}`);
    // Replace the home folder so reports don't leak the user name.
    if (list.length) errors = list.join("\n").split(home || "\u0000").join("~");
  }
  return { lines, errors };
}

const b64 = (u: Uint8Array) => {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Saves the screenshots into Downloads/omega-report-<time>/ and returns that folder. */
async function saveImages(images: Uint8Array[]): Promise<string> {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const dir = joinPath((await downloadDir()).replace(/\\/g, "/").replace(/\/+$/, ""), `omega-report-${stamp}`);
  for (const [i, png] of images.entries()) await fsApi.writeFileBase64(joinPath(dir, `screenshot-${i + 1}.png`), b64(png));
  return dir;
}

/** Opens the pre-filled issue. Returns the folder the screenshots were saved to (several images) or null. */
export async function submitReport(kind: ReportKind, text: string, images: Uint8Array[], withErrors: boolean): Promise<string | null> {
  const desc = text.trim();
  const first = desc.split("\n")[0].trim();
  const title = `${kind === "bug" ? "[Bug]" : "[Idea]"} ${first.length > 80 ? first.slice(0, 77) + "…" : first}`;
  const env = await environment(withErrors);
  const hint = images.length === 1 ? t("app.report.pasteHere") : images.length > 1 ? t("app.report.dropHere", { n: images.length }) : "";
  const build = (errors: string) =>
    [
      desc,
      hint ? `<!-- ${hint} -->` : "",
      withErrors ? ["---", ...env.lines].join("\n") : "",
      errors ? `<details><summary>Recent errors</summary>\n\n\`\`\`\n${errors}\n\`\`\`\n</details>` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  const url = (body: string) =>
    `https://github.com/${REPO}/issues/new?` +
    new URLSearchParams({ title, body, labels: kind === "bug" ? "bug" : "enhancement" }).toString();
  let errors = env.errors;
  let u = url(build(errors));
  // Too long: trim the error log first, then the description.
  while (u.length > MAX_URL && errors.length > 200) {
    errors = errors.slice(-Math.floor(errors.length / 2));
    u = url(build(errors));
  }
  if (u.length > MAX_URL) u = url(build("").slice(0, 3000) + "\n…");
  let folder: string | null = null;
  if (images.length === 1) await writeImage(images[0]);
  else if (images.length > 1) folder = await saveImages(images);
  await openUrl(u);
  // Open the folder after the browser so it ends up on top, ready to drag from.
  if (folder) await revealItemInDir(joinPath(folder, "screenshot-1.png")).catch(() => {});
  return folder;
}
