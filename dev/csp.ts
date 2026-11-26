/**
 * The Content Security Policy (#166). It lives in `src-tauri/tauri.conf.json`; Tauri sends it with
 * every page of a release build. In `tauri dev` the window loads Vite directly and Tauri adds no
 * policy, so Vite sends the same one (plus its HMR socket): a violation shows up while developing,
 * not only in a release.
 */
export type CspMap = Record<string, string | string[]>;

/** `{ "img-src": ["'self'", "data:"] }` → `img-src 'self' data:` */
export function cspString(csp: CspMap) {
  return Object.entries(csp)
    .map(([directive, sources]) => `${directive} ${Array.isArray(sources) ? sources.join(" ") : sources}`)
    .join("; ");
}

const list = (sources: string | string[] | undefined, fallback: string[]) =>
  Array.isArray(sources) ? sources : sources ? sources.split(/\s+/) : fallback;

/**
 * The release policy for Vite's dev server. HMR talks over a WebSocket on `hmrHost`, and after a
 * lost connection Vite's client waits for the server in a SharedWorker made from a `blob:` URL.
 */
export function devCsp(csp: CspMap, hmrHost = "localhost") {
  const self = list(csp["default-src"], ["'self'"]);
  return cspString({
    ...csp,
    "connect-src": [...list(csp["connect-src"], self), `ws://${hmrHost}:*`],
    "worker-src": [...list(csp["worker-src"], self), "blob:"],
  });
}
