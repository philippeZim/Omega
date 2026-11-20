<script lang="ts">
  import Glyph from "./Glyph.svelte";
  import VarTree from "./VarTree.svelte";
  import { dbg, setBreakpointLines } from "../lib/debug/store.svelte";
  import {
    startDebugging, stopDebugging, restartDebugging, continueRun, stepOver, stepInto, stepOut, pause,
    selectFrame, selectThread, addWatch, removeWatch, toggleWatch,
    stopReasonLabel,
  } from "../lib/debug/debugger.svelte";
  import { t } from "../lib/i18n/index.svelte";
  import { openFile } from "../lib/state.svelte";
  import * as ed from "../lib/editor";

  let newWatch = $state("");
  let open = $state<Record<string, boolean>>(JSON.parse(localStorage.getItem("debugSections") || '{"vars":true,"watch":true,"stack":true,"bps":false}'));

  const stopped = $derived(dbg.status === "stopped");
  const running = $derived(dbg.status === "running" || dbg.status === "starting");
  const live = $derived(stopped || running);
  const bpList = $derived(Object.entries(dbg.breakpoints).flatMap(([p, list]) => list.map((b) => ({ path: p, ...b }))));

  function toggleSection(k: string) {
    open[k] = !open[k];
    localStorage.setItem("debugSections", JSON.stringify(open));
  }

  async function gotoBp(p: string, line: number) {
    await openFile(p);
    const v = ed.getView();
    if (v && line <= v.state.doc.lines) {
      v.dispatch({ selection: { anchor: v.state.doc.line(line).from }, scrollIntoView: true });
      v.focus();
    }
  }

  function removeBp(p: string, line: number) {
    setBreakpointLines(p, (dbg.breakpoints[p] ?? []).filter((b) => b.line !== line));
  }

</script>

