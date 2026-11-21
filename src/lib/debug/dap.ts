/** Debug Adapter Protocol session over a proc.rs connection (stdio or TCP). */
import { invoke } from "@tauri-apps/api/core";
import { onRpc } from "../rpc";
import { t } from "../i18n/index.svelte";

type Json = any;

export class DapSession {
  readonly id: string;
  private seq = 1;
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void; command: string }>();
  capabilities: Json = {};
  alive = true;
  /** Set when this session was created by a `startDebugging` request of another session. */
  parent: DapSession | null = null;
  private off: () => void;

  constructor(
    readonly label: string,
    private handlers: {
      event: (s: DapSession, ev: Json) => void;
      reverse: (s: DapSession, req: Json) => Promise<Json>;
      exit: (s: DapSession) => void;
      stderr?: (s: DapSession, line: string) => void;
    },
  ) {
    this.id = `dap-${Math.random().toString(36).slice(2, 9)}`;
    this.off = onRpc(this.id, {
      message: (m) => this.handle(m),
      exit: () => {
        this.alive = false;
        for (const p of this.pending.values()) p.reject(new Error(t("code.dap.exited")));
        this.pending.clear();
        this.off();
        this.handlers.exit(this);
      },
      stderr: (l) => this.handlers.stderr?.(this, l),
    });
  }

  spawnStdio(cmd: string, args: string[], cwd: string | null, env?: Record<string, string>) {
    return invoke("proc_spawn", { id: this.id, cmd, args, cwd, env: env ?? null });
  }

  connect(port: number) {
    return invoke("proc_connect", { id: this.id, port });
  }

  private send(msg: Json) {
    return invoke("proc_send", { id: this.id, msg: JSON.stringify(msg) });
  }

  request<T = Json>(command: string, args?: Json, timeoutMs = 30000): Promise<T> {
    const seq = this.seq++;
    return new Promise<T>((resolve, reject) => {
      if (!this.alive) return reject(new Error(t("code.dap.sessionEnded")));
      this.pending.set(seq, { resolve, reject, command });
      this.send({ seq, type: "request", command, arguments: args }).catch((e) => {
        this.pending.delete(seq);
        reject(e);
      });
      if (timeoutMs > 0)
        setTimeout(() => {
          if (this.pending.delete(seq)) reject(Object.assign(new Error(t("code.dap.noResponse", { command })), { timeout: true }));
        }, timeoutMs);
    });
  }

  private async handle(msg: Json) {
    if (msg.type === "response") {
      const p = this.pending.get(msg.request_seq);
      if (!p) return;
      this.pending.delete(msg.request_seq);
      if (msg.success) p.resolve(msg.body ?? {});
      else p.reject(new Error(msg.body?.error?.format ?? msg.message ?? t("code.dap.requestFailed", { command: p.command })));
    } else if (msg.type === "event") {
      this.handlers.event(this, msg);
    } else if (msg.type === "request") {
      let body: Json = {};
      let success = true;
      let message: string | undefined;
      try {
        body = await this.handlers.reverse(this, msg);
      } catch (e) {
        success = false;
        message = String(e);
      }
      // The adapter may be gone by now: then nobody is waiting for this answer.
      this.send({ seq: this.seq++, type: "response", request_seq: msg.seq, command: msg.command, success, message, body }).catch(() => {});
    }
  }

  kill() {
    this.alive = false;
    invoke("proc_kill", { id: this.id });
  }
}
