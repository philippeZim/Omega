#!/usr/bin/env node
// Omega dev MCP proxy: lets AI agents (Claude Code, Codex, OpenCode) start and drive their own
// Omega instances – several side by side, one per worktree or several per agent (collab tests).
//
//   node dev/omega-mcp.mjs                         stdio MCP server (register this in the agent)
//   node dev/omega-mcp.mjs list                    running instances
//   node dev/omega-mcp.mjs launch [name] [paths…]  start an instance of this worktree
//   node dev/omega-mcp.mjs stop <name|all>         stop instances started from this worktree
//
// Each instance runs its own Vite (stable port per worktree + name) and the debug binary of the worktree with
// OMEGA_INSTANCE=<name>: own settings/localStorage, control MCP on a free port. Every running
// control MCP announces port + token in <runtime dir>/omega/instances/<pid>.json (see
// src-tauri/src/instance.rs); the proxy reads it on every call, so token changes don't matter.
//
// Safety: without an explicit `instance` argument the proxy only talks to instances of the
// agent's own worktree – never to the Omega you use yourself.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

// ------------------------------------------------------------------ registry

/** Per call: worktree given explicitly (subagents run in the orchestrator's directory). */
let worktreeOverride = "";

const runtimeBase = () => {
  const x = process.env.XDG_RUNTIME_DIR;
  return x && fs.existsSync(x) ? x : os.tmpdir();
};
const omegaDir = (...p) => path.join(runtimeBase(), "omega", ...p);

const alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

