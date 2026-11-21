<script lang="ts">
  import Glyph from "./Glyph.svelte";
  import { settings, applySyntaxTheme, setSize, setAppearance, setMaterial, PROSE_WIDTH_FULL, type Appearance, type Material } from "../lib/settings.svelte";
  import { t, i18n, setLocale, LOCALES, type Key } from "../lib/i18n/index.svelte";

  // `label`/`sub` are i18n keys, translated at render time.
  const SIZES = [
    { key: "codeFontSize", label: "app.settings.codeFont", sub: "app.settings.codeFontSub", min: 10, max: 24, step: 1, unit: "px" },
    { key: "proseFontSize", label: "app.settings.proseFont", sub: "app.settings.proseFontSub", min: 12, max: 28, step: 1, unit: "px" },
    { key: "proseWidth", label: "app.settings.proseWidth", sub: "app.settings.proseWidthSub", min: 600, max: PROSE_WIDTH_FULL, step: 20, unit: "px" },
    { key: "terminalFontSize", label: "app.settings.terminalFont", sub: "app.settings.terminalFontSub", min: 9, max: 22, step: 1, unit: "px" },
    { key: "uiScale", label: "app.settings.uiScale", sub: "app.settings.uiScaleSub", min: 0.75, max: 1.5, step: 0.05, unit: "%" },
  ] as const;
  import { SYNTAX_THEMES, themeVars } from "../lib/syntaxThemes";
  import * as ed from "../lib/editor";
  import KeybindingEditor from "./KeybindingEditor.svelte";
  import { app, activeTab, toggleSpell, setSpellLang, spellLangFor } from "../lib/state.svelte";
  import { SPELL_LANGS } from "../lib/spell";
  import { control, setControlEnabled, regenerateToken, mcpAddCommand, setControlPort } from "../lib/ai/control.svelte";
  import { ideLink, AGENTS, startAgent, isConnected, detectAgents, type Agent } from "../lib/ai/ide.svelte";
  import { runCommand, listShells, shellPref, setDefaultShell } from "../lib/terminal.svelte";
  import { lspSettings, setStrictPython } from "../lib/code/lsp.svelte";
  import { power, setKeepAwake } from "../lib/power.svelte";
  import { installs, catalog, refreshInstalls, checkUpdates, updateAvailable, wasChecked, canInstall, manualHint, install, update, remove, type Group } from "../lib/installs.svelte";

  const INSTALL_GROUPS: Group[] = ["tool", "lsp", "debug"];
  const installItems = $derived(catalog());
  $effect(() => {
    if (tab === "installs") {
      refreshInstalls();
      refreshCliCommand();
    }
  });
  const updateCount = $derived(installItems.filter((i) => updateAvailable(i.id)).length);
  import { blameSettings, setGitBlame } from "../lib/git/blame.svelte";

  const AGENT_INFO: Record<Agent["id"], Key> = {
    claude: "app.settings.agent.claude",
    codex: "app.settings.agent.codex",
    opencode: "app.settings.agent.opencode",
  };
  let mcpAgent = $state<Agent["id"]>("claude");
  $effect(() => {
    if (tab === "ai") detectAgents();
  });
  import { formatKey } from "../lib/keys";
  import { cliCommand, installCliCommand, refreshCliCommand } from "../lib/cliCommand.svelte";
  import { keysFor } from "../lib/commands.svelte";
  import { writeText } from "@tauri-apps/plugin-clipboard-manager";
  import { ui } from "../lib/ui.svelte";

  let showToken = $state(false);
  async function copy(text: string, msg: string) {
    await writeText(text);
    ui.toast(msg);
  }

  const TABS = [
    { id: "look", label: "app.settings.tab.look" },
    { id: "theme", label: "app.settings.tab.theme" },
    { id: "code", label: "app.settings.tab.code" },
    { id: "installs", label: "app.settings.tab.installs" },
    { id: "spell", label: "app.settings.tab.spell" },
    { id: "keys", label: "app.settings.tab.keys" },
    { id: "ai", label: "app.settings.tab.ai" },
  ] as const;
  let tab = $state<(typeof TABS)[number]["id"]>((localStorage.getItem("settingsTab") as any) || "look");
  $effect(() => localStorage.setItem("settingsTab", tab));
  const spellLang = $derived(spellLangFor(activeTab()?.path ?? null));

  const groups = ["classic", "modern", "retro"] as const;
  const APPEARANCES: { id: Appearance; label: Key }[] = [
    { id: "dark", label: "app.settings.appearance.dark" },
    { id: "light", label: "app.settings.appearance.light" },
  ];
  const MATERIALS: { id: Material; label: Key }[] = [
    { id: "solid", label: "app.settings.material.solid" },
    { id: "liquid", label: "app.settings.material.liquid" },
  ];
  const visibleThemes = $derived(SYNTAX_THEMES.filter((th) => !!th.light === (settings.appearance === "light")));

  function close() {
    settings.open = false;
    queueMicrotask(() => ed.focus());
  }
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && settings.open && !e.defaultPrevented && (e.preventDefault(), close())} />

