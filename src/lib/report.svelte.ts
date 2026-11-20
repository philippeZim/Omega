/**
 * "Report a problem": the user writes a short description (plus an optional image); we open GitHub's
 * "new issue" form pre-filled with it and the app version / OS / recent errors. GitHub's URL can't
 * carry images, so the image goes to the clipboard and the user pastes it into the form (Ctrl+V
 * uploads it there).
 */
import { openUrl } from "@tauri-apps/plugin-opener";
import { writeImage } from "@tauri-apps/plugin-clipboard-manager";
import { getVersion } from "@tauri-apps/api/app";
import { platform } from "./platform";
import { recentErrors } from "./ai/control.svelte";
import { app } from "./state.svelte";
import { t } from "./i18n/index.svelte";

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

export async function submitReport(kind: ReportKind, text: string, image: Uint8Array | null, withErrors: boolean) {
  const desc = text.trim();
  const first = desc.split("\n")[0].trim();
  const title = `${kind === "bug" ? "[Bug]" : "[Idee]"} ${first.length > 80 ? first.slice(0, 77) + "…" : first}`;
  const env = await environment(withErrors);
  const build = (errors: string) =>
    [
      desc,
      image ? `<!-- ${t("app.report.pasteHere")} -->` : "",
      withErrors ? ["---", ...env.lines].join("\n") : "",
      errors ? `<details><summary>Letzte Fehler</summary>\n\n\`\`\`\n${errors}\n\`\`\`\n</details>` : "",
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
  if (image) await writeImage(image);
  await openUrl(u);
}