function readJsonDir(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {}
  return names.flatMap((n) => {
    try {
      return [{ file: path.join(dir, n), ...JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")) }];
    } catch {
      return [];
    }
  });
}

/** Worktree of the agent: OMEGA_WORKTREE or the git toplevel around the working directory. */
function myWorktree() {
  if (worktreeOverride) return real(worktreeOverride);
  if (process.env.OMEGA_WORKTREE) return real(process.env.OMEGA_WORKTREE);
  try {
    return real(execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch {
    return real(process.cwd());
  }
}

/** Launch records (vite + app pids) of instances this tool started; removes dead ones. */
function launches() {
  return readJsonDir(omegaDir("launched")).filter((l) => {
    if (alive(l.appPid)) return true;
    killTree(l.vitePid); // the app is gone → its Vite too
    fs.rmSync(l.file, { force: true });
    return false;
  });
}

function instances() {
  const wt = myWorktree();
  const launched = launches();
  return readJsonDir(omegaDir("instances"))
    .filter((i) => alive(i.pid) || (fs.rmSync(i.file, { force: true }), false)) // killed → stale entry
    .map((i) => ({
      name: i.name,
      pid: i.pid,
      port: i.port,
      token: i.token,
      worktree: i.worktree ? real(i.worktree) : null,
      sameWorktree: !!i.worktree && real(i.worktree) === wt,
      launched: launched.some((l) => l.appPid === i.pid),
      devUrl: i.devUrl ?? null,
      started: i.started ?? 0,
    }))
    .sort((a, b) => b.started - a.started);
}

const publicInfo = ({ token, ...i }) => ({ ...i, default: i.pid === defaultPid });

// ------------------------------------------------------------------ launch / stop

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const portFree = (port) =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.unref();
    s.on("error", () => resolve(false));
    s.listen(port, "localhost", () => s.close(() => resolve(true)));
  });

/** Stable Vite port per worktree + name (20000–39999): the webview origin, and with it the
 *  instance's localStorage (settings), stays the same across restarts. Next free one if taken. */
async function vitePortFor(root, name) {
  let h = 2166136261;
  for (const c of `${root}\0${name}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  for (let i = 0; i < 50; i++) {
    const port = 20000 + ((h + i * 7919) % 20000);
    if (await portFree(port)) return port;
  }
  throw new Error("Kein freier Port für Vite gefunden");
}

async function httpUp(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

function killTree(pid) {
  if (!pid || !alive(pid)) return;
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-pid, "SIGTERM"); // detached → own process group
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
}

const tail = (file, n = 30) => {
  try {
    return fs.readFileSync(file, "utf8").split("\n").slice(-n).join("\n");
  } catch {
    return "";
  }
};

const validName = (n) => /^[A-Za-z0-9_-]{1,40}$/.test(n);

// ------------------------------------------------------------------ Hyprland: own desktop

/** Test instances open on their own desktop (Hyprland workspace, default 5), so they never land
 *  on the one you are working on. OMEGA_TEST_WORKSPACE overrides it; "" disables it. */
const testWorkspace = () => (process.env.HYPRLAND_INSTANCE_SIGNATURE ? (process.env.OMEGA_TEST_WORKSPACE ?? "5") : "");

function hypr(...args) {
  try {
    return execFileSync("hyprctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 });
  } catch {
    return "";
  }
}
const hyprJson = (...args) => {
  try {
    return JSON.parse(hypr(...args, "-j"));
  } catch {
    return null;
  }
};

/** Moves the window of `pid` to the test desktop without following it; gives the focus back to
 *  `prevAddr` if the new window took it. Returns true once the window was found. */
function toTestWorkspace(pid, prevAddr) {
  const ws = testWorkspace();
  if (!ws) return true;
  const win = (hyprJson("clients") ?? []).find((c) => c.pid === pid);
  if (!win) return false;
  if (String(win.workspace?.id) !== ws && win.workspace?.name !== ws) {
    hypr("dispatch", `hl.dsp.window.move({ workspace = "${ws}", follow = false, window = "address:${win.address}" })`);
  }
  if (prevAddr && hyprJson("activewindow")?.address !== prevAddr) {
    hypr("dispatch", `hl.dsp.focus({ window = "address:${prevAddr}" })`);
  }
  return true;
}

/** App tool call through the proxy (MCP and CLI). */
async function appCall(inst, name, args) {
  return forward(inst, "tools/call", { name, arguments: args });
}

/** Builds (cargo) and starts an instance of `root`; resolves when its control MCP is up. */
async function launch(name = "agent", paths = [], log = () => {}) {
  if (!validName(name)) throw new Error(`Ungültiger Name "${name}" (erlaubt: A-Z a-z 0-9 _ -)`);
  const root = myWorktree();
  if (!fs.existsSync(path.join(root, "src-tauri", "Cargo.toml"))) throw new Error(`${root} ist kein Omega-Repo`);
  const existing = instances().find((i) => i.sameWorktree && i.name === name);
  if (existing) return { ...publicInfo(existing), note: "lief bereits" };

  fs.mkdirSync(omegaDir("logs"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(omegaDir("launched"), { recursive: true, mode: 0o700 });
  const stamp = `${path.basename(root)}-${name}`;
  const appLog = omegaDir("logs", `${stamp}.log`);
  const viteLog = omegaDir("logs", `${stamp}.vite.log`);

  // 1. Build first (the slow part; cargo serialises parallel builds of the same worktree).
  log("Baue Omega (cargo build) …");
  let exe;
  try {
    const out = execFileSync("cargo", ["build", "--manifest-path", path.join(root, "src-tauri", "Cargo.toml"), "--message-format=json-render-diagnostics"], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const line of out.split("\n")) {
      if (!line.startsWith("{")) continue;
      const m = JSON.parse(line);
      if (m.reason === "compiler-artifact" && m.executable && m.target?.kind?.includes("bin")) exe = m.executable;
    }
  } catch (e) {
    throw new Error(`cargo build fehlgeschlagen:\n${String(e.stderr ?? e.message).split("\n").slice(-40).join("\n")}`);
  }
  if (!exe) throw new Error("cargo build lieferte kein Programm");

  // 2. Own Vite on a free port.
  const vitePort = await vitePortFor(root, name);
  const devUrl = `http://localhost:${vitePort}`;
  const env = { ...process.env, OMEGA_VITE_PORT: String(vitePort) };
  const vite = spawn(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "--port", String(vitePort), "--strictPort"], {
    cwd: root,
    env,
    detached: true,
    stdio: ["ignore", fs.openSync(viteLog, "w"), fs.openSync(viteLog, "a")],
  });
  vite.unref();
  log(`Vite startet auf ${devUrl} …`);
  for (let t = 0; !(await httpUp(devUrl)); t++) {
    if (vite.exitCode !== null || t > 120) {
      killTree(vite.pid);
      throw new Error(`Vite startete nicht:\n${tail(viteLog)}`);
    }
    await sleep(250);
  }

  // 3. The app.
  const prevAddr = testWorkspace() ? hyprJson("activewindow")?.address : undefined;
  const app = spawn(exe, paths, {
    cwd: root,
    env: { ...env, OMEGA_INSTANCE: name, OMEGA_DEV_URL: devUrl, OMEGA_WORKTREE: root },
    detached: true,
    stdio: ["ignore", fs.openSync(appLog, "w"), fs.openSync(appLog, "a")],
  });
  app.unref();
  fs.writeFileSync(omegaDir("launched", `${app.pid}.json`), JSON.stringify({ name, worktree: root, appPid: app.pid, vitePid: vite.pid, devUrl, log: appLog }), { mode: 0o600 });
  log(`Omega „${name}“ startet (pid ${app.pid}) …`);

  // 4. Ready when the control MCP announces itself; meanwhile move the window to its desktop.
  let placed = false;
  for (let t = 0; t < 600; t++) {
    if (!placed) placed = toTestWorkspace(app.pid, prevAddr);
    const inst = instances().find((i) => i.pid === app.pid);
    if (inst && (placed || t > 50)) return { ...publicInfo(inst), log: appLog, ...(testWorkspace() ? { workspace: testWorkspace() } : {}) };
    if (app.exitCode !== null || !alive(app.pid)) {
      killTree(vite.pid);
      throw new Error(`Omega wurde beendet:\n${tail(appLog)}`);
    }
    await sleep(200);
  }
  throw new Error(`Omega meldet keinen Steuerungs-MCP (Log: ${appLog})`);
}

/** Waits until `pids` have exited; kills them hard after `ms`. */
async function waitGone(pids, ms = 5000) {
  for (let t = 0; t < ms / 100 && pids.some(alive); t++) await sleep(100);
  for (const pid of pids.filter(alive)) {
    try {
      process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
    } catch {}
  }
}

/** Stops instances started from this worktree (name or "all"). */
async function stop(name) {
  const root = myWorktree();
  const mine = launches().filter((l) => real(l.worktree) === root && (name === "all" || l.name === name));
  if (!mine.length) {
    const other = instances().find((i) => i.name === name);
    throw new Error(other ? `„${name}“ wurde nicht von omega-mcp in diesem Worktree gestartet – stoppe ich nicht` : `Keine Instanz „${name}“`);
  }
  for (const l of mine) {
    // Only the app itself: it exits cleanly (lets WebKit's helper processes write localStorage
    // first); signalling the whole group would kill those helpers and lose recent settings.
    try {
      process.kill(l.appPid, "SIGTERM");
    } catch {}
    killTree(l.vitePid);
    fs.rmSync(l.file, { force: true });
  }
  await waitGone(mine.map((l) => l.appPid), 8000);
  await waitGone(mine.map((l) => l.vitePid));
  return mine.map((l) => l.name);
}

// ------------------------------------------------------------------ forwarding

let defaultPid = 0;

/** Instance a call goes to: explicit name (own worktree first) › last launched › the only one of this worktree. */
function target(name) {
  const all = instances();
  const mine = all.filter((i) => i.sameWorktree);
  name ||= process.env.OMEGA_INSTANCE;
  if (name) {
    const hit = mine.find((i) => i.name === name) ?? all.find((i) => i.name === name);
    if (!hit) throw new Error(`Keine laufende Instanz „${name}“. Laufend: ${all.map((i) => i.name).join(", ") || "keine"} – starte eine mit instance_launch.`);
    return hit;
  }
  const def = mine.find((i) => i.pid === defaultPid);
  if (def) return def;
  if (mine.length === 1) return mine[0];
  if (!mine.length) throw new Error("In diesem Worktree läuft keine Omega-Instanz – starte eine mit instance_launch.");
  throw new Error(`Mehrere Instanzen laufen (${mine.map((i) => i.name).join(", ")}) – gib "instance" an.`);
}

let rpcId = 1;
async function forward(inst, method, params) {
  const res = await fetch(`http://127.0.0.1:${inst.port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${inst.token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
    signal: AbortSignal.timeout(130_000),
  });
  if (!res.ok) throw new Error(`Instanz „${inst.name}“ antwortet mit HTTP ${res.status}${res.status === 503 ? " (Steuerungs-MCP ausgeschaltet)" : ""}`);
  const msg = await res.json();
  if (msg.error) throw new Error(msg.error.message);
  return msg.result;
}

// ------------------------------------------------------------------ MCP server (stdio)

const MGMT = [
  {
    name: "instance_list",
    description: "Laufende Omega-Instanzen (Name, pid, Worktree, ob dieser Worktree, Standard-Ziel). Ohne `instance` gehen App-Werkzeuge an die zuletzt gestartete bzw. einzige Instanz dieses Worktrees.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "instance_launch",
    description:
      "Baut (cargo build) und startet eine Omega-Instanz aus diesem Worktree mit eigenen Einstellungen, eigenem Vite und Steuerungs-MCP. Kann beim ersten Mal Minuten dauern. Mehrere Instanzen mit verschiedenen Namen gleichzeitig möglich (z. B. host + guest für Collab). Die gestartete Instanz wird Standard-Ziel.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name der Instanz (A-Z a-z 0-9 _ -), Standard: agent" },
        paths: { type: "array", items: { type: "string" }, description: "Ordner/Dateien, die direkt geöffnet werden (relativ zum Worktree)" },
        worktree: { type: "string", description: "Absoluter Pfad des Worktrees, aus dem gebaut wird (Standard: Arbeitsordner des Agents). Für Subagents, die im Ordner des Orchestrators laufen." },
      },
    },
  },
  {
    name: "instance_stop",
    description: "Beendet eine mit instance_launch gestartete Instanz dieses Worktrees (samt ihrem Vite). name = \"all\" beendet alle.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, worktree: { type: "string", description: "Absoluter Pfad des Worktrees (Standard: Arbeitsordner des Agents)" } }, required: ["name"] },
  },
];

const INSTANCE_ARG = { type: "string", description: "Ziel-Instanz (Name aus instance_list); Standard: zuletzt gestartete bzw. einzige dieses Worktrees" };

async function appTools() {
  let inst;
  try {
    inst = target();
  } catch {
    inst = instances().find((i) => i.sameWorktree) ?? instances()[0]; // schemas only
  }
  if (!inst) return [];
  try {
    const { tools } = await forward(inst, "tools/list", {});
    return tools.map((t) => ({
      ...t,
      inputSchema: { ...(t.inputSchema ?? { type: "object" }), properties: { ...(t.inputSchema?.properties ?? {}), instance: INSTANCE_ARG } },
    }));
  } catch {
    return [];
  }
}

const text = (v, isError = false) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }], ...(isError ? { isError } : {}) });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");

let knownApp = false;
async function callTool(name, args = {}) {
  worktreeOverride = name.startsWith("instance_") ? (args.worktree ?? "") : "";
  switch (name) {
    case "instance_list":
      return text(instances().map(publicInfo));
    case "instance_launch": {
      const info = await launch(args.name || "agent", args.paths ?? [], (m) => process.stderr.write(m + "\n"));
      defaultPid = info.pid;
      if (!knownApp) send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      return text({ ...info, default: true });
    }
    case "instance_stop":
      return text(`Beendet: ${(await stop(args.name)).join(", ")}`);
    default: {
      const { instance, ...rest } = args;
      return appCall(target(instance), name, rest);
    }
  }
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notification
  try {
    switch (method) {
      case "initialize":
        return send({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "omega-dev", title: "Omega (Entwicklung)", version: "1" },
            instructions:
              "Startet und steuert Omega-Instanzen dieses Worktrees zum Testen. Zuerst instance_launch, dann die App-Werkzeuge (get_state, click, type_text, press_key, screenshot …). Mit `instance` eine bestimmte Instanz wählen. Am Ende instance_stop.",
          },
        });
      case "ping":
        return send({ jsonrpc: "2.0", id, result: {} });
      case "tools/list": {
        const app = await appTools();
        knownApp = app.length > 0;
        return send({ jsonrpc: "2.0", id, result: { tools: [...MGMT, ...app] } });
      }
      case "tools/call": {
        let result;
        try {
          result = await callTool(params?.name, params?.arguments ?? {});
        } catch (e) {
          result = text(e instanceof Error ? e.message : String(e), true);
        }
        return send({ jsonrpc: "2.0", id, result });
      }
      default:
        return send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    }
  } catch (e) {
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(e?.message ?? e) } });
  }
}

function serve() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    for (const m of Array.isArray(msg) ? msg : [msg]) handle(m);
  });
}

// ------------------------------------------------------------------ CLI

/** `call [-i instance] [-o out.png] <tool> [json]`: one app tool from a shell (for subagents
 *  without MCP access). Text goes to stdout; images are written to -o (default: a temp file)
 *  and their path is printed. Exit code 1 if the tool reports an error. */
async function cliCall(argv) {
  let instance;
  let outFile;
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-i") instance = argv[++i];
    else if (argv[i] === "-o") outFile = argv[++i];
    else pos.push(argv[i]);
  }
  const [name, json] = pos;
  if (!name) throw new Error("call: Tool-Name fehlt");
  const args = json ? JSON.parse(json) : {};
  const res = await appCall(target(instance), name, args);
  let n = 0;
  for (const c of res.content ?? []) {
    if (c.type === "image") {
      const file = outFile && n === 0 ? outFile : `${os.tmpdir()}/omega-shot-${Date.now()}-${n}.png`;
      fs.writeFileSync(file, Buffer.from(c.data, "base64"));
      console.log(`[Bild] ${file}`);
      n++;
    } else console.log(c.text ?? JSON.stringify(c));
  }
  if (res.isError) process.exitCode = 1;
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (!cmd || cmd === "serve") serve();
  else if (cmd === "list") console.log(JSON.stringify(instances().map(publicInfo), null, 2));
  else if (cmd === "launch") console.log(JSON.stringify(await launch(rest[0] || "agent", rest.slice(1), (m) => console.error(m)), null, 2));
  else if (cmd === "stop") console.log(`Beendet: ${(await stop(rest[0] || "all")).join(", ")}`);
  else if (cmd === "call") await cliCall(rest);
  else if (cmd === "tools") {
    const { tools } = await forward(target(rest[0]), "tools/list", {});
    for (const t of tools) console.log(`${t.name} ${JSON.stringify(Object.keys(t.inputSchema?.properties ?? {}))}\n    ${t.description}`);
  }
  else {
    console.error("Benutzung: omega-mcp.mjs [serve | list | launch [name] [pfade…] | stop <name|all> | call [-i instanz] [-o bild.png] <tool> [json-args] | tools [instanz]]");
    process.exit(2);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
