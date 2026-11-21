// Keep the computer awake (also with the lid closed) while an AI agent runs in a terminal.
// The backend (src-tauri/src/power.rs) watches the terminals; this only holds the setting.
import { invoke } from "@tauri-apps/api/core";
import { onGlobalChange } from "./windowStorage";
import { listen } from "./windowEvents";

type Status = { active: boolean; agent: string | null; lid: boolean; error: string | null };

export const power = $state({
  // On by default; only an explicit "false" turns it off.
  enabled: localStorage.getItem("keepAwakeAgents") !== "false",
  status: { active: false, agent: null, lid: false, error: null } as Status,
});

export async function setKeepAwake(enabled: boolean) {
  power.enabled = enabled;
  localStorage.setItem("keepAwakeAgents", String(enabled));
  power.status = await invoke<Status>("power_keep_awake", { enabled });
}

listen<Status>("power-status", (e) => (power.status = e.payload));
onGlobalChange("keepAwakeAgents", (v) => (power.enabled = v !== "false"));
setKeepAwake(power.enabled);
