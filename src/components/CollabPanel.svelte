<script lang="ts">
  import { collab, startHosting, join, leave, approve, deny, kick, setMyName, clipboardTicket } from "../lib/collab/collab.svelte";
  import { onMount, tick } from "svelte";

  let codeInput: HTMLInputElement | undefined = $state();
  onMount(async () => {
    if (collab.role) return;
    const t = await clipboardTicket();
    if (t) code = t;
    await tick();
    codeInput?.focus();
  });
  import { writeText } from "@tauri-apps/plugin-clipboard-manager";
  import { ui } from "../lib/ui.svelte";
  import { share, follow } from "../lib/collab/share.svelte";

  /** Presence key of a participant ("host" for the host as seen by guests). */
  const presenceKey = (p: { peer: string; role: string }) => (p.role === "host" && collab.role === "guest" ? "host" : p.peer);

  let code = $state("");
  let copied = $state(false);

  async function copy() {
    await writeText(collab.ticket);
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }

  async function rename() {
    const n = await ui.prompt("Dein Name in Sessions", collab.me.name);
    if (n) setMyName(n);
  }

  const busy = $derived(collab.status === "starting" || collab.status === "joining");
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && collab.open && !ui.dialog && (collab.open = false)} />

<div class="catcher" role="presentation" onclick={() => (collab.open = false)}></div>
<div class="panel" role="dialog" aria-label="Zusammen coden">
  <header>
    <h2>Zusammen coden</h2>
    <button class="me" onclick={rename} title="Namen ändern">
      <span class="dot" style="background: {collab.me.color}"></span>{collab.me.name || "Name festlegen"}
    </button>
  </header>

  {#if !collab.role}
    <p class="desc">Teile dein geöffnetes Projekt oder tritt einer Session bei. Verbindung direkt oder verschlüsselt über ein öffentliches Relay – funktioniert auch im Uni-WLAN.</p>
    <button class="btn primary wide" onclick={startHosting} disabled={busy}>Session starten</button>
    <div class="or"><span>oder</span></div>
    <div class="joinrow">
      <input bind:this={codeInput} placeholder="Einladungscode einfügen" bind:value={code} spellcheck="false" onkeydown={(e) => e.key === "Enter" && code.trim() && join(code)} />
      <button class="btn" onclick={() => join(code)} disabled={!code.trim() || busy}>Beitreten</button>
    </div>
    {#if collab.error}<p class="err">{collab.error}</p>{/if}
  {:else if collab.status === "starting"}
    <p class="desc"><span class="spin"></span> Session wird gestartet …</p>
  {:else if collab.status === "joining" || collab.status === "waiting"}
    <p class="desc"><span class="spin"></span> {collab.status === "joining" ? "Verbinde mit dem Host …" : "Warte auf Bestätigung durch den Host …"}</p>
    <button class="btn wide" onclick={leave}>Abbrechen</button>
  {:else}
    {#if collab.role === "host"}
      <label class="lbl" for="ticket">Einladungscode</label>
      <div class="ticket">
        <input id="ticket" readonly value={collab.ticket} onfocus={(e) => (e.currentTarget as HTMLInputElement).select()} />
        <button class="btn" onclick={copy}>{copied ? "Kopiert" : "Kopieren"}</button>
      </div>
      <p class="hint">Schick den Code per Chat. Wer ihn nutzt, muss von dir bestätigt werden.</p>

      {#each collab.requests as r (r.peer)}
        <div class="request">
          <span><b>{r.name}</b> möchte beitreten</span>
          <button class="btn small" onclick={() => deny(r)}>Ablehnen</button>
          <button class="btn small primary" onclick={() => approve(r)}>Zulassen</button>
        </div>
      {/each}
    {/if}

    <label class="lbl" for="plist">Teilnehmer</label>
    <div class="people" id="plist">
      {#each collab.participants as p (p.peer)}
        {@const isMe = collab.role === "host" ? p.peer === "self" : p.name === collab.me.name && p.color === collab.me.color}
        {@const where = share.presence[presenceKey(p)]}
        {@const following = share.following === presenceKey(p)}
        <div class="person" class:following>
          <span class="avatar" style="background: {p.color}">{p.name.slice(0, 1).toUpperCase()}</span>
          <span class="pinfo">
            <span class="pname">{p.name}{isMe ? " (du)" : ""}</span>
            {#if !isMe && where?.file}<span class="pfile">{where.file}:{where.line}</span>{/if}
          </span>
          {#if p.role === "host"}<span class="tag">Host</span>{/if}
          <span class="spacer"></span>
          {#if p.rtt !== undefined}
            <span class="conn" class:relay={!p.direct} title={p.direct ? "Direkte Verbindung" : "Über öffentliches Relay (verschlüsselt)"}>{p.direct ? "direkt" : "Relay"} · {p.rtt} ms</span>
          {/if}
          {#if !isMe}
            <button class="followbtn" class:on={following} onclick={() => follow(presenceKey(p))} title={following ? "Folgen beenden" : `${p.name} folgen – du siehst immer, wo er gerade arbeitet`}>{following ? "Folgt" : "Folgen"}</button>
          {/if}
          {#if collab.role === "host" && p.peer !== "self"}
            <button class="x" onclick={() => kick(p.peer)} title="Entfernen" aria-label="Entfernen">×</button>
          {/if}
        </div>
      {/each}
    </div>

    <button class="btn wide danger" onclick={leave}>{collab.role === "host" ? "Session beenden" : "Session verlassen"}</button>
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
    animation: drop 0.25s cubic-bezier(0.22, 1.2, 0.36, 1);
    transform-origin: top right;
  }
  header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
  h2 { margin: 0; font-size: 17px; font-weight: 700; }
  .me { display: flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border-radius: 999px; font-size: 12px; color: var(--label-2); background: rgba(255, 255, 255, 0.06); }
  .me:hover { color: var(--label); background: rgba(255, 255, 255, 0.12); }
  .dot { width: 8px; height: 8px; border-radius: 50%; }
  .desc { margin: 0 0 14px; font-size: 12.5px; line-height: 1.5; color: var(--label-2); display: flex; align-items: center; gap: 8px; }
  .wide { width: 100%; }
  .or { display: flex; align-items: center; gap: 10px; margin: 14px 0; color: var(--label-3); font-size: 11px; }
  .or::before, .or::after { content: ""; flex: 1; height: 1px; background: rgba(255, 255, 255, 0.08); }
  .joinrow, .ticket { display: flex; gap: 8px; }
  .joinrow input, .ticket input { flex: 1; min-width: 0; font-family: var(--mono); font-size: 12px; }
  .lbl { display: block; margin: 14px 4px 6px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--label-2); }
  .hint { margin: 6px 4px 0; font-size: 11.5px; color: var(--label-3); }
  .err { margin: 10px 4px 0; font-size: 12px; color: var(--red); }
  .request { display: flex; align-items: center; gap: 6px; margin-top: 10px; padding: 10px 12px; border-radius: 14px; background: rgba(107, 155, 224, 0.12); box-shadow: inset 0 0 0 1px rgba(107, 155, 224, 0.25); font-size: 12.5px; }
  .request span { flex: 1; }
  .btn.small { padding: 5px 11px; font-size: 12px; }
  .people { display: flex; flex-direction: column; gap: 2px; margin-bottom: 14px; padding: 4px; border-radius: 16px; background: rgba(255, 255, 255, 0.035); }
  .person { display: flex; align-items: center; gap: 9px; min-height: 40px; padding: 0 8px; border-radius: 11px; font-size: 13px; }
  .person:hover { background: rgba(255, 255, 255, 0.05); }
  .person.following { background: rgba(255, 255, 255, 0.07); }
  .pinfo { display: flex; flex-direction: column; min-width: 0; line-height: 1.2; }
  .pfile { font-size: 10.5px; color: var(--label-3); font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 150px; }
  .followbtn { height: 22px; padding: 0 9px; border-radius: 999px; font-size: 11px; color: var(--label-2); background: rgba(255, 255, 255, 0.06); }
  .followbtn:hover { background: rgba(255, 255, 255, 0.12); color: var(--label); }
  .followbtn.on { background: var(--accent); color: #fff; }
  .avatar { width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; font-weight: 700; color: #111; }
  .tag { font-size: 10px; padding: 1px 7px; border-radius: 999px; background: rgba(255, 255, 255, 0.1); color: var(--label-2); }
  .spacer { flex: 1; }
  .conn { font-size: 11px; color: var(--green); font-variant-numeric: tabular-nums; }
  .conn.relay { color: var(--orange); }
  .x { width: 20px; height: 20px; border-radius: 50%; color: var(--label-3); }
  .x:hover { background: var(--fill-2); color: var(--label); }
  .danger { color: var(--red); }
  .spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--label-3); border-top-color: var(--label); animation: spin 0.8s linear infinite; flex-shrink: 0; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes drop { from { opacity: 0; transform: translateY(-6px) scale(0.97); } }
</style>
