"use strict";
var fs = require("node:fs/promises"),
  path = require("node:path"),
  MAX_SKILL_CHARS = 24e3,
  MAX_DESCRIPTION_CHARS = 5e3,
  NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/,
  parseFrontMatter = (t) => {
    let e = t.replace(/^﻿/, "").replace(
        /\r\n/g,
        `
`,
      ),
      r = /^---\n([\s\S]*?)\n---\n?/.exec(e);
    if (!r) return { meta: {}, body: e.trim() };
    let n = {},
      o = r[1].split(`
`);
    for (let s = 0; s < o.length; s++) {
      let i = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(o[s]);
      if (!i) continue;
      let a = i[1].toLowerCase(),
        c = i[2].trim();
      if (c === ">" || c === "|" || c === ">-" || c === "|-") {
        let l = c.startsWith(">"),
          u = [];
        for (; s + 1 < o.length && (o[s + 1].trim() === "" || /^\s+\S/.test(o[s + 1]));)
          u.push(o[++s].trim());
        c = l
          ? u.join(" ").replace(/\s+/g, " ").trim()
          : u
              .join(
                `
`,
              )
              .trim();
      }
      n[a] = c.replace(/^["']|["']$/g, "");
    }
    return { meta: n, body: e.slice(r[0].length).trim() };
  },
  Skills = class {
    constructor(e) {
      ((this.dir = e), (this.cache = null), (this.loadedAt = 0), (this.loading = null));
    }
    async all(e = !1) {
      return !e && this.cache && Date.now() - this.loadedAt < MAX_DESCRIPTION_CHARS
        ? this.cache
        : this.loading
          ? this.loading
          : ((this.loading = this.load().finally(() => {
              this.loading = null;
            })),
            this.loading);
    }
    async load() {
      let e = new Map(),
        r = [];
      try {
        r = await fs.readdir(this.dir, { withFileTypes: !0 });
      } catch {
        return ((this.cache = e), (this.loadedAt = Date.now()), e);
      }
      for (let n of r.sort((o, s) => o.name.localeCompare(s.name))) {
        if (!n.isFile() || !n.name.toLowerCase().endsWith(".md")) continue;
        let o;
        try {
          o = await fs.readFile(path.join(this.dir, n.name), "utf8");
        } catch {
          continue;
        }
        let { meta: s, body: i } = parseFrontMatter(o),
          a = String(s.name || n.name.replace(/\.md$/i, "")).toLowerCase();
        !NAME_RE.test(a) ||
          e.has(a) ||
          e.set(a, {
            name: a,
            description: String(s.description || "").slice(0, 300) || "No description provided.",
            body: i.slice(0, MAX_SKILL_CHARS),
            truncated: i.length > MAX_SKILL_CHARS,
          });
      }
      return ((this.cache = e), (this.loadedAt = Date.now()), e);
    }
    async index() {
      let e = await this.all();
      return {
        skills: [...e.values()].map((r) => ({ name: r.name, description: r.description })),
        count: e.size,
        usage: e.size
          ? "Call skill again with a name to load that skill's full instructions."
          : "No skills are bundled with this build.",
      };
    }
    async get(e) {
      let r = String(e || "")
          .trim()
          .toLowerCase(),
        n = await this.all(),
        o = n.get(r);
      if (o)
        return { name: o.name, description: o.description, instructions: o.body, truncated: o.truncated };
      let s = [...n.keys()],
        i = s.filter((a) => a.includes(r) || r.includes(a));
      throw Error(
        `Unknown skill '${r}'.${i.length ? ` Did you mean: ${i.join(", ")}?` : ""} Available: ${s.join(", ") || "none"}`,
      );
    }
  };
module.exports = { Skills };
