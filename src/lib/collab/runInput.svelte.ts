/**
 * Level 1 of guest terminal access: typing into the host's running Build/Run program (capability
 * `run`). Input names the task it's meant for and the host drops it unless exactly that task still
 * runs, so a late keystroke can't reach a newer task. The PTY's echo reaches everybody through the
 * normal mirror, so guests don't echo locally. Ctrl+C is the Stop action, with its rules.
 */
import { sessionEndHooks } from "./collab.svelte";
import { guestCan } from "./guard";
import { hasCapability, isObj, registerMethod, rpcErrorText, RpcFail, call } from "./rpc.svelte";
import { InputPump, sanitizeProgramInput, TERM_LIMITS } from "./guestInput";
import { runningPackageTask, writeTaskInput } from "../terminal.svelte";
import { runner } from "../code/runner.svelte";
import { ui } from "../ui.svelte";
import { t } from "../i18n/index.svelte";

declare module "./rpc.svelte" {
  interface RpcMethods {
    "run.input": { params: { taskId: number; data: string }; result: null };
  }
}

registerMethod({
  name: "run.input",
  capability: "run",
  validate: (raw) =>
    isObj(raw) && Number.isSafeInteger(raw.taskId) && typeof raw.data === "string" && raw.data.length > 0 && raw.data.length <= TERM_LIMITS.maxInput ? { taskId: raw.taskId as number, data: raw.data } : null,
  handle: async ({ taskId, data }, { peer }) => {
    const packageTask = runningPackageTask(taskId);
    if (packageTask === null) throw new RpcFail("task_ended");
    // Answering an installer's prompt is part of changing packages.
    if (packageTask && !hasCapability(peer, "packages")) throw new RpcFail("forbidden");
    const clean = sanitizeProgramInput(data);
    if (!clean) return null;
    const r = await writeTaskInput(taskId, clean);
    if (r === "busy") throw new RpcFail("input_busy");
    if (r === "ended") throw new RpcFail("task_ended");
    return null;
  },
});

// ------------------------------------------------------------------ guest

let pumpTask: number | null = null;
let hinted = false;

function hintOnce(text: string) {
  if (!hinted) ui.toast(text);
  hinted = true;
}

const pump = new InputPump(
  async (data) => {
    if (pumpTask === null) return false;
    const r = await call("run.input", { taskId: pumpTask, data });
    if (r.ok) return true;
    if (r.error.code === "input_busy") hintOnce(t("ai.collab.inputBusy"));
    else if (r.error.code !== "task_ended") hintOnce(rpcErrorText(r.error.code));
    return false;
  },
  () => hintOnce(t("ai.collab.inputBusy")),
);

function typeText(text: string) {
  const clean = sanitizeProgramInput(text);
  if (!clean) return; // e.g. the guest's terminal answering a status query
  const task = runner.remoteTask;
  if (!guestCan("run")) return hintOnce(t("ai.collab.termReadOnly"));
  if (!task?.running || task.taskId === null) {
    pump.clear();
    pumpTask = null;
    return hintOnce(t("ai.collab.termNoTask"));
  }
  if (task.taskId !== pumpTask) {
    pump.clear();
    pumpTask = task.taskId;
    hinted = false;
  }
  pump.push(clean);
}

/** Guest: what was typed into the mirror of the host's Build/Run terminal. */
export function typeIntoHostRun(data: string, stop: () => unknown) {
  data.split("\x03").forEach((text, i) => {
    if (i > 0 && runner.remoteTask?.running) void stop();
    if (text) typeText(text);
  });
}

sessionEndHooks.push(() => {
  pump.clear();
  pumpTask = null;
  hinted = false;
});
