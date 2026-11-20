<script lang="ts">
  import Glyph from "./Glyph.svelte";
  import { collab, startHosting, join, leave, approve, deny, kick, setMyName, clipboardTicket } from "../lib/collab/collab.svelte";
  import { onMount, tick } from "svelte";

  let codeInput: HTMLInputElement | undefined = $state();
  onMount(async () => {
    if (collab.role) return;
    const ticket = await clipboardTicket();
    if (ticket) code = ticket;
    await tick();
    codeInput?.focus();
  });
  import { writeText } from "@tauri-apps/plugin-clipboard-manager";
  import { ui } from "../lib/ui.svelte";
  import { app } from "../lib/state.svelte";
  import { share, follow } from "../lib/collab/share.svelte";
  import { t } from "../lib/i18n/index.svelte";

  /** Presence key of a participant ("host" for the host as seen by guests). */
  // Shared tabs that aren't project files have keys like "tab:<id>" – show their name instead.
  const fileLabel = (key: string) =>
    key.startsWith("tab:") ? (share.hostTabs.find((x) => x.key === key)?.name ?? app.tabs.find((x) => x.id === key.slice(4))?.name ?? "…") : key;
  const presenceKey = (p: { peer: string; role: string }) => (p.role === "host" && collab.role === "guest" ? "host" : p.peer);

  let code = $state("");
  let copied = $state(false);

  async function copy() {
    await writeText(collab.ticket);
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }

  async function rename() {
    const n = await ui.prompt(t("ai.collab.yourName"), collab.me.name);
    if (n) setMyName(n);
  }

  const busy = $derived(collab.status === "starting" || collab.status === "joining");
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && collab.open && !ui.dialog && (collab.open = false)} />

