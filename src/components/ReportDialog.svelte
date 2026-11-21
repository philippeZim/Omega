<script lang="ts">
  import { onMount } from "svelte";
  import { readImage } from "@tauri-apps/plugin-clipboard-manager";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { convertFileSrc } from "@tauri-apps/api/core";
  import { report, submitReport, toPngBytes, type ReportKind } from "../lib/report.svelte";
  import { ui } from "../lib/ui.svelte";
  import { t } from "../lib/i18n/index.svelte";

  let kind = $state<ReportKind>("bug");
  let text = $state("");
  let withErrors = $state(true);
  /** Screenshots as PNG bytes plus an object URL for the thumbnail. */
  let images = $state<{ png: Uint8Array; url: string }[]>([]);
  const MAX_IMAGES = 10;
  let sending = $state(false);
  let dragging = $state(false);
  let area: HTMLTextAreaElement;
  let fileInput: HTMLInputElement;

  const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp)$/i;

  onMount(() => {
    area?.focus();
    // Files dragged in from the file manager arrive as Tauri drag-drop events (the webview never
    // sees them as HTML drops), so the drop zone listens here.
    let unlisten: (() => void) | undefined;
    let alive = true;
    getCurrentWebview()
      .onDragDropEvent(async ({ payload }) => {
        if (payload.type === "enter") dragging = payload.paths.some((p) => IMAGE_FILE.test(p));
        else if (payload.type === "leave") dragging = false;
        else if (payload.type === "drop") {
          dragging = false;
          for (const path of payload.paths.filter((p) => IMAGE_FILE.test(p))) addImage(await (await fetch(convertFileSrc(path))).blob());
        }
      })
      .then((fn) => (alive ? (unlisten = fn) : fn()));
    return () => {
      alive = false;
      unlisten?.();
      // Free the thumbnails only when the dialog closes (an $effect reading `images` would re-run
      // on every new image and revoke URLs that are still shown).
      for (const i of images) URL.revokeObjectURL(i.url);
    };
  });

  async function addImage(blob: Blob) {
    if (images.length >= MAX_IMAGES) return ui.toast(t("app.report.tooMany", { n: MAX_IMAGES }), "error");
    try {
      const png = await toPngBytes(blob);
      images.push({ png, url: URL.createObjectURL(new Blob([png as BlobPart], { type: "image/png" })) });
    } catch {
      ui.toast(t("app.report.badImage"), "error");
    }
  }

  function removeImage(i: number) {
    URL.revokeObjectURL(images[i].url);
    images.splice(i, 1);
  }

  // Ctrl+V: macOS and Windows put a pasted screenshot into the paste event, but WebKitGTK (Linux)
  // usually doesn't. So the paste event is tried first and, if it brought no image, the clipboard
  // is read through the Tauri plugin. Text still pastes into the field as usual.
  let pastedImage = false;

  function onPaste(e: ClipboardEvent) {
    const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
    const file = item?.getAsFile();
    if (file) {
      pastedImage = true;
      e.preventDefault();
      addImage(file);
    }
  }

  async function imageFromClipboard() {
    let img;
    try {
      img = await readImage();
    } catch {
      return; // no image on the clipboard (e.g. plain text)
    }
    try {
      const [{ width, height }, rgba] = await Promise.all([img.size(), img.rgba()]);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
      if (blob && !pastedImage) addImage(blob);
    } catch {
      ui.toast(t("app.report.badImage"), "error");
    } finally {
      img.close?.();
    }
  }

  function onDrop(e: DragEvent) {
    dragging = false;
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      e.preventDefault();
      for (const f of files) addImage(f);
    }
  }

  function onPick() {
    for (const f of fileInput.files ?? []) addImage(f);
    fileInput.value = "";
  }

  async function send() {
    if (!text.trim() || sending) return;
    sending = true;
    try {
      const folder = await submitReport(kind, text, images.map((i) => i.png), withErrors);
      report.open = false;
      ui.toast(folder ? t("app.report.sentImages", { n: images.length }) : images.length ? t("app.report.sentImage") : t("app.report.sent"));
    } catch (e) {
      ui.toast(t("app.report.failed", { error: String(e) }), "error");
    } finally {
      sending = false;
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      report.open = false;
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send();
    } else if (e.key.toLowerCase() === "v" && (e.ctrlKey || e.metaKey) && !e.altKey) {
      // Give the paste event a moment; only fall back to reading the clipboard if it had no image.
      pastedImage = false;
      setTimeout(() => !pastedImage && imageFromClipboard(), 60);
    }
  }
</script>

