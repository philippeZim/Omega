<script lang="ts">
  import { onMount } from "svelte";
  import { report, submitReport, toPngBytes, type ReportKind } from "../lib/report.svelte";
  import { ui } from "../lib/ui.svelte";
  import { t } from "../lib/i18n/index.svelte";

  let kind = $state<ReportKind>("bug");
  let text = $state("");
  let withErrors = $state(true);
  let image = $state<Uint8Array | null>(null);
  let preview = $state<string | null>(null);
  let sending = $state(false);
  let dragging = $state(false);
  let area: HTMLTextAreaElement;
  let fileInput: HTMLInputElement;

  onMount(() => area?.focus());
  $effect(() => () => preview && URL.revokeObjectURL(preview));

  async function setImage(blob: Blob) {
    try {
      const png = await toPngBytes(blob);
      if (preview) URL.revokeObjectURL(preview);
      image = png;
      preview = URL.createObjectURL(new Blob([png as BlobPart], { type: "image/png" }));
    } catch {
      ui.toast(t("app.report.badImage"), "error");
    }
  }

  function clearImage() {
    if (preview) URL.revokeObjectURL(preview);
    image = null;
    preview = null;
  }

  function onPaste(e: ClipboardEvent) {
    const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
    const file = item?.getAsFile();
    if (file) {
      e.preventDefault();
      setImage(file);
    }
  }

  function onDrop(e: DragEvent) {
    dragging = false;
    const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith("image/"));
    if (file) {
      e.preventDefault();
      setImage(file);
    }
  }

  function onPick() {
    const f = fileInput.files?.[0];
    if (f) setImage(f);
    fileInput.value = "";
  }

  async function send() {
    if (!text.trim() || sending) return;
    sending = true;
    try {
      await submitReport(kind, text, image, withErrors);
      report.open = false;
      ui.toast(image ? t("app.report.sentImage") : t("app.report.sent"));
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

    {#if preview}
      <div class="shot">
        <img src={preview} alt={t("app.report.image")} />
        <button class="remove" onclick={clearImage} aria-label={t("app.report.removeImage")} title={t("app.report.removeImage")}>×</button>
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
    <input bind:this={fileInput} type="file" accept="image/*" hidden onchange={onPick} />

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
  .shot { position: relative; margin-top: 10px; border-radius: 16px; overflow: hidden; background: var(--recess); }
  .shot img { display: block; width: 100%; max-height: 220px; object-fit: contain; }
  .remove { position: absolute; top: 6px; right: 6px; width: 26px; height: 26px; border-radius: 999px; font-size: 16px; line-height: 1; color: white; background: rgba(0, 0, 0, 0.55); }
  .remove:hover { background: rgba(0, 0, 0, 0.75); }
  .check { display: flex; align-items: center; gap: 8px; margin-top: 12px; font-size: 12.5px; color: var(--label-2); cursor: pointer; }
  .hint { margin: 8px 0 14px; font-size: 11.5px; line-height: 1.45; color: var(--label-3); }
  .buttons { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .buttons button { height: 38px; border-radius: 999px; font-size: 13.5px; font-weight: 500; background: rgba(var(--fg-rgb), 0.08); box-shadow: inset 0 1px 0 rgba(var(--hl-rgb), 0.06); }
  .buttons button:hover { background: rgba(var(--fg-rgb), 0.14); }
  .buttons button.primary { font-weight: 600; background: var(--accent); color: white; }
  .buttons button:disabled { opacity: 0.45; cursor: default; }
</style>
