/**
 * Code Together: images and relative links in a shared Markdown doc. The host reads and checks the
 * image (latex_guest.rs: inside the project, by content, size cap); the guest only ever shows it
 * through `<img>` with a `data:` URL, where an SVG can't run scripts or load anything.
 */
import { invoke } from "@tauri-apps/api/core";
import { call, isObj, registerMethod, RpcFail } from "./rpc.svelte";
import { sessionEndHooks } from "./collab.svelte";
import { guestScope, openRemote, share } from "./share.svelte";
import { AssetCache, imageDataUrl, remoteRel } from "./guestAssets";
import { imageHooks } from "../markdown/widgets";
import { viewerHooks } from "../viewerData";
import { activeTab, collabHooks } from "../state.svelte";
import { ui } from "../ui.svelte";
import { t } from "../i18n/index.svelte";

declare module "./rpc.svelte" {
  interface RpcMethods {
    "asset.image": { params: { path: string }; result: { mime: string; data: string } };
  }
}

const CODE = /^[a-z][a-z0-9_]{0,40}$/;

registerMethod({
  name: "asset.image",
  capability: null, // whoever can read the project can see its images
  validate: (raw) => (isObj(raw) && typeof raw.path === "string" && raw.path.length <= 4096 ? { path: raw.path } : null),
  handle: async ({ path }, { signal }) => {
    const scope = guestScope();
    if (!scope || !path || !(await scope.check(path)) || !scope.live()) throw new RpcFail("asset_refused");
    if (signal.aborted) throw new RpcFail("asset_refused");
    try {
      return await invoke<{ mime: string; data: string }>("collab_read_image", { root: scope.root, rel: path });
    } catch (e) {
      throw new RpcFail(CODE.test(String(e)) ? String(e) : "asset_missing");
    }
  },
});

const cache = new AssetCache(48 * 1024 * 1024);
const loading = new Map<string, Promise<string | null>>();
let cachedGen = -1;

function fetchImage(rel: string): Promise<string | null> {
  // The host's files changed: what's cached may be stale or no longer allowed.
  if (cachedGen !== share.treeGen) {
    cachedGen = share.treeGen;
    cache.clear();
  }
  const hit = cache.get(rel);
  if (hit) return Promise.resolve(hit);
  let p = loading.get(rel);
  if (!p) {
    const gen = share.treeGen;
    p = call("asset.image", { path: rel }, { timeoutMs: 20_000 }).then((r) => {
      loading.delete(rel);
      const url = r.ok ? imageDataUrl(r.value?.mime, r.value?.data) : null;
      if (url && gen === share.treeGen) cache.set(rel, url);
      return url;
    });
    loading.set(rel, p);
  }
  return p;
}

imageHooks.load = (img, rel) => {
  if (!rel) return void img.classList.add("broken");
  void fetchImage(rel).then((url) => {
    if (url) img.src = url;
    else img.classList.add("broken");
  });
};

viewerHooks.remoteImage = fetchImage;

sessionEndHooks.push(() => {
  cache.clear();
  loading.clear();
});

/** How long a linked file may take to open before its #heading is given up on. */
const OPEN_WAIT_MS = 4000;

collabHooks.openLink = async (href, from, jumpToHeading) => {
  let rel = remoteRel(href, from);
  if (!rel) return ui.toast(t("ai.collab.linkOutside"), "error");
  const slash = rel.lastIndexOf("/");
  const dir = slash < 0 ? "" : rel.slice(0, slash);
  const listed = await call("fs.list", { path: dir }, { timeoutMs: 10_000 });
  const entries = listed.ok ? listed.value : [];
  let entry = entries.find((e) => e.rel === rel);
  if (!entry) {
    entry = entries.find((e) => e.rel === `${rel}.md`);
    if (entry) rel = entry.rel;
  }
  if (!entry) return ui.toast(t("app.fileNotFound", { path: rel }), "error");
  if (entry.is_dir) return ui.toast(t("app.linkIsFolder", { path: rel }), "error");
  await openRemote(rel);
  const hash = href.indexOf("#");
  if (hash < 0 || href.length <= hash + 1) return;
  const target = `collab:${rel}`;
  for (const end = Date.now() + OPEN_WAIT_MS; Date.now() < end; await new Promise((r) => setTimeout(r, 60))) {
    if (activeTab()?.path === target) return jumpToHeading(href.slice(hash + 1));
  }
};
