"use strict";
var crypto = require("node:crypto"),
  OSC_PREFIX = "\x1B]633;CCMING;",
  BEL = "\x07",
  quotePwsh = (t) => "'" + t.replace(/'/g, "''") + "'",
  quotePosix = (t) => "'" + t.replace(/'/g, "'\\''") + "'",
  PtyShell = class {
    constructor(e, r, n) {
      ((this.vscode = e),
        (this.options = r),
        (this.hooks = n),
        (this.id = crypto.randomUUID()),
        (this.owner = r.owner),
        (this.cwd = r.cwd),
        (this.cols = r.cols || 100),
        (this.rows = r.rows || 30),
        (this.state = "starting"),
        (this.job = null),
        (this.buffer = ""),
        (this.lastUsed = Date.now()),
        (this.windows = process.platform === "win32"),
        (this.token = crypto.randomBytes(18).toString("hex")),
        (this.opened = !1),
        (this.mirrorBuffer = ""),
        (this.disposables = []),
        (this.ready = new Promise((o, s) => {
          ((this.resolveReady = o), (this.rejectReady = s));
        })),
        this.ready.catch(() => {}));
    }
    async start() {
      let e;
      try {
        if (process.platform === "darwin")
          try {
            let h = require("node:path").join(require.resolve("node-pty/package.json"), "..", "prebuilds", `darwin-${process.arch}`, "spawn-helper");
            require("node:fs").chmodSync(h, 0o755);
          } catch {}
        e = require("node-pty");
      } catch (s) {
        throw (
          (this.state = "closed"),
          this.rejectReady(s),
          Error(
            'PTY native module unavailable. Install runtime dependencies and package for this host platform/architecture. No silent fallback was performed; use execution:"direct" explicitly if desired.',
          )
        );
      }
      let r = this.options.shell || require("./shell").shellFor("pty"),
        n = r.path;
      ((this.shell = n), (this.shellInfo = { name: r.name, hint: r.hint }));
      try {
        ((this.process = e.spawn(n, r.args, {
          name: "xterm-256color",
          cols: this.cols,
          rows: this.rows,
          cwd: this.cwd,
          env: { ...process.env, TERM: "xterm-256color" },
          useConpty: this.windows,
        })),
          (this.pid = this.process.pid));
      } catch (s) {
        throw ((this.state = "closed"), this.rejectReady(s), Error(`PTY spawn failed: ${s.message}`));
      }
      (this.disposables.push(this.process.onData((s) => this.receive(s))),
        this.disposables.push(
          this.process.onExit((s) => {
            ((this.state = "closed"),
              clearTimeout(this.readyTimer),
              this.rejectReady(Error("PTY shell exited before handshake")),
              this.hooks.exit(this, s),
              this.disposeView());
          }),
        ),
        (this.writeEmitter = new this.vscode.EventEmitter()),
        (this.closeEmitter = new this.vscode.EventEmitter()),
        this.disposables.push(this.writeEmitter, this.closeEmitter),
        (this.view = this.vscode.window.createTerminal({
          name: `Anvil PTY ${this.id.slice(0, 6)}`,
          pty: {
            onDidWrite: this.writeEmitter.event,
            onDidClose: this.closeEmitter.event,
            open: (s) => {
              ((this.opened = !0),
                s && this.resize(s.columns, s.rows),
                this.writeEmitter.fire(this.mirrorBuffer),
                (this.mirrorBuffer = ""));
            },
            close: () => this.hooks.close(this, "closed by local user"),
            handleInput: (s) => {
              this.state === "busy" &&
                this.job?.started &&
                (s === "" ? this.hooks.interrupt(this.job) : this.process.write(s));
            },
            setDimensions: (s) => this.resize(s.columns, s.rows),
          },
        })),
        (this.readyTimer = setTimeout(() => {
          (this.rejectReady(Error("PTY shell handshake timed out")),
            this.hooks.close(this, "handshake timeout"));
        }, 12e3)));
      let o = this.windows
        ? `[Console]::Write(([char]27).ToString()+']633;CCMING;${this.token};READY;'+$PWD.Path+[char]7)`
        : `printf '\\033]633;CCMING;%s;READY;%s\\007' '${this.token}' "$PWD"`;
      return (this.process.write(o + "\r"), await this.ready, this);
    }
    emit(e) {
      e && this.job?.started && (this.hooks.output(this.job, e), this.mirror(e));
    }
    mirror(e) {
      this.opened ? this.writeEmitter?.fire(e) : (this.mirrorBuffer = (this.mirrorBuffer + e).slice(-32768));
    }
    receive(e) {
      for (this.buffer += e; ;) {
        let r = this.buffer.indexOf(OSC_PREFIX);
        if (r < 0) {
          let i = 0;
          for (let c = 1; c < OSC_PREFIX.length; c++) this.buffer.endsWith(OSC_PREFIX.slice(0, c)) && (i = c);
          let a = this.buffer.length - i;
          (this.emit(this.buffer.slice(0, a)), (this.buffer = this.buffer.slice(a)));
          return;
        }
        (this.emit(this.buffer.slice(0, r)), (this.buffer = this.buffer.slice(r)));
        let n = this.buffer.indexOf(BEL, OSC_PREFIX.length);
        if (n < 0) {
          if (this.buffer.length > 16384) {
            (this.emit(this.buffer[0]), (this.buffer = this.buffer.slice(1)));
            continue;
          }
          return;
        }
        let o = this.buffer.slice(0, n + 1),
          s = this.buffer.slice(OSC_PREFIX.length, n);
        ((this.buffer = this.buffer.slice(n + 1)), this.frame(s) || this.emit(o));
      }
    }
    frame(e) {
      let r = e.indexOf(";");
      if (r < 0) return !1;
      let n = e.slice(0, r),
        o = e.slice(r + 1);
      if (n === this.token && o.startsWith("READY;") && this.state === "starting")
        return (
          (this.cwd = o.slice(6)),
          (this.state = "idle"),
          clearTimeout(this.readyTimer),
          this.resolveReady(this),
          !0
        );
      let s = this.job;
      if (!s || n !== s.marker) return !1;
      if (o === "START") return ((s.started = !0), this.hooks.started(s), !0);
      let i = /^END;(-?\d+);([\s\S]*)$/.exec(o);
      if (i && s.started) {
        let a = Number(i[1]);
        return (
          (this.cwd = i[2]),
          (this.lastUsed = Date.now()),
          (this.job = null),
          this.state !== "closing" && this.state !== "closed" && (this.state = "idle"),
          this.hooks.done(s, Number.isSafeInteger(a) ? a : null),
          this.mirror(`\r
\x1B[90m[anvil] command finished; idle terminal retained.\x1B[0m\r
`),
          !0
        );
      }
      return !1;
    }
    execute(e, r, n) {
      if (this.state !== "idle") throw Error("PTY is not idle");
      ((this.job = e),
        (this.state = "busy"),
        (this.lastUsed = Date.now()),
        (e.marker = crypto.randomBytes(18).toString("hex")));
      let o = "__cc_" + crypto.randomBytes(6).toString("hex"),
        i = Buffer.from(r, "utf8")
          .toString("base64")
          .match(/.{1,512}/g) || [""],
        a;
      if (this.windows) {
        let c = "$" + o,
          l = (d) => `[Console]::Write(([char]27).ToString()+']633;CCMING;${e.marker};${d}`;
        a = [`${c}=''`, ...i.map((d) => `${c}+='${d}'`)];
        let u = n ? `Set-Location -LiteralPath ${quotePwsh(n)} -ErrorAction Stop; ` : "";
        a.push(
          `${l("START")}'+[char]7); $global:LASTEXITCODE=0; ${c}_code=0; try { ${u}Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${c}))); ${c}_ok=$?; if ($LASTEXITCODE -ne 0) { ${c}_code=[int]$LASTEXITCODE } elseif (-not ${c}_ok) { ${c}_code=1 } } catch { Write-Output ($_ | Out-String); ${c}_code=1 }; ${l("END;'")}+${c}_code+';'+$PWD.Path+[char]7); Remove-Variable -Name '${o}','${o}_code','${o}_ok' -ErrorAction SilentlyContinue`,
        );
      } else {
        a = [`${o}=''`, ...i.map((u) => `${o}="$${o}"${quotePosix(u)}`)];
        let c = process.platform === "darwin" ? "-D" : "-d",
          l = n ? `builtin cd -- ${quotePosix(n)} && ` : "";
        a.push(
          `builtin printf '\\033]633;CCMING;%s;START\\007' '${e.marker}'; if ${o}_text=$(builtin printf '%s' "$${o}" | /usr/bin/base64 ${c}); then ${l}eval "$${o}_text"; ${o}_code=$?; else builtin printf '%s\\n' 'ccming: command decode failed'; ${o}_code=125; fi; builtin printf '\\033]633;CCMING;%s;END;%s;%s\\007' '${e.marker}' "$${o}_code" "$PWD"; unset ${o} ${o}_text ${o}_code`,
        );
      }
      (this.mirror(
        `\r
\x1B[90m[anvil] running ` +
          e.id.slice(0, 8) +
          `\x1B[0m\r
`,
      ),
        this.process.write(a.join("\r") + "\r"));
    }
    input(e) {
      if (this.state !== "busy" || !this.job?.started) throw Error("PTY is not ready for command input");
      this.process.write(e);
    }
    resize(e, r) {
      !Number.isInteger(e) ||
        !Number.isInteger(r) ||
        ((this.cols = Math.max(20, Math.min(500, e))),
        (this.rows = Math.max(5, Math.min(200, r))),
        this.process &&
          !["closed", "closing"].includes(this.state) &&
          this.process.resize(this.cols, this.rows));
    }
    show() {
      this.view?.show(!0);
    }
    disposeView() {
      let e = this.view;
      ((this.view = null), this.closeEmitter?.fire(), e?.dispose());
      for (let r of this.disposables.splice(0)) r.dispose();
    }
    markClosing() {
      return ["closed", "closing"].includes(this.state)
        ? !1
        : ((this.state = "closing"),
          clearTimeout(this.readyTimer),
          this.rejectReady(Error("PTY was closed")),
          !0);
    }
  };
module.exports = { PtyShell };
