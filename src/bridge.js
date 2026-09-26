"use strict";
var http = require("node:http"),
  crypto = require("node:crypto"),
  { Files } = require("./files"),
  { Commands } = require("./commands"),
  { Navigation } = require("./navigation"),
  { Skills } = require("./skills"),
  { Checkpoints } = require("./checkpoints"),
  { Git } = require("./git"),
  { tools: TOOLS, validate } = require("./tools"),
  { shellSummary } = require("./shell"),
  SESSION_IDLE_MS = 2 * 6e4,
  SESSION_MAX_IDLE_MS = 5 * 6e4,
  PRUNE_INTERVAL_MS = 2 * 6e4,
  EVENT_STORE_LIMIT = 512,
  KEEP_ALIVE_MS = 15e3,
  RETRY_INTERVAL_MS = 2e3,
  MAX_BODY_BYTES = 8 * 1024 * 1024,
  REQUEST_TIMEOUT_MS = 3e4,
  RESPONSE_BUDGET_CHARS = 2e5,
  safeEqual = (t, e) => {
    let r = Buffer.from(t || ""),
      n = Buffer.from(e || "");
    return r.length === n.length && crypto.timingSafeEqual(r, n);
  };
function toolResult(t, e = "text") {
  let r = JSON.stringify(t),
    n = e === "both" ? r.length * 2 : r.length;
  if (n > RESPONSE_BUDGET_CHARS)
    throw Error(
      `Result exceeds response budget (${n} > ${RESPONSE_BUDGET_CHARS} chars); narrow the request with paths, ranges or max_results`,
    );
  return e === "both"
    ? { content: [{ type: "text", text: r }], structuredContent: t, isError: !1 }
    : { content: [{ type: "text", text: r }], isError: !1 };
}
function toolFailure(t) {
  let e = t?.message || "Tool failed";
  return !t?.code || typeof t.code != "string"
    ? { content: [{ type: "text", text: e }], isError: !0 }
    : {
        content: [{ type: "text", text: `${t.code}: ${e}` }],
        structuredContent: { error: { code: t.code, message: e, ...(t.details || {}) } },
        isError: !0,
      };
}
var SERVER_INSTRUCTIONS = `Reuse Mcp-Session-Id for this standard Streamable HTTP session. Operate only on the selected root. Read before editing, and pass the SHA-256 versions read_files returned in expected_versions whenever they are available. Approval mode requires local approval for writes and enabled shell/stdin. Full access is local-user controlled. Shells are not sandboxed. GET streams, event replay, POST responses, DELETE, and cancellation are supported. No automatic tests or builds unless the user asks.

Tool selection:
- list_directory/find_files to discover files; find_files matches paths, not contents.
- search_files for raw text search; lsp for symbols, definitions, references and type information.
- Prefer semantic navigation over broad text search when locating code symbols.
- Do not assume an empty lsp result means a symbol does not exist.
- lsp incoming_calls before changing a signature, to find callers a text search would miss.
- read_files before editing; apply_patch for every workspace change.
- git_status/git_diff for structured source control state; never parse git text output from run_command.
- get_diagnostics to inspect errors structurally instead of parsing compiler output.
- run_command for builds, tests and scripts; always choose background explicitly.
- get_command_output/send_command_input/stop_command to drive a running command; never relaunch it.
- set_todos for durable task state, report_progress for what you are doing right now.
- skill with no arguments to see bundled expert workflows; load one before non-trivial review, debugging or refactoring work.

Task coordination:
- Use set_todos for multi-step work, significant replanning, or validation workflows.
- Send the complete ordered todo list whenever task state changes.
- Keep at most one todo in_progress.
- Use stable todo IDs across updates.
- Keep todos at the goal level; do not create one todo per tool call.
- Send an empty todo list when the task state should be cleared.
- Report meaningful progress periodically during long work, but avoid progress updates for every tool call.

Failure recovery:
- Reread affected files after stale patch or context-mismatch failures before retrying; never retry the same patch blindly.
- Prefer small, focused patches with enough unique context.
- After a STALE_FILE rejection, re-read the file and regenerate the patch with refreshed expected_versions.
- If a result exceeds the response budget, narrow the request with paths, ranges or max_results instead of repeating it.
- Reinitialize the session if it is reported unknown or expired; an aborted request leaves the workspace unchanged.`,
  MemoryEventStore = class {
    constructor(e = EVENT_STORE_LIMIT) {
      ((this.limit = e), (this.events = new Map()), (this.order = []), (this.sequence = 0));
    }
    async storeEvent(e, r) {
      let n = `${Date.now().toString(36)}-${(++this.sequence).toString(36)}-${crypto.randomUUID()}`;
      for (
        this.events.set(n, { streamId: e, message: r }), this.order.push(n);
        this.order.length > this.limit;
      ) {
        let o = this.order.shift();
        o && this.events.delete(o);
      }
      return n;
    }
    async replayEventsAfter(e, { send: r }) {
      let n = this.events.get(e);
      if (!n) return "";
      let o = !1;
      for (let s of this.order) {
        if (s === e) {
          o = !0;
          continue;
        }
        if (!o) continue;
        let i = this.events.get(s);
        i?.streamId === n.streamId && (await r(s, i.message));
      }
      return n.streamId;
    }
  },
  Bridge = class {
    constructor(e, r, n) {
      ((this.vscode = e),
        (this.root = r),
        (this.hooks = n),
        (this.token = crypto.randomBytes(32).toString("hex")),
        (this.sessions = new Map()),
        (this.sockets = new Set()),
        (this.running = !1),
        (this.port = null),
        (this.publicHost = null),
        (this.writeQueue = Promise.resolve()),
        (this.inFlight = 0),
        (this.sdk = null),
        (this.files = new Files(r, e)),
        (this.commands = new Commands(this.files, e, n.event, n.accessState)),
        (this.nav = new Navigation(e, this.files)),
        (this.git = new Git(r, this.files)),
        (this.skills = new Skills(n.skillsDir)),
        (this.checkpoints = new Checkpoints(r, n.storageDir, n.event)));
    }
    async loadSdk() {
      return (
        this.sdk ||
          (this.sdk = Promise.all([
            import("@modelcontextprotocol/sdk/server/index.js"),
            import("@modelcontextprotocol/sdk/server/streamableHttp.js"),
            import("@modelcontextprotocol/sdk/types.js"),
          ]).then(([e, r, n]) => ({
            Server: e.Server,
            StreamableHTTPServerTransport: r.StreamableHTTPServerTransport,
            ...n,
          }))),
        this.sdk
      );
    }
    url(e) {
      return `${e || `http://127.0.0.1:${this.port}`}/mcp/${this.token}`;
    }
    runningCommands(e) {
      return [...this.commands.jobs.values()].filter((r) => r.owner === e.id && r.running).length;
    }
    sessionState(e, r = Date.now()) {
      return e.initialized
        ? e.busy || this.runningCommands(e)
          ? "working"
          : r - e.last < PRUNE_INTERVAL_MS
            ? "recent"
            : "idle"
        : "initializing";
    }
    summary() {
      let e = Date.now();
      return [...this.sessions.values()].map((r) => ({
        id: r.id.slice(0, 8),
        client: r.client,
        initialized: r.initialized,
        state: this.sessionState(r, e),
        created: r.created,
        last: r.last,
        lastTool: r.lastTool,
        toolCalls: r.toolCalls,
        runningCommands: this.runningCommands(r),
        tasks: r.tasks,
        progress: r.progress,
        phase: r.phase,
        percent: r.percent,
        todoId: r.todoId,
        tasksUpdatedAt: r.tasksUpdatedAt || 0,
        progressUpdatedAt: r.progressUpdatedAt || 0,
      }));
    }
    pruneSessions() {
      let e = Date.now();
      for (let r of this.sessions.values())
        r.busy ||
          r.streams ||
          (!r.initialized && e - r.created >= SESSION_IDLE_MS
            ? this.closeSession(r, "初始化超时（2 分钟）")
            : r.initialized &&
              e - r.last >= SESSION_MAX_IDLE_MS &&
              !this.runningCommands(r) &&
              this.closeSession(r, "闲置超时（5 分钟，无运行命令）"));
    }
    async start(e) {
      (await this.loadSdk(),
        (this.http = http.createServer((r, n) => {
          this.handle(r, n).catch((o) => {
            (this.hooks.event("Server error", o?.message || "Request failed"),
              !n.headersSent && !n.destroyed
                ? this.reply(n, 500, { error: "Internal bridge error" })
                : n.destroy());
          });
        })),
        (this.http.headersTimeout = 1e4),
        (this.http.requestTimeout = 0),
        (this.http.keepAliveTimeout = 5e3),
        this.http.on("connection", (r) => {
          if (this.sockets.size >= 40) {
            r.destroy();
            return;
          }
          (this.sockets.add(r), r.on("close", () => this.sockets.delete(r)));
        }),
        await new Promise((r, n) => {
          (this.http.once("error", n),
            this.http.listen(e, "127.0.0.1", () => {
              (this.http.removeListener("error", n), r());
            }));
        }),
        this.http.on("error", () => {
          (this.hooks.event("Server error", "Stopping bridge"), this.stop());
        }),
        (this.port = this.http.address().port),
        (this.running = !0),
        (this.pruner = setInterval(() => {
          (this.pruneSessions(), this.sessions.size && this.hooks.changed());
        }, 15e3)),
        this.pruner.unref?.(),
        this.hooks.changed());
    }
    reply(e, r, n, o = {}) {
      e.destroyed ||
        e.writableEnded ||
        (e.writeHead(r, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          ...o,
        }),
        e.end(n === void 0 ? void 0 : JSON.stringify(n)));
    }
    async body(e) {
      return new Promise((r, n) => {
        let o = 0,
          s = [],
          i = !1,
          a = (l) => {
            i || ((i = !0), clearTimeout(c), n(l));
          },
          c = setTimeout(() => {
            (a(Error(`Request body timeout after ${REQUEST_TIMEOUT_MS / 1e3}s`)), e.destroy());
          }, REQUEST_TIMEOUT_MS);
        (e.on("data", (l) => {
          ((o += l.length),
            o > MAX_BODY_BYTES
              ? (a(
                  Error(
                    `Request body exceeds ${MAX_BODY_BYTES / 1048576} MiB; split the patch into smaller batches`,
                  ),
                ),
                e.destroy())
              : s.push(l));
        }),
          e.on("error", a),
          e.on("aborted", () => a(Error("Request aborted"))),
          e.on("end", () => {
            if (!i) {
              ((i = !0), clearTimeout(c));
              try {
                r(JSON.parse(Buffer.concat(s).toString("utf8")));
              } catch {
                n(Error("Invalid JSON"));
              }
            }
          }));
      });
    }
    cors(e) {
      (e.setHeader("Access-Control-Allow-Origin", "*"),
        e.setHeader(
          "Access-Control-Allow-Headers",
          "content-type, accept, mcp-session-id, mcp-protocol-version, mcp-method, mcp-name, last-event-id, authorization",
        ),
        e.setHeader("Access-Control-Expose-Headers", "mcp-session-id"),
        e.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS"),
        e.setHeader("Cache-Control", "no-store"),
        e.setHeader("X-Accel-Buffering", "no"));
    }
    newSession(e) {
      let r = Date.now();
      return {
        created: r,
        lastTool: null,
        toolCalls: 0,
        clientVersion: String(e?.params?.clientInfo?.version || "").slice(0, 80),
        id: crypto.randomUUID(),
        initialized: !1,
        client: String(e?.params?.clientInfo?.name || "Unknown client").slice(0, 100),
        last: r,
        tasks: [],
        progress: "",
        phase: "",
        percent: null,
        todoId: null,
        busy: 0,
        streams: 0,
        count: 0,
        window: r,
        alive: !0,
        transport: null,
        server: null,
      };
    }
    async createSession(e) {
      let {
          Server: r,
          StreamableHTTPServerTransport: n,
          ListToolsRequestSchema: o,
          CallToolRequestSchema: s,
        } = await this.loadSdk(),
        i = this.newSession(e),
        a = shellSummary(this.vscode.workspace.getConfiguration("lanternBridge").get("windowsShell", "auto")),
        c = new r(
          { name: "anvil-bridge", version: require("../package.json").version },
          {
            capabilities: { tools: {} },
            instructions: `${SERVER_INSTRUCTIONS}

Host shell:
- ${a}
- Every run_command / get_command_output result also carries shell and shell_hint.`,
          },
        ),
        l;
      ((l = new n({
        sessionIdGenerator: () => i.id,
        enableJsonResponse: !1,
        eventStore: new MemoryEventStore(),
        keepAliveMs: KEEP_ALIVE_MS,
        retryInterval: RETRY_INTERVAL_MS,
        onsessioninitialized: () => {
          ((i.initialized = !0),
            (i.last = Date.now()),
            this.hooks.event("会话初始化完成", `${i.id.slice(0, 8)} \xB7 ${i.client}`),
            this.hooks.changed());
        },
        onsessionclosed: () => this.closeSession(i, "客户端关闭传输"),
      })),
        (i.server = c),
        (i.transport = l),
        c.setRequestHandler(o, async () => ({ tools: TOOLS })),
        c.setRequestHandler(s, async (d, f) =>
          this.callTool(i, d.params.name, d.params.arguments || {}, f?.signal),
        ),
        (l.onclose = () => {
          i.alive && this.closeSession(i, "传输已关闭");
        }),
        this.sessions.set(i.id, i));
      let u = [...this.sessions.values()].filter((d) => d !== i && d.client === i.client).length;
      return (
        this.hooks.event(
          "会话已创建",
          `${i.id.slice(0, 8)} \xB7 ${i.client} ${i.clientVersion}${u ? ` \xB7 另有 ${u} 个同名会话` : ""}`,
        ),
        this.hooks.changed(),
        await c.connect(l),
        i
      );
    }
    async callTool(e, r, n, o) {
      this.hooks.toolCalled?.();
      let s = TOOLS.find((d) => d.name === r);
      if (!s) return { content: [{ type: "text", text: "Unknown tool" }], isError: !0 };
      try {
        validate(n, s.inputSchema);
      } catch (d) {
        return { content: [{ type: "text", text: d.message }], isError: !0 };
      }
      let i = Date.now();
      ((e.last = Date.now()),
        (e.lastTool = e.last),
        e.toolCalls++,
        e.busy++,
        e.toolCalls === 1 &&
          this.hooks.event("会话首次调用工具", `${e.id.slice(0, 8)} \xB7 ${e.client} \xB7 ${r}`));
      let a = crypto.randomUUID(),
        c,
        l = () => this.commands.cancelRequest(e, a);
      o?.addEventListener("abort", l, { once: !0 });
      let u = () => {
        if (o?.aborted || !this.running || !e.alive || !this.vscode.workspace.isTrusted)
          throw Error("Session revoked, request cancelled, or workspace untrusted");
        if (c !== void 0 && c !== this.hooks.accessState().revision)
          throw Error("Access mode changed; request must be submitted again");
      };
      try {
        u();
        let d = async (w, z) => {
            ((c = (await this.hooks.approve(e, w, z, u, r)).revision), u());
          },
          f = () => (u(), this.dispatch(r, n, e, d, u, a)),
          p;
        if (r === "apply_patch") {
          let w = this.writeQueue.then(async () => {
            let z = this.describe(r, n),
              x = z?.title ? `修改前快照 \xB7 ${z.title}` : "修改前快照",
              S = null;
            this.files.beforeWrite = async (Ie) => {
              S || (S = await this.checkpoints.capture(x, Ie));
            };
            let R;
            try {
              R = await f();
            } finally {
              this.files.beforeWrite = null;
            }
            return {
              ...R,
              checkpoint: S
                ? { ...S, created: !0 }
                : { created: !1, error: this.checkpoints.lastError || "没有可快照的文件" },
            };
          });
          ((this.writeQueue = w.catch(() => {})), (p = await w));
        } else p = await f();
        u();
        let h = toolResult(p, this.hooks.resultMode?.() || "text"),
          m = this.describe(r, n),
          g =
            r === "search_files" && Array.isArray(p.matches)
              ? {
                  kind: "search",
                  root: this.root,
                  pattern: n.pattern,
                  scope: n.path || ".",
                  mode: p.mode,
                  durationMs: Math.max(0, Date.now() - i),
                  matchCount: p.matches.length,
                  fileCount: new Set(p.matches.map((w) => w.path)).size,
                  truncated: !!p.truncated,
                  previewOmitted: Math.max(0, p.matches.length - 20),
                  matches: p.matches.slice(0, 20).map((w) => ({
                    path: String(w.path),
                    line: w.line,
                    column: w.column,
                    snippet: String(w.snippet || "").slice(0, 500),
                  })),
                }
              : void 0,
          y = p && typeof p.command_id == "string" && typeof p.status == "string",
          b = {
            kind: "outcome",
            isError:
              h.isError === !0 ||
              !!(
                y &&
                (["failed", "timed_out", "termination_unconfirmed"].includes(p.status) ||
                  (p.running === !1 && Number.isInteger(p.exit_code) && p.exit_code !== 0))
              ),
          };
        return (
          y &&
            Object.assign(b, {
              command_id: p.command_id,
              status: p.status,
              exit_code: p.exit_code,
              reason: p.reason || p.signal || null,
            }),
          this.hooks.event(m?.title || "Tool completed", m?.detail || r, g || b),
          h
        );
      } catch (d) {
        let f = { kind: "outcome", isError: !0, message: String(d?.message || "Tool failed").slice(0, 500) },
          p =
            r === "run_command"
              ? [...this.commands.jobs.values()].find((h) => h.owner === e.id && h.requestId === a)
              : null;
        return (
          p &&
            Object.assign(f, {
              command_id: p.id,
              command_text: p.command,
              status: p.state,
              exit_code: p.exitCode,
              reason: p.reason || p.signal || null,
            }),
          this.hooks.event("Tool failed", d?.code ? `${r} \xB7 ${d.code}` : r, f),
          toolFailure(d)
        );
      } finally {
        (o?.removeEventListener("abort", l),
          this.commands.releaseRequest(e, a),
          e.busy--,
          e.alive && this.hooks.changed());
      }
    }
    async handle(e, r) {
      if (
        !new Set([`127.0.0.1:${this.port}`, `localhost:${this.port}`, this.publicHost].filter(Boolean)).has(
          e.headers.host,
        )
      ) {
        this.reply(r, 403, { error: "Host rejected" });
        return;
      }
      let o = (e.url || "").split("?")[0],
        s = e.headers.authorization,
        i = o.startsWith("/mcp/") && safeEqual(o.slice(5), this.token),
        a = o === "/mcp" && typeof s == "string" && safeEqual(s, `Bearer ${this.token}`);
      if (!this.running || !(i || a)) {
        this.reply(r, 404, { error: "Not found" });
        return;
      }
      if ((this.cors(r), e.method === "OPTIONS")) {
        r.writeHead(204).end();
        return;
      }
      let c = typeof e.headers["mcp-session-id"] == "string" ? e.headers["mcp-session-id"] : null,
        l = c ? this.sessions.get(c) : null;
      if (c && !l) {
        this.reply(r, 404, { error: "Unknown or expired session; initialize again" });
        return;
      }
      if (!["POST", "GET", "DELETE"].includes(e.method)) {
        this.reply(r, 405, { error: "Method not allowed" }, { Allow: "POST, GET, DELETE, OPTIONS" });
        return;
      }
      if (e.method === "POST") {
        if (!String(e.headers["content-type"]).toLowerCase().startsWith("application/json")) {
          this.reply(r, 415, { error: "Expected application/json" });
          return;
        }
        if (this.inFlight >= 15 || (l?.busy || 0) >= 15) {
          this.reply(r, 429, { error: "Too many in-flight requests" }, { "Retry-After": "1" });
          return;
        }
        let u;
        try {
          u = await this.body(e);
        } catch (d) {
          this.reply(r, 400, { error: d.message });
          return;
        }
        if (!l) {
          if (u?.method !== "initialize" || u?.jsonrpc !== "2.0" || !Object.hasOwn(u, "id")) {
            this.reply(r, 400, { error: "POST without Mcp-Session-Id must be initialize" });
            return;
          }
          if ((this.pruneSessions(), this.sessions.size >= 8)) {
            this.reply(r, 429, { error: "Session limit reached" });
            return;
          }
          l = await this.createSession(u);
        }
        if ((Date.now() - l.window >= 6e4 && ((l.window = Date.now()), (l.count = 0)), ++l.count > 180)) {
          this.reply(r, 429, { error: "Session request rate exceeded" });
          return;
        }
        (this.inFlight++, (l.last = Date.now()));
        try {
          await l.transport.handleRequest(e, r, u);
        } catch (d) {
          (r.headersSent || this.reply(r, 500, { error: d.message }),
            l.initialized || this.closeSession(l, "初始化失败"));
        } finally {
          (this.inFlight--, l.alive && this.hooks.changed());
        }
        return;
      }
      if (!l) {
        this.reply(r, 400, { error: "Mcp-Session-Id header is required" });
        return;
      }
      if (((l.last = Date.now()), e.method === "GET")) {
        l.streams++;
        let u = !1,
          d = () => {
            u || ((u = !0), l.streams--, (l.last = Date.now()));
          };
        r.once("close", d);
        try {
          await l.transport.handleRequest(e, r);
        } finally {
          (r.off("close", d), d());
        }
        return;
      }
      (await l.transport.handleRequest(e, r), l.alive && this.closeSession(l, "客户端 DELETE"));
    }
    describe(e, r) {
      let n = (o) => String(o).split(/[\\/]/).pop();
      if (e === "read_files") {
        let o = [...new Set((r.files || []).map((i) => i.path))];
        return o.length
          ? {
              title: o.length === 1 ? `读取 ${n(o[0])}` : `读取 ${o.length} 个文件`,
              detail: o.join(`
`),
            }
          : null;
      }
      if (e === "apply_patch") {
        let o = [],
          s = 0,
          i = 0,
          a = null,
          c = new Map();
        for (let f of String(r.patch || "").split(`
`)) {
          let p = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(f);
          if (p) {
            ((a = p[2].trim()), c.set(a, { a: 0, d: 0, action: p[1] }));
            continue;
          }
          let h = /^\*\*\* Move to: (.+)$/.exec(f);
          if (h) {
            a && c.has(a) && (c.get(a).move_to = h[1].trim());
            continue;
          }
          f.startsWith("***") ||
            f.startsWith("@@") ||
            !a ||
            (f.startsWith("+") ? (s++, c.get(a).a++) : f.startsWith("-") && (i++, c.get(a).d++));
        }
        if (!c.size) return null;
        let l = [...c.keys()];
        for (let [f, p] of c)
          o.push(
            `${f}${p.move_to ? " → " + p.move_to : ""}  ${p.action === "Delete" ? "已删除" : p.move_to && !p.a && !p.d ? "已重命名" : `+${p.a} -${p.d}`}`,
          );
        let u = c.size === 1 && [...c.values()][0].move_to;
        return {
          title:
            l.length === 1 ? `${u && !s && !i ? "重命名" : "编辑"} ${n(l[0])}` : `编辑 ${l.length} 个文件`,
          detail: [`+${s} -${i}`, ...o].join(`
`),
        };
      }
      return e === "search_files"
        ? {
            title: `搜索 "${r.pattern}"`,
            detail: r.path ? `路径: ${r.path}` : "工作区根目录",
          }
        : e === "find_files"
          ? {
              title: `查找 ${(r.patterns || []).join(", ")}`,
              detail: r.path ? `路径: ${r.path}` : "工作区根目录",
            }
          : e === "list_directory"
            ? { title: `浏览目录 ${r.path || "."}`, detail: `深度: ${r.depth || 1}` }
            : e === "run_command"
              ? { title: "执行命令", detail: r.command }
              : e === "get_diagnostics"
                ? {
                    title: "获取代码诊断",
                    detail: r.path || "工作区全部文件",
                  }
                : e === "get_file_outline"
                  ? { title: "提取代码大纲", detail: r.path || "" }
                  : e === "lsp"
                    ? {
                        title: `LSP \xB7 ${r.operation}`,
                        detail: r.path ? `${r.path}${r.line ? `:${r.line}` : ""}` : "",
                      }
                    : e === "skill"
                      ? r.name
                        ? { title: `加载技能 \xB7 ${r.name}`, detail: "" }
                        : { title: "查看技能索引", detail: "" }
                      : e === "git_status"
                        ? {
                            title: "读取版本状态",
                            detail: r.include_diff_stat ? "含改动行数统计" : "只读",
                          }
                        : e === "git_diff"
                          ? {
                              title: `读取 ${r.staged ? "暂存区" : "工作区"} 差异`,
                              detail: r.path || "全部改动文件",
                            }
                          : null;
    }
    async dispatch(e, r, n, o, s, i) {
      switch (e) {
        case "list_directory":
          return this.files.list(r);
        case "find_files":
          return this.files.find(r);
        case "read_files":
          return this.files.read(r);
        case "search_files":
          return this.files.search(r);
        case "apply_patch":
          return this.files.patch(r, o, s);
        case "run_command":
          return this.commands.run(r, n, o, s, i);
        case "get_command_output":
          return this.commands.output(r, n);
        case "send_command_input":
          return this.commands.input(r, n, o, s);
        case "stop_command":
          return this.commands.stop(r, n);
        case "list_terminals":
          return this.commands.list(n);
        case "resize_terminal":
          return this.commands.resize(r, n);
        case "close_terminal":
          return this.commands.close(r, n);
        case "get_diagnostics":
          return this.nav.diagnostics(r);
        case "lsp":
          return this.nav.lsp(r);
        case "get_file_outline":
          return this.nav.outline(r);
        case "skill":
          return r.name ? this.skills.get(r.name) : this.skills.index();
        case "git_status":
          return this.git.status(r);
        case "git_diff":
          return this.git.diff(r);
        case "set_todos": {
          if (
            r.todos.filter((a) => a.status === "in_progress").length > 1 ||
            new Set(r.todos.map((a) => a.id)).size !== r.todos.length
          )
            throw Error("Unique task IDs and at most one in_progress task required");
          return (
            (n.tasks = r.todos),
            (n.tasksUpdatedAt = Date.now()),
            this.hooks.changed(),
            { saved: !0, tasks: r.todos }
          );
        }
        case "report_progress": {
          ((n.progress = r.message),
            (n.progressUpdatedAt = Date.now()),
            (n.phase = r.phase || ""),
            (n.percent = Number.isInteger(r.percent) ? r.percent : null));
          let a = n.tasks.filter((l) => l.status === "in_progress"),
            c = r.todo_id || (a.length === 1 ? a[0].id : null);
          return (
            (n.todoId = c && n.tasks.some((l) => l.id === c) ? c : null),
            this.hooks.changed(),
            { accepted: !0, phase: n.phase || null, percent: n.percent, todo_id: n.todoId }
          );
        }
        default:
          throw Error("Unknown tool");
      }
    }
    closeSession(e, r = "本地吊销会话") {
      !e.alive ||
        this.sessions.get(e.id) !== e ||
        ((e.alive = !1),
        this.sessions.delete(e.id),
        this.commands.stopSession(e),
        Promise.resolve(e.transport?.close?.()).catch(() => {}),
        Promise.resolve(e.server?.close?.()).catch(() => {}),
        this.hooks.event(
          "会话已关闭",
          `${e.id.slice(0, 8)} \xB7 ${e.client} \xB7 ${r} \xB7 工具调用 ${e.toolCalls} 次 \xB7 保留 ${Math.floor((Date.now() - e.created) / 1e3)} 秒`,
        ),
        this.hooks.changed());
    }
    async stop() {
      ((this.running = !1), clearInterval(this.pruner));
      for (let r of [...this.sessions.values()]) this.closeSession(r, "服务已停止");
      let e = this.commands.dispose();
      if (((this.token = crypto.randomBytes(32).toString("hex")), this.http)) {
        this.http.close();
        for (let r of this.sockets) r.destroy();
      }
      (this.hooks.changed(), await e);
    }
  };
module.exports = { Bridge, toolResult, toolFailure };