<div class="catcher" role="presentation" onclick={() => (collab.open = false)}></div>
<div class="panel" role="dialog" aria-label={t("ai.collab.title")}>
  <header>
    <h2>{t("ai.collab.title")}</h2>
    <button class="me" onclick={rename} title={t("ai.collab.changeName")}>
      <span class="dot" style="background: {collab.me.color}"></span>{collab.me.name || t("ai.collab.setName")}
    </button>
  </header>

  {#if !collab.role}
    <p class="desc">{t("ai.collab.desc")}</p>
    <button class="btn primary wide" onclick={startHosting} disabled={busy}>{t("ai.collab.start")}</button>
    <div class="or"><span>{t("ai.collab.or")}</span></div>
    <div class="joinrow">
      <input bind:this={codeInput} placeholder={t("ai.collab.pasteTicket")} bind:value={code} spellcheck="false" onkeydown={(e) => e.key === "Enter" && code.trim() && join(code)} />
      <button class="btn" onclick={() => join(code)} disabled={!code.trim() || busy}>{t("ai.collab.join")}</button>
    </div>
    {#if collab.error}<p class="err">{collab.error}</p>{/if}
  {:else if collab.status === "starting"}
    <p class="desc"><span class="spin"></span> {t("ai.collab.starting")}</p>
  {:else if collab.status === "joining" || collab.status === "waiting"}
    <p class="desc"><span class="spin"></span> {collab.status === "joining" ? t("ai.collab.connecting") : t("ai.collab.waiting")}</p>
    <button class="btn wide" onclick={leave}>{t("common.cancel")}</button>
  {:else}
    {#if collab.role === "host"}
      <label class="lbl" for="ticket">{t("ai.collab.ticket")}</label>
      <div class="ticket">
        <input id="ticket" readonly value={collab.ticket} onfocus={(e) => (e.currentTarget as HTMLInputElement).select()} />
        <button class="btn" onclick={copy}>{copied ? t("ai.collab.copied") : t("ai.collab.copy")}</button>
      </div>
      <p class="hint">{t("ai.collab.ticketHint")}</p>

      {#each collab.requests as r (r.peer)}
        <div class="request">
          <span><b>{r.name}</b> {t("ai.collab.wantsToJoin")}</span>
          <button class="btn small" onclick={() => deny(r)}>{t("ai.collab.deny")}</button>
          <button class="btn small primary" onclick={() => approve(r)}>{t("ai.collab.allow")}</button>
        </div>
      {/each}
    {/if}

    <label class="lbl" for="plist">{t("ai.collab.participants")}</label>
    <div class="people" id="plist">
      {#each collab.participants as p (p.peer)}
        {@const isMe = collab.role === "host" ? p.peer === "self" : p.name === collab.me.name && p.color === collab.me.color}
        {@const where = share.presence[presenceKey(p)]}
        {@const following = share.following === presenceKey(p)}
        <div class="person" class:following>
          <span class="avatar" style="background: {p.color}">{p.name.slice(0, 1).toUpperCase()}</span>
          <span class="pinfo">
            <span class="pname">{p.name}{isMe ? t("ai.collab.you") : ""}</span>
            {#if !isMe && where?.file}<span class="pfile">{fileLabel(where.file)}:{where.line}</span>{/if}
          </span>
          {#if p.role === "host"}<span class="tag">{t("ai.collab.host")}</span>{/if}
          <span class="spacer"></span>
          {#if p.rtt !== undefined}
            <span class="conn" class:relay={!p.direct} title={p.direct ? t("ai.collab.directTitle") : t("ai.collab.relayTitle")}>{p.direct ? t("ai.collab.direct") : t("ai.collab.relay")} · {p.rtt} ms</span>
          {/if}
          {#if !isMe}
            <button class="followbtn" class:on={following} onclick={() => follow(presenceKey(p))} title={following ? t("ai.collab.unfollow") : t("ai.collab.followTitle", { name: p.name })}>{following ? t("ai.collab.following") : t("ai.collab.follow")}</button>
          {/if}
          {#if collab.role === "host" && p.peer !== "self"}
            <button class="x" onclick={() => kick(p.peer)} title={t("ai.collab.remove")} aria-label={t("ai.collab.remove")}><Glyph name="x" size={8} /></button>
          {/if}
        </div>
      {/each}
    </div>

    <button class="btn wide danger" onclick={leave}>{collab.role === "host" ? t("ai.collab.end") : t("ai.collab.leave")}</button>
  {/if}
</div>

<style>
  .catcher { position: fixed; inset: 0; z-index: 89; }
  .panel {
    position: fixed;
    top: 58px;
    right: 14px;
    z-index: 90;
    width: 380px;
    padding: 18px;
    border-radius: 24px;
    background: var(--glass-strong);
    backdrop-filter: var(--blur);
    box-shadow: var(--glass-highlight), 0 24px 60px rgba(0, 0, 0, 0.6);
    /* No open animation: animating opacity/transform over backdrop-filter makes WebKitGTK render a
       frame without the panel (it blinks), same as the help panel. */
  }
  header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
  h2 { margin: 0; font-size: 17px; font-weight: 700; }
  .me { display: flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border-radius: 999px; font-size: 12px; color: var(--label-2); background: rgba(var(--fg-rgb), 0.06); }
  .me:hover { color: var(--label); background: rgba(var(--fg-rgb), 0.12); }
  .dot { width: 8px; height: 8px; border-radius: 50%; }
  .desc { margin: 0 0 14px; font-size: 12.5px; line-height: 1.5; color: var(--label-2); display: flex; align-items: center; gap: 8px; }
  .wide { width: 100%; }
  .or { display: flex; align-items: center; gap: 10px; margin: 14px 0; color: var(--label-3); font-size: 11px; }
  .or::before, .or::after { content: ""; flex: 1; height: 1px; background: rgba(var(--fg-rgb), 0.08); }
  .joinrow, .ticket { display: flex; gap: 8px; }
  .joinrow input, .ticket input { flex: 1; min-width: 0; font-family: var(--mono); font-size: 12px; }
  .lbl { display: block; margin: 14px 4px 6px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--label-2); }
  .hint { margin: 6px 4px 0; font-size: 11.5px; color: var(--label-3); }
  .err { margin: 10px 4px 0; font-size: 12px; color: var(--red); }
  .request { display: flex; align-items: center; gap: 6px; margin-top: 10px; padding: 10px 12px; border-radius: 14px; background: rgba(107, 155, 224, 0.12); box-shadow: inset 0 0 0 1px rgba(107, 155, 224, 0.25); font-size: 12.5px; }
  .request span { flex: 1; }
  .btn.small { padding: 5px 11px; font-size: 12px; }
  .people { display: flex; flex-direction: column; gap: 2px; margin-bottom: 14px; padding: 4px; border-radius: 16px; background: rgba(var(--fg-rgb), 0.035); }
  .person { display: flex; align-items: center; gap: 9px; min-height: 40px; padding: 0 8px; border-radius: 11px; font-size: 13px; }
  .person:hover { background: rgba(var(--fg-rgb), 0.05); }
  .person.following { background: rgba(var(--fg-rgb), 0.07); }
  .pinfo { display: flex; flex-direction: column; min-width: 0; line-height: 1.2; }
  .pfile { font-size: 10.5px; color: var(--label-3); font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 150px; }
  .followbtn { height: 22px; padding: 0 9px; border-radius: 999px; font-size: 11px; color: var(--label-2); background: rgba(var(--fg-rgb), 0.06); }
  .followbtn:hover { background: rgba(var(--fg-rgb), 0.12); color: var(--label); }
  .followbtn.on { background: var(--accent); color: #fff; }
  .avatar { width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; font-weight: 700; color: #111; }
  .tag { font-size: 10px; padding: 1px 7px; border-radius: 999px; background: rgba(var(--fg-rgb), 0.1); color: var(--label-2); }
  .spacer { flex: 1; }
  .conn { font-size: 11px; color: var(--green); font-variant-numeric: tabular-nums; }
  .conn.relay { color: var(--orange); }
  .x { width: 20px; height: 20px; display: grid; place-items: center; border-radius: 50%; color: var(--label-3); }
  .x:hover { background: var(--fill-2); color: var(--label); }
  .danger { color: var(--red); }
  .spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--label-3); border-top-color: var(--label); animation: spin 0.8s linear infinite; flex-shrink: 0; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