<div class="overlay" role="dialog" aria-label={t("app.settings")}>
  <div class="sheet">
    <header>
      <h1>{t("app.settings")}</h1>
      <button class="close" onclick={close} aria-label={t("common.close")} title="{t('common.close')} (Esc)">
        <svg width="12" height="12" viewBox="0 0 10 10"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>
    </header>
    <nav class="tabs">
      {#each TABS as tb (tb.id)}
        <button class="tab" class:on={tab === tb.id} onclick={() => (tab = tb.id)}>{t(tb.label)}</button>
      {/each}
    </nav>

    <div class="scroll">
      {#if tab === "look"}
      <section>
        <h2>{t("app.settings.tab.look")}</h2>
        <p class="desc">{t("app.settings.lookDesc")}</p>
        <div class="box">
          <div class="srow">
            <div><b>{t("app.settings.language")}</b><span class="sub2">{t("app.settings.languageSub")}</span></div>
            <div class="seg">
              {#each LOCALES as l (l.id)}
                <button class:on={i18n.locale === l.id} onclick={() => setLocale(l.id)} lang={l.id}>{l.label}</button>
              {/each}
            </div>
          </div>
          {#each SIZES as sz (sz.key)}
            {@const v = settings[sz.key]}
            <div class="srow">
              <div><b>{t(sz.label)}</b><span class="sub2">{t(sz.sub)}</span></div>
              <div class="stepper">
                <button onclick={() => setSize(sz.key, Math.max(sz.min, +(v - sz.step).toFixed(2)))} aria-label={t("app.settings.smaller")}><Glyph name="minus" size={10} /></button>
                <input type="range" aria-label={t(sz.label)} min={sz.min} max={sz.max} step={sz.step} value={v} oninput={(e) => setSize(sz.key, Number((e.currentTarget as HTMLInputElement).value))} />
                <button onclick={() => setSize(sz.key, Math.min(sz.max, +(v + sz.step).toFixed(2)))} aria-label={t("app.settings.larger")}><Glyph name="plus" size={10} /></button>
                <span class="val">{sz.unit === "%" ? Math.round(v * 100) + " %" : sz.key === "proseWidth" && v >= PROSE_WIDTH_FULL ? t("app.settings.proseWidthFull") : v + " px"}</span>
              </div>
            </div>
          {/each}
        </div>
      </section>
      {:else if tab === "code"}
      <section>
        <h2>{t("app.settings.tab.code")}</h2>
        <div class="box">
          <div class="srow">
            <div><b>{t("app.settings.strictPython")}</b><span class="sub2">{t("app.settings.strictPythonSub")}</span></div>
            <button class="switch" class:on={lspSettings.strictPython} onclick={() => setStrictPython(!lspSettings.strictPython)} role="switch" aria-checked={lspSettings.strictPython} aria-label={t("app.settings.strictPython")}><span></span></button>
          </div>
          <div class="srow">
            <div><b>{t("app.settings.gitBlame")}</b><span class="sub2">{t("app.settings.gitBlameSub")}</span></div>
            <button class="switch" class:on={blameSettings.enabled} onclick={() => setGitBlame(!blameSettings.enabled)} role="switch" aria-checked={blameSettings.enabled} aria-label={t("app.settings.gitBlame")}><span></span></button>
          </div>
          <div class="srow">
            <div><b>{t("app.settings.defaultShell")}</b><span class="sub2">{t("app.settings.defaultShellSub")}</span></div>
            {#await listShells() then shells}
              <select class="shell-select" value={shellPref.id} onchange={(e) => setDefaultShell((e.currentTarget as HTMLSelectElement).value)}>
                <option value="">{t("app.settings.systemDefault")}{shells[0] ? ` (${shells[0].label})` : ""}</option>
                {#each shells.slice(1) as sh (sh.id)}<option value={sh.id}>{sh.label}</option>{/each}
              </select>
            {/await}
          </div>
        </div>
      </section>
      {:else if tab === "installs"}
      <section>
        <h2>{t("app.settings.tab.installs")}</h2>
        <p class="desc">{t("installs.desc")}</p>
        <div class="ibar">
          <button class="btn" disabled={installs.checking || installs.loading} onclick={checkUpdates}>{installs.checking ? t("installs.checking") : t("installs.check")}</button>
          <button class="btn ghost" disabled={installs.loading} onclick={refreshInstalls}>{t("installs.refresh")}</button>
          {#if installs.checkedAt && !installs.checking}<span class="note inline">{updateCount ? t("installs.updatesFound", { n: updateCount }) : t("installs.noUpdates")}</span>{/if}
        </div>
        {#if cliCommand.status?.available}
          {@const cli = cliCommand.status}
          <h3>{t("app.cli.title")}</h3>
          <div class="box">
            <div class="srow">
              <div class="grow">
                <b>omega</b>
                <span class="sub2 ipath" title={cli.path}>{cli.state === "foreign" ? t("app.cli.foreign", { path: cli.path }) : cli.state === "missing" ? t("app.cli.sub") : cli.path}</span>
                {#if cli.state !== "foreign" && !cli.onPath}<span class="sub2">{t("app.cli.notOnPath", { dir: cli.dir })}</span>{/if}
              </div>
              <div class="rowend">
                {#if cli.state === "installed"}<span class="pill ok">{t("app.cli.ready")}</span>{:else}
                  <button class="btn" disabled={cliCommand.busy} onclick={installCliCommand}>{cli.state === "stale" ? t("app.cli.update") : t("app.cli.install")}</button>
                {/if}
              </div>
            </div>
          </div>
        {:else if cliCommand.error}
          <h3>{t("app.cli.title")}</h3>
          <div class="box">
            <div class="srow"><div class="grow"><b>omega</b><span class="sub2">{cliCommand.error}</span></div></div>
          </div>
        {/if}
        {#each INSTALL_GROUPS as g (g)}
          <h3>{t(`installs.group.${g}`)}</h3>
          <div class="box">
            {#each installItems.filter((i) => i.group === g) as it (it.id)}
              {@const st = installs.status[it.id]}
              {@const busy = installs.busy[it.id]}
              {@const upd = updateAvailable(it.id)}
              <div class="srow">
                <div class="grow">
                  <b>{it.label}</b>
                  <span class="sub2 ipath" title={st?.path ?? ""}>{#if st?.path}{st.owner ? `${st.owner.manager}: ${st.owner.package} · ` : ""}{st.path}{:else if st && !canInstall(it.id) && manualHint(it.id)}{t("installs.manual")}: {manualHint(it.id)}{:else}&nbsp;{/if}</span>
                </div>
                <div class="rowend">
                  {#if st}
                    <span class="pill" class:ok={st.source === "omega"} class:sys={st.source === "system"}>
                      {st.source === "omega" ? t("installs.omega") : st.source === "system" ? t("installs.system") : t("installs.missing")}{#if st.source !== "missing"}{` · ${st.version ?? t("installs.unknownVersion")}`}{/if}
                    </span>
                  {:else}
                    <span class="pill">…</span>
                  {/if}
                  {#if busy}
                    <span class="note inline">{t(`installs.busy.${busy}`)}</span>
                  {:else if st?.source === "omega" || st?.source === "system"}
                    {#if it.id === "lsp:rust" && st.source === "omega"}
                      <span class="note inline">{t("installs.withRust")}</span>
                    {:else if upd}
                      <button class="btn" onclick={() => update(it.id)}>{t("installs.update", { v: upd })}</button>
                    {:else if wasChecked(it.id)}
                      <span class="note inline">{t("installs.upToDate")}</span>
                    {/if}
                    {#if st.source === "omega"}<button class="btn ghost" onclick={() => remove(it.id)}>{t("installs.remove")}</button>{/if}
                  {:else if st?.source === "missing" && canInstall(it.id)}
                    <button class="btn" onclick={() => install(it.id)}>{t("installs.install")}</button>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        {/each}
      </section>
      {:else if tab === "spell"}
      <section>
        <h2>{t("app.settings.tab.spell")}</h2>
        <p class="desc">{t("app.settings.spellDesc")}</p>
        <div class="box">
          <div class="srow">
            <div><b>{t("app.settings.spellCheck")}</b><span class="sub2">{t("app.settings.spellToggleSub")}</span></div>
            <button class="switch" class:on={app.spellEnabled} onclick={toggleSpell} role="switch" aria-checked={app.spellEnabled} aria-label={t("app.settings.spellCheck")}><span></span></button>
          </div>
          <div class="srow">
            <div><b>{t("app.settings.spellLang")}</b><span class="sub2">{activeTab()?.path ? t("app.settings.spellLangSubFile", { name: activeTab()?.name ?? "" }) : t("app.settings.spellLangSubDefault")}</span></div>
            <div class="seg">
              {#each SPELL_LANGS as l (l.id)}
                <button class:on={spellLang === l.id} onclick={() => setSpellLang(l.id)}>{l.label}</button>
              {/each}
            </div>
          </div>
        </div>
      </section>
      {:else if tab === "ai"}
      <section>
        <h2>{t("app.settings.aiAgents")}</h2>
        <p class="desc">{t("app.settings.aiDesc")}</p>
        <div class="box">
          {#each AGENTS as a (a.id)}
            {@const inst = ideLink.installed[a.id]}
            {@const conn = isConnected(a)}
            <div class="srow">
              <div><b>{a.label}</b><span class="sub2">{t(AGENT_INFO[a.id])}</span></div>
              <div class="rowend">
                <span class="pill" class:ok={conn}>{conn ? t("app.settings.connected") : inst === false ? t("app.settings.notInstalled") : t("app.settings.ready")}</span>
                <button class="btn" disabled={inst === false} onclick={() => { startAgent(a.id); settings.open = false; }}>{t("app.settings.start")}</button>
              </div>
            </div>
          {/each}
          <div class="srow">
            <div><b>{t("app.settings.sendSelection")}</b><span class="sub2">{t("app.settings.sendSelectionSub")}</span></div>
            <span class="kbd">{keysFor("ai.mention").map(formatKey).join(" / ") || "—"}</span>
          </div>
        </div>
        <div class="box mt-s">
          <div class="srow">
            <div><b>{t("app.settings.keepAwake")}</b><span class="sub2">{t("app.settings.keepAwakeSub")}{#if power.enabled && power.status.active} · {power.status.lid ? t("app.settings.keepAwakeActive", { agent: power.status.agent ?? "" }) : t("app.settings.keepAwakeIdleOnly", { agent: power.status.agent ?? "" })}{/if}{#if power.status.error}<br />{power.status.error}{/if}</span></div>
            <button class="switch" class:on={power.enabled} onclick={() => setKeepAwake(!power.enabled)} role="switch" aria-checked={power.enabled} aria-label={t("app.settings.keepAwake")}><span></span></button>
          </div>
        </div>
        <p class="note">{ideLink.port ? t("app.settings.ideServer", { port: ideLink.port }) : t("app.settings.ideServerOff")} · {t("app.settings.codexContext", { state: ideLink.codex === "listening" ? "~/.codex/ipc/ipc.sock" : ideLink.codex === "busy" ? t("app.settings.codexBusy") : t("app.settings.codexUnavailable") })}</p>

        <h2 class="mt">{t("app.settings.controlMcp")}</h2>
        <p class="desc">{t("app.settings.controlDesc")}</p>
        <div class="box">
          <div class="srow">
            <div><b>{t("app.settings.controlMcp")}</b><span class="sub2">{control.running ? t("app.settings.controlRunning", { port: control.boundPort || control.port }) + (control.calls ? t("app.settings.controlCalls", { n: control.calls, tool: control.lastTool }) : "") : control.error ? control.error : t("app.settings.off")}</span></div>
            <button class="switch" class:on={control.enabled} onclick={() => setControlEnabled(!control.enabled)} role="switch" aria-checked={control.enabled} aria-label={t("app.settings.controlMcp")}><span></span></button>
          </div>
          {#if control.enabled}
            <div class="srow">
              <div class="grow"><b>{t("app.settings.addToAgents")}</b><span class="sub2">{t("app.settings.addToAgentsSub")}{mcpAgent === "codex" ? t("app.settings.codexTokenNote") : ""}</span>
                <div class="seg small">
                  {#each AGENTS as a (a.id)}<button class:on={mcpAgent === a.id} onclick={() => (mcpAgent = a.id)}>{a.label}</button>{/each}
                </div>
                <code class="cmd">{showToken ? mcpAddCommand(mcpAgent) : mcpAddCommand(mcpAgent).replace(control.token, "•".repeat(12))}</code>
              </div>
              <div class="col">
                <button class="btn" disabled={ideLink.installed[mcpAgent] === false} onclick={() => { runCommand(mcpAddCommand(mcpAgent), app.root, t("app.settings.mcpSetup")); settings.open = false; }}>{t("common.run")}</button>
                <button class="btn ghost" onclick={() => copy(mcpAddCommand(mcpAgent), t("app.settings.copiedCommand"))}>{t("app.settings.copy")}</button>
                <button class="btn ghost" onclick={() => (showToken = !showToken)}>{showToken ? t("app.settings.hide") : t("app.settings.showToken")}</button>
              </div>
            </div>
            <div class="srow">
              <div><b>Port</b><span class="sub2">{t("app.settings.portSub")}</span></div>
              <input class="port" type="number" aria-label="Port" min="1024" max="65535" value={control.port} onchange={(e) => setControlPort(Number((e.currentTarget as HTMLInputElement).value))} />
            </div>
            <div class="srow">
              <div><b>{t("app.settings.renewToken")}</b><span class="sub2">{t("app.settings.renewTokenSub")}</span></div>
              <button class="btn ghost" onclick={regenerateToken}>{t("app.settings.renew")}</button>
            </div>
          {/if}
        </div>
      </section>
      {:else if tab === "keys"}
      <section>
        <h2>{t("app.settings.tab.keys")}</h2>
        <p class="desc">{t("app.settings.keysDesc")}</p>
        <KeybindingEditor />
      </section>
      {:else}
      <section>
        <h2>{t("app.settings.tab.theme")}</h2>
        <div class="box">
          <div class="srow">
            <div><b>{t("app.settings.appearance")}</b><span class="sub2">{t("app.settings.appearanceSub")}</span></div>
            <div class="seg">
              {#each APPEARANCES as a (a.id)}
                <button class:on={settings.appearance === a.id} onclick={() => setAppearance(a.id)}>{t(a.label)}</button>
              {/each}
            </div>
          </div>
          <div class="srow">
            <div><b>{t("app.settings.material")}</b><span class="sub2">{t("app.settings.materialSub")}</span></div>
            <div class="seg">
              {#each MATERIALS as m (m.id)}
                <button class:on={settings.material === m.id} onclick={() => setMaterial(m.id)}>{t(m.label)}</button>
              {/each}
            </div>
          </div>
        </div>

        <h2 class="mt">{t("app.settings.syntaxTheme")}</h2>
        <p class="desc">{t("app.settings.themeDesc")}</p>

        {#each groups as g (g)}
          <h3>{t(`app.settings.group.${g}`)}</h3>
          <div class="grid">
            {#each visibleThemes.filter((th) => th.group === g) as th (th.id)}
              <button class="card" class:on={settings.syntaxTheme === th.id} style={themeVars(th)} onclick={() => applySyntaxTheme(th.id)}>
                <pre class="code"><span class="k">def</span> <span class="f">fib</span>(<span class="d">n</span>: <span class="t">int</span>) <span class="o">-&gt;</span> <span class="t">list</span>:
    <span class="c"># {t("app.settings.sampleComment")}</span>
    <span class="d">xs</span> <span class="o">=</span> [<span class="n">0</span>, <span class="n">1</span>]
    <span class="k">for</span> _ <span class="k">in</span> <span class="f">range</span>(<span class="d">n</span>):
        <span class="d">xs</span>.<span class="f">append</span>(<span class="s">"…"</span>)
    <span class="k">return</span> <span class="p">self</span>.<span class="pr">values</span></pre>
                <div class="foot">
                  <span class="name">{th.name}</span>
                  <span class="swatches">
                    {#each th.ansi.slice(1, 7) as c (c)}<i style="background: {c}"></i>{/each}
                  </span>
                </div>
              </button>
            {/each}
          </div>
        {/each}
      </section>
      {/if}
    </div>
  </div>
</div>

<style>
  .overlay { position: fixed; inset: 0; z-index: 80; padding: 14px; background: var(--scrim); backdrop-filter: blur(18px) saturate(140%); }
  .sheet { height: 100%; display: flex; flex-direction: column; border-radius: 28px; background: var(--glass); box-shadow: var(--glass-highlight), 0 30px 90px rgba(0, 0, 0, 0.6); overflow: hidden; }
  header { display: flex; align-items: center; justify-content: space-between; padding: 26px 26px 8px 34px; }
  h1 { margin: 0; font-size: 32px; font-weight: 750; letter-spacing: -0.025em; }
  .close { width: 38px; height: 38px; display: grid; place-items: center; border-radius: 50%; color: var(--label); background: rgba(var(--fg-rgb), 0.08); box-shadow: inset 0 1px 0 rgba(var(--hl-rgb), 0.08); transition: background 0.2s; }
  .close:hover { background: rgba(var(--fg-rgb), 0.14); transform: rotate(90deg); }
  .scroll { flex: 1; overflow: auto; padding: 8px 34px 34px; }
  /* One centred column for title, tabs and content (wide windows would otherwise spread it). */
  header, .tabs, .scroll > section { width: 100%; max-width: 900px; margin-left: auto; margin-right: auto; }
  /* Header and tabs pad their content inside the box like .scroll does around the sections, so their
     column is wider by that padding (34px each side) and the left edges line up at every width (#124). */
  header, .tabs { max-width: calc(900px + 2 * 34px); }
  header { padding-left: 34px; padding-right: 26px; }
  .tabs { padding-left: 30px; }
  .tabs { display: flex; gap: 6px; padding: 6px 30px 10px; overflow-x: auto; flex-shrink: 0; }
  .tabs::-webkit-scrollbar { height: 0; }
  .tab { flex-shrink: 0; white-space: nowrap; }
  .tab { height: 32px; padding: 0 16px; border-radius: 999px; font-size: 13px; font-weight: 600; color: var(--label-2); background: rgba(var(--fg-rgb), 0.05); transition: background 0.2s, color 0.2s; }
  .tab:hover { color: var(--label); background: rgba(var(--fg-rgb), 0.1); }
  .tab:active { transform: scale(0.95); }
  .tab.on { color: var(--label); background: var(--raised-bg); box-shadow: var(--raised-shadow); }
  .box { border-radius: 18px; background: rgba(var(--fg-rgb), 0.035); box-shadow: inset 0 1px 0 rgba(var(--hl-rgb), 0.04); padding: 4px; margin-top: 14px; }
  /* The control wraps below its label once the label would get narrower than ~200px. */
  .srow { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 20px; padding: 14px 16px; }
  .srow > :first-child { flex: 1 1 200px; min-width: 0; }
  .srow > :not(:first-child) { max-width: 100%; }
  .srow + .srow { border-top: 1px solid rgba(var(--fg-rgb), 0.05); }
  .srow b { display: block; font-size: 14px; font-weight: 600; }
  .sub2 { display: block; margin-top: 2px; font-size: 12px; color: var(--label-3); }
  .switch { position: relative; width: 50px; height: 30px; border-radius: 999px; background: rgba(120, 120, 128, 0.32); transition: background 0.25s; flex-shrink: 0; }
  .switch span { position: absolute; top: 2px; left: 2px; width: 26px; height: 26px; border-radius: 50%; background: #fff; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35); /* slides via `left`, not transform (WebKitGTK flash) */ transition: left 0.35s cubic-bezier(0.34, 1.56, 0.64, 1); }
  .switch.on { background: var(--green); }
  .switch.on span { left: 22px; }
  .stepper { display: flex; align-items: center; gap: 8px; }
  .stepper button { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 50%; background: rgba(var(--fg-rgb), 0.07); color: var(--label); font-size: 15px; transition: background 0.15s; }
  .stepper button:hover { background: rgba(var(--fg-rgb), 0.14); }
  .stepper button:active { transform: scale(0.88); }
  .stepper .val { width: 56px; text-align: right; font-variant-numeric: tabular-nums; color: var(--label-2); font-size: 12.5px; }
  input[type="range"] { width: clamp(80px, 25vw, 180px); padding: 0; height: 4px; appearance: none; background: var(--recess); box-shadow: var(--recess-shadow); border-radius: 999px; }
  input[type="range"]::-webkit-slider-thumb { appearance: none; width: 20px; height: 20px; border-radius: 50%; background: #fff; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45); cursor: pointer;  }
  input[type="range"]::-webkit-slider-thumb:hover { transform: scale(1.12); }
  .seg { display: flex; padding: 3px; border-radius: 999px; background: var(--recess); box-shadow: var(--recess-shadow); }
  .seg button { height: 28px; padding: 0 14px; border-radius: 999px; font-size: 12.5px; font-weight: 500; color: var(--label-2); transition: background 0.2s, color 0.2s; }
  .seg button.on { color: var(--label); background: var(--raised-bg); box-shadow: var(--raised-shadow); }
  h2.mt { margin-top: 30px; }
  .box.mt-s { margin-top: 12px; }
  .rowend { display: flex; align-items: center; gap: 10px; }
  .btn:disabled { opacity: 0.4; pointer-events: none; }
  .note { margin: 10px 4px 0; font-size: 11.5px; color: var(--label-3); }
  .seg.small { display: inline-flex; margin-top: 10px; }
  .seg.small button { height: 24px; padding: 0 11px; font-size: 12px; }
  .pill { height: 26px; padding: 0 12px; display: inline-flex; align-items: center; border-radius: 999px; font-size: 12px; color: var(--label-2); background: rgba(var(--fg-rgb), 0.06); white-space: nowrap; }
  .pill.ok { color: var(--label); background: rgba(123, 191, 142, 0.35); }
  .pill.sys { color: var(--label); background: rgba(var(--fg-rgb), 0.1); }
  .ibar { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
  .note.inline { margin: 0; white-space: nowrap; }
  .ipath { font-family: var(--mono); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .btn { height: 30px; padding: 0 14px; border-radius: 999px; font-size: 12.5px; font-weight: 600; color: var(--label); background: linear-gradient(180deg, rgba(var(--fg-rgb), 0.2), rgba(var(--fg-rgb), 0.1)); box-shadow: inset 0 1px 0 rgba(var(--hl-rgb), 0.18); white-space: nowrap; transition: background 0.2s; }
  .btn:hover { background: linear-gradient(180deg, rgba(var(--fg-rgb), 0.26), rgba(var(--fg-rgb), 0.14)); }
  .btn:active { transform: scale(0.94); }
  .btn.ghost { background: rgba(var(--fg-rgb), 0.06); box-shadow: none; color: var(--label-2); }
  .col { display: flex; flex-direction: column; gap: 6px; align-items: stretch; }
  .grow { flex: 1; min-width: 0; }
  .cmd { display: block; margin-top: 8px; padding: 8px 10px; border-radius: 10px; background: var(--recess); font-family: var(--mono); font-size: 11.5px; color: var(--label-2); word-break: break-all; user-select: text; }
  .kbd { font-family: var(--mono); font-size: 12px; color: var(--label-2); padding: 4px 10px; border-radius: 8px; background: rgba(var(--fg-rgb), 0.06); }
  .port { width: 90px; height: 30px; border-radius: 10px; background: var(--recess); box-shadow: var(--recess-shadow); color: var(--label); padding: 0 10px; font-variant-numeric: tabular-nums; }
  h2 { margin: 12px 0 4px; font-size: 20px; font-weight: 700; }
  .desc { margin: 0 0 8px; color: var(--label-2); font-size: 13px; }
  h3 { margin: 22px 2px 10px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--label-2); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(280px, 100%), 1fr)); gap: 14px; }
  @media (max-width: 600px) {
    .overlay { padding: 8px; }
    header { padding: 18px 16px 6px 22px; }
    .tabs { padding: 6px 18px 10px; }
    .scroll { padding: 8px 18px 24px; }
    .srow { padding: 12px; }
  }
  .card {
    display: flex;
    flex-direction: column;
    text-align: left;
    border-radius: 20px;
    background: var(--well);
    box-shadow: inset 0 1px 0 rgba(var(--hl-rgb), 0.05), 0 0 0 1px rgba(var(--fg-rgb), 0.05);
    overflow: hidden;
    transition: box-shadow 0.25s;
  }
  .card:hover { transform: translateY(-3px); box-shadow: inset 0 1px 0 rgba(var(--hl-rgb), 0.07), 0 0 0 1px rgba(var(--fg-rgb), 0.12), 0 14px 30px rgba(0, 0, 0, 0.4); }
  .card:active { transform: scale(0.98); }
  .card.on { box-shadow: inset 0 1px 0 rgba(var(--hl-rgb), 0.08), 0 0 0 2px rgba(var(--fg-rgb), 0.55), 0 14px 30px rgba(0, 0, 0, 0.4); }
  .code { margin: 0; padding: 16px 18px 12px; font-family: var(--mono); font-size: 12px; line-height: 1.6; color: var(--syn-plain); white-space: pre; overflow: hidden; }
  .k { color: var(--syn-keyword); font-weight: 600; }
  .f { color: var(--syn-function); }
  .d { color: var(--syn-definition); }
  .t { color: var(--syn-type); }
  .o { color: var(--syn-operator); }
  .c { color: var(--syn-comment); font-style: italic; }
  .n { color: var(--syn-number); }
  .s { color: var(--syn-string); }
  .p { color: var(--syn-keyword); }
  .pr { color: var(--syn-property); }
  .foot { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px 12px; border-top: 1px solid rgba(var(--fg-rgb), 0.05); background: rgba(var(--fg-rgb), 0.025); }
  .name { font-weight: 600; font-size: 13px; }
  .swatches { display: flex; gap: 4px; }
  .swatches i { width: 10px; height: 10px; border-radius: 50%; }
  /* No open animation: any fade over the blurred backdrop flashes the editor in WebKitGTK. */
  .shell-select { padding: 5px 10px; border-radius: 8px; background: var(--recess); color: var(--label); border: 1px solid rgba(var(--fg-rgb), 0.1); font: inherit; font-size: 12.5px; max-width: 220px; }
</style>
