"use strict";
var { execFile } = require("node:child_process"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  MAX_BUFFER = 64 * 1024 * 1024,
  GIT_TIMEOUT_MS = 3e4,
  gitWithInput = (t, e, r, n) =>
    new Promise((o, s) => {
      execFile(
        "git",
        ["--git-dir", t, "--work-tree", e, ...r],
        { cwd: n || e, maxBuffer: MAX_BUFFER, timeout: GIT_TIMEOUT_MS, windowsHide: !0, encoding: "buffer" },
        (i, a, c) => {
          if (i) return ((i.stderr = String(c || "")), s(i));
          o(String(a || ""));
        },
      );
    }),
  git = (t, e) =>
    new Promise((r, n) => {
      execFile(
        "git",
        t,
        { cwd: e, maxBuffer: MAX_BUFFER, timeout: GIT_TIMEOUT_MS, windowsHide: !0, encoding: "buffer" },
        (o, s, i) => {
          if (o) return ((o.stderr = String(i || "")), n(o));
          r(String(s || ""));
        },
      );
    }),
  NUL = String.fromCharCode(0),
  TAB = String.fromCharCode(9),
  NL = String.fromCharCode(10),
  RECORD = String.fromCharCode(30),
  UNIT = String.fromCharCode(31),
  PATHS_MARKER = "anvil-paths:",
  parseNumstat = (t) => {
    let e = t.includes(NUL) ? t.split(NUL).filter(Boolean) : t.split(NL).filter(Boolean);
    return e.map((r) => {
      let i = r.split(TAB),
        a = i.slice(2).join(TAB);
      return { path: a, added: i[0] === "-" ? null : Number(i[0]), removed: i[1] === "-" ? null : Number(i[1]), binary: i[0] === "-" };
    });
  },
  parseDiff = (t) => {
    let e = t.includes(NUL) ? t.split(NUL) : t.split(NL),
      r = new Map(),
      n = new Map();
    for (let o = 0; o < e.length; o++) {
      let s = e[o];
      if (!s) continue;
      if (s.startsWith(":")) {
        if (s.includes(TAB)) {
          let i = s.split(TAB);
          r.set(i[1], i[0].trim().split(" ").pop());
        } else if (e[o + 1]) (r.set(e[o + 1], s.trim().split(" ").pop()), o++);
        continue;
      }
      let i = s.split(TAB);
      i.length > 2 &&
        n.set(i.slice(2).join(TAB), {
          added: i[0] === "-" ? null : Number(i[0]),
          removed: i[1] === "-" ? null : Number(i[1]),
          binary: i[0] === "-",
        });
    }
    return { statuses: r, counts: n };
  },
  countLines = (t) => {
    if (typeof t != "string" || !t.length) return 0;
    let e = t.split(NL);
    e.length && e[e.length - 1] === "" && e.pop();
    return e.length;
  },
  newFileDiff = (t, e, r) => {
    let n = "diff --git a/" + t + " b/" + t + NL + "new file mode 100644" + NL;
    if (e === null || e.includes(NUL)) return n + "Binary file (" + r + " bytes) created in the worktree" + NL;
    let o = e.split(NL);
    o.length && o[o.length - 1] === "" && o.pop();
    return n + "--- /dev/null" + NL + "+++ b/" + t + NL + "@@ -0,0 +1," + o.length + " @@" + o.map((s) => NL + "+" + s).join("") + NL;
  },
  MAX_CHECKPOINTS = 50,
  MAX_LIST = 30,
  Checkpoints = class {
    constructor(e, r, n) {
      ((this.root = e), (this.event = n || (() => {})));
      let o = crypto.createHash("sha256").update(path.resolve(e)).digest("hex").slice(0, 16);
      ((this.gitDir = path.join(r, "checkpoints", o)),
        (this.ready = null),
        (this.queue = Promise.resolve()),
        (this.lastError = null));
    }
    get keep() {
      return MAX_CHECKPOINTS;
    }
    get maxFileMb() {
      return MAX_LIST;
    }
    git(e, r) {
      return gitWithInput(this.gitDir, this.root, e, r);
    }
    enqueue(e) {
      let r = this.queue.then(e);
      return ((this.queue = r.catch(() => {})), r);
    }
    capture(e, r) {
      return this.enqueue(() => this.captureNow(e, r));
    }
    list(e) {
      return this.enqueue(() => this.listNow(e));
    }
    diff(e, r) {
      return this.enqueue(() => this.diffNow(e, r));
    }
    restore(e, r) {
      return this.enqueue(() => this.restoreNow(e, r));
    }
    clear() {
      return this.enqueue(() => this.clearNow());
    }
    async existsIn(commit, file) {
      try {
        return !!(await this.git(["--literal-pathspecs", "ls-tree", "-z", "--name-only", commit, "--", file])).length;
      } catch {
        return !1;
      }
    }
    async fileAt(file) {
      try {
        return await fs.stat(path.join(this.root, file));
      } catch {
        return null;
      }
    }
    recordedPaths(text) {
      let r = [];
      for (let n of String(text || "").split(NL)) {
        if (!n.startsWith(PATHS_MARKER)) continue;
        try {
          let o = JSON.parse(n.slice(PATHS_MARKER.length).trim());
          if (Array.isArray(o)) for (let s of o) typeof s == "string" && s && r.push(s);
        } catch {}
      }
      return r;
    }
    async recordedPathsOf(commit) {
      return this.recordedPaths(await this.git(["log", "-1", "--format=%b", commit]));
    }
    async changesOf(commit, only, recorded) {
      await this.init();
      let args = ["--literal-pathspecs", "diff", "--raw", "--numstat", "-z", "--no-renames", "--no-abbrev", commit],
        files = [];
      only && args.push("--", only);
      let diff = parseDiff(await this.git(args)),
        seen = new Set();
      for (let [p, status] of diff.statuses) {
        let c = diff.counts.get(p);
        (seen.add(p),
          files.push({
            path: p,
            status,
            added: c ? c.added : null,
            removed: c ? c.removed : null,
            binary: !!(c && c.binary),
          }));
      }
      let list = recorded || (await this.recordedPathsOf(commit));
      for (let p of list) {
        if (seen.has(p) || (only && p !== only)) continue;
        if (await this.existsIn(commit, p)) continue;
        let stat = await this.fileAt(p);
        if (!stat || !stat.isFile()) continue;
        let added = null;
        if (stat.size <= 262144)
          try {
            added = countLines(await fs.readFile(path.join(this.root, p), "utf8"));
          } catch {
            added = null;
          }
        files.push({ path: p, status: "A", added, removed: 0, binary: !1, created: !0 });
      }
      return files;
    }
    async init() {
      return this.ready
        ? this.ready
        : ((this.ready = (async () => {
            await fs.mkdir(this.gitDir, { recursive: !0 });
            try {
              await fs.access(path.join(this.gitDir, "HEAD"));
            } catch {
              await git(["init", "--quiet", "--bare", this.gitDir], path.dirname(this.gitDir));
            }
            let e = [
              ["core.worktree", path.resolve(this.root)],
              ["core.bare", "false"],
              ["core.autocrlf", "false"],
              ["core.safecrlf", "false"],
              ["core.fileMode", "false"],
              ["commit.gpgSign", "false"],
              ["core.quotePath", "false"],
              ["user.name", "Anvil Bridge"],
              ["user.email", "bridge@localhost"],
              ["gc.auto", "0"],
            ];
            for (let [n, o] of e) await git(["--git-dir", this.gitDir, "config", n, o], this.root);
            let r = path.join(this.gitDir, "info", "exclude");
            return (
              await fs.mkdir(path.dirname(r), { recursive: !0 }),
              await fs.writeFile(
                r,
                [
                  "node_modules/",
                  ".git/",
                  "dist/",
                  "build/",
                  "out/",
                  "coverage/",
                  ".venv/",
                  "__pycache__/",
                  "*.vsix",
                  "*.log",
                  ".DS_Store",
                  "",
                ].join(`
`),
                "utf8",
              ),
              !0
            );
          })().catch((e) => {
            throw ((this.ready = null), e);
          })),
          this.ready);
    }
    async captureNow(e, r) {
      let n = [...new Set((r || []).filter(Boolean))];
      if (!n.length) return null;
      try {
        await this.init();
        let o = !0;
        try {
          await this.git(["rev-parse", "--verify", "--quiet", "HEAD"]);
        } catch (u) {
          if (u.code === 1) o = !1;
          else throw u;
        }
        await this.git(o ? ["read-tree", "HEAD"] : ["read-tree", "--empty"]);
        let s = this.maxFileMb * 1024 * 1024,
          i = [];
        for (let u of n) {
          if (typeof u != "string" || path.isAbsolute(u) || u.split(/[\\/]/).includes(".."))
            throw Error("检查点路径无效");
          let d;
          try {
            d = await fs.lstat(path.join(this.root, u));
          } catch (f) {
            if (f.code !== "ENOENT") throw f;
          }
          if (d) {
            if (!d.isFile() || d.size > s)
              throw Error(`Cannot snapshot ${u}: not a regular file or exceeds ${this.maxFileMb} MB`);
            i.push(u);
          } else
            try {
              await this.git(["--literal-pathspecs", "ls-files", "--error-unmatch", "--", u]);
            } catch (f) {
              if (f.code === 1) continue;
              throw f;
            }
          i.push(u);
        }
        let c0 = o
          ? ((await this.git(["--literal-pathspecs", "ls-tree", "-r", "-z", "--name-only", "HEAD"])).split(NUL).filter(Boolean))
          : [];
        let staged = [...new Set([...c0, ...i])];
        staged.length && (await this.git(["--literal-pathspecs", "add", "--force", "--all", "--", ...staged]));
        let a =
            String(e || "workspace write")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 120) || "workspace write",
          c = PATHS_MARKER + " " + JSON.stringify(n);
        try {
          await this.git(["commit", "--quiet", "--allow-empty", "--no-verify", "-m", a, "-m", c]);
        } catch (u) {
          if (!/nothing to commit/i.test(u.stderr || "")) throw u;
        }
        let l = (await this.git(["rev-parse", "HEAD"])).trim();
        return (
          await this.prune(),
          (this.lastError = null),
          this.event("检查点已创建", `${l.slice(0, 8)} \xB7 ${n.length} 个文件`),
          { id: l, summary: a, files: n.length }
        );

      } catch (o) {
        return (
          (this.lastError = String(o.stderr?.trim() || o.message || "检查点错误").slice(0, 500)),
          this.event("检查点失败", this.lastError),
          null
        );
      }
    }
    async listNow(e) {
      await this.init();
      let r = Math.max(1, Math.min(this.keep, e || this.keep));
      try {
        await this.git(["rev-parse", "--verify", "--quiet", "HEAD"]);
      } catch (o) {
        if (o.code === 1) return [];
        throw o;
      }
      let n = (await this.git(["log", `-${r}`, `--format=%H${UNIT}%at${UNIT}%s${UNIT}%b${RECORD}`]))
          .split(RECORD)
          .map((o) => o.replace(/^[\r\n]+/, ""))
          .filter(Boolean),
        o = [];
      for (let s of n) {
        let i = s.split(UNIT),
          a = { id: i[0], at: Number(i[1]) * 1e3, summary: i[2] || "", recorded: this.recordedPaths(i.slice(3).join(UNIT)) };
        a.id && o.push(a);
      }
      for (let s of o) {
        let i;
        try {
          i = await this.changesOf(s.id, null, s.recorded);
        } catch (c) {
          throw Error(`无法读取检查点 ${s.id.slice(0, 8)}: ${c.stderr?.trim() || c.message}`);
        }
        ((s.files = i),
          (s.added = i.reduce((c, l) => c + (l.added || 0), 0)),
          (s.removed = i.reduce((c, l) => c + (l.removed || 0), 0)),
          (s.binary = i.filter((c) => c.binary).length),
          delete s.recorded);
      }
      return o;
    }

    async diffNow(e, r) {
      await this.init();
      let n = ["--literal-pathspecs", "diff", "--no-color", "--no-ext-diff", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", "--unified=3", e];
      r && n.push("--", r);
      let o = "";
      try {
        o = await this.git(n);
      } catch (s) {
        throw Error(s.stderr?.slice(0, 200) || "diff failed");
      }
      let s = await this.newFilesDiff(e, r, o);
      return o && s ? o + NL + s : o + s;
    }
    async newFilesDiff(e, r, n) {
      let o = new Set();
      for (let i of String(n || "").split(NL))
        i.startsWith("+++ b/") ? o.add(i.slice(6)) : i.startsWith("--- a/") && o.add(i.slice(6));
      let s = r ? [r] : await this.recordedPathsOf(e),
        i = [];
      for (let a of s) {
        if (!a || o.has(a) || (await this.existsIn(e, a))) continue;
        let c = await this.fileAt(a);
        if (!c || !c.isFile()) continue;
        let l = null;
        if (c.size <= 262144)
          try {
            l = await fs.readFile(path.join(this.root, a), "utf8");
          } catch {
            l = null;
          }
        i.push(newFileDiff(a, l, c.size));
      }
      return i.join(NL);
    }

    async restoreNow(e, r) {
      await this.init();
      let n = [...new Set((await this.changesOf(e, r || null)).map((o) => o.path))];
      if (!n.length) return { restored: e, file: r || null, files: [], unchanged: !0 };
      if (
        !(await this.captureNow(r ? `回滚前保护性检查点：${r}` : "回滚前保护性检查点", n)) &&
        this.lastError
      )
        throw Error("保护性检查点创建失败，已取消回滚：" + this.lastError);
      let o = [],
        s = [];
      for (let i of n)
        if (await this.existsIn(e, i)) {
          try {
            await this.git(["--literal-pathspecs", "checkout", e, "--", i]);
          } catch (a) {
            throw Error(`恢复 ${i} 失败：${a.stderr?.trim() || a.message}`);
          }
          o.push(i);
        } else {
          let a = path.join(this.root, i);
          try {
            await fs.lstat(a);
          } catch {
            continue;
          }
          (await fs.rm(a, { force: !0 }), s.push(i));
        }
      try {
        await this.git(["--literal-pathspecs", "add", "--all", "--", ...n]);
      } catch {}
      return { restored: e, file: r || null, files: n, restoredFiles: o, removedFiles: s, unchanged: !1 };
    }

    async prune() {
      try {
        let r = (await this.git(["log", "--format=%H"]))
          .split(
            `
`,
          )
          .filter(Boolean);
        if (r.length <= this.keep) return;
        let n = r[this.keep - 1],
          o = path.join(this.gitDir, "info", "grafts");
        (await fs.mkdir(path.dirname(o), { recursive: !0 }),
          await fs.writeFile(
            o,
            n +
              `
`,
            "utf8",
          ));
      } catch {}
    }
    async branch() {
      try {
        return (await this.git(["rev-parse", "--abbrev-ref", "HEAD"])).trim() || "master";
      } catch {
        return "master";
      }
    }
    async usage() {
      let e = 0,
        r = async (n) => {
          let o = [];
          try {
            o = await fs.readdir(n, { withFileTypes: !0 });
          } catch {
            return;
          }
          for (let s of o) {
            let i = path.join(n, s.name);
            if (s.isDirectory()) await r(i);
            else
              try {
                e += (await fs.stat(i)).size;
              } catch {}
          }
        };
      return (await r(this.gitDir), e);
    }
    async clearNow() {
      return (
        await fs.rm(this.gitDir, { recursive: !0, force: !0 }),
        (this.ready = null),
        (this.lastError = null),
        !0
      );
    }
  };
module.exports = { Checkpoints };
