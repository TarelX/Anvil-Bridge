"use strict";
let __ptyOk;
function ptyAvailable() {
  if (__ptyOk === void 0) {
    try { require("node-pty"); __ptyOk = !0; } catch { __ptyOk = !1; }
  }
  return __ptyOk;
}
var { spawn } = require("node:child_process"),
  crypto = require("node:crypto"),
  { PtyShell } = require("./pty-shell"),
  { terminateTree } = require("./process-tree"),
  { shellFor } = require("./shell"),
  sleep = (t) => new Promise((e) => setTimeout(e, t)),
  Commands = class {
    constructor(e, r, n, o) {
      ((this.files = e),
        (this.vscode = r),
        (this.event = n),
        (this.accessState = o),
        (this.jobs = new Map()),
        (this.terminals = new Map()),
        (this.preparing = 0),
        (this.closingTasks = new Set()),
        (this.disposed = !1),
        (this.pruner = setInterval(() => {
          for (let s of this.terminals.values())
            s.state === "idle" && Date.now() - s.lastUsed > 30 * 6e4 && this.closePty(s, "idle timeout");
        }, 6e4)),
        this.pruner.unref?.());
    }
    enabled() {
      return (
        !this.disposed &&
        (this.accessState().mode === "full" ||
          this.vscode.workspace.getConfiguration("lanternBridge").get("enableCommands", !1))
      );
    }
    shellPreference() {
      return this.vscode.workspace.getConfiguration("lanternBridge").get("windowsShell", "auto");
    }
    owned(e, r) {
      let n = this.jobs.get(e);
      if (!n || n.owner !== r.id) throw Error("Unknown command for this session");
      return n;
    }
    terminal(e, r) {
      let n = this.terminals.get(e);
      if (!n || n.owner !== r.id) throw Error("Unknown terminal for this session");
      return n;
    }
    capacity() {
      if ([...this.jobs.values()].filter((e) => e.running).length + this.preparing >= 3)
        throw Error("Three command slots are occupied; read output or stop an existing command first");
      for (; this.jobs.size >= 60;) {
        let e = [...this.jobs.values()].find((r) => !r.running && !r.cleanupPending);
        if (!e) throw Error("Command history is full");
        this.jobs.delete(e.id);
      }
    }
    newJob(e, r, n, o = null) {
      let s,
        i = new Promise((c) => {
          s = c;
        }),
        a = {
          id: crypto.randomUUID(),
          owner: e.id,
          execution: r,
          background: n,
          terminal: o,
          running: !0,
          state: "starting",
          started: !1,
          created: Date.now(),
          text: "",
          base: 0,
          exitCode: null,
          signal: null,
          reason: null,
          done: i,
          resolveDone: s,
          cleanupPending: !1,
          stopRequested: !1,
        };
      return (this.jobs.set(a.id, a), a);
    }
    append(e, r) {
      if (((e.text += r), e.text.length > 131072)) {
        let n = e.text.length - 131072;
        ((e.text = e.text.slice(n)), (e.base += n));
      }
    }
    finish(e, r, n = null) {
      e.running &&
        ((e.running = !1),
        (e.exitCode = r),
        (e.signal = n),
        (e.ended = Date.now()),
        clearTimeout(e.timer),
        clearTimeout(e.stopTimer),
        clearTimeout(e.startTimer),
        (e.state =
          e.reason === "command lifetime exceeded"
            ? "timed_out"
            : e.stopRequested
              ? "cancelled"
              : r === 0
                ? "completed"
                : "failed"),
        e.resolveDone(),
        this.event(
          "Command finished",
          `${e.id.slice(0, 8)} / ${e.execution} / ${e.state} / exit ${r ?? n ?? "unknown"}`,
          {
            kind: "outcome",
            command_id: e.id,
            command_text: e.command,
            output: e.text.slice(-4e3),
            status: e.state,
            exit_code: r,
            reason: e.reason || n,
            isError: ["failed", "timed_out"].includes(e.state) || (Number.isInteger(r) && r !== 0),
          },
        ));
    }
    arm(e, r) {
      ((e.timeoutMs = r),
        (e.timer = setTimeout(() => this.stopJob(e, "command lifetime exceeded", !0), r)),
        e.timer.unref?.());
    }
    async run(e, r, n, o, s) {
      if ((o(), !this.enabled())) throw Error("Shell execution is disabled");
      this.capacity();
      let i = e.execution || (ptyAvailable() ? "pty" : "direct");
      if (i === "pty" && !ptyAvailable())
        throw Error("PTY is unavailable on this platform (" + process.platform + "-" + process.arch + '); use execution:"direct" or omit execution to fall back automatically.');
      if (i === "direct" && e.terminal_id) throw Error("terminal_id only applies to PTY");
      if (i === "direct" && (e.cols || e.rows)) throw Error("direct has no terminal dimensions");
      let a = null;
      if (i === "pty")
        if (e.terminal_id) {
          if (((a = this.terminal(e.terminal_id, r)), a.state !== "idle"))
            throw Error("Terminal is busy or closed; use send_command_input or choose another terminal");
        } else
          e.background ||
            (a =
              [...this.terminals.values()]
                .filter((f) => f.owner === r.id && f.state === "idle" && !f.backgroundDedicated)
                .sort((f, p) => p.lastUsed - f.lastUsed)[0] || null);
      let c;
      if (
        (e.cwd !== void 0
          ? (c = await this.files.resolve(e.cwd))
          : a
            ? (c = await this.files.resolve(this.files.relative(a.cwd) || "."))
            : (c = await this.files.resolve(".")),
        o(),
        this.capacity(),
        a && a.state !== "idle")
      )
        throw Error("Terminal was reserved by another request; retry or select another terminal");
      (a && (a.state = "reserved"), this.preparing++);
      let l,
        u = !1;
      try {
        if (
          i === "pty" &&
          !a &&
          ([...this.terminals.values()].filter((p) => p.state !== "closed").length >= 6 ||
            [...this.terminals.values()].filter((p) => p.owner === r.id && p.state !== "closed").length >= 3)
        )
          throw Error("Terminal limit reached (3 per session, 6 globally); close an idle terminal");
        let f = e.timeout_ms || (e.background ? 36e5 : 12e4);
        if (
          (await n(
            "Execute command (" + i + ")",
            `Working directory: ${c}
Terminal: ${a?.id || "new"}
Background: ${e.background}
Lifetime: ${f} ms

${e.command}

Shells have OS user permissions, network and environment access; this is not a workspace sandbox.`,
          ),
          o(),
          !this.enabled())
        )
          throw Error("Command access revoked");
        if ((await this.files.resolve(this.files.relative(c) || "."), o(), i === "pty")) {
          if (a) {
            if (a.state !== "reserved") throw Error("Terminal changed during approval");
            a.state = "idle";
          } else {
            if (
              this.terminals.size >= 6 ||
              [...this.terminals.values()].filter((p) => p.owner === r.id).length >= 3
            )
              throw Error("Terminal capacity changed while awaiting approval");
            ((a = new PtyShell(
              this.vscode,
              {
                owner: r.id,
                cwd: c,
                cols: e.cols,
                rows: e.rows,
                shell: shellFor("pty", this.shellPreference()),
              },
              {
                output: (p, h) => this.append(p, h),
                interrupt: (p) => this.stopJob(p, "local interrupt"),
                started: (p) => {
                  (clearTimeout(p.startTimer), (p.state = "running"));
                },
                done: (p, h) => this.finish(p, h),
                close: (p, h) => this.closePty(p, h),
                exit: (p, h) => {
                  (p.job && this.finish(p.job, h.exitCode ?? null, h.signal ?? null),
                    (p.job = null),
                    this.terminals.delete(p.id),
                    this.event("Terminal closed", p.id.slice(0, 8)));
                },
              },
            )),
              (a.backgroundDedicated = e.background),
              this.terminals.set(a.id, a),
              (u = !0));
            try {
              await a.start();
            } catch (p) {
              throw (
                a.state === "closed"
                  ? (this.terminals.delete(a.id), a.disposeView())
                  : this.closePty(a, "startup failed"),
                p
              );
            }
            o();
          }
          if (!this.enabled()) throw Error("Command access revoked");
          ((e.cols || e.rows) && a.resize(e.cols || a.cols, e.rows || a.rows),
            (l = this.newJob(r, i, e.background, a)),
            (l.requestId = s),
            (l.command = e.command),
            this.arm(l, f),
            (l.startTimer = setTimeout(() => {
              !l.started && l.running && this.stopJob(l, "command start marker timeout", !0);
            }, 15e3)),
            a.execute(l, e.command, e.cwd !== void 0 ? c : null),
            e.show && a.show());
        } else {
          ((l = this.newJob(r, i, e.background)), (l.requestId = s), (l.command = e.command));
          let p = process.platform === "win32",
            h = shellFor("direct", this.shellPreference());
          ((l.shell = h),
            (l.child = spawn(h.path, [...h.args, e.command], {
              cwd: c,
              windowsHide: !0,
              detached: !p,
              stdio: ["pipe", "pipe", "pipe"],
            })),
            (l.pid = l.child.pid),
            (l.started = !0),
            (l.state = "running"),
            this.arm(l, f));
          for (let m of [l.child.stdout, l.child.stderr])
            (m.setEncoding("utf8"), m.on("data", (g) => this.append(l, g)));
          (l.child.stdin.on("error", (m) =>
            this.append(
              l,
              `
[stdin: ${m.message}]
`,
            ),
          ),
            l.child.on("error", (m) => {
              (this.append(
                l,
                `
[spawn failed: ${m.message}]`,
              ),
                this.finish(l, null, "spawn-error"));
            }),
            l.child.on("close", (m, g) => this.finish(l, m, g)));
        }
        this.event(
          "Command started",
          `${l.id.slice(0, 8)} / ${i}${a ? " / terminal " + a.id.slice(0, 8) : ""}`,
          {
            kind: "outcome",
            command_id: l.id,
            command_text: l.command,
            status: l.state,
            exit_code: l.exitCode,
            reason: l.reason || l.signal,
            isError:
              ["failed", "timed_out"].includes(l.state) || (Number.isInteger(l.exitCode) && l.exitCode !== 0),
          },
        );
      } catch (f) {
        throw (
          l
            ? l.terminal
              ? this.closePty(l.terminal, "launch failed")
              : l.child
                ? this.stopJob(l, "launch failed", !0)
                : this.finish(l, null, "spawn-error")
            : u && a && this.closePty(a, "launch cancelled"),
          f
        );
      } finally {
        (this.preparing--, a?.state === "reserved" && (a.state = "idle"));
      }
      let d = e.wait_ms === void 0 ? (e.background ? 0 : 1e4) : e.wait_ms;
      if (d > 0 && l.running) {
        let f;
        (await Promise.race([
          l.done,
          new Promise((p) => {
            f = setTimeout(p, d);
          }),
        ]),
          clearTimeout(f));
      }
      return this.output({ command_id: l.id }, r);
    }
    output(e, r) {
      let n = this.owned(e.command_id, r),
        o = e.offset || 0,
        s = Math.min(Math.max(o - n.base, 0), n.text.length),
        i = n.text.slice(s, s + (e.max_chars || 16e3)),
        a = n.terminal?.shellInfo || n.shell || null;
      return {
        command_id: n.id,
        execution: n.execution,
        terminal_id: n.terminal?.id || null,
        terminal_state: n.terminal?.state || null,
        terminal_cwd: n.terminal?.cwd || null,
        shell: a?.name || null,
        shell_hint: a?.hint || null,
        running: n.running,
        status: n.state,
        exit_code: n.exitCode,
        signal: n.signal,
        reason: n.reason,
        cleanup_pending: n.cleanupPending,
        elapsed_ms: (n.ended || Date.now()) - n.created,
        output: i,
        next_offset: n.base + s + i.length,
        first_available_offset: n.base,
        truncated_before_offset: o < n.base,
        next_action: n.running
          ? "Command is still running. Poll get_command_output, send input, or stop_command. Do not launch it again."
          : "Command finished. Read remaining output; an idle PTY can be reused.",
      };
    }
    async input(e, r, n, o) {
      let s = this.owned(e.command_id, r);
      if (!s.running || s.stopRequested) throw Error("Command is not accepting input");
      if (!this.enabled()) throw Error("Command input disabled");
      if (
        (await n(
          "Send command input",
          `Command ${s.id}

${e.input}`,
        ),
        o(),
        (s = this.owned(e.command_id, r)),
        !this.enabled() || !s.running || s.stopRequested)
      )
        throw Error("Input permission or command state changed");
      if (s.execution === "pty" && e.input === "")
        return (this.stopJob(s, "remote interrupt"), { interrupt_requested: !0, command_id: s.id });
      let i =
        e.input +
        (e.append_newline === !1
          ? ""
          : s.execution === "pty"
            ? "\r"
            : `
`);
      if (s.execution === "pty") s.terminal.input(i);
      else {
        if (!s.child.stdin.writable) throw Error("stdin is closed");
        await new Promise((a, c) => s.child.stdin.write(i, (l) => (l ? c(l) : a())));
      }
      return { sent: !0, command_id: s.id, execution: s.execution };
    }
    stopJob(e, r = "stop requested", n = !1) {
      if (e.running && !(e.stopRequested && !n))
        if (((e.stopRequested = !0), (e.reason = r), (e.state = "stopping"), e.execution === "pty"))
          if (n || !e.started) this.closePty(e.terminal, r);
          else {
            try {
              e.terminal.input("");
            } catch {
              this.closePty(e.terminal, r);
            }
            e.stopTimer = setTimeout(() => {
              e.running && this.closePty(e.terminal, r);
            }, 1500);
          }
        else
          e.cleanupPending ||
            ((e.cleanupPending = !0),
            this.track(
              terminateTree(e.pid, () => {
                try {
                  e.child.kill("SIGKILL");
                } catch {}
              }).finally(() => {
                ((e.cleanupPending = !1),
                  e.running &&
                    (this.append(
                      e,
                      `
[Termination requested; OS exit not yet confirmed.]
`,
                    ),
                    (e.state = "termination_unconfirmed")));
              }),
            ));
    }
    track(e) {
      return (this.closingTasks.add(e), e.finally(() => this.closingTasks.delete(e)).catch(() => {}), e);
    }
    closePty(e, r = "terminal closed") {
      if (!e || !e.markClosing()) return;
      let n = e.job;
      (n?.running &&
        ((n.stopRequested = !0), (n.reason = r), (n.state = "stopping"), (n.cleanupPending = !0)),
        this.event("Terminal closing", `${e.id.slice(0, 8)} / ${r}`),
        this.track(
          terminateTree(e.pid, () => {
            try {
              e.process?.kill();
            } catch {}
          }).finally(() => {
            if ((n && (n.cleanupPending = !1), e.state !== "closed")) {
              try {
                e.process?.kill();
              } catch {}
              e.process
                ? n?.running &&
                  ((n.state = "termination_unconfirmed"),
                  this.append(
                    n,
                    `
[PTY termination requested; awaiting OS exit.]
`,
                  ))
                : ((e.state = "closed"), this.terminals.delete(e.id), e.disposeView());
            }
          }),
        ));
    }
    stop(e, r) {
      let n = this.owned(e.command_id, r);
      return (this.stopJob(n, "stop requested", !!e.force), this.output({ command_id: n.id }, r));
    }
    list(e) {
      return {
        terminals: [...this.terminals.values()]
          .filter((r) => r.owner === e.id)
          .map((r) => ({
            terminal_id: r.id,
            status: r.state,
            cwd: r.cwd,
            shell: r.shellInfo?.name || null,
            shell_path: r.shell,
            shell_hint: r.shellInfo?.hint || null,
            pid: r.pid,
            cols: r.cols,
            rows: r.rows,
            active_command_id: r.job?.running ? r.job.id : null,
            background_dedicated: !!r.backgroundDedicated,
          })),
        max_terminals_per_session: 3,
        max_terminals_global: 6,
      };
    }
    resize(e, r) {
      let n = this.terminal(e.terminal_id, r);
      if (["closing", "closed"].includes(n.state)) throw Error("Terminal is closing");
      return (n.resize(e.cols, e.rows), { resized: !0, terminal_id: n.id, cols: n.cols, rows: n.rows });
    }
    close(e, r) {
      let n = this.terminal(e.terminal_id, r);
      return (this.closePty(n), { close_requested: !0, terminal_id: n.id });
    }
    async showPicker() {
      let e = [...this.terminals.values()].filter((n) => !["closed", "closing"].includes(n.state));
      if (!e.length) {
        this.vscode.window.showInformationMessage("当前没有持久 PTY；先通过 run_command 创建终端。");
        return;
      }
      (
        await this.vscode.window.showQuickPick(
          e.map((n) => ({
            label: `PTY ${n.id.slice(0, 8)} \xB7 ${n.state}`,
            description: n.cwd,
            terminal: n,
          })),
          { title: "Anvil Bridge — 持久终端" },
        )
      )?.terminal.show();
    }
    releaseRequest(e, r) {
      for (let n of this.jobs.values()) n.owner === e.id && n.requestId === r && delete n.requestId;
    }
    cancelRequest(e, r) {
      for (let n of this.jobs.values())
        n.owner === e.id && n.requestId === r && n.running && this.stopJob(n, "request cancelled", !0);
    }
    stopSession(e) {
      for (let r of this.terminals.values()) r.owner === e.id && this.closePty(r, "session closed");
      for (let r of this.jobs.values())
        r.owner === e.id && r.execution === "direct" && this.stopJob(r, "session closed", !0);
    }
    closeAll(e = "access revoked") {
      for (let r of this.terminals.values()) this.closePty(r, e);
      for (let r of this.jobs.values()) r.execution === "direct" && this.stopJob(r, e, !0);
    }
    async dispose() {
      ((this.disposed = !0),
        clearInterval(this.pruner),
        this.closeAll("bridge stopped"),
        await Promise.race([Promise.allSettled([...this.closingTasks]), sleep(6e3)]));
    }
  };
module.exports = { Commands };
