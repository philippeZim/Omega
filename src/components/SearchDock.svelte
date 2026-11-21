<script lang="ts">
  import Glyph from "./Glyph.svelte";
  import { find, gotoHit, matchSummary, type Hit } from "../lib/search/search.svelte";
  import { app } from "../lib/state.svelte";
  import { basename } from "../lib/api";
  import { t } from "../lib/i18n/index.svelte";

  let collapsed = $state<Record<string, boolean>>({});
  const groups = $derived.by(() => {
    const m = new Map<string, Hit[]>();
    for (const h of find.docked?.hits ?? []) {
      if (!m.has(h.file)) m.set(h.file, []);
      m.get(h.file)!.push(h);
    }
    return [...m];
  });
  const rel = (f: string) => (f.startsWith("collab:") ? f.slice(7) : app.root && f.startsWith(app.root + "/") ? f.slice(app.root.length + 1) : f);

  function segs(h: Hit) {
    const lead = h.text.length - h.text.trimStart().length;
    const t = h.text.slice(lead);
    const out: { t: string; m: boolean }[] = [];
    let pos = 0;
    for (const [a0, b0] of h.ranges) {
      const a = Math.max(0, a0 - lead), b = Math.max(0, b0 - lead);
      if (a > pos) out.push({ t: t.slice(pos, a), m: false });
      out.push({ t: t.slice(a, b), m: true });
      pos = b;
    }
    out.push({ t: t.slice(pos), m: false });
    return out;
  }
</script>

<div class="dock">
  {#if find.docked}
    <div class="head">
      {t("git.search.qOpen")}<b>{find.docked.query}</b>{t("git.search.qClose")} — {matchSummary(find.docked.total, find.docked.files)}
    </div>
    <div class="list">
      {#each groups as [file, hits] (file)}
        <button class="file" onclick={() => (collapsed[file] = !collapsed[file])}>
          <span class="chev" class:open={!collapsed[file]}><Glyph name="chevron" size={8} /></span>
          <span class="fname">{basename(rel(file))}</span>
          <span class="fpath">{rel(file)}</span>
          <span class="n">{hits.length}</span>
        </button>
        {#if !collapsed[file]}
          {#each hits as h, i (i)}
            <button class="hit" onclick={() => gotoHit(h, true)}>
              <span class="ln">{h.line}</span>
              <span class="text">{#each segs(h) as s, k (k)}<span class:m={s.m}>{s.t}</span>{/each}</span>
            </button>
          {/each}
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .dock { position: absolute; inset: 0; display: flex; flex-direction: column; }
  .head { padding: 8px 16px; font-size: 12px; color: var(--label-2); border-bottom: 1px solid rgba(var(--fg-rgb), 0.05); }
  .head b { color: var(--label); font-family: var(--mono); font-weight: 500; }
  .list { flex: 1; overflow: auto; padding: 4px 8px 10px; }
  .file { width: 100%; display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 8px; text-align: left; font-size: 12.5px; }
  .file:hover, .hit:hover { background: rgba(var(--fg-rgb), 0.06); }
  .chev { display: inline-grid; place-items: center; width: 10px; height: 10px; flex-shrink: 0; color: var(--label-3);  }
  .chev.open { transform: rotate(90deg); }
  .fname { font-weight: 600; }
  .fpath { color: var(--label-3); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .n { margin-left: auto; color: var(--label-3); font-size: 11px; }
  .hit { width: 100%; display: flex; gap: 12px; padding: 3px 8px 3px 30px; border-radius: 8px; text-align: left; font-family: var(--mono); font-size: 12px; }
  .ln { width: 36px; text-align: right; color: var(--label-3); flex-shrink: 0; }
  .text { color: var(--label-2); white-space: pre; overflow: hidden; text-overflow: ellipsis; }
  .m { color: var(--label); background: rgba(216, 194, 122, 0.28); border-radius: 3px; }
</style>