<div class="debug-panel">

  <div class="toolbar">
    {#if !live}
      <div class="gcap">
        <button class="gbtn debug" title="{t('code.debug')} (⇧F9)" onclick={startDebugging}>
          <svg class="ico" width="14" height="14" viewBox="0 0 16 16"><path d="M8 3.2c-1.6 0-2.8 1.3-2.8 2.9v.4h5.6v-.4C10.8 4.5 9.6 3.2 8 3.2zM4.6 7.5v2.8a3.4 3.4 0 0 0 6.8 0V7.5z" fill="currentColor"/><path d="M2.5 8.5h2M11.5 8.5h2M3 5l1.8 1.3M13 5l-1.8 1.3M3 12.5l1.8-1M13 12.5l-1.8-1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
          {t("code.debug")}
        </button>
      </div>
    {:else}
      <div class="gcap">
        {#if stopped}
          <button class="gbtn icon run" title="{t('code.dbg.continue')} (F9)" onclick={continueRun} aria-label={t("code.dbg.continue")}>
            <svg class="ico" width="14" height="14" viewBox="0 0 14 14"><rect x="1.5" y="2" width="2.2" height="10" rx="1" fill="currentColor"/><path d="M5.8 2.6v8.8a.6.6 0 0 0 .9.5l6-4.4a.6.6 0 0 0 0-1l-6-4.4a.6.6 0 0 0-.9.5z" fill="currentColor"/></svg>
          </button>
        {:else}
          <button class="gbtn icon debug live" title={t("code.dbg.pause")} onclick={pause} aria-label={t("code.dbg.pause")}>
            <svg class="ico" width="13" height="13" viewBox="0 0 14 14"><rect x="3" y="2" width="2.6" height="10" rx="1" fill="currentColor"/><rect x="8.4" y="2" width="2.6" height="10" rx="1" fill="currentColor"/></svg>
          </button>
        {/if}
        <span class="gsep"></span>
        <button class="gbtn icon step" title="{t('code.dbg.stepOver')} (F8)" disabled={!stopped} onclick={stepOver} aria-label={t("code.dbg.stepOver")}>
          <svg class="ico" width="16" height="14" viewBox="0 0 16 14"><path d="M2 8a6 6 0 0 1 11.2-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M13.8 1.6v3.8H10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="8" cy="11.5" r="1.7" fill="currentColor"/></svg>
        </button>
        <button class="gbtn icon step" title="{t('code.dbg.stepInto')} (F7)" disabled={!stopped} onclick={stepInto} aria-label={t("code.dbg.stepInto")}>
          <svg class="ico" width="14" height="14" viewBox="0 0 14 14"><path d="M7 1v7M4 5.2 7 8.2l3-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="7" cy="11.7" r="1.7" fill="currentColor"/></svg>
        </button>
        <button class="gbtn icon step" title="{t('code.dbg.stepOut')} (⇧F8)" disabled={!stopped} onclick={stepOut} aria-label={t("code.dbg.stepOut")}>
          <svg class="ico" width="14" height="14" viewBox="0 0 14 14"><path d="M7 8.5v-7M4 4.5 7 1.5l3 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="7" cy="11.7" r="1.7" fill="currentColor"/></svg>
        </button>
        <span class="gsep"></span>
        <button class="gbtn icon neutral" title={t("code.dbg.restart")} onclick={restartDebugging} aria-label={t("code.dbg.restart")}>
          <svg class="ico" width="14" height="14" viewBox="0 0 14 14"><path d="M11.6 7.6A4.7 4.7 0 1 1 10 3.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M10.6 1v3.2H7.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="gbtn icon stop" title={t("code.dbg.stopTitle")} onclick={stopDebugging} aria-label={t("code.dbg.stop")}>
          <svg class="ico" width="11" height="11" viewBox="0 0 12 12"><rect width="12" height="12" rx="2.8" fill="currentColor"/></svg>
        </button>
      </div>
    {/if}
  </div>

  <div class="status {dbg.status}">
    <span class="dot"></span>
    <span class="st">{t(`code.dbg.status.${dbg.status}`)}{stopped && dbg.stopReason ? ` · ${stopReasonLabel(dbg.stopReason)}` : ""}</span>
    {#if dbg.label && dbg.status !== "idle"}<span class="label">{dbg.label}</span>{/if}
  </div>

  <div class="scroll">
    <!-- Variables -->
    <button class="sec" onclick={() => toggleSection("vars")}><span class="chev" class:open={open.vars}><Glyph name="chevron" size={8} /></span>{t("code.dbg.variables")}</button>
    {#if open.vars}
      <div class="box">
        {#if stopped && dbg.scopes.length}
          <VarTree nodes={dbg.scopes} />
        {:else}
          <p class="hint">{live ? t("code.dbg.varsRunning") : t("code.dbg.varsIdle")}</p>
        {/if}
      </div>
    {/if}

    <!-- Watches -->
    <button class="sec" onclick={() => toggleSection("watch")}><span class="chev" class:open={open.watch}><Glyph name="chevron" size={8} /></span>{t("code.dbg.watches")}</button>
    {#if open.watch}
      <div class="box">
        {#each dbg.watches as w, i (w.expr + i)}
          <div class="watch" role="treeitem" tabindex="-1" aria-selected="false" onclick={() => toggleWatch(i)} onkeydown={() => {}}>
            {#if w.ref}<span class="chev small" class:open={w.expanded}><Glyph name="chevron" size={8} /></span>{:else}<span class="sp"></span>{/if}
            <span class="expr">{w.expr}</span>
            <span class="eq">=</span>
            <span class="wval" class:err={w.error}>{w.value || (stopped ? "…" : "–")}</span>
            <button class="rm" onclick={(e) => { e.stopPropagation(); removeWatch(i); }} aria-label={t("code.dbg.remove")}><Glyph name="x" size={8} /></button>
          </div>
          {#if w.expanded && w.children}<VarTree nodes={w.children} depth={1} />{/if}
        {/each}
        <form class="add" onsubmit={(e) => { e.preventDefault(); addWatch(newWatch); newWatch = ""; }}>
          <input placeholder={t("code.dbg.watchPlaceholder")} bind:value={newWatch} spellcheck="false" />
        </form>
      </div>
    {/if}

    <!-- Call stack -->
    <button class="sec" onclick={() => toggleSection("stack")}><span class="chev" class:open={open.stack}><Glyph name="chevron" size={8} /></span>{t("code.dbg.callStack")}</button>
    {#if open.stack}
      <div class="box">
        {#if dbg.threads.length > 1}
          <div class="threads">
            {#each dbg.threads as th (th.id)}
              <button class="thread" class:on={th.id === dbg.threadId} onclick={() => selectThread(th.id)}>{th.name}</button>
            {/each}
          </div>
        {/if}
        {#each dbg.frames as f (f.id)}
          <button class="frame" class:on={f.id === dbg.frameId} class:subtle={f.subtle} onclick={() => selectFrame(f)}>
            <span class="fname">{f.name}</span>
            {#if f.path}<span class="floc">{f.path.split("/").pop()}:{f.line}</span>{/if}
          </button>
        {:else}
          <p class="hint">—</p>
        {/each}
      </div>
    {/if}

    <!-- Breakpoints -->
    <button class="sec" onclick={() => toggleSection("bps")}><span class="chev" class:open={open.bps}><Glyph name="chevron" size={8} /></span>{t("code.dbg.breakpoints")} <span class="count">{bpList.length}</span></button>
    {#if open.bps}
      <div class="box">
        {#each bpList as b (b.path + b.line)}
          <div class="bp" role="button" tabindex="-1" onclick={() => gotoBp(b.path, b.line)} onkeydown={() => {}}>
            <span class="bdot" class:cond={b.condition} class:unverified={b.verified === false}></span>
            <span class="bfile">{b.path.split("/").pop()}:{b.line}</span>
            {#if b.condition}<span class="bcond">{b.condition}</span>{/if}
            <button class="rm" onclick={(e) => { e.stopPropagation(); removeBp(b.path, b.line); }} aria-label={t("code.dbg.remove")}><Glyph name="x" size={8} /></button>
          </div>
        {:else}
          <p class="hint">{t("code.dbg.noBreakpoints")}</p>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .debug-panel { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
  .toolbar { height: 54px; flex-shrink: 0; display: flex; align-items: center; gap: 6px; padding: 0 10px; border-bottom: 1px solid rgba(var(--fg-rgb), 0.05); }
  .status { display: flex; align-items: center; gap: 8px; padding: 10px 16px 6px; font-size: 12px; }
  .status .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--label-3); flex-shrink: 0; }
  .status.running .dot, .status.starting .dot { background: var(--green); animation: pulse 1.4s infinite; }
  .status.stopped .dot { background: var(--yellow); }
  .status.terminated .dot { background: var(--red); }
  @keyframes pulse { 50% { opacity: 0.35; } }
  .st { font-weight: 600; }
  .label { color: var(--label-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .scroll { flex: 1; overflow: auto; padding: 0 10px 20px; }
  .sec { width: 100%; display: flex; align-items: center; gap: 6px; margin-top: 12px; padding: 4px 6px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--label-2); }
  .chev { display: inline-grid; place-items: center; width: 10px; height: 10px;  }
  .chev.open { transform: rotate(90deg); }
  .chev.small { color: var(--label-3); }
  .count { margin-left: auto; color: var(--label-3); }
  .box { background: rgba(var(--fg-rgb), 0.035); box-shadow: inset 0 1px 0 rgba(var(--hl-rgb), 0.03); border-radius: 14px; padding: 6px; margin-top: 4px; }
  .hint { margin: 6px 8px; font-size: 12px; color: var(--label-3); line-height: 1.45; }
  .watch, .bp { display: flex; align-items: center; gap: 6px; min-height: 26px; padding: 0 4px 0 6px; border-radius: 8px; font-family: var(--mono); font-size: 12px; }
  .watch:hover, .bp:hover { background: var(--fill-hover); }
  .sp { width: 10px; }
  .expr { color: var(--teal); white-space: nowrap; }
  .eq { color: var(--label-3); }
  .wval { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wval.err { color: var(--red); font-family: var(--font); font-size: 11.5px; }
  .rm { width: 20px; height: 20px; display: grid; place-items: center; border-radius: 50%; color: var(--label-3); opacity: 0; font-family: var(--font); }
  .watch:hover .rm, .bp:hover .rm { opacity: 1; }
  .rm:hover { background: var(--fill-2); color: var(--label); }
  .add { padding: 4px 2px 2px; }
  .add input { width: 100%; font-family: var(--mono); font-size: 12px; padding: 5px 12px; }
  .threads { display: flex; flex-wrap: wrap; gap: 4px; padding: 2px 2px 6px; }
  .thread { padding: 3px 10px; border-radius: 999px; font-size: 11px; background: var(--fill); }
  .thread.on { background: var(--accent); }
  .frame { width: 100%; display: flex; justify-content: space-between; gap: 10px; padding: 5px 8px; border-radius: 8px; text-align: left; font-size: 12px; }
  .frame:hover { background: var(--fill-hover); }
  .frame.on { background: rgba(216, 194, 122, 0.16); }
  .frame.subtle { color: var(--label-3); }
  .fname { font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .floc { color: var(--label-3); white-space: nowrap; font-size: 11px; }
  .bdot { width: 9px; height: 9px; border-radius: 50%; background: var(--red); flex-shrink: 0; }
  .bdot.cond { background: var(--orange); }
  .bdot.unverified { background: transparent; border: 1.6px solid var(--red); }
  .bfile { white-space: nowrap; }
  .bcond { flex: 1; color: var(--orange); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bp .rm { margin-left: auto; }
</style>
