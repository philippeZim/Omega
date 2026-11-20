/** Glue between the UI and projects.ts: current project, running actions, new-project flow. */
import { detectProject, type Action, type Project, TEMPLATES } from "./projects";
import { versionSettings, type VersionSetting } from "./versions";
import { runCommand, interruptRun } from "../terminal.svelte";
import { app, activeTab, save, setRoot, openFile, setMode } from "../state.svelte";
import { ui } from "../ui.svelte";
import { fsApi, joinPath } from "../api";
import { t } from "../i18n/index.svelte";
import { ensureTools } from "../tools.svelte";
import { cd, q } from "../platform";

export const runner = $state({
  project: null as Project | null,
  /** Language/runtime versions of the current project (see versions.ts). */
  versions: [] as VersionSetting[],
  newProject: false,
});

let seq = 0;
export async function refreshProject() {
  const s = ++seq;
  const p = await detectProject(activeTab()?.path ?? null, app.root);
  if (s !== seq) return;
  runner.project = p && withCustomRun(p);
  const v = await versionSettings(p);
  if (s === seq) runner.versions = v;
}

// ------------------------------------------------------------------ custom run command (per project)

const runKey = (root: string) => `runCmd:${root}`;

function customRunCmd(root: string): string | null {
  try {
    return localStorage.getItem(runKey(root));
  } catch {
    return null;
  }
}

/** Replaces the detected run action with the user's command, keeping the original for "reset". */
function withCustomRun(p: Project): Project {
  const cmd = customRunCmd(p.root);
  if (!cmd) return p;
  return { ...p, defaultRun: p.run, run: { id: "run", label: t("common.run"), cmd, shortcut: p.run?.shortcut ?? "Shift+F10" } };
}

export async function editRunCommand() {
  const p = runner.project;
  if (!p) return;
  const v = await ui.prompt(t("code.rb.runCmdTitle"), p.run?.cmd ?? "", t("code.rb.runCmdPlaceholder"), undefined, undefined, true);
  if (v === null) return;
  try {
    if (v === p.defaultRun?.cmd || (!p.defaultRun && v === p.run?.cmd)) localStorage.removeItem(runKey(p.root));
    else localStorage.setItem(runKey(p.root), v);
  } catch {}
  await refreshProject();
}

export async function resetRunCommand() {
  const p = runner.project;
  if (!p) return;
  try {
    localStorage.removeItem(runKey(p.root));
  } catch {}
  await refreshProject();
}

// ------------------------------------------------------------------ language versions

/** Lets the user pick a version for one setting and applies it (file edit and/or terminal command). */
export async function chooseVersion(s: VersionSetting) {
  const p = runner.project;
  if (!p) return;
  let opts: Promise<Awaited<ReturnType<VersionSetting["options"]>>> | null = null;
  const v = await ui.prompt(t("code.ver.choose", { label: s.label }), "", s.current ?? "", undefined, async (q) => {
    const all = await (opts ??= s.options());
    const n = q.trim().toLowerCase();
    return n ? all.filter((o) => o.value.toLowerCase().includes(n)) : all;
  });
  if (!v || v === s.current) return;
  try {
    const cmd = await s.apply(v);
    if (cmd) {
      if (!(await ensureTools(p.needs, t("tools.purpose.run")))) return;
      runCommand(cmd, p.root, `${s.label} ${v}`);
      setTimeout(refreshProject, 4000);
    } else if (s.note) ui.toast(t(s.note, { label: s.label, version: v }));
  } catch (e) {
    ui.toast(String(e), "error");
  }
  await refreshProject();
}

async function saveAll() {
  for (const t of app.tabs) if (t.dirty && t.path) await save(t.id);
}

export async function runAction(a: Action | null | undefined) {
  const p = runner.project;
  if (!a?.cmd || !p) return;
  let cmd = a.cmd;
  if (a.ask) {
    const v = await ui.prompt(a.label.replace("…", ""), "", a.ask, undefined, a.suggest);
    if (!v) return;
    cmd = cmd.replace("{}", a.arg ? await a.arg(v) : v);
  }
  // `{file}` in a (custom) command = the file open in the editor.
  if (cmd.includes("{file}")) {
    const file = activeTab()?.path;
    if (!file) return ui.toast(t("code.rb.noFileOpen"), "error");
    cmd = cmd.replaceAll("{file}", q(file));
  }
  if (!(await ensureTools([...p.needs, ...(a.needs ?? [])], t("tools.purpose.run")))) return;
  await saveAll();
  runCommand(cmd, p.root, `${p.label}: ${a.label.replace("…", "")}`);
  // Dependency changes may alter the project (e.g. new scripts).
  if (a.ask) setTimeout(refreshProject, 3000);
}

export const stopRun = interruptRun;

export async function createProject(templateId: string, parent: string, name: string) {
  const tpl = TEMPLATES.find((x) => x.id === templateId);
  if (!tpl) return;
  const dir = joinPath(parent, name);
  if (await fsApi.exists(dir)) return ui.toast(t("code.existsAlready", { name }), "error");
  if (tpl.id === "empty") {
    await fsApi.createDir(dir);
    runner.newProject = false;
    setRoot(dir);
    refreshProject();
    return;
  }
  const needs = typeof tpl.needs === "function" ? await tpl.needs() : tpl.needs;
  if (!(await ensureTools(needs, t("tools.purpose.create")))) return;
  const plan = await tpl.create(name);
  if (!plan.inParent) {
    await fsApi.createDir(dir);
    for (const [rel, content] of Object.entries(plan.files ?? {})) await fsApi.writeFile(joinPath(dir, rel), content);
  }
  runner.newProject = false;
  setMode(tpl.mode ?? "code");
  const cmd = plan.cmds.join(" && ");
  if (cmd) runCommand(plan.inParent ? cmd : `${cd(dir)} && ${cmd}`, plan.inParent ? parent : null, t("code.newProjectTitle", { name }));
  // Open the folder as soon as the project file exists (tools differ in which source files they create).
  for (let i = 0; i < 240; i++) {
    if (i) await new Promise((r) => setTimeout(r, 500));
    if (!(await fsApi.exists(joinPath(dir, tpl.marker)))) continue;
    setRoot(dir);
    // Give the tool a moment to write its source files, then open the best candidate.
    for (let j = 0; j < 20; j++) {
      for (const rel of tpl.open) {
        const f = joinPath(dir, rel.replace("{name}", name.replace(/-/g, "_")));
        if (await fsApi.exists(f)) {
          await openFile(f);
          refreshProject();
          return;
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    refreshProject();
    return;
  }
  ui.toast(t("code.projectNotCreated"), "error");
}