<div class="backdrop" role="presentation" onclick={() => (report.open = false)}>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="card" role="dialog" tabindex="-1" aria-label={t("app.report.title")} onclick={(e) => e.stopPropagation()} onkeydown={onKey} onpaste={onPaste}>
    <h2>{t("app.report.title")}</h2>
    <div class="seg">
      <button class:on={kind === "bug"} onclick={() => (kind = "bug")}>{t("app.report.bug")}</button>
      <button class:on={kind === "idea"} onclick={() => (kind = "idea")}>{t("app.report.idea")}</button>
    </div>
    <textarea bind:this={area} bind:value={text} rows="5" placeholder={kind === "bug" ? t("app.report.bugPlaceholder") : t("app.report.ideaPlaceholder")}></textarea>

    {#if images.length}
      <div class="shots">
        {#each images as img, i (img.url)}
          <div class="shot">
            <img src={img.url} alt={t("app.report.image")} />
            <button class="remove" onclick={() => removeImage(i)} aria-label={t("app.report.removeImage")} title={t("app.report.removeImage")}>×</button>
          </div>
        {/each}
        {#if images.length < MAX_IMAGES}
          <button class="shot add" class:dragging onclick={() => fileInput.click()} title={t("app.report.addMore")} aria-label={t("app.report.addMore")}>+</button>
        {/if}
      </div>
    {:else}
      <button
        class="drop"
        class:dragging
        onclick={() => fileInput.click()}
        ondragover={(e) => { e.preventDefault(); dragging = true; }}
        ondragleave={() => (dragging = false)}
        ondrop={onDrop}
      >{t("app.report.addImage")}</button>
    {/if}
    <input bind:this={fileInput} type="file" accept="image/*" multiple hidden onchange={onPick} />

    <label class="check"><input type="checkbox" bind:checked={withErrors} /> {t("app.report.withErrors")}</label>
    <p class="hint">{t("app.report.hint")}</p>

    <div class="buttons">
      <button onclick={() => (report.open = false)}>{t("common.cancel")}</button>
      <button class="primary" disabled={!text.trim() || sending} onclick={send}>{t("app.report.send")}</button>
    </div>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; background: var(--scrim); }
  .card {
    width: min(480px, 92vw);
    max-height: 90vh;
    overflow-y: auto;
    padding: 20px 18px 14px;
    border-radius: 26px;
    background: var(--glass-strong);
    backdrop-filter: var(--blur);
    box-shadow: var(--glass-highlight), 0 30px 80px rgba(0, 0, 0, 0.7);
    outline: none;
  }
  h2 { margin: 0 0 14px; font-size: 15px; font-weight: 600; text-align: center; }
  .seg { display: grid; grid-template-columns: 1fr 1fr; padding: 3px; margin-bottom: 12px; border-radius: 999px; background: var(--recess); box-shadow: var(--recess-shadow); }
  .seg button { height: 30px; border-radius: 999px; font-size: 13px; font-weight: 600; color: var(--label-2); transition: background 0.2s, color 0.2s; }
  .seg button.on { color: var(--label); background: var(--raised-bg); box-shadow: var(--raised-shadow); }
  textarea { display: block; width: 100%; min-height: 110px; max-height: 40vh; resize: vertical; padding: 10px 14px; border: none; border-radius: 16px; font: 13px/1.5 var(--sans, inherit); color: var(--label); background: var(--recess); box-shadow: var(--recess-shadow); outline: none; }
  textarea:focus { box-shadow: var(--recess-shadow), 0 0 0 1px rgba(var(--fg-rgb), 0.14); }
  .drop { display: block; width: 100%; margin-top: 10px; padding: 14px; border-radius: 16px; border: 1px dashed rgba(var(--fg-rgb), 0.18); font-size: 12.5px; color: var(--label-2); transition: background 0.15s; }
  .drop:hover, .drop.dragging { background: rgba(var(--fg-rgb), 0.06); color: var(--label); }
  .shots { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 8px; margin-top: 10px; }
  .shot { position: relative; aspect-ratio: 4 / 3; border-radius: 12px; overflow: hidden; background: var(--recess); }
  .shot img { display: block; width: 100%; height: 100%; object-fit: cover; }
  .shot.add { border: 1px dashed rgba(var(--fg-rgb), 0.18); background: none; font-size: 22px; color: var(--label-2); }
  .shot.add:hover, .shot.add.dragging { background: rgba(var(--fg-rgb), 0.06); color: var(--label); }
  .remove { position: absolute; top: 4px; right: 4px; width: 22px; height: 22px; border-radius: 999px; font-size: 16px; line-height: 1; color: white; background: rgba(0, 0, 0, 0.55); }
  .remove:hover { background: rgba(0, 0, 0, 0.75); }
  .check { display: flex; align-items: center; gap: 8px; margin-top: 12px; font-size: 12.5px; color: var(--label-2); cursor: pointer; }
  .hint { margin: 8px 0 14px; font-size: 11.5px; line-height: 1.45; color: var(--label-3); }
  .buttons { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .buttons button { height: 38px; border-radius: 999px; font-size: 13.5px; font-weight: 500; background: rgba(var(--fg-rgb), 0.08); box-shadow: inset 0 1px 0 rgba(var(--hl-rgb), 0.06); }
  .buttons button:hover { background: rgba(var(--fg-rgb), 0.14); }
  .buttons button.primary { font-weight: 600; background: var(--accent-fill); color: white; }
  .buttons button:disabled { opacity: 0.45; cursor: default; }
</style>
