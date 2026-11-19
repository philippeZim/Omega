/** Glue between the UI and projects.ts: current project, running actions, new-project flow. */
import { detectProject, type Action, type Project, TEMPLATES } from "./projects";
import { runCommand, interruptRun } from "../terminal.svelte";
import { app, activeTab, save, setRoot, openFile, setMode } from "../state.svelte";
import { ui } from "../ui.svelte";
import { fsApi, joinPath } from "../api";
import { t } from "../i18n/index.svelte";

export const runner = $state({
  project: null as Project | null,
  newProject: false,
});

let seq = 0;
export async function refreshProject() {
  const s = ++seq;
  const p = await detectProject(activeTab()?.path ?? null, app.root);
  if (s === seq) runner.project = p;
}

async function saveAll() {
  for (const t of app.tabs) if (t.dirty && t.path) await save(t.id);
}

export async function runAction(a: Action | null | undefined) {
  const p = runner.project;
  if (!a?.cmd || !p) return;
  let cmd = a.cmd;
  if (a.ask) {
    const v = await ui.prompt(a.label.replace("…", ""), "", a.ask);
    if (!v) return;
    cmd = cmd.replace("{}", v);
  }
  await saveAll();
  runCommand(cmd, p.root, `${p.label}: ${a.label.replace("…", "")}`);
  // Dependency changes may alter the project (e.g. new scripts).
  if (a.ask) setTimeout(refreshProject, 3000);
}

export const stopRun = interruptRun;

export async function createProject(templateId: string, parent: string, name: string) {
  const tpl = TEMPLATES.find((x) => x.id === templateId);
  if (!tpl) return;
  const [cmd] = tpl.create(parent, name);
  const dir = joinPath(parent, name);
  if (tpl.id === "empty") {
    if (await fsApi.exists(dir)) return ui.toast(t("code.existsAlready", { name }), "error");
    await fsApi.createDir(dir);
    runner.newProject = false;
    setRoot(dir);
    refreshProject();
    return;
  }
  runner.newProject = false;
  setMode("code");
  runCommand(cmd, null, t("code.newProjectTitle", { name }));
  // Open the folder as soon as the project file exists (tools differ in which source files they create).
  for (let i = 0; i < 240; i++) {
    await new Promise((r) => setTimeout(r, 500));
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
