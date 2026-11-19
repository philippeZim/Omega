/** Aggregates all area dictionaries. Each area file is owned by one part of the UI. */
import * as common from "./common";
import * as help from "./help";
import * as commands from "./commands";
import * as app from "./app";
import * as git from "./git";
import * as code from "./code";
import * as ai from "./ai";
import * as tools from "./tools";

const areas = [common, help, commands, app, git, code, ai, tools];
type En = typeof common.en & typeof help.en & typeof commands.en & typeof app.en & typeof git.en & typeof code.en & typeof ai.en & typeof tools.en;
const merge = (k: "en" | "de" | "fr") => Object.assign({}, ...areas.map((a) => a[k])) as En;

export const dictionaries = { en: merge("en"), de: merge("de"), fr: merge("fr") };
