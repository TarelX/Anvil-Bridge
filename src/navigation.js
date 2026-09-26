"use strict";
var Navigation = class {
  constructor(e, r) {
    ((this.vscode = e), (this.files = r));
  }
  async location(e, r) {
    if (!e || e.scheme !== "file") return null;
    try {
      let n = this.files.relative(e.fsPath);
      return (
        await this.files.resolve(n),
        {
          path: n,
          line: r.start.line + 1,
          column: r.start.character + 1,
          end_line: r.end.line + 1,
          end_column: r.end.character + 1,
        }
      );
    } catch {
      return null;
    }
  }
  async diagnostics(e) {
    let r = [],
      n = e.max_results || 100,
      o = e.path ? await this.files.resolve(e.path) : null,
      s = require("node:path"),
      i = !1,
      a = e.severity?.length ? new Set(e.severity) : null,
      c = { error: 0, warning: 0, information: 0, hint: 0 };
    for (let [l, u] of this.vscode.languages.getDiagnostics()) {
      if (o) {
        let d = s.relative(o, l.fsPath);
        if (d === ".." || d.startsWith(".." + s.sep) || s.isAbsolute(d)) continue;
      }
      for (let d of u) {
        let f = ["error", "warning", "information", "hint"][d.severity] || "error";
        if (a && !a.has(f)) continue;
        let p = await this.location(l, d.range);
        if (p) {
          if ((c[f]++, r.length >= n)) {
            i = !0;
            break;
          }
          r.push({ ...p, message: d.message.slice(0, 2e3), severity: f, source: d.source });
        }
      }
      if (i) break;
    }
    return {
      diagnostics: r,
      truncated: i,
      counts: c,
      severity_filter: e.severity?.length ? e.severity : "all",
      note: "Existing editor diagnostics only; no build was run.",
      ...(i ? { next_step: "Narrow path or filter severity to see the remaining diagnostics." } : {}),
    };
  }
  async lsp(e) {
    let r = this.vscode,
      n = e.max_results || 50,
      o,
      s;
    if (e.operation !== "workspace_symbols") {
      if (!e.path) throw Error("path is required");
      ((o = r.Uri.file(await this.files.resolve(e.path))), await this.files.bytes(e.path));
      let p = await r.workspace.openTextDocument(o);
      if (
        [
          "definition",
          "references",
          "implementation",
          "hover",
          "type_definition",
          "incoming_calls",
          "outgoing_calls",
        ].includes(e.operation)
      ) {
        if (!e.line || !e.column || e.line > p.lineCount || e.column - 1 > p.lineAt(e.line - 1).text.length)
          throw Error("Invalid line/column");
        s = new r.Position(e.line - 1, e.column - 1);
      }
    }
    let i = (p, ...h) => {
        let m;
        return Promise.race([
          r.commands.executeCommand(p, ...h),
          new Promise((g, y) => {
            m = setTimeout(() => y(Error("Language provider timeout")), 12e3);
          }),
        ]).finally(() => clearTimeout(m));
      },
      a;
    if (
      (e.operation === "workspace_symbols" &&
        (a = await i("vscode.executeWorkspaceSymbolProvider", e.query || "")),
      e.operation === "document_symbols" && (a = await i("vscode.executeDocumentSymbolProvider", o)),
      e.operation === "definition" && (a = await i("vscode.executeDefinitionProvider", o, s)),
      e.operation === "type_definition" && (a = await i("vscode.executeTypeDefinitionProvider", o, s)),
      e.operation === "references" && (a = await i("vscode.executeReferenceProvider", o, s)),
      e.operation === "implementation" && (a = await i("vscode.executeImplementationProvider", o, s)),
      e.operation === "incoming_calls" || e.operation === "outgoing_calls")
    ) {
      let h = ((await i("vscode.prepareCallHierarchy", o, s)) || [])[0];
      if (!h)
        return {
          results: [],
          provider_state: "empty",
          semantic_result_inconclusive: !0,
          inconclusive_if_empty: !0,
          note: "No call hierarchy item at this position; point at a function or method name.",
        };
      let m = e.operation === "incoming_calls",
        g = (await i(m ? "vscode.provideIncomingCalls" : "vscode.provideOutgoingCalls", h)) || [],
        y = [];
      for (let b of g.slice(0, n)) {
        let w = m ? b.from : b.to,
          z = await this.location(w?.uri, w?.selectionRange || w?.range);
        if (!z) continue;
        let x = [];
        for (let S of (b.fromRanges || []).slice(0, 20))
          x.push({ line: S.start.line + 1, column: S.start.character + 1 });
        y.push({
          ...z,
          name: w.name,
          kind: w.kind,
          detail: w.detail || void 0,
          ...(x.length ? { call_sites: x } : {}),
        });
      }
      return {
        root: {
          name: h.name,
          kind: h.kind,
          ...((await this.location(h.uri, h.selectionRange || h.range)) || {}),
        },
        direction: m ? "incoming" : "outgoing",
        results: y,
        truncated: g.length > n,
        provider_state: g.length ? "answered" : "empty",
        semantic_result_inconclusive: !y.length,
        inconclusive_if_empty: !0,
        note: m
          ? "Callers of the symbol; call_sites are positions inside each caller."
          : "Callees invoked by the symbol; call_sites are positions inside the queried symbol.",
      };
    }
    if (e.operation === "hover") {
      a = await i("vscode.executeHoverProvider", o, s);
      let p = (a || []).slice(0, 5).map((h) => ({
        text: h.contents
          .map((m) => (typeof m == "string" ? m : m.value || ""))
          .join(
            `
`,
          )
          .slice(0, 8e3),
      }));
      return {
        results: p,
        provider_state: p.length ? "answered" : "empty",
        semantic_result_inconclusive: !p.length,
        inconclusive_if_empty: !0,
      };
    }
    let c = [...(a || [])],
      l = [],
      u = 0,
      d = 0;
    for (; c.length && l.length < n && u++ < 2e3;) {
      let p = c.shift();
      p.children && c.push(...p.children);
      let h = await this.location(
        p.location?.uri || p.targetUri || p.uri || o,
        p.location?.range || p.targetSelectionRange || p.range || p.selectionRange,
      );
      if (!h) {
        d++;
        continue;
      }
      (e.operation === "references" &&
        e.include_declaration === !1 &&
        h.path === e.path?.replace(/\\/g, "/") &&
        h.line === e.line) ||
        l.push({ ...h, ...(p.name ? { name: p.name, kind: p.kind } : {}) });
    }
    let f = Array.isArray(a) ? a.length > 0 : !!a;
    return {
      results: l,
      truncated: c.length > 0,
      filtered_outside_workspace: d,
      provider_state: f ? "answered" : "empty",
      semantic_result_inconclusive: !l.length,
      inconclusive_if_empty: !0,
    };
  }
  async outline(e) {
    if (!e.path) throw Error("path is required");
    let r = this.vscode,
      n = await this.files.resolve(e.path),
      o = r.Uri.file(n);
    await this.files.bytes(e.path);
    let s = await r.workspace.openTextDocument(o),
      a = await ((d, ...f) => {
        let p;
        return Promise.race([
          r.commands.executeCommand(d, ...f),
          new Promise((h, m) => {
            p = setTimeout(() => m(Error("Language provider timeout")), 12e3);
          }),
        ]).finally(() => clearTimeout(p));
      })("vscode.executeDocumentSymbolProvider", o),
      c = [
        "file",
        "module",
        "namespace",
        "package",
        "class",
        "method",
        "property",
        "field",
        "constructor",
        "enum",
        "interface",
        "function",
        "variable",
        "constant",
        "string",
        "number",
        "boolean",
        "array",
        "object",
        "key",
        "null",
        "enum_member",
        "struct",
        "event",
        "operator",
        "type_parameter",
      ],
      l = (d) => {
        let f = d.range || d.location?.range,
          p = f ? f.start.line + 1 : 1,
          h = f ? f.end.line + 1 : 1,
          m =
            typeof d.kind == "number" && d.kind >= 1 && d.kind <= c.length
              ? c[d.kind - 1]
              : String(d.kind || "symbol"),
          g = { name: d.name, kind: m, start_line: p, end_line: h };
        return (
          d.detail && (g.detail = d.detail),
          d.containerName && (g.container = d.containerName),
          Array.isArray(d.children) && d.children.length && (g.children = d.children.map(l)),
          g
        );
      },
      u = Array.isArray(a) ? a.map(l) : [];
    return {
      path: e.path,
      total_lines: s?.lineCount ?? 0,
      symbols: u,
      count: u.length,
      provider_state: Array.isArray(a) && a.length ? "answered" : "empty",
      note: u.length
        ? "Hierarchical outline extracted from document symbols."
        : "No document symbols returned by active language services.",
    };
  }
};
module.exports = { Navigation };
