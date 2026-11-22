/**
 * Zen mode: hides all UI and centers the text. State of this window only and never saved, so a
 * restart always comes back with the normal layout. Hiding is CSS in App.svelte; nothing unmounts.
 */
import { tick } from "svelte";
import { freezeLayout, restoreLayout } from "./layout.svelte";
import * as ed from "./editor";

export const zen = $state({ on: false });

let focusBefore: HTMLElement | null = null;

export function enterZen() {
  if (zen.on) return;
  focusBefore = document.activeElement as HTMLElement | null;
  freezeLayout();
  zen.on = true;
  // Without an open file the editor can't take focus; keys must not go on to a hidden terminal.
  focusBefore?.blur();
  ed.focus();
}

export async function exitZen() {
  if (!zen.on) return;
  zen.on = false;
  restoreLayout();
  const el = focusBefore;
  focusBefore = null;
  await tick();
  if (el?.isConnected && el !== document.body) el.focus();
  else ed.focus();
}

export const toggleZen = () => (zen.on ? exitZen() : enterZen());
