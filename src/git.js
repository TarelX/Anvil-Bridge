"use strict";
var { execFile } = require("node:child_process"),
  GIT_TIMEOUT_MS = 1e4,
  MAX_BUFFER = 8 * 1024 * 1024,
  DEFAULT_MAX_CHARS = 2e4,
  MAX_CHARS = 6e4,
  Git = class {
    constructor(e, r) {
      ((this.root = e), (this.files = r));
    }
    run(e) {
      return new Promise((r) => {
        execFile(
          "git",
          e,
          { cwd: this.root, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, shell: !1, windowsHide: !0 },
          (n, o, s) => {
            if (n && n.code === "ENOENT")
              return r({ ok: !1, reason: "git_not_found", stdout: "", stderr: "" });
            if (n && n.killed) return r({ ok: !1, reason: "timeout", stdout: "", stderr: "" });
            r({
              ok: !n,
              code: n ? (typeof n.code == "number" ? n.code : 1) : 0,
              stdout: o || "",
              stderr: (s || "").slice(0, 2e3),
            });
          },
        );
      });
    }
    async safePath(e) {
      return (await this.files.resolve(e), e.replace(/\\/g, "/"));
    }
    async repoCheck() {
      let e = await this.run(["rev-parse", "--is-inside-work-tree"]);
      return e.ok
        ? { ok: e.stdout.trim() === "true" }
        : {
            ok: !1,
            detail:
              e.reason === "git_not_found"
                ? "git executable not found on PATH"
                : e.stderr.trim() || "not a git repository",
          };
    }
    async status(e = {}) {
      let r = await this.repoCheck();
      if (!r.ok)
        return { is_repository: !1, note: r.detail || "The workspace root is not a git repository." };
      let [n, o, s] = await Promise.all([
          this.run(["rev-parse", "--abbrev-ref", "HEAD"]),
          this.run(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]),
          this.run(["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
        ]),
        i = n.ok ? n.stdout.trim() : null,
        a = null,
        c = null;
      if (o.ok) {
        let [m, g] = o.stdout.trim().split(/\s+/);
        ((c = Number(m) || 0), (a = Number(g) || 0));
      }
      let l = [],
        u = [],
        d = [],
        f = [],
        p = s.stdout.split("\0");
      for (let m = 0; m < p.length; m++) {
        let g = p[m];
        if (!g || g.length < 4) continue;
        let y = g[0],
          b = g[1],
          w = g.slice(3),
          z = null;
        if (
          ((y === "R" || y === "C") && (z = p[++m] || null),
          y === "U" || b === "U" || (y === "A" && b === "A") || (y === "D" && b === "D"))
        ) {
          f.push({ path: w, code: y + b });
          continue;
        }
        if (y === "?" && b === "?") {
          d.push({ path: w });
          continue;
        }
        (y !== " " && y !== "?" && l.push({ path: w, code: y, ...(z ? { moved_from: z } : {}) }),
          b !== " " && b !== "?" && u.push({ path: w, code: b }));
      }
      let h = {
        is_repository: !0,
        branch: i,
        detached: i === "HEAD",
        ahead: a,
        behind: c,
        staged: l,
        unstaged: u,
        untracked: d,
        conflicted: f,
        counts: { staged: l.length, unstaged: u.length, untracked: d.length, conflicted: f.length },
        clean: !l.length && !u.length && !d.length && !f.length,
        note: "Read-only snapshot; no git command that mutates the repository was run.",
      };
      if (e.include_diff_stat) {
        let [m, g] = await Promise.all([
            this.run(["diff", "--numstat"]),
            this.run(["diff", "--cached", "--numstat"]),
          ]),
          y = (b) =>
            b
              .trim()
              .split(
                `
`,
              )
              .filter(Boolean)
              .map((w) => {
                let [z, x, S] = w.split("	");
                return {
                  path: S,
                  added: z === "-" ? null : Number(z),
                  deleted: x === "-" ? null : Number(x),
                  binary: z === "-",
                };
              });
        h.diff_stat = { unstaged: m.ok ? y(m.stdout) : [], staged: g.ok ? y(g.stdout) : [] };
      }
      return h;
    }
    async diff(e = {}) {
      let r = await this.repoCheck();
      if (!r.ok)
        return { is_repository: !1, note: r.detail || "The workspace root is not a git repository." };
      let n = Math.min(e.max_chars || DEFAULT_MAX_CHARS, MAX_CHARS),
        s = [
          "--no-pager",
          "diff",
          "--no-color",
          `--unified=${e.context_lines === void 0 ? 3 : e.context_lines}`,
        ];
      (e.staged && s.push("--cached"), e.path && s.push("--", await this.safePath(e.path)));
      let i = await this.run(s);
      if (!i.ok && !i.stdout) return { is_repository: !0, error: i.stderr || i.reason || "git diff failed" };
      let a = i.stdout,
        c = a.length > n,
        l = [...a.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map((u) => u[2]);
      return {
        staged: !!e.staged,
        path: e.path || null,
        files: l,
        diff: c ? a.slice(0, n) : a,
        truncated: c,
        total_chars: a.length,
        ...(c
          ? { next_step: "Request a single path, reduce context_lines, or raise max_chars to see the rest." }
          : {}),
        ...(a.trim() ? {} : { note: e.staged ? "No staged changes." : "No unstaged changes." }),
      };
    }
  };
module.exports = { Git };
