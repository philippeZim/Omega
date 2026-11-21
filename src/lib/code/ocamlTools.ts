/**
 * Omega's own OCaml comes first when it is installed, so what runs is what Settings shows. Its
 * folder is last on the PATH like every managed tool, and a shell may have run `eval $(opam env)`
 * for another switch, so it is addressed directly. Without it the system's OCaml is used.
 */
import { invoke } from "@tauri-apps/api/core";
import { q } from "../platform";

const whichCmd = (cmd: string) => invoke<string | null>("which_cmd", { cmd }).catch(() => null);
const ocamlDir = async () => `${await invoke<string>("tools_dir")}/ocaml`;

/** A program of Omega's switch, null if it isn't installed there. */
export const managedOcaml = async (cmd: string) => whichCmd(`${await ocamlDir()}/root/omega/bin/${cmd}`);

/**
 * What a shell command has to start with to run in Omega's switch: its launcher clears the
 * calling shell's opam environment. Empty without a managed OCaml.
 */
export async function ocamlShellPrefix() {
  const runner = await whichCmd(`${await ocamlDir()}/run`);
  return runner ? `${q(runner)} ` : "";
}

/** Set for a debugged program of Omega's switch: `null` removes a variable another switch set. */
export const OCAML_PROGRAM_ENV = { CAML_LD_LIBRARY_PATH: null, OCAMLPATH: null, OCAMLTOP_INCLUDE_PATH: null, OCAMLFIND_CONF: null };
