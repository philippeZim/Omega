<script lang="ts">
  import { tick } from "svelte";
  import { dbg } from "../lib/debug/store.svelte";
  import { replEval } from "../lib/debug/debugger.svelte";

  let input = $state("");
  let list: HTMLDivElement | undefined = $state();
  const history: string[] = [];
  let hIdx = -1;

  $effect(() => {
    void dbg.console.length;
    tick().then(() => list && (list.scrollTop = list.scrollHeight));
  });

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter" && input.trim()) {
      history.unshift(input);
      hIdx = -1;
      replEval(input);
      input = "";
    } else if (e.key === "ArrowUp" && history.length) {
      hIdx = Math.min(history.length - 1, hIdx + 1);
      input = history[hIdx];
      e.preventDefault();
    } else if (e.key === "ArrowDown") {
      hIdx = Math.max(-1, hIdx - 1);
      input = hIdx < 0 ? "" : history[hIdx];
      e.preventDefault();
    }
  }
</script>

<div class="console">
  <div class="lines" bind:this={list}>
    {#each dbg.console as l, i (i)}
      <div class="line {l.kind}">{l.text}</div>
    {:else}
      <div class="line info">Debug-Ausgaben und Ergebnisse erscheinen hier. Während das Programm angehalten ist, kannst du unten Ausdrücke auswerten.</div>
    {/each}
  </div>
  <div class="prompt" class:disabled={dbg.status !== "stopped"}>
    <span>›</span>
    <input bind:value={input} onkeydown={onKey} spellcheck="false" placeholder={dbg.status === "stopped" ? "Ausdruck auswerten (Enter)" : "Nur verfügbar, wenn das Programm angehalten ist"} disabled={dbg.status !== "stopped"} />
  </div>
</div>

<style>
  .console { position: absolute; inset: 0; display: flex; flex-direction: column; user-select: text; }
  .lines { flex: 1; overflow: auto; padding: 8px 14px; font-family: var(--mono); font-size: 12.5px; line-height: 1.5; }
  .line { white-space: pre-wrap; word-break: break-word; }
  .line.err, .line.error { color: #e09a92; }
  .line.info { color: var(--label-3); }
  .line.build { color: var(--teal); }
  .line.input { color: var(--accent); }
  .line.result { color: var(--label); padding-left: 12px; }
  .prompt { display: flex; align-items: center; gap: 8px; padding: 6px 12px 10px; border-top: 1px solid rgba(255, 255, 255, 0.05); }
  .prompt span { color: var(--accent); font-family: var(--mono); }
  .prompt input { flex: 1; font-family: var(--mono); font-size: 12.5px; background: transparent; box-shadow: none; padding: 4px 0; border-radius: 0; }
  .prompt.disabled { opacity: 0.5; }
</style>
