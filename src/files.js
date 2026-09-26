"use strict";
var fs = require("node:fs/promises"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  { TextDecoder } = require("node:util"),
  MAX_FILE_BYTES = 1024 * 1024,
  IGNORED_DIRS = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    "out",
    ".next",
    ".cache",
    "coverage",
    ".venv",
  ]),
  versionOf = (t) => "sha256:" + crypto.createHash("sha256").update(t).digest("hex"),
  isSensitivePath = (t) =>
    t.some(
      (e) =>
        /^(?:\.git|\.ssh|\.aws|\.azure|\.gnupg|\.env(?:\..*)?|\.npmrc|\.netrc|\.git-credentials|credentials(?:\..*)?|id_rsa|id_ed25519)$/i.test(
          e,
        ) || /\.(?:pem|key|pfx|p12)$/i.test(e),
    );
function globToRegExp(t, e = !1) {
  if (/[\[\]{}!]/.test(t)) throw Error("Only *, ** and ? glob syntax is supported");
  let r = "^";
  for (let n = 0; n < t.length; n++) {
    let o = t[n];
    o === "*" && t[n + 1] === "*"
      ? (n++, t[n + 1] === "/" ? (n++, (r += "(?:.*/)?")) : (r += ".*"))
      : o === "*"
        ? (r += "[^/]*")
        : o === "?"
          ? (r += "[^/]")
          : (r += o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  }
  return new RegExp(r + "$", e ? "" : "i");
}
var compileGlobs = (t, e) => (t || []).map((r) => globToRegExp(r, e)),
  matchesAny = (t, e) => t.some((r) => r.test(e)),
  PatchError = class extends Error {
    constructor(e, r, n = {}) {
      (super(r), (this.name = "PatchError"), (this.code = e), (this.details = n));
    }
  },
  MAX_PATCH_FILES = 30,
  squash = (t) => t.replace(/\s+/g, " ").trim(),
  Files = class {
    constructor(e, r) {
      ((this.root = e), (this.vscode = r), (this.beforeWrite = null));
    }
    relative(e) {
      return path.relative(this.root, e).split(path.sep).join("/");
    }
    async resolve(e = ".", r = !1) {
      if (
        typeof e != "string" ||
        e.includes("\0") ||
        e.includes(":") ||
        path.isAbsolute(e) ||
        e.startsWith("\\")
      )
        throw Error("Only workspace-relative paths are allowed");
      let n = e
        .replace(/\\/g, "/")
        .split("/")
        .filter((s) => s && s !== ".");
      if (n.includes("..") || isSensitivePath(n)) throw Error("Traversal or protected secret path denied");
      let o = this.root;
      for (let s of n) {
        o = path.join(o, s);
        try {
          if ((await fs.lstat(o)).isSymbolicLink()) throw Error("Symlinks/junctions are not permitted");
          let a = await fs.realpath(o),
            c = path.relative(this.root, a);
          if (c === ".." || c.startsWith(".." + path.sep) || path.isAbsolute(c))
            throw Error("Path escapes workspace");
        } catch (i) {
          if (!(r && i.code === "ENOENT")) throw i;
        }
      }
      return o;
    }
    async bytes(e) {
      let r = await this.resolve(e),
        n = await fs.stat(r);
      if (!n.isFile() || n.size > MAX_FILE_BYTES) throw Error("Not a regular file or exceeds 1 MiB limit");
      let o = await fs.readFile(r);
      if (o.length > MAX_FILE_BYTES || o.includes(0)) throw Error("Binary/oversized file refused");
      let s = new TextDecoder("utf-8", { fatal: !0, ignoreBOM: !0 }).decode(o);
      return { full: r, bytes: o, text: s, version: versionOf(o) };
    }
    dirty(e) {
      return this.vscode.workspace.textDocuments.some(
        (r) => r.uri.scheme === "file" && path.resolve(r.uri.fsPath) === path.resolve(e) && r.isDirty,
      );
    }
    async walk(e = ".", r = !1, n = 1 / 0, o = 8e3, s = !1) {
      let i = await this.resolve(e),
        a = await fs.stat(i),
        c = [];
      if (a.isFile()) return { entries: [{ path: this.relative(i), directory: !1 }], truncated: !1 };
      if (!a.isDirectory()) throw Error("Not a regular file or directory");
      let l = [{ full: i, depth: 0 }],
        u = 0,
        d = !1;
      e: for (; l.length;) {
        let f = l.shift(),
          p = await fs.opendir(f.full);
        for await (let h of p) {
          if (++u > o) {
            d = !0;
            break e;
          }
          if (h.isSymbolicLink() || (!s && IGNORED_DIRS.has(h.name)) || (!r && h.name.startsWith(".")))
            continue;
          let m = this.relative(path.join(f.full, h.name));
          isSensitivePath(m.split("/")) ||
            (!h.isDirectory() && !h.isFile()) ||
            (c.push({ path: m, directory: h.isDirectory() }),
            h.isDirectory() &&
              f.depth + 1 < n &&
              l.push({ full: path.join(f.full, h.name), depth: f.depth + 1 }));
        }
      }
      return { entries: c, truncated: d };
    }
    async list(e) {
      let r = await this.walk(e.path, e.include_hidden, e.depth || 1, 3e3, e.no_ignore),
        n = e.max_entries || 150,
        o = r.truncated || r.entries.length > n;
      return {
        entries: r.entries.slice(0, n),
        truncated: o,
        ...(o ? { next_step: "List a narrower path instead of raising max_entries." } : {}),
      };
    }
    async find(e) {
      if (!e.patterns.length) throw Error("patterns must not be empty");
      let r = e.case_sensitive === !0,
        n = compileGlobs(e.patterns, r),
        o = compileGlobs(e.exclude, r),
        s = await this.walk(e.path, e.include_hidden, 1 / 0, 8e3, e.no_ignore),
        i = e.max_results || 100,
        a = s.entries
          .filter((l) => !l.directory && matchesAny(n, l.path) && !matchesAny(o, l.path))
          .map((l) => l.path);
      if (e.sort === "modified_desc") {
        let l = [];
        for (let u of a) {
          let d = 0;
          try {
            d = (await fs.stat(await this.resolve(u))).mtimeMs;
          } catch {}
          l.push({ rel: u, mtime: d });
        }
        a = l.sort((u, d) => d.mtime - u.mtime || (u.rel < d.rel ? -1 : 1)).map((u) => u.rel);
      } else a = a.sort();
      let c = s.truncated || a.length > i;
      return {
        files: a.slice(0, i),
        truncated: c,
        sort: e.sort === "modified_desc" ? "modified_desc" : "path_asc",
        patterns_relative_to: "workspace root",
        ...(c ? { next_step: "Narrow path/patterns or add exclude before raising max_results." } : {}),
      };
    }
    async read(e) {
      let r = [],
        n = 1e5,
        o = 1e3;
      for (let s of e.files)
        try {
          if (n <= 0) {
            r.push({ path: s.path, status: "skipped", reason: "Response budget exhausted" });
            continue;
          }
          let i = await this.bytes(s.path),
            a = i.text.split(/\r?\n/),
            c = s.start_line || 1,
            l = s.whole_file ? Math.max(c, a.length) : s.end_line || c + 199;
          if (l < c) throw Error("end_line precedes start_line");
          let u = Math.min(a.length, l, c + o - 1),
            d = "",
            f = c - 1,
            p = [];
          for (let g = c - 1; g < u && !(n < 100); g++) {
            let y = Math.min(3e3, n - 40),
              b = a[g].slice(0, y);
            b.length < a[g].length && p.push(g + 1);
            let w = `${g + 1}: ${b}
`;
            ((d += w), (n -= w.length), (f = g + 1));
          }
          let h = f < a.length,
            m;
          if (h) {
            let g = f - c + 1 >= o;
            m =
              n < 100
                ? `Shared response budget reached at line ${f}; request fewer files per call or continue from next_start_line.`
                : g
                  ? `Per-file cap of ${o} lines reached; continue from next_start_line ${f + 1}.`
                  : `Only lines ${c}-${f} of ${a.length} were returned. For a large file, call lsp document_symbols first to see its structure and then read just the ranges you need; otherwise pass end_line (up to ${o} lines per call) or whole_file:true.`;
          }
          r.push({
            path: s.path,
            status: "success",
            version: i.version,
            content: d,
            start_line: c,
            end_line: f,
            total_lines: a.length,
            has_more: h,
            next_start_line: h ? f + 1 : null,
            truncated_line_numbers: p,
            ...(m ? { next_step: m } : {}),
          });
        } catch (i) {
          r.push({ path: s.path, status: "error", message: i.message });
        }
      return { files: r };
    }
    async search(e) {
      let r = e.case_sensitive === void 0 ? /[A-Z]/.test(e.pattern) : e.case_sensitive === !0,
        n;
      if (e.is_regex) {
        let h;
        try {
          h = new RegExp(e.pattern, r ? "g" : "gi");
        } catch (m) {
          throw Error(`Invalid regular expression: ${m.message}`);
        }
        if (h.test("")) throw Error("Pattern matches the empty string; make it more specific");
        n = (m) => {
          let g = [];
          h.lastIndex = 0;
          let y;
          for (; (y = h.exec(m)) && g.length < 50;) {
            if (y[0].length === 0) {
              h.lastIndex++;
              continue;
            }
            g.push({ column: y.index + 1, length: y[0].length });
          }
          return g;
        };
      } else {
        let h = r ? e.pattern : e.pattern.toLowerCase();
        n = (m) => {
          let g = r ? m : m.toLowerCase(),
            y = [],
            b = 0,
            w;
          for (; (w = g.indexOf(h, b)) >= 0 && y.length < 50;)
            (y.push({ column: w + 1, length: h.length }), (b = w + h.length));
          return y;
        };
      }
      let o = compileGlobs(e.include, !1),
        s = compileGlobs(e.exclude, !1),
        i = await this.walk(e.path, e.include_hidden, 1 / 0, 8e3, e.no_ignore),
        a = [],
        c = e.max_results || 100,
        l = e.max_matches_per_file || 20,
        u = Math.min(e.context_lines === void 0 ? 1 : e.context_lines, 5),
        d = 0,
        f = 0,
        p = i.truncated;
      for (let h of i.entries.filter((m) => !m.directory))
        if (!(o.length && !matchesAny(o, h.path)) && !(s.length && matchesAny(s, h.path))) {
          if (a.length >= c) {
            p = !0;
            break;
          }
          if (d >= 1500 || f >= 8 * MAX_FILE_BYTES) {
            p = !0;
            break;
          }
          d++;
          try {
            let m = await this.bytes(h.path);
            f += m.bytes.length;
            let g = m.text.split(/\r?\n/),
              y = 0;
            for (let b = 0; b < g.length; b++) {
              for (let w of n(g[b])) {
                if (y >= l) {
                  p = !0;
                  break;
                }
                if (a.length >= c) {
                  p = !0;
                  break;
                }
                let z = {
                  path: h.path,
                  line: b + 1,
                  column: w.column,
                  snippet: g[b].slice(Math.max(0, w.column - 1 - 100), w.column - 1 + 400),
                };
                (u &&
                  ((z.before = g.slice(Math.max(0, b - u), b).map((x) => x.slice(0, 400))),
                  (z.after = g.slice(b + 1, Math.min(g.length, b + 1 + u)).map((x) => x.slice(0, 400)))),
                  a.push(z),
                  y++);
              }
              if (y >= l || a.length >= c) break;
            }
          } catch {}
        }
      return {
        matches: a,
        truncated: p,
        scanned_files: d,
        case_sensitive: r,
        mode: e.is_regex ? "regex" : "literal",
        ...(p ? { next_step: "Narrow pattern/path or add include-exclude globs, then search again." } : {}),
      };
    }
    parsePatch(e) {
      let r = e.replace(
        /\r\n/g,
        `
`,
      ).split(`
`);
      if ((r.at(-1) === "" && r.pop(), r.shift() !== "*** Begin Patch" || r.pop() !== "*** End Patch"))
        throw new PatchError(
          "PATCH_ENVELOPE",
          "Patch must start with '*** Begin Patch' and end with '*** End Patch'",
        );
      let n = [],
        o;
      for (let [c, l] of r.entries()) {
        let u = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(l),
          d = /^\*\*\* Move to: (.+)$/.exec(l);
        if (u) ((o = { action: u[1], path: u[2].trim(), move_to: null, rows: [] }), n.push(o));
        else if (d) {
          if (!o || o.action !== "Update" || o.move_to || o.rows.length)
            throw new PatchError(
              "PATCH_DIRECTIVE",
              "'*** Move to:' must immediately follow '*** Update File:'",
              {
                line: c + 2,
                row: l,
              },
            );
          o.move_to = d[1].trim();
        } else {
          if (!o || l.startsWith("***"))
            throw new PatchError(
              "PATCH_DIRECTIVE",
              `Unsupported patch directive at patch line ${c + 2}: ${l.slice(0, 80)}`,
              { line: c + 2, row: l.slice(0, 200) },
            );
          o.rows.push(l);
        }
      }
      if (!n.length) throw new PatchError("PATCH_EMPTY", "Patch contains no file directives");
      let s = [],
        i = new Map(),
        a = (c) => c.replace(/\\/g, "/");
      for (let c of n) {
        let l = a(c.path),
          u = i.get(l);
        if (u && u.action === "Update" && c.action === "Update" && !u.move_to && !c.move_to) {
          u.rows.push(...c.rows);
          continue;
        }
        if (u)
          throw new PatchError(
            "DUPLICATE_PATH",
            `${c.path} appears more than once with conflicting actions (${u.action} then ${c.action})`,
            { path: c.path, actions: [u.action, c.action] },
          );
        if (c.move_to) {
          let d = a(c.move_to);
          if (i.has(d))
            throw new PatchError(
              "DUPLICATE_PATH",
              `${c.move_to} is both a move destination and another directive's target`,
              { path: c.move_to },
            );
          i.set(d, c);
        }
        (i.set(l, c), s.push(c));
      }
      if (s.length > MAX_PATCH_FILES)
        throw new PatchError(
          "PATCH_TOO_LARGE",
          `Patch touches ${s.length} files; the limit is ${MAX_PATCH_FILES}. Split it into batches.`,
          { count: s.length, limit: MAX_PATCH_FILES },
        );
      return s;
    }
    async patch(e, r, n) {
      let o = [];
      for (let i of this.parsePatch(e.patch)) {
        let a = await this.resolve(i.path, i.action === "Add");
        if (this.dirty(a)) throw Error(`${i.path}: editor has unsaved changes`);
        let c = a;
        if (i.move_to) {
          if (i.action !== "Update") throw Error("Move is only supported on Update");
          if (((c = await this.resolve(i.move_to, !0)), this.dirty(c)))
            throw Error(`${i.move_to}: editor has unsaved changes`);
          try {
            throw (await fs.lstat(c), Error(`${i.move_to}: move destination already exists`));
          } catch (f) {
            if (f.code !== "ENOENT") throw f;
          }
        }
        let l = o.flatMap((f) => [f.full.toLowerCase(), f.dest.toLowerCase()]);
        if (l.includes(a.toLowerCase()) || l.includes(c.toLowerCase()))
          throw new PatchError(
            "DUPLICATE_PATH",
            `${i.path}: resolves to a path already targeted by this patch (case-insensitive)`,
            { path: i.path },
          );
        let u = null,
          d = null;
        if (i.action === "Add") {
          try {
            throw (await fs.lstat(a), Error(`${i.path}: already exists`));
          } catch (f) {
            if (f.code !== "ENOENT") throw f;
          }
          if (i.rows.some((f) => !f.startsWith("+"))) throw Error("Add lines must start with +");
          d =
            i.rows.map((f) => f.slice(1)).join(`
`) +
            `
`;
        } else {
          u = await this.bytes(i.path);
          let f = e.expected_versions?.[i.path];
          if (f !== void 0 && f !== u.version)
            throw new PatchError(
              "STALE_FILE",
              `${i.path}: the file changed after it was read - read it again and regenerate the patch`,
              { path: i.path, expected: f, actual: u.version },
            );
          if (i.action === "Delete") {
            if (i.rows.length) throw Error("Delete directive takes no body");
          } else {
            let p = u.text.startsWith("﻿"),
              m = (p ? u.text.slice(1) : u.text).replace(
                /\r\n/g,
                `
`,
              ).split(`
`),
              g = [],
              y;
            for (let w of i.rows)
              if (w === "@@" || w.startsWith("@@ ")) ((y = { before: [], after: [] }), g.push(y));
              else {
                if (!y || ![" ", "+", "-"].includes(w[0])) throw Error("Invalid hunk line");
                (w[0] !== "+" && y.before.push(w.slice(1)), w[0] !== "-" && y.after.push(w.slice(1)));
              }
            if (!g.length && !i.move_to) throw Error("Update needs at least one hunk");
            let b = 0;
            for (let [w, z] of g.entries()) {
              let x = { path: i.path, hunk: w + 1, first_context: z.before[0] ?? null };
              if (!z.before.length)
                throw new PatchError(
                  "HUNK_NO_CONTEXT",
                  `${i.path}: hunk ${w + 1} has only '+' lines; include at least one unchanged or removed line so the insertion point is unique`,
                  x,
                );
              let S = [];
              for (let R = 0; R <= m.length - z.before.length; R++)
                z.before.every((Ie, Ge) => m[R + Ge] === Ie) && S.push(R);
              if (!S.length) {
                let R = z.before.find((Ge) => !m.includes(Ge)) ?? null,
                  Ie = R !== null && m.some((Ge) => squash(Ge) === squash(R));
                throw new PatchError(
                  "HUNK_NOT_FOUND",
                  `${i.path}: hunk ${w + 1} context not found${R !== null ? `; no line equals ${JSON.stringify(R.slice(0, 120))}` : " as a contiguous block"}${Ie ? " (a whitespace-different line exists)" : ""}. Re-read the file and copy context exactly.`,
                  {
                    ...x,
                    missing_line: R,
                    hint: Ie
                      ? "A line with the same text but different leading/trailing whitespace exists; copy context exactly as read_files returned it."
                      : R === null
                        ? "Every context line exists individually but not in this order/adjacency; the block may span a region that changed."
                        : "The line does not exist in the file; it may have been edited or the patch targets the wrong file.",
                  },
                );
              }
              if (S.length > 1)
                throw new PatchError(
                  "HUNK_AMBIGUOUS",
                  `${i.path}: hunk ${w + 1} context matches ${S.length} places (lines ${S.map((R) => R + 1).join(", ")}); add surrounding lines to make it unique`,
                  { ...x, occurrences: S.map((R) => R + 1) },
                );
              if (S[0] < b)
                throw new PatchError(
                  "HUNK_OUT_OF_ORDER",
                  `${i.path}: hunk ${w + 1} matches at line ${S[0] + 1}, but after the previous hunk it must start at or after line ${b + 1}; order hunks top-to-bottom`,
                  { ...x, found_line: S[0] + 1, cursor_line: b + 1 },
                );
              (m.splice(S[0], z.before.length, ...z.after), (b = S[0] + z.after.length));
            }
            ((d =
              (p ? "﻿" : "") +
              m.join(`
`)),
              u.text.includes(`\r
`) &&
                (d = d.replace(
                  /\n/g,
                  `\r
`,
                )));
          }
        }
        if (d !== null && Buffer.byteLength(d) > MAX_FILE_BYTES) throw Error("Result file exceeds 1 MiB");
        o.push({ ...i, full: a, dest: c, old: u, body: d });
      }
      (await r(
        "Write workspace files",
        o.map(
          (i) => `${i.action}${i.move_to ? " + Move" : ""}: ${i.path}${i.move_to ? " -> " + i.move_to : ""}`,
        ).join(`
`) +
          `

PATCH (remote supplied):
` +
          e.patch,
      ),
        n());
      for (let i of o) {
        if ((await this.resolve(i.path, !i.old), this.dirty(i.full)))
          throw Error("Editor changed while awaiting approval");
        if (i.old) {
          if ((await this.bytes(i.path)).version !== i.old.version)
            throw Error("File changed while awaiting approval");
        } else
          try {
            throw (await fs.lstat(i.full), Error("New file appeared"));
          } catch (a) {
            if (a.code !== "ENOENT") throw a;
          }
        if (i.dest !== i.full) {
          if ((await this.resolve(i.move_to, !0), this.dirty(i.dest)))
            throw Error("Editor changed while awaiting approval");
          try {
            throw (await fs.lstat(i.dest), Error("Move destination appeared while awaiting approval"));
          } catch (a) {
            if (a.code !== "ENOENT") throw a;
          }
        }
      }
      this.beforeWrite && (await this.beforeWrite(o.flatMap((i) => [i.path, i.move_to].filter(Boolean))));
      let s = [];
      try {
        for (let i of o)
          i.body !== null &&
            (await fs.mkdir(path.dirname(i.dest), { recursive: !0 }),
            await this.resolve(i.move_to || i.path, !0),
            (i.temp = path.join(path.dirname(i.dest), `.anvil-${crypto.randomUUID()}.tmp`)),
            await fs.writeFile(i.temp, i.body, {
              flag: "wx",
              mode: i.old ? (await fs.stat(i.full)).mode : 420,
            }));
        for (let i of o) {
          if ((n(), await this.resolve(i.path, !i.old), this.dirty(i.full)))
            throw Error("Unsaved editor detected during commit");
          if (i.old && (await this.bytes(i.path)).version !== i.old.version)
            throw Error("File changed during commit");
          if (i.dest !== i.full && this.dirty(i.dest)) throw Error("Unsaved editor detected during commit");
          (i.body === null
            ? await fs.unlink(i.full)
            : i.dest !== i.full
              ? (await fs.link(i.temp, i.dest), await fs.unlink(i.full))
              : i.old
                ? await fs.rename(i.temp, i.full)
                : await fs.link(i.temp, i.full),
            s.push(i));
        }
      } catch (i) {
        let a = [];
        for (let c of s.reverse())
          try {
            if (c.body !== null && versionOf(await fs.readFile(c.dest)) !== versionOf(Buffer.from(c.body)))
              throw Error("Concurrent writer; refusing to overwrite");
            c.dest !== c.full
              ? (await fs.writeFile(c.full, c.old.bytes, { flag: "wx" }), await fs.unlink(c.dest))
              : c.old
                ? await fs.writeFile(c.full, c.old.bytes, c.body === null ? { flag: "wx" } : {})
                : await fs.unlink(c.full);
          } catch {
            a.push(c.path);
          }
        throw Error(`${i.message}; rollback${a.length ? " incomplete: " + a.join(", ") : " completed"}`);
      } finally {
        for (let i of o) i.temp && (await fs.unlink(i.temp).catch(() => {}));
      }
      return {
        changed: o.map((i) => ({
          path: i.move_to || i.path,
          action: i.action,
          ...(i.move_to ? { moved_from: i.path } : {}),
          version: i.body === null ? null : versionOf(Buffer.from(i.body)),
        })),
        multi_file_atomic: !1,
      };
    }
  };
module.exports = { Files, PatchError };
