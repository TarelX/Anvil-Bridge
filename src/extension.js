"use strict";
var vscode = require("vscode"),
  HOST_NAME = (() => { try { return require("node:os").hostname() || "本机"; } catch { return "本机"; } })(),
  fsp = require("node:fs/promises"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  { spawn } = require("node:child_process"),
  cloudflared = require("./cloudflared"),
  { Bridge } = require("./bridge"),
  controller,
  esc = (t) =>
    String(t ?? "").replace(
      /[&<>"']/g,
      (e) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[e],
    ),
  diffTag = (t, e = "") => {
    if (!t) return "";
    let r = String(t).trim(),
      n = e ? `diff-tag ${e}` : "diff-tag";
    if (r === "已删除" || /delete/i.test(r))
      return `<span class="${n}"><span class="diff-del">已删除</span></span>`;
    let o = /\+(\d+)/.exec(r),
      s = /-(\d+)/.exec(r);
    if (o || s) {
      let i = [];
      return (
        o && i.push(`<span class="diff-add">+${o[1]}</span>`),
        s && i.push(`<span class="diff-del">-${s[1]}</span>`),
        `<span class="${n}">${i.join(" ")}</span>`
      );
    }
    return `<span class="${n}"><span class="diff-neutral">${esc(r)}</span></span>`;
  },
  { EMPTY_PHRASES, groupEvents, updateCommandEvent } = require("./activity"),
  ANVIL_PATH = "M16 0H20V1H16ZM16 1H22V2H16ZM16 2H23V3H16ZM16 3H24V4H16ZM8 4H13V5H8ZM17 4H25V5H17ZM5 5H15V6H5ZM19 5H25V6H19ZM2 6H16V7H2ZM20 6H26V7H20ZM1 7H17V8H1ZM21 7H26V8H21ZM30 7H32V8H30ZM1 8H8V9H1ZM15 8H18V9H15ZM21 8H26V9H21ZM29 8H32V9H29ZM1 9H7V10H1ZM16 9H19V10H16ZM22 9H26V10H22ZM28 9H32V10H28ZM8 10H10V11H8ZM22 10H26V11H22ZM28 10H32V11H28ZM6 11H10V12H6ZM22 11H26V12H22ZM28 11H32V12H28ZM5 12H9V13H5ZM23 12H26V13H23ZM28 12H32V13H28ZM3 13H8V14H3ZM11 13H21V14H11ZM23 13H25V14H23ZM27 13H32V14H27ZM2 14H7V15H2ZM11 14H21V15H11ZM24 14H25V15H24ZM27 14H32V15H27ZM1 15H7V16H1ZM12 15H20V16H12ZM26 15H32V16H26ZM1 16H6V17H1ZM13 16H18V17H13ZM25 16H31V17H25ZM1 17H6V18H1ZM14 17H18V18H14ZM25 17H31V18H25ZM0 18H5V19H0ZM8 18H9V19H8ZM12 18H19V19H12ZM24 18H30V19H24ZM0 19H5V20H0ZM7 19H9V20H7ZM12 19H20V20H12ZM23 19H28V20H23ZM0 20H5V21H0ZM7 20H10V21H7ZM22 20H27V21H22ZM0 21H5V22H0ZM7 21H11V22H7ZM21 21H24V22H21ZM27 21H31V22H27ZM0 22H4V23H0ZM7 22H11V23H7ZM15 22H16V23H15ZM25 22H31V23H25ZM0 23H3V24H0ZM7 23H11V24H7ZM14 23H31V24H14ZM7 24H13V25H7ZM15 24H31V25H15ZM7 25H14V26H7ZM16 25H30V26H16ZM8 26H14V27H8ZM18 26H28V27H18ZM9 27H15V28H9ZM20 27H25V28H20ZM10 28H17V29H10ZM11 29H17V30H11ZM12 30H17V31H12ZM13 31H17V32H13Z",
  ACTIVITY_KEEP = 100,
  ACTIVITY_SHOW = 50,
  CHECKPOINT_SHOW = 50,
  Controller = class {
    constructor(e) {
      ((this.context = e),
        (this.bridge = null),
        (this.panel = null),
        (this.skillsPanel = null),
        (this.cpPanel = null),
        (this.tunnel = null),
        (this.publicBase = null),
        (this.events = []),
        (this.pending = !1),
        (this.epoch = 0),
        (this.accessMode = "approval"),
        (this.accessRevision = 0),
        (this.modePrompt = !1),
        (this.tunnelWaiters = []),
        (this.cfState = null),
        (this.cfBusy = !1),
        (this.renderTimer = null),
        (this.lastRender = 0),
        (this.output = vscode.window.createOutputChannel("Anvil Bridge")),
        (this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50)),
        (this.status.command = "lanternBridge.panel"),
        this.status.show(),
        e.subscriptions.push(this.output, this.status));
      let n = {
          start: () => this.start(),
          stop: () => this.stop(),
          panel: () => this.openPanel(),
          copyUrl: () => this.copyUrl(),
          copyPrompt: () => this.copyUrl(!0),
          copyReconnectPrompt: () => this.copyUrl(!1, !0),
          rotate: () => this.rotate(),
          tunnel: () => this.startTunnel(),
          stopTunnel: () => this.stopTunnel(),
          checkCloudflared: () => this.checkCloudflared(),
          installCloudflared: () => this.installCloudflared(),
          approvalMode: () => this.setAccessMode("approval"),
          fullAccessMode: () => this.setAccessMode("full"),
          confirmFullAccess: () => this.confirmFullAccess(),
          cancelFullAccess: () => this.cancelFullAccess(),
          terminals: () => {
            if (!this.bridge?.running) throw Error("请先启动服务");
            return this.bridge.commands.showPicker();
          },
          skills: () => this.openSkills(),
          checkpoints: () => this.openCheckpoints(),
          clearLog: () => {
            ((this.events = []), this.output.clear(), this.changed());
          },
        },
        o = null;
      for (let [s, i] of Object.entries(n))
        e.subscriptions.push(
          vscode.commands.registerCommand(`lanternBridge.${s}`, () =>
            this.safe(async () => i()),
          ),
        );
      (e.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
          (this.stop(), this.event("工作区已变更", "服务已停止；请重新选择根目录并启动。"));
        }),
      ),
        e.subscriptions.push(
          vscode.window.registerWebviewViewProvider("lanternBridge.sidebar", this, {
            webviewOptions: { retainContextWhenHidden: !1 },
          }),
        ),
        e.subscriptions.push(
          vscode.workspace.onDidChangeConfiguration((s) => {
            (s.affectsConfiguration("lanternBridge.enableCommands") &&
              this.accessMode !== "full" &&
              !vscode.workspace.getConfiguration("lanternBridge").get("enableCommands", !1) &&
              this.bridge?.commands.closeAll("commands disabled"),
              s.affectsConfiguration("lanternBridge") && this.changed());
          }),
        ),
        this.changed());
    }
    get uiUnlocked() {
      return !0;
    }
    async safe(e) {
      try {
        return await e();
      } catch (r) {
        (this.event("本地操作失败", r.message),
          vscode.window.showErrorMessage(`Anvil Bridge: ${r.message}`));
      }
    }
    event(e, r = "", n) {
      let o = {
        id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        time: new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }),
        title: e,
        detail: String(r).slice(0, 1e3),
      };
      (n?.kind === "search" && (o.search = n),
        n?.kind === "outcome" && (o.outcome = n),
        updateCommandEvent(this.events, o) || this.events.unshift(o),
        (this.events = this.events.slice(0, ACTIVITY_KEEP)),
        this.output.appendLine(`${o.time} ${e} ${String(r).slice(0, 1e3)}`),
        this.changed(),
        (e === "自动检查点已创建" || e === "检查点失败") && this.refreshCheckpoints?.());
    }
    async openFile(e) {
      try {
        let r = this.bridge?.root || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!r) {
          vscode.window.showWarningMessage("未找到工作区根目录");
          return;
        }
        let n = String(e || "").trim(),
          o = null,
          s = 0,
          i = /^(.*?):(\d+)(?::(\d+))?$/.exec(n);
        i && ((n = i[1]), (o = parseInt(i[2], 10) - 1), (s = Math.max(0, Number(i[3] || 1) - 1)));
        let a = path.resolve(r, n),
          c = path.relative(r, a);
        if (c.startsWith("..") || path.isAbsolute(c)) {
          vscode.window.showErrorMessage("无法打开工作区之外的文件");
          return;
        }
        let l = vscode.Uri.file(a),
          u = await vscode.workspace.openTextDocument(l),
          d = await vscode.window.showTextDocument(u, { preview: !0, preserveFocus: !1 });
        if (o !== null && o >= 0 && o < u.lineCount) {
          let f = new vscode.Position(o, Math.min(s, u.lineAt(o).text.length));
          ((d.selection = new vscode.Selection(f, f)),
            d.revealRange(new vscode.Range(f, f), vscode.TextEditorRevealType.InCenter));
        }
      } catch (r) {
        vscode.window.showErrorMessage(`无法打开文件 ${e}: ${r.message}`);
      }
    }
    async openSearchMatch(e, r) {
      if (typeof e != "string" || !Number.isInteger(r) || r < 0 || r >= 20) return;
      let n = this.events.find((i) => i.id === e)?.search,
        o = n?.matches[r],
        s = this.bridge;
      if (!o || !s || n.root !== s.root) {
        vscode.window.showInformationMessage("搜索记录已清空或工作区已变化，请重新搜索。");
        return;
      }
      (await s.files.resolve(o.path),
        this.bridge === s &&
          (!Number.isSafeInteger(o.line) ||
            o.line < 1 ||
            !Number.isSafeInteger(o.column) ||
            o.column < 1 ||
            (await this.openFile(`${o.path}:${o.line}:${o.column}`))));
    }
    formatSearchCard(e) {
      let r = e.search,
        n = `${r.matchCount} 个匹配 \xB7 ${r.fileCount} 个文件${r.truncated ? "（结果不完整）" : ""}`,
        o = r.matches
          .map(
            (c, l) =>
              `<button type="button" class="search-match" data-search-event="${esc(e.id)}" data-search-index="${l}" title="打开 ${esc(c.path)}:${c.line}:${c.column}"><code class="search-snippet">${esc(c.snippet)}</code><span class="search-location">${esc(c.path)}:${c.line}:${c.column}</span></button>`,
          )
          .join(""),
        s = r.matchCount
          ? ""
          : `<p class="detail-text">${r.truncated ? "已扫描范围内没有匹配；搜索未完成，请缩小范围。" : "未找到匹配。"}</p>`,
        i = r.previewOmitted
          ? `<p class="detail-text">仅预览前 20 条，另有 ${r.previewOmitted} 条已返回给 AI。</p>`
          : "",
        a = r.truncated
          ? '<p class="detail-text">搜索达到预算或结果上限；以上数量不是完整总数，请缩小搜索范围。</p>'
          : "";
      return `<li class="event-item"><details class="event-card search-event" data-event-id="${esc(e.id)}"><summary class="event-summary"><span class="tool-badge search"><svg class="badge-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>FIND</span><span class="search-heading"><strong class="event-title">搜索 “${esc(r.pattern)}”</strong><span class="search-count">${n}</span></span><time class="event-time">${esc((e.time || "").slice(11, 19))}</time><svg class="event-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg></summary><div class="event-body"><p class="search-scope">${r.mode === "regex" ? "正则" : "字面"}搜索 \xB7 ${esc(r.scope)}</p><div class="search-matches">${o}</div>${s}${i}${a}</div></details></li>`;
    }
    formatEventCard(e, r, n) {
      if (e.search) return this.formatSearchCard(e);
      let o = n?.count || 1,
        s = {
          "Session opened": "会话已连接",
          "Session closed": "会话已断开",
          "Tool request": "工具请求",
          "Tool completed": "工具已完成",
          "Tool failed": "工具失败",
          "Command started": "命令已启动",
          "Command finished": "命令已结束",
        },
        i = e.title || "",
        a = s[i] || i,
        c = e.detail || "",
        l = (e.time || "").slice(11, 19),
        u = (o > 1 ? n.id : e.id) || `ev-${r}`,
        d = "system",
        f = "SYS",
        p = "system",
        h =
          '<svg class="badge-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
        m = e.outcome
          ? e.outcome.isError === !0
          : [
              "Tool failed",
              "Server error",
              "本地操作失败",
              "检查点失败",
              "隧道启动失败",
              "隧道超时",
              "操作失败",
            ].includes(i),
        g = [],
        y = "",
        b = e.outcome?.command_id ? c : "";
      if (m)
        ((d = "error"),
          (f = "FAIL"),
          (p = "error"),
          (h =
            '<svg class="badge-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'));
      else if (/^读取|^read/i.test(i))
        ((d = "read"),
          (f = "READ"),
          (p = "read"),
          (h =
            '<svg class="badge-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>'),
          c &&
            (g = [
              ...new Set(
                c
                  .split(
                    `
`,
                  )
                  .map((x) => x.trim())
                  .filter(Boolean),
              ),
            ].map((x) => ({ path: x }))));
      else if (/^编辑|^edit|^patch/i.test(i)) {
        if (
          ((d = "edit"),
          (f = "EDIT"),
          (p = "edit"),
          (h =
            '<svg class="badge-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>'),
          c)
        )
          for (let x of c
            .split(
              `
`,
            )
            .map((S) => S.trim())
            .filter(Boolean))
            if (/^[+-]\d+/.test(x)) y = x;
            else {
              let S = x.split(/\s{2,}/);
              g.push({ path: S[0], diff: S[1] || "" });
            }
      } else
        /命令|command|run_command|exec/i.test(i)
          ? ((d = "command"),
            (f = "EXEC"),
            (p = "command"),
            (h =
              '<svg class="badge-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>'),
            (b = c))
          : /搜索|查找|浏览|search|find|list/i.test(i)
            ? ((d = "search"),
              (f = "FIND"),
              (p = "search"),
              (h =
                '<svg class="badge-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>'))
            : /LSP|诊断|diagnostic/i.test(i)
              ? ((d = "diag"),
                (f = "LSP"),
                (p = "diag"),
                (h =
                  '<svg class="badge-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 12 2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>'),
                c && !c.includes(" ") && c.includes(".") && (g = [{ path: c.split(":")[0] }]))
              : /session|会话/i.test(i)
                ? ((d = "session"),
                  (f = "CONN"),
                  (p = "session"),
                  (h =
                    '<svg class="badge-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>'))
                : /检查点.*已创建/i.test(i) &&
                  ((d = "checkpoint"),
                  (f = "PSST"),
                  (p = "psst"),
                  (h =
                    '<svg class="badge-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="⌘"><path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z"/></svg>'));
      if (!g.length && c)
        for (let x of c
          .split(
            `
`,
          )
          .map((S) => S.trim())
          .filter(Boolean))
          /^[a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+(?::\d+)?$/.test(x) && g.push({ path: x.split(":")[0] });
      let w = "";
      if (g.length) {
        let x = g
          .map(
            (S) =>
              `<button type="button" class="file-link-btn" data-open-file="${esc(S.path)}" title="在 VS Code 中打开预览 ${esc(S.path)}"><svg class="file-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><span class="file-name">${esc(S.path)}</span>${diffTag(S.diff, "file-diff")}<span class="file-action">在 VS Code 中打开 ↗</span></button>`,
          )
          .join("");
        w += `<div class="file-group-title">${d === "edit" ? "修改的文件与变更" : "涉及的文件"}</div><div class="file-list">${x}</div>`;
      }
      if (
        (b && (w += `<div class="file-group-title">终端命令</div><div class="code-block">$ ${esc(b)}</div>`),
        e.outcome?.output &&
          (w += `<div class="file-group-title">命令输出（末尾最多 4000 字符）</div><div class="code-block">${esc(e.outcome.output)}</div>`),
        !g.length && !b && c && (w += `<p class="detail-text">${esc(c)}</p>`),
        e.outcome)
      ) {
        let x = e.outcome,
          S = {
            starting: "启动中",
            running: "运行中",
            stopping: "正在停止",
            completed: "已完成",
            failed: "执行失败",
            cancelled: "已取消",
            timed_out: "已超时",
            termination_unconfirmed: "终止尚未确认",
          },
          R = [];
        (x.command_id && R.push("命令 " + x.command_id.slice(0, 8)),
          x.status && R.push(S[x.status] || x.status),
          x.exit_code !== void 0 && R.push("退出码 " + (x.exit_code ?? "尚未取得")),
          x.reason && R.push("原因：" + x.reason),
          x.message && R.push("错误：" + x.message),
          R.length && (w += '<p class="detail-text">' + esc(R.join(" \xB7 ")) + "</p>"));
      }
      if (o > 1) {
        let x = n.times.map((S) => `<li>${esc((S || "").slice(11, 19))}</li>`).join("");
        w += `<div class="file-group-title">连续 ${o} 次调用（最新在前）</div><ol class="event-times">${x}</ol>`;
      }
      let z = o > 1 ? `<span class="event-count" title="连续 ${o} 次相同操作，已合并">\xD7${o}</span>` : "";
      return `<li class="event-item"><details class="event-card${o > 1 ? " grouped" : ""}" data-event-id="${esc(u)}"><summary class="event-summary"><span class="tool-badge ${p}">${h}${f}</span><strong class="event-title">${esc(a)}</strong>${z}${diffTag(y, "event-diff-stat")}<time class="event-time">${esc(l)}</time><svg class="event-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg></summary><div class="event-body">${w || '<p class="detail-text">无附加元数据</p>'}</div></details></li>`;
    }
    changed() {
      let e = Date.now() - this.lastRender;
      if (e >= CHECKPOINT_SHOW) {
        this.render();
        return;
      }
      this.renderTimer ||
        (this.renderTimer = setTimeout(() => {
          ((this.renderTimer = null), this.render());
        }, CHECKPOINT_SHOW - e));
    }
    render() {
      (this.renderTimer && (clearTimeout(this.renderTimer), (this.renderTimer = null)),
        (this.lastRender = Date.now()),
        (this.status.text = this.bridge?.running
          ? `$(radio-tower) Anvil Bridge：${this.accessMode === "full" ? "完全访问" : "审批模式"}`
          : "$(radio-tower) Anvil Bridge：已停止"),
        (this.status.tooltip = this.bridge?.running
          ? `本地 MCP 端口 ${this.bridge.port}。点击打开控制面板。`
          : "服务已停止，不会自动启动。"),
        this.panel &&
          this.panel.webview.postMessage({
            type: "state",
            authenticated: this.uiUnlocked,
            html: this.uiUnlocked ? this.stateHtml() : "",
          }));
    }
    async setAccessMode(e) {
      if (e === "approval") {
        this.modePrompt = null;
        this.accessRevision++;
        let o = this.accessMode === "full";
        ((this.accessMode = "approval"),
          o && this.bridge?.commands.closeAll("access mode changed"),
          this.event("访问模式已切换", "审批模式：文件与命令逐次确认；已请求停止完全访问期间的托管命令"));
        return;
      }
      if (e !== "full" || this.accessMode === "full" || this.modePrompt) return;
      let r = this.bridge,
        n = this.accessRevision;
      if (!r?.running || !vscode.workspace.isTrusted) throw Error("请先在受信任的工作区启动服务");
      ((this.modePrompt = { bridge: r, revision: n }), await this.openPanel().catch(() => {}), this.changed());
    }
    confirmFullAccess() {
      let p = this.modePrompt;
      if (!p) return;
      this.modePrompt = null;
      try {
        if (this.bridge !== p.bridge || !p.bridge.running || !vscode.workspace.isTrusted || this.accessRevision !== p.revision)
          throw Error("连接或权限已变化，请重新选择模式");
        ((this.accessMode = "full"),
          this.accessRevision++,
          this.event("访问模式已切换", "完全访问：文件、Shell 命令与 stdin 均免逐次审批"));
      } finally {
        this.changed();
      }
    }
    cancelFullAccess() {
      this.modePrompt && ((this.modePrompt = null), this.changed());
    }
    async approve(e, r, n, o, s) {
      o();
      let i = this.accessRevision;
      if (["apply_patch", "run_command", "send_command_input"].includes(s) && this.accessMode === "full")
        return (this.event("操作自动授权", `完全访问模式 \xB7 ${s}`), { revision: i });
      let a = `远程客户端：${e.client}
会话：${e.id.slice(0, 8)}

`;
      for (;;) {
        if ((o(), i !== this.accessRevision)) throw Error("访问模式已变化，请重新发起请求");
        let c = await vscode.window.showWarningMessage(
          `Anvil Bridge — ${r}`,
          {
            modal: !0,
            detail:
              a +
              n.slice(0, 1e4) +
              (n.length > 1e4
                ? `

[预览已截断。请选择「查看完整请求」。]`
                : ""),
          },
          "允许一次",
          "查看完整请求",
        );
        if ((o(), i !== this.accessRevision)) throw Error("审批期间访问模式已变化，请重新发起请求");
        if (c === "允许一次") return { revision: i };
        if (c !== "查看完整请求") throw Error("用户已拒绝该请求");
        let l = await vscode.workspace.openTextDocument({
          language: "plaintext",
          content:
            `不可信的远程请求 — 并非来自 Anvil Bridge 的指令

` +
            a +
            n,
        });
        if (
          (await vscode.window.showTextDocument(l, { preview: !1 }),
          (await vscode.window.showInformationMessage(
            "请查看请求文档。准备就绪后点击继续，或直接关闭以拒绝。",
            "继续审批",
          )) !== "继续审批")
        )
          throw Error("已关闭审查；请求已被拒绝");
      }
    }
    async start() {
      if (this.pending || this.bridge?.running) {
        await this.openPanel();
        return;
      }
      if (!vscode.workspace.isTrusted) throw Error("需要受信任的工作区");
      let e = (vscode.workspace.workspaceFolders || []).filter((n) => n.uri.scheme === "file");
      if (!e.length) throw Error("请先打开一个本地文件夹");
      this.pending = !0;
      let r = this.epoch;
      try {
        let n =
          e.length === 1
            ? e[0]
            : (
                await vscode.window.showQuickPick(
                  e.map((a) => ({ label: a.name, description: a.uri.fsPath, folder: a })),
                  { title: "请选择要公开的唯一根目录" },
                )
              )?.folder;
        if (!n) return;
        let o = await fsp.realpath(n.uri.fsPath);
        if (r !== this.epoch) return;
        if (
          !vscode.workspace.isTrusted ||
          !vscode.workspace.workspaceFolders?.some((a) => a.uri.toString() === n.uri.toString())
        )
          throw Error("等待批准期间工作区发生变化");
        if (r !== this.epoch) return;
        let s = vscode.workspace.getConfiguration("lanternBridge").get("port", 0);
        if (!Number.isInteger(s) || s < 0 || s > 65535) throw Error("端口设置无效");
        let i = new Bridge(vscode, o, {
          event: (a, c, l) => this.event(a, c, l),
          changed: () => this.changed(),
          approve: (...a) => this.approve(...a),
          accessState: () => ({ mode: this.accessMode, revision: this.accessRevision }),
          resultMode: () => vscode.workspace.getConfiguration("lanternBridge").get("resultFormat", "text"),
          skillsDir: path.join(this.context.extensionPath, "skills"),
          storageDir: this.context.globalStorageUri.fsPath,
        });
        this.bridge = i;
        try {
          await i.start(s);
        } catch (a) {
          throw (await i.stop(), (this.bridge = null), a);
        }
        if (r !== this.epoch || !this.uiUnlocked || this.bridge !== i) {
          await i.stop();
          return;
        }
        (this.event("服务已启动", `127.0.0.1:${i.port}`), await this.openPanel());
        vscode.workspace.getConfiguration("lanternBridge").get("autoTunnel", !0) &&
          this.startTunnel().catch((a) => (this.event("隧道启动失败", a?.message || String(a)), vscode.window.showErrorMessage(`Anvil Bridge 公网隧道启动失败：${a?.message || a}`)));
      } finally {
        ((this.pending = !1), this.changed());
      }
    }
    async stop() {
      ((this.accessMode = "approval"), (this.modePrompt = null), this.accessRevision++, this.epoch++, this.stopTunnel());
      let e = this.bridge;
      ((this.bridge = null),
        e && (await e.stop(), this.event("服务已停止", "会话已全部吊销；已请求清理命令和持久终端")),
        this.changed());
    }
    async rotate() {
      if (!this.bridge?.running) throw Error("请先启动服务");
      if (!(
        (await vscode.window.showWarningMessage(
          "吊销所有会话并轮换私有 URL？",
          {
            modal: !0,
            detail: "这同时会终止现有会话托管的命令。客户端必须重新初始化。",
          },
          "轮换",
        )) !== "轮换" || !this.bridge?.running
      )) {
        ((this.accessMode = "approval"), this.accessRevision++);
        for (let r of [...this.bridge.sessions.values()]) this.bridge.closeSession(r);
        ((this.bridge.token = crypto.randomBytes(32).toString("hex")),
          this.event("访问凭证已轮换", "之前复制的 URL 已失效"));
      }
    }
    connectionPrompt(url, isPublic) {
      let h = `-H "Content-Type: application/json" -H "Accept: application/json, text/event-stream"`;
      return `请连接我的 MCP 服务器（Anvil Bridge，VS Code 工作区服务）。

MCP 地址（路径里的长串就是访问令牌，不要删改）：
${url}
${
  isPublic
    ? ""
    : `
⚠️ 这是本机地址 127.0.0.1。如果你运行在云端或沙箱里，是访问不到的，请直接告诉我，我会开启公网隧道后重新发给你。
`
}
【传输方式】只用 Streamable HTTP（transport = "streamable-http"/"http"）。不要用旧版 SSE，也不要发 GET 建立 SSE 流，GET 会一直挂住或者返回 405。

【如果你有原生 MCP 客户端】直接用上面的地址添加 streamable-http 服务器，然后调用 tools/list。

【如果没有 MCP 客户端，就用 HTTP 手动连】（每一步都是 POST，响应是 SSE 格式，JSON 在 "data:" 行里）
1. 初始化，并从响应头读取 mcp-session-id：
   curl -sS -D headers.txt -X POST "${url}" ${h} -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"ai-client","version":"1.0"}}}'
2. 发送 initialized 通知（返回 202 即正常）：
   curl -sS -X POST "${url}" ${h} -H "mcp-session-id: <会话ID>" -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
3. 列出工具：
   curl -sS -X POST "${url}" ${h} -H "mcp-session-id: <会话ID>" -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
4. 调用工具：method 用 "tools/call"，params 写成 {"name":"<工具名>","arguments":{...}}，每次请求都带上 mcp-session-id。

【注意事项】
- 所有请求都必须带 mcp-session-id。如果返回 404 "Unknown or expired session"，就从第 1 步重新初始化。
- 如果你的 HTTP 客户端被 Cloudflare 拦截（403/1010），加上请求头 User-Agent: curl/8。
- 单次结果上限约 20 万字符，超出时请用 paths、行范围或 max_results 缩小请求范围。
- run_command 的 command 最多 8000 字符。

连上后请列出可用工具，确认连接成功，然后等我的指示。`;
    }
    async copyUrl(e = !1, r = !1) {
      let n = this.bridge;
      if (!n?.running) throw Error("请先启动服务");
      (e || r) && (this.tunnel || this.tunnelStarting) && !this.publicBase && (this.event("等待公网隧道", "就绪后复制公网地址"), await this.waitForTunnel());
      if (!this.bridge?.running) throw Error("请先启动服务");
      let o = n.url(this.publicBase),
        s = r
          ? `MCP 连接已断开或会话已过期，请用下面的地址重新初始化（POST initialize，从响应头拿新的 mcp-session-id；只用 Streamable HTTP，不要发 GET）：
${o}

重连后先简要告诉我你之前做到哪一步，然后继续。修改文件前先 read_files 获取最新版本；如果有冲突，先问我。`
          : e
            ? this.connectionPrompt(o, !!this.publicBase)
            : o;
      (await vscode.env.clipboard.writeText(s),
        e && this.panel?.webview.postMessage({ type: "copyPromptCopied" }),
        vscode.window.showInformationMessage(
          (r ? "重连提示词已复制" : e ? "连接提示词已复制" : "MCP 地址已复制") +
            (this.publicBase ? "（公网地址）。" : "（本机地址，云端 AI 访问不到）。"),
        ));
    }
    async startTunnel() {
      let e = this.bridge;
      if (!e?.running) throw Error("请先启动服务");
      if (this.tunnel) throw Error("隧道已在运行或正在启动");
      // 与「检测 cloudflared」卡片共用同一套查找逻辑（PATH + WinGet Links + Program Files 等），
      // 并用检测到的完整路径启动，避免 VS Code 进程 PATH 过旧时卡片显示已安装、隧道却 ENOENT。
      if (this.tunnelStarting) throw Error("隧道正在启动");
      let det;
      this.tunnelStarting = !0;
      try {
        det = await cloudflared.detect(this.cfExecutable());
      } finally {
        this.tunnelStarting = !1;
      }
      det?.installed || this.resolveTunnelWaiters();
      if (this.bridge !== e || !e.running || this.tunnel) return;
      if (!det.installed) {
        this.cfState = det;
        this.changed();
        throw Error("未找到 cloudflared：请点击「一键安装」，或在设置 lanternBridge.cloudflaredPath 中填写 cloudflared 的完整路径");
      }
      this.cfState = det;
      let r = det.executable;
      // 等价于：cloudflared tunnel --url http://localhost:PORT --http-host-header localhost:PORT
      // 固定 Host 头为 localhost:PORT，这样无论公网域名是什么，本地服务的 Host 校验都能通过。
      let n = spawn(
        r,
        ["tunnel", "--no-autoupdate", "--url", `http://localhost:${e.port}`, "--http-host-header", `localhost:${e.port}`],
        {
        windowsHide: !0,
        stdio: ["ignore", "pipe", "pipe"],
      },
      );
      this.tunnel = n;
      this.output.appendLine(`[tunnel] ${r} tunnel --url http://localhost:${e.port} --http-host-header localhost:${e.port}`);
      let o = "",
        s = !1,
        i = setTimeout(() => {
          this.tunnel === n && !s && (this.stopTunnel(), this.event("隧道超时", "45 秒内未获得公共端点"));
        }, 45e3);
      i.unref?.();
      let a = (c) => {
        if (this.tunnel !== n || this.bridge !== e || !e.running) return;
        (this.output.append(c.toString()), (o = (o + c.toString()).slice(-16e3)));
        let l = /https:\/\/([a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com)\b/i.exec(o);
        l &&
          !s &&
          ((s = !0),
          clearTimeout(i),
          (this.publicBase = `https://${l[1].toLowerCase()}`),
          (e.publicHost = l[1].toLowerCase()),
          this.event("公共隧道已就绪", `${this.publicBase} · 可直接「复制提示词」`),
          this.changed(),
          this.resolveTunnelWaiters());
      };
      (n.stdout.on("data", a),
        n.stderr.on("data", a),
        n.on("error", (err) => {
          (clearTimeout(i),
            this.tunnel === n &&
              ((this.tunnel = null),
              (this.publicBase = null),
              (e.publicHost = null),
              this.event("隧道启动失败", `${r}：${err?.code === "ENOENT" ? "文件不存在" : err?.message || err}`),
              vscode.window.showErrorMessage(`Anvil Bridge 公网隧道启动失败：${err?.message || err}`),
              this.resolveTunnelWaiters(),
              this.changed()));
        }),
        n.on("close", () => {
          (clearTimeout(i),
            this.tunnel === n &&
              ((this.tunnel = null),
              (this.publicBase = null),
              (e.publicHost = null),
              this.event("隧道已关闭"),
              this.resolveTunnelWaiters(),
              this.changed()));
        }),
        this.event("隧道启动中", "正在等待端点"));
    }
    resolveTunnelWaiters() {
      let e = this.tunnelWaiters;
      this.tunnelWaiters = [];
      for (let r of e) r();
    }
    waitForTunnel(ms = 3e4) {
      return this.publicBase || !(this.tunnel || this.tunnelStarting)
        ? Promise.resolve()
        : new Promise((e) => {
            let r = setTimeout(e, ms);
            this.tunnelWaiters.push(() => (clearTimeout(r), e()));
          });
    }
    cfExecutable() {
      return vscode.workspace.getConfiguration("lanternBridge").get("cloudflaredPath", "cloudflared");
    }
    async checkCloudflared(e = !1) {
      if (this.cfBusy) return this.cfState;
      ((this.cfBusy = !0), this.changed());
      try {
        ((this.cfState = await cloudflared.detect(this.cfExecutable())),
          e ||
            this.event(
              this.cfState.installed ? "cloudflared 已就绪" : "未检测到 cloudflared",
              this.cfState.version || "可使用一键安装",
            ));
      } catch (r) {
        if (((this.cfState = { installed: !1, error: r?.message || String(r) }), !e)) throw r;
      } finally {
        ((this.cfBusy = !1), this.changed());
      }
      return this.cfState;
    }
    async installCloudflared() {
      if (!this.cfBusy) {
        ((this.cfBusy = !0),
          (this.cfState = Object.assign({}, this.cfState || {}, { installing: !0 })),
          this.changed(),
          this.event(
            "正在安装 cloudflared",
            process.platform === "darwin"
              ? "优先使用 Homebrew，否则下载官方二进制，可能需要几分钟"
              : "通过 winget 静默安装，可能需要几分钟",
          ));
        try {
          let e = await cloudflared.install(this.cfExecutable());
          ((this.cfState = e),
            e.installed
              ? (this.event(
                  e.alreadyInstalled ? "cloudflared 已安装" : "cloudflared 安装完成",
                  e.version || "",
                ),
                vscode.window.showInformationMessage(
                  "cloudflared 已就绪：" +
                    (e.version || "已安装") +
                    (e.via === "homebrew" ? "（Homebrew）" : e.via === "official" ? "（官方二进制）" : "")
                ))
              : (this.event("cloudflared 安装失败", e.error || "未知错误"),
                vscode.window.showErrorMessage(e.error || "cloudflared 安装失败")));
        } catch (e) {
          ((this.cfState = { installed: !1, error: (e && e.message) || String(e) }),
            this.event("cloudflared 安装失败", this.cfState.error));
        } finally {
          ((this.cfBusy = !1), this.changed());
        }
      }
    }
    cloudflaredCard(ic = {}) {
      let e = this.cfState,
        r = this.cfBusy,
        n = r && e && e.installing,
        o = '<span class="cf-badge unknown">未检测</span>',
        s = "开启公网隧道需要 cloudflared";
      n
        ? ((o = '<span class="cf-badge working">安装中</span>'),
          (s = process.platform === "darwin" ? "正在安装 cloudflared…" : "正在通过 winget 安装…"))
        : r
          ? ((o = '<span class="cf-badge working">检测中</span>'), (s = "正在查找 cloudflared…"))
          : e && e.installed
            ? ((o = '<span class="cf-badge ok">已安装</span>'), (s = esc((e.version || "已就绪").replace(/^cloudflared version /i, "版本 ").replace(/\s*\(built[^)]*\)/i, ""))))
            : e && e.error
              ? ((o = '<span class="cf-badge bad">不可用</span>'), (s = esc(e.error)))
              : e &&
                ((o = '<span class="cf-badge bad">未安装</span>'),
                (s =
                  process.platform === "darwin"
                    ? "未找到 cloudflared，可以一键安装（Homebrew 或官方二进制）"
                    : process.platform === "win32"
                      ? "未找到 cloudflared，可以一键安装（Windows / winget）"
                      : "未找到 cloudflared，请按官方文档手动安装"));
      let i = r ? " disabled" : "",
        a =
          e && e.installed
            ? `<button class="link" data-command="checkCloudflared"${i}>重新检查</button>`
            : "";
      let canInstall = process.platform === "win32" || process.platform === "darwin",
        extra =
          e && e.installed
            ? ""
            : canInstall
              ? `<div class="cf-actions"><button class="btn btn-primary" data-command="installCloudflared"${i}>${n ? "安装中…" : "一键安装"}</button><button class="btn" data-command="checkCloudflared"${i}>检查</button></div>`
              : `<div class="cf-actions"><button class="btn" data-command="checkCloudflared"${i}>检查</button></div>`;
      return `<div class="group-title">隧道组件</div><div class="group"><div class="row"><span class="sq orange">${ic.cloud || ""}</span><div class="lbl"><b>cloudflared</b><span>${s}</span></div>${o}${a}</div>${extra}</div>`;
    }
    stopTunnel() {
      let e = this.tunnel;
      ((this.tunnel = null),
        (this.publicBase = null),
        this.bridge && (this.bridge.publicHost = null),
        e &&
          (e.kill(),
          setTimeout(() => {
            e.exitCode === null && e.kill("SIGKILL");
          }, 1500).unref?.(),
          this.event("隧道已停止")),
        this.changed());
    }
    groupedSessions() {
      let e = new Map(),
        r = { initializing: 0, idle: 1, recent: 2, working: 3 };
      for (let n of this.bridge?.summary() || []) {
        let o = e.get(n.client);
        (o ||
          ((o = {
            client: n.client,
            state: "initializing",
            last: 0,
            toolCalls: 0,
            runningCommands: 0,
            tasks: [],
            progress: "",
            phase: "",
            percent: null,
            todoId: null,
            tasksAt: 0,
            progressAt: 0,
          }),
          e.set(n.client, o)),
          r[n.state] > r[o.state] && (o.state = n.state),
          (o.last = Math.max(o.last, n.last)),
          (o.toolCalls += n.toolCalls || 0),
          (o.runningCommands += n.runningCommands || 0));
        let s = n.tasksUpdatedAt || (n.tasks.length ? n.last : 0),
          i = n.progressUpdatedAt || (n.progress ? n.last : 0);
        (s > 0 && s >= o.tasksAt && ((o.tasks = n.tasks), (o.tasksAt = s)),
          i > 0 &&
            i >= o.progressAt &&
            ((o.progress = n.progress),
            (o.progressAt = i),
            (o.phase = n.phase || ""),
            (o.percent = Number.isInteger(n.percent) ? n.percent : null),
            (o.todoId = n.todoId || null)));
      }
      return [...e.values()];
    }
    stateHtml() {
      let e = !!this.bridge?.running,
        r = this.groupedSessions(),
        n = r.filter((y) => y.state === "recent" || y.state === "working").length,
        o = {
          initializing: "初始化中",
          working: "处理中",
          recent: "近期有请求",
          idle: "闲置保留",
        },
        s = (y) => {
          let b = Math.max(0, Math.floor((Date.now() - y) / 1e3));
          return b < 60 ? b + " 秒前" : Math.floor(b / 60) + " 分钟前";
        },
        i = e
          ? `<div class="mcp-address"><label for="mcpUrl">MCP 地址</label><div class="mcp-address-row"><input id="mcpUrl" type="text" readonly spellcheck="false" autocomplete="off" aria-describedby="mcpUrlHint" value="${esc(this.bridge.url(this.publicBase))}"><button class="secondary" data-command="copyUrl" title="仅复制 MCP 地址">复制</button></div><p id="mcpUrlHint" class="${this.publicBase ? "public" : "local"}">${this.publicBase ? "公网地址 · 含访问令牌，不要外传" : this.tunnel ? "隧道连接中，就绪后自动切换为公网地址" : "本机地址 · 云端 AI 需要先开启公网隧道"}</p></div>`
          : "",
        a = {
          pending: "待处理",
          in_progress: "进行中",
          completed: "已完成",
        },
        c = { pending: "○", in_progress: "◉", completed: "✓" },
        l = {
          "Session opened": "会话已连接",
          "Session closed": "会话已断开",
          "Tool request": "工具请求",
          "Tool completed": "工具已完成",
          "Tool failed": "工具失败",
          "Command started": "命令已启动",
          "Command finished": "命令已结束",
        },
        u = '<div class="feed" id="activityFeed"><section class="tasks"><h2>任务与进度</h2>';
      r.length ||
        (u +=
          '<div class="empty"><div class="empty-icon" aria-hidden="true"><span class="waiting-shape"><span class="ws-ring"></span><svg class="ws-mark" viewBox="0 0 32 32" shape-rendering="crispEdges"><path fill="#f36f2b" d="'+ANVIL_PATH+'"/></svg></span></div><strong>等待外部 AI 连接</strong><p>启动服务并分享私有 MCP URL。客户端提交的任务和活动会显示在这里。</p></div>');
      for (let y of r) {
        let b = y.tasks.filter((S) => S.status === "completed").length,
          w = y.tasks.length > 0 && b === y.tasks.length,
          z = w ? "completed" : b > 0 ? "in-progress" : "",
          x = w;
        if (
          ((u += `<article class="task-card${x ? " collapsed" : ""}" data-client="${esc(y.client)}"><div class="task-card-header" role="button" tabindex="0" aria-expanded="${x ? "false" : "true"}" title="${x ? "点击展开任务详情" : "点击折叠任务详情"}"><header class="task-heading"><strong>${esc(HOST_NAME)}</strong><span class="client-chip" title="AI 客户端">${esc(y.client)}</span><span class="count-badge ${z}">${y.tasks.length ? b + "/" + y.tasks.length : "无任务"}</span><svg class="task-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 9 6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></header><p class="muted session-label">${o[y.state]} \xB7 最后请求 ${s(y.last)} \xB7 工具调用 ${y.toolCalls} 次${y.runningCommands ? " \xB7 " + y.runningCommands + " 条运行命令" : ""}</p></div><div class="task-body"><div class="task-body-inner"><div class="task-body-divider"></div>`),
          y.progress)
        ) {
          let S = Number.isInteger(y.percent) ? Math.max(0, Math.min(100, y.percent)) : null;
          ((u += '<div class="progress">'),
            (u += `<p class="progress-text">${y.phase ? `<span class="phase-chip">${esc(y.phase)}</span>` : ""}<span>${esc(y.progress)}</span></p>`),
            S !== null &&
              (u += `<div class="progress-meter" role="progressbar" aria-valuenow="${S}" aria-valuemin="0" aria-valuemax="100" aria-label="完成度估计"><div class="progress-track"><div class="progress-fill" style="width:${S}%"></div></div><span class="progress-pct">${S}%</span></div>`),
            (u += "</div>"));
        }
        ((u += '<ul class="task-list">'),
          y.tasks.length || (u += '<li class="muted">客户端尚未提交任务清单。</li>'));
        for (let S of y.tasks)
          u += `<li class="task ${esc(S.status)}${y.todoId && S.id === y.todoId ? " reported" : ""}"><span class="task-icon" aria-label="${a[S.status]}">${c[S.status]}</span><span>${esc(S.title)}</span></li>`;
        u += "</ul></div></div></article>";
      }
      ((u +=
        '</section><section class="activity"><header class="section-heading"><h2>活动记录</h2><button class="quiet" data-command="clearLog" title="仅清空活动记录，不影响任务或连接">清空</button></header><ol class="activity-list">'),
        this.events.length ||
          (u += `<li class="muted empty-log"><div class="empty-carousel" role="status" aria-live="polite">${EMPTY_PHRASES.map((y) => `<p class="empty-phrase"><span class="empty-phrase-text">${esc(y)}</span></p>`).join("")}</div></li>`));
      let d = groupEvents(this.events).slice(0, ACTIVITY_SHOW);
      for (let y of d) u += this.formatEventCard(y.event, y.index, y);
      u += "</ol></section></div>";
      let f =
          '<svg class="btn-icon" width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
        p =
          '<svg class="btn-icon" width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
        h =
          '<svg class="btn-icon copy-normal" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
        m = e
          ? `<button class="btn-stop" data-command="stop" ${this.pending ? "disabled" : ""}>${p}<span>停止服务</span></button>`
          : `<button class="btn-start" data-command="start" ${this.pending ? "disabled" : ""}>${this.pending ? "" : f}<span>${this.pending ? "启动中…" : "启动"}</span></button>`,
        g = `<button class="btn-copy-prompt" data-command="copyPrompt" ${e ? "" : "disabled"}>${h}<span>复制连接提示词</span></button>`;
      let tun = this.publicBase ? "on" : this.tunnel ? "busy" : "",
        state = e
          ? this.publicBase
            ? `<span class="dot online"></span>公网可用 · ${r.length} 个会话`
            : this.tunnel
              ? `<span class="dot pending"></span>隧道连接中…`
              : `<span class="dot online"></span>仅本机 · ${r.length} 个会话`
          : this.pending
            ? `<span class="dot pending"></span>启动中…`
            : `<span class="dot"></span>未运行`,
        ic = {
          warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 21h20L12 3z"/><path d="M12 10v5"/><path d="M12 18h.01"/></svg>',
          power: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 3v9"/><path d="M6.3 7.2a8 8 0 1 0 11.4 0"/></svg>',
          globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
          shield: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5z"/></svg>',
          cloud: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 19a5 5 0 0 1-.6-10A6 6 0 0 1 18 9.5 4.5 4.5 0 0 1 17.5 19z"/></svg>',
          gear: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.4 13a7.7 7.7 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.6 7.6 0 0 0-1.7 1l-2.4-1-2 3.4L6.6 11a7.7 7.7 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7.6 7.6 0 0 0 1.7-1l2.4 1 2-3.4zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/></svg>',
        };
      ((u += `<section class="dock" aria-label="Anvil Bridge 控制中心"><header class="connection-heading"><span class="app-icon"><svg viewBox="0 0 32 32" shape-rendering="crispEdges" aria-hidden="true"><path fill="#f36f2b" d="${ANVIL_PATH}"/></svg></span><div class="app-title"><strong>Anvil Bridge</strong><span class="connection-state">${state}</span></div><button class="dock-toggle" data-toggle="dock" aria-expanded="true" aria-controls="dockBody" title="折叠"><svg class="chev" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 9 6 6 6-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button></header><div class="dock-body" id="dockBody"><div class="tiles"><button class="tile ${e ? "on green" : this.pending ? "busy" : ""}" data-command="${e ? "stop" : "start"}" ${this.pending ? "disabled" : ""}><span class="glyph">${ic.power}</span><span class="t"><b>${e ? "运行中" : this.pending ? "启动中" : "启动"}</b><span>${e ? `端口 ${this.bridge.port} · 点击停止` : "点击开始"}</span></span></button><button class="tile ${tun}" data-command="${this.tunnel ? "stopTunnel" : "tunnel"}" ${e ? "" : "disabled"}><span class="glyph">${ic.globe}</span><span class="t"><b>公网隧道</b><span>${this.publicBase ? "已连接 · 点击关闭" : this.tunnel ? "连接中…" : "未开启"}</span></span></button></div>${i}<div class="actions">${g}<button data-command="copyReconnectPrompt" ${e ? "" : "disabled"}>重连提示词</button></div>`),
        (u += `<div class="group-title">访问权限</div><div class="group"><div class="access-control" role="group" aria-label="工作区访问模式"><div class="mode-buttons"><button class="mode-button" data-command="approvalMode" aria-pressed="${this.accessMode === "approval"}">审批模式</button><button class="mode-button full-mode" data-command="fullAccessMode" aria-pressed="${this.accessMode === "full"}" ${!e ? "disabled" : ""}>完全访问</button></div><p class="access-note ${this.accessMode === "full" ? "warning" : ""}">${this.accessMode === "full" ? "文件、Shell 和命令输入都不用审批。Shell 能访问工作区外的文件，只连接你信任的 AI。" : "每次修改文件都要你批准；命令需在设置中开启，并且逐条审批。"}</p></div></div>`));
      return (
        (u += this.cloudflaredCard(ic)),
        (u += `<details id="connectionDetails"><summary><span class="sq gray">${ic.gear}</span>连接详情</summary><div class="row"><div class="lbl"><b>工作区</b></div><span class="val" title="${esc(this.bridge?.root || "")}">${esc(this.bridge?.root || "未选择")}</span></div><div class="row"><div class="lbl"><b>本地端口</b></div><span class="val">${e ? `127.0.0.1:${this.bridge.port}` : "未监听"}</span></div><div class="row"><div class="lbl"><b>公网地址</b></div><span class="val">${this.publicBase ? esc(this.publicBase.replace("https://", "")) : this.tunnel ? "连接中…" : "未开启"}</span></div><div class="row"><div class="lbl"><b>Shell 命令</b></div><span class="val">${this.accessMode === "full" ? "免审批" : vscode.workspace.getConfiguration("lanternBridge").get("enableCommands", !1) ? "逐条审批" : "已禁用"}</span></div><div class="foot"><button class="btn" data-command="rotate" ${e ? "" : "disabled"}>轮换令牌并断开所有连接</button><p>远程发来的内容不可信；命令没有沙箱，审批时请看清楚。</p></div></details><p class="footnote">Anvil Bridge ${esc(this.context.extension.packageJSON.version)}</p></div></section>`),
        (u += (this.modePrompt ? `<div class="sheet-backdrop" role="dialog" aria-modal="true" aria-labelledby="fullSheetTitle"><div class="sheet"><div class="sheet-icon">${ic.warn || "⚠"}</div><h3 id="fullSheetTitle">开启完全访问？</h3><p class="sheet-path" title="${esc(this.bridge?.root || "")}">${esc(this.bridge?.root || "")}</p><ul class="sheet-list"><li>文件修改、Shell 命令免审批</li><li>Shell 可访问工作区外的文件</li><li>停止服务或轮换令牌后自动恢复审批</li></ul><div class="sheet-actions"><button class="btn" data-command="cancelFullAccess">取消</button><button class="btn btn-danger" data-command="confirmFullAccess" autofocus>开启</button></div></div></div>` : "")),
        u
      );
    }
    async openCheckpoints() {
      if (!this.bridge) throw Error("请先启动服务并选择工作区");
      let e = () => (this.bridge?.running ? this.bridge.checkpoints : null);
      if (!e()) throw Error("请先启动服务并选择工作区");
      let r = async () => {
        let u = e();
        return u
          ? {
              list: await u.list(),
              usage: await u.usage(),
              keep: u.keep,
              maxFileMb: u.maxFileMb,
              offline: !1,
              error: u.lastError || null,
            }
          : { list: [], usage: 0, keep: 0, maxFileMb: 0, offline: !0 };
      };
      if (this.cpPanel) {
        (this.cpPanel.reveal(vscode.ViewColumn.Active), await this.refreshCheckpoints?.());
        return;
      }
      let n = vscode.window.createWebviewPanel(
        "lanternBridge.checkpoints",
        "Anvil Bridge — 检查点",
        vscode.ViewColumn.Active,
        { enableScripts: !0, retainContextWhenHidden: !0, localResourceRoots: [] },
      );
      this.cpPanel = n;
      let o = crypto.randomBytes(20).toString("hex"),
        s = !1,
        i = !1,
        a = !1,
        c = async () => {
          if (!a) {
            if (s) {
              i = !0;
              return;
            }
            s = !0;
            try {
              let u = await Promise.race([
                r(),
                new Promise((d, f) => setTimeout(() => f(Error("读取检查点超时（60 秒），请检查 Git / 磁盘状态后重试")), 6e4)),
              ]);
              a || (await n.webview.postMessage({ type: "data", ...u }));
            } catch (u) {
              a ||
                (await n.webview.postMessage({
                  type: "loadError",
                  message: String(u.stderr?.trim() || u.message || u).slice(0, 500),
                }));
            } finally {
              ((s = !1), i && !a && ((i = !1), c()));
            }
          }
        };
      this.refreshCheckpoints = c;
      let l = [];
      (l.push(
        n.webview.onDidReceiveMessage(async (u) => {
          try {
            if (u?.command === "refresh") return c();
            if (u?.command === "diff") {
              let d = e();
              if (!d) throw Error("服务已停止，请先启动");
              let f = await d.diff(u.id, u.file || void 0);
              n.webview.postMessage({
                type: "diff",
                id: u.id,
                file: u.file || null,
                text: f || "(无差异)",
              });
              return;
            }
            if (u?.command === "restore") {
              let f = Array.isArray(u.files) ? u.files.filter(Boolean) : [],
                y = u.file
                  ? `把文件「${u.file}」回滚到检查点 ${String(u.id).slice(0, 8)}${
                      Number(u.deletes) ? "（该检查点里没有这个文件，回滚会删除它）" : ""
                    }`
                  : `回滚此检查点的全部改动（${f.length} 个文件${
                      f.length ? "：" + f.slice(0, 3).join("、") + (f.length > 3 ? ` 等 ${f.length} 个` : "") : ""
                    }${Number(u.deletes) ? `，其中 ${Number(u.deletes)} 个新增文件会被删除` : ""}）`;
              if (
                (await vscode.window.showWarningMessage(
                  `${y}？回滚前会自动创建保护性检查点，回滚后仍可再回滚。`,
                  { modal: !0 },
                  "回滚",
                )) !== "回滚"
              )
                return;
              let w = e();
              if (!w) throw Error("服务已停止，请先启动");
              let z = this.bridge,
                S = () => {
                  if (this.bridge !== z || e() !== w) throw Error("服务已变化，请重试");
                  return w.restore(u.id, u.file || void 0);
                },
                k = z.writeQueue.then(S);
              z.writeQueue = k.catch(() => {});
              let A = await k;
              return (
                A?.unchanged
                  ? (this.event("无需回滚", `${u.file || String(u.id).slice(0, 8)} 与该检查点内容一致`),
                    vscode.window.showInformationMessage("当前内容与该检查点一致，没有需要回滚的改动。"))
                  : this.event(
                      "已回滚",
                      `${u.file || String(u.id).slice(0, 8)} · 还原 ${
                        (A?.restoredFiles || []).length
                      } 个文件 · 删除 ${(A?.removedFiles || []).length} 个新增文件`,
                    ),
                c()
              );
            }
            if (u?.command === "clear") {
              if (
                (await vscode.window.showWarningMessage(
                  "清理全部检查点？此操作不可撤销。",
                  { modal: !0 },
                  "清理",
                )) !== "清理"
              )
                return;
              let f = e();
              if (!f) throw Error("服务已停止，请先启动");
              let p = this.bridge,
                h = p.writeQueue.then(() => {
                  if (e() !== f) throw Error("服务已变化，请重试");
                  return f.clear();
                });
              return ((p.writeQueue = h.catch(() => {})), await h, this.event("检查点已清理"), c());
            }
          } catch (d) {
            vscode.window.showErrorMessage(`检查点: ${d.message}`);
          }
        }),
      ),
        l.push(
          n.onDidChangeViewState(() => {
            n.visible && c();
          }),
        ),
        l.push(
          n.onDidDispose(() => {
            ((a = !0), this.cpPanel === n && ((this.cpPanel = null), (this.refreshCheckpoints = null)));
            for (let u of l) u.dispose();
          }),
        ),
        (n.webview.html = this.checkpointsHtml(o)));
    }
    checkpointsHtml(e) {
      return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${e}'; script-src 'nonce-${e}';">
<style nonce="${e}">
*{box-sizing:border-box}body{margin:0;padding:18px 20px 30px;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background)}
h1{font-size:16px;margin:0 0 5px}.lead{margin:0 0 16px;font-size:12px;color:var(--vscode-descriptionForeground);line-height:1.6;max-width:76ch}
.cfg{display:flex;align-items:center;padding:9px 14px;border:1px solid var(--vscode-panel-border,#3a3a3a);border-radius:6px;margin-bottom:14px}
.policy{font-size:12px;color:var(--vscode-descriptionForeground)}
button{font:inherit;cursor:pointer;border-radius:3px;padding:5px 12px;border:1px solid transparent;background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
button:hover{background:var(--vscode-button-hoverBackground)}
button.ghost{background:transparent;color:var(--vscode-foreground);border-color:var(--vscode-panel-border,#444);padding:2px 9px;font-size:11px}
button.ghost:hover{background:var(--vscode-list-hoverBackground)}
button.danger{background:transparent;border-color:var(--vscode-inputValidation-errorBorder,#be1100);color:var(--vscode-errorForeground,#f48771)}
.stat{font-size:11px;color:var(--vscode-descriptionForeground);margin:0 0 12px}
.cp{border:1px solid var(--vscode-panel-border,#3a3a3a);border-radius:6px;margin-bottom:9px;overflow:hidden}
.cp-head{display:flex;align-items:center;gap:10px;padding:9px 12px;cursor:pointer;user-select:none}
.cp-head:hover{background:var(--vscode-list-hoverBackground)}
.dot{width:9px;height:9px;border-radius:50%;background:#30d158;flex:none;box-shadow:0 0 6px rgba(48,209,88,.5)}
.cp-main{flex:1;min-width:0}.cp-time{font-size:12px;font-weight:600}
.cp-sum{font-size:11px;color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cp-acts{display:flex;gap:5px;flex:none}
.cp-body{padding:2px 12px 11px;border-top:1px solid var(--vscode-panel-border,#333)}
.tally{font-size:11px;color:var(--vscode-descriptionForeground);margin:9px 0 7px}
.add{color:#3fb950}.del{color:#f85149}
.file{display:flex;align-items:center;gap:9px;padding:4px 6px;border-radius:3px;font-size:12px}
.file:hover{background:var(--vscode-list-hoverBackground)}
.mark{width:15px;text-align:center;font-weight:700;font-size:11px;flex:none}
.fname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--vscode-editor-font-family,monospace)}
.fstat{font-size:11px;flex:none;font-variant-numeric:tabular-nums}
pre.diff{margin:9px 0 0;padding:10px 12px;background:var(--vscode-textCodeBlock-background,rgba(127,127,127,.12));border-radius:4px;font-family:var(--vscode-editor-font-family,monospace);font-size:11.5px;line-height:1.55;white-space:pre;overflow:auto;max-height:400px;user-select:text}
pre.diff .p{color:#3fb950}pre.diff .m{color:#f85149}pre.diff .h{color:var(--vscode-descriptionForeground)}
.mark.mk-new{color:#3fb950}.mark.mk-del{color:#f85149}.mark.mk-mod{color:#d29922}
#refresh{margin:0 0 16px}
.sbs{margin:8px 0 8px}
.sbs[hidden]{display:none}
.dv{--ebg:var(--vscode-editor-background,#1e1e1e);--line:color-mix(in srgb,var(--vscode-foreground) 12%,transparent);--dl:var(--vscode-diffEditor-removedLineBackground,rgba(248,81,73,.14));--al:var(--vscode-diffEditor-insertedLineBackground,rgba(46,160,67,.15));--dt:var(--vscode-diffEditor-removedTextBackground,rgba(248,81,73,.38));--at:var(--vscode-diffEditor-insertedTextBackground,rgba(46,160,67,.38));--fillc:var(--vscode-diffEditor-diagonalFill,rgba(128,128,128,.22));border-radius:10px;overflow:hidden;background:var(--ebg);box-shadow:inset 0 0 0 1px var(--line)}
.dv-bar{display:flex;align-items:center;gap:12px;padding:6px 10px;border-bottom:1px solid var(--line);font-size:11px;color:var(--vscode-descriptionForeground);background:color-mix(in srgb,var(--vscode-foreground) 4%,var(--ebg))}
.seg{display:inline-flex;padding:2px;border-radius:7px;background:color-mix(in srgb,var(--vscode-foreground) 8%,transparent);flex:none}
.seg button{padding:2px 10px !important;border-radius:5px !important;font-size:11px !important;box-shadow:none !important;background:transparent !important;color:var(--vscode-descriptionForeground) !important}
.seg button.on{background:#0a84ff !important;color:#fff !important}
.dv-lab{display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden;white-space:nowrap}
.dv-lab .old{color:#f85149}.dv-lab .new{color:#3fb950}.dv-lab .arr{opacity:.6}
.dv-sum{margin-left:auto;white-space:nowrap;font-variant-numeric:tabular-nums}
.dv-nav{display:inline-flex;gap:4px;flex:none}
.dv-nav button{padding:1px 8px !important;font-size:12px !important;line-height:1.4}
.dv-body{max-height:560px;overflow-y:auto;overflow-x:hidden;position:relative}
.dv-cols{position:sticky;top:0;z-index:4;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);height:26px;line-height:26px;font-size:11px;font-weight:600;color:var(--vscode-descriptionForeground);background:color-mix(in srgb,var(--vscode-foreground) 6%,var(--ebg));border-bottom:1px solid var(--line)}
.dv-cols>div{padding:0 12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dv-cols>div+div{border-left:1px solid var(--line)}
.dv-fh{position:sticky;top:0;z-index:3;display:flex;align-items:center;gap:8px;height:30px;padding:0 12px;font-size:12px;background:color-mix(in srgb,var(--vscode-foreground) 3%,var(--ebg));border-bottom:1px solid var(--line)}
.dv[data-mode="split"] .dv-fh{top:26px}
.dv-f+.dv-f .dv-fh{border-top:1px solid var(--line)}
.dv-fh .fname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-family:var(--vscode-editor-font-family,monospace)}
.dv-note,.dv-none{padding:14px 16px;font-size:12px;color:var(--vscode-descriptionForeground)}
.dv-split{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
.dv-split>.dv-pane+.dv-pane{border-left:1px solid var(--line)}
.dv-pane{overflow-x:auto;overflow-y:hidden}
.dv-pane::-webkit-scrollbar{height:10px}
.dv-pane::-webkit-scrollbar-thumb{background:var(--vscode-scrollbarSlider-background,rgba(121,121,121,.4));border-radius:5px}
.dv-pane::-webkit-scrollbar-thumb:hover{background:var(--vscode-scrollbarSlider-hoverBackground,rgba(100,100,100,.7))}
.dv-lines{width:max-content;min-width:100%;padding:2px 0 4px}
.dv .r{--t:transparent;display:flex;height:20px;line-height:20px;white-space:pre;background:var(--t);font-family:var(--vscode-editor-font-family),"SF Mono",Menlo,Consolas,monospace;font-size:12px;tab-size:4;user-select:text}
.dv .r .g{position:sticky;left:0;z-index:1;flex:none;width:56px;padding-right:10px;text-align:right;color:var(--vscode-editorLineNumber-foreground,#6e7681);background:linear-gradient(var(--t),var(--t)),var(--ebg);user-select:none;font-variant-numeric:tabular-nums}
.dv .r .g2{left:56px;width:52px}
.dv .r .s{position:sticky;left:56px;z-index:1;flex:none;width:18px;text-align:center;background:linear-gradient(var(--t),var(--t)),var(--ebg);user-select:none;font-weight:700}
.dv-uni .r .s{left:108px}
.dv .r .c{flex:1 0 auto;padding-right:24px}
.dv .r.del{--t:var(--dl)}.dv .r.del .s{color:#f85149}
.dv .r.add{--t:var(--al)}.dv .r.add .s{color:#3fb950}
.dv .r.del .wx{background:var(--dt);border-radius:2px}
.dv .r.add .wx{background:var(--at);border-radius:2px}
.dv .r.fill .c{background:repeating-linear-gradient(-45deg,transparent 0 5px,var(--fillc) 5px 6px)}
.dv .r.hk{--t:color-mix(in srgb,var(--vscode-textLink-foreground,#3794ff) 9%,transparent);color:var(--vscode-descriptionForeground);font-size:11px}
.dv .r.hk .g{color:var(--vscode-textLink-foreground,#3794ff)}
.dv .r.ctx .c,.dv .r.del .c,.dv .r.add .c{color:var(--vscode-editor-foreground,var(--vscode-foreground))}
.dv .r.hit{box-shadow:inset 3px 0 0 #0a84ff}
.sbs-load{padding:10px 12px;color:var(--vscode-descriptionForeground)}
.empty{padding:32px;text-align:center;border:1px dashed var(--vscode-panel-border,#444);border-radius:6px;color:var(--vscode-descriptionForeground)}
.foot{margin-top:16px;display:flex;justify-content:space-between;align-items:center;gap:10px}
.note{font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.6}

body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC",var(--vscode-font-family),sans-serif !important;-webkit-font-smoothing:antialiased;padding:24px 28px 36px !important}
h1{font-size:22px !important;font-weight:700;letter-spacing:-.4px}
button{border-radius:8px !important;padding:5px 13px !important;font-weight:500;background:#0a84ff !important;color:#fff !important;box-shadow:inset 0 .5px 0 rgba(255,255,255,.3),0 1px 2px rgba(0,0,0,.25);transition:filter .15s,transform .1s}
button:hover{filter:brightness(1.08)}button:active{transform:scale(.97)}
button.ghost{background:color-mix(in srgb,var(--vscode-foreground) 10%,transparent) !important;color:var(--vscode-foreground) !important;border:0 !important}
button.danger{background:color-mix(in srgb,#ff453a 18%,transparent) !important;color:#ff453a !important;border:0 !important}
.card,.cp,.cfg{border:0 !important;border-radius:12px !important;background:color-mix(in srgb,var(--vscode-foreground) 6%,transparent) !important;box-shadow:inset 0 0 0 .5px color-mix(in srgb,var(--vscode-foreground) 13%,transparent)}
.badge{background:#0a84ff !important;color:#fff !important}
pre.body,pre.diff{border-radius:9px !important;font-family:"SF Mono",Menlo,var(--vscode-editor-font-family),monospace !important}
.empty{border-radius:14px !important;border-style:solid !important;border-color:color-mix(in srgb,var(--vscode-foreground) 12%,transparent) !important}
.dot{background:#30d158}
</style></head><body>
<h1>检查点</h1>
<div class="cfg"><span class="policy" id="policy">始终开启 \xB7 保留最近 50 条检查点 \xB7 单文件上限 30 MB</span></div>
<p class="stat" id="stat" role="status">载入中…</p>
<button class="ghost" id="refresh">刷新 / 重试</button>
<div id="list"></div>
<div class="foot"><button class="danger" id="clear">清理全部检查点</button><span class="note">每个检查点记录修改前的内容：点「回滚」即可把文件还原到该检查点。回滚前会自动创建保护性检查点，回滚后仍可再回滚。</span></div>
<script nonce="${e}">
const api=acquireVsCodeApi();
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const open=new Set();let rows=[];
let loadTimer;
function refresh(){clearTimeout(loadTimer);document.getElementById('stat').textContent='载入中…';loadTimer=setTimeout(()=>{document.getElementById('stat').textContent='载入尚未完成，请检查 Git / 磁盘状态，可点击刷新重试。';},45000);api.postMessage({command:'refresh'});}
const kb=n=>n<1024?n+' B':n<1048576?(n/1024).toFixed(1)+' KB':(n/1048576).toFixed(1)+' MB';
const when=t=>{const d=new Date(t);const p=x=>String(x).padStart(2,'0');return d.getFullYear()+'/'+(d.getMonth()+1)+'/'+d.getDate()+' '+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());};
const ck=(id,p)=>'d-'+id+'-'+btoa(unescape(encodeURIComponent(p))).replace(/=/g,'');
const markOf=s=>s==='A'?['新','mk-new']:s==='D'?['删','mk-del']:['改','mk-mod'];
const NL=String.fromCharCode(10);
const diffCache=new Map();
let viewMode=((api.getState&&api.getState())||{}).viewMode==='inline'?'inline':'split';
function parseDiff(text){
  const files=[];let f=null,h=null,L=0,R=0,pend=[];
  const newFile=()=>{f={a:'',b:'',name:'',status:'M',hunks:[],notes:[],add:0,del:0};files.push(f);h=null;};
  const flush=()=>{
    if(!pend.length||!h){pend=[];return;}
    const dels=pend.filter(x=>x.k==='-'),adds=pend.filter(x=>x.k==='+'),n=Math.max(dels.length,adds.length);
    for(let i=0;i<n;i++){
      const d=dels[i],a=adds[i];
      h.rows.push({k:d&&a?'m':(d?'d':'a'),l:d?d.n:null,lt:d?d.t:'',r:a?a.n:null,rt:a?a.t:''});
    }
    pend=[];
  };
  for(const line of String(text).split(NL)){
    if(h&&(h.ro>0||h.rn>0)){
      const c=line.charAt(0),t=line.slice(1);
      if(c==='+'){pend.push({k:'+',t:t,n:R++});h.rn--;f.add++;continue;}
      if(c==='-'){pend.push({k:'-',t:t,n:L++});h.ro--;f.del++;continue;}
      if(c===' '||line===''){flush();h.rows.push({k:'c',l:L++,lt:t,r:R++,rt:t});h.ro--;h.rn--;continue;}
    }
    if(line.charCodeAt(0)===92)continue;
    flush();
    if(line.startsWith('diff --git ')){newFile();f.name=line.slice(11);continue;}
    if(!f)newFile();
    const m=/^@@ -([0-9]+)(?:,([0-9]+))? [+]([0-9]+)(?:,([0-9]+))? @@ ?(.*)$/.exec(line);
    if(m){
      L=+m[1];R=+m[3];
      h={ol:L,nl:R,oc:m[2]===undefined?1:+m[2],nc:m[4]===undefined?1:+m[4],ctx:m[5]||'',rows:[]};
      h.ro=h.oc;h.rn=h.nc;f.hunks.push(h);continue;
    }
    if(line.startsWith('--- ')){f.a=line.slice(4);continue;}
    if(line.startsWith('+++ ')){f.b=line.slice(4);continue;}
    if(line.startsWith('new file mode')){f.status='A';continue;}
    if(line.startsWith('deleted file mode')){f.status='D';continue;}
    if(line.startsWith('Binary files')||line.startsWith('GIT binary patch')){f.notes.push('二进制文件，无法显示文本差异');continue;}
  }
  flush();
  const clean=p=>{p=String(p||'').trim();if(p.charAt(0)==='"'&&p.charAt(p.length-1)==='"')p=p.slice(1,-1);return p.replace(/^[ab][/]/,'');};
  for(const x of files){
    if(x.a==='/dev/null')x.status='A';
    if(x.b==='/dev/null')x.status='D';
    const p=x.b&&x.b!=='/dev/null'?x.b:(x.a&&x.a!=='/dev/null'?x.a:'');
    x.name=p?clean(p):clean(String(x.name).split(' b/').pop());
    for(const hk of x.hunks){let prev='c';for(const r of hk.rows){if(r.k!=='c'&&prev==='c')r.start=1;prev=r.k;}}
  }
  return files.filter(x=>x.hunks.length||x.notes.length);
}
const TOK=/[A-Za-z0-9_]+|[^A-Za-z0-9_]/g;
function joinSeg(seg){
  let h='',on=0,buf='';
  const out=()=>{if(buf)h+=on?'<span class="wx">'+esc(buf)+'</span>':esc(buf);buf='';};
  for(const s of seg){if(s[0]!==on){out();on=s[0];}buf+=s[1];}
  out();return h;
}
function wordDiff(a,b){
  const x=a.match(TOK)||[],y=b.match(TOK)||[],n=x.length,m=y.length;
  if(!n||!m||n*m>90000)return [esc(a),esc(b)];
  const dp=[];for(let i=0;i<=n;i++)dp.push(new Uint16Array(m+1));
  for(let i=n-1;i>=0;i--)for(let j=m-1;j>=0;j--)dp[i][j]=x[i]===y[j]?dp[i+1][j+1]+1:Math.max(dp[i+1][j],dp[i][j+1]);
  const sa=[],sb=[];let i=0,j=0,same=0;
  while(i<n&&j<m){
    if(x[i]===y[j]){same+=x[i].length;sa.push([0,x[i++]]);sb.push([0,y[j++]]);}
    else if(dp[i+1][j]>=dp[i][j+1])sa.push([1,x[i++]]);
    else sb.push([1,y[j++]]);
  }
  while(i<n)sa.push([1,x[i++]]);
  while(j<m)sb.push([1,y[j++]]);
  if(same<Math.max(a.length,b.length)*0.3)return [esc(a),esc(b)];
  return [joinSeg(sa),joinSeg(sb)];
}
function cell(cls,num,sign,html,ch){
  return '<div class="r '+cls+'"'+(ch?' data-ch="1"':'')+'><span class="g">'+(num===null?'':num)+'</span><span class="s">'+sign+'</span><span class="c">'+html+'</span></div>';
}
function splitHtml(f){
  let L='',R='';
  for(const h of f.hunks){
    L+='<div class="r hk"><span class="g">⋯</span><span class="s"></span><span class="c">'+esc('@@ -'+h.ol+','+h.oc+' +'+h.nl+','+h.nc+' @@')+'</span></div>';
    R+='<div class="r hk"><span class="g">⋯</span><span class="s"></span><span class="c">'+esc(h.ctx)+'</span></div>';
    for(const r of h.rows){
      let lt=esc(r.lt),rt=esc(r.rt);
      if(r.k==='m'){const w=wordDiff(r.lt,r.rt);lt=w[0];rt=w[1];}
      L+=r.l===null?cell('fill',null,'','',r.start):cell(r.k==='c'?'ctx':'del',r.l,r.k==='c'?'':'−',lt,r.start);
      R+=r.r===null?cell('fill',null,'','',r.start):cell(r.k==='c'?'ctx':'add',r.r,r.k==='c'?'':'+',rt,r.start);
    }
  }
  return '<div class="dv-split"><div class="dv-pane"><div class="dv-lines">'+L+'</div></div><div class="dv-pane"><div class="dv-lines">'+R+'</div></div></div>';
}
function icell(cls,l,r,sign,html,ch){
  return '<div class="r '+cls+'"'+(ch?' data-ch="1"':'')+'><span class="g">'+(l===null?'':l)+'</span><span class="g g2">'+(r===null?'':r)+'</span><span class="s">'+sign+'</span><span class="c">'+html+'</span></div>';
}
function inlineHtml(f){
  let H='';
  for(const h of f.hunks){
    H+='<div class="r hk"><span class="g">⋯</span><span class="g g2"></span><span class="s"></span><span class="c">'+esc('@@ -'+h.ol+','+h.oc+' +'+h.nl+','+h.nc+' @@ '+h.ctx)+'</span></div>';
    let i=0;const rows=h.rows;
    while(i<rows.length){
      const r=rows[i];
      if(r.k==='c'){H+=icell('ctx',r.l,r.r,'',esc(r.lt),0);i++;continue;}
      const blk=[];while(i<rows.length&&rows[i].k!=='c')blk.push(rows[i++]);
      const ws=blk.map(b=>b.k==='m'?wordDiff(b.lt,b.rt):[esc(b.lt),esc(b.rt)]);
      let first=1;
      blk.forEach((b,j)=>{if(b.l!==null){H+=icell('del',b.l,null,'−',ws[j][0],first);first=0;}});
      blk.forEach((b,j)=>{if(b.r!==null){H+=icell('add',null,b.r,'+',ws[j][1],first);first=0;}});
    }
  }
  return '<div class="dv-uni"><div class="dv-pane"><div class="dv-lines">'+H+'</div></div></div>';
}
function diffView(text,id,single){
  const files=parseDiff(text),sid=esc(String(id||'').slice(0,8));
  const seg='<div class="seg" role="group" aria-label="显示方式"><button class="ghost'+(viewMode==='split'?' on':'')+'" data-mode="split">并排</button><button class="ghost'+(viewMode==='inline'?' on':'')+'" data-mode="inline">行内</button></div>';
  if(!files.length)return '<div class="dv"><div class="dv-bar">'+seg+'</div><div class="dv-none">没有差异：当前内容与该检查点一致，无需回滚。</div></div>';
  let add=0,del=0,chunks=0;
  for(const f of files){add+=f.add;del+=f.del;for(const h of f.hunks)for(const r of h.rows)if(r.start)chunks++;}
  const bar='<div class="dv-bar">'+seg+'<span class="dv-lab"><span class="old">检查点 '+sid+'</span><span class="arr">→</span><span class="new">当前内容</span></span><span class="dv-sum"><span class="add">+'+add+'</span> <span class="del">−'+del+'</span> · '+chunks+' 处改动</span><span class="dv-nav"><button class="ghost" data-nav="-1" title="上一处改动">↑</button><button class="ghost" data-nav="1" title="下一处改动">↓</button></span></div>';
  const cols=viewMode==='split'?'<div class="dv-cols"><div>改动前 · 检查点 '+sid+'</div><div>改动后 · 当前内容</div></div>':'';
  let body='';
  for(const f of files){
    const mk=markOf(f.status);
    body+='<section class="dv-f">'+(single&&files.length===1?'':'<div class="dv-fh"><span class="mark '+mk[1]+'">'+mk[0]+'</span><span class="fname">'+esc(f.name)+'</span><span class="fstat"><span class="add">+'+f.add+'</span> <span class="del">−'+f.del+'</span></span></div>');
    for(const n of f.notes)body+='<div class="dv-note">'+esc(n)+'</div>';
    if(f.hunks.length)body+=viewMode==='split'?splitHtml(f):inlineHtml(f);
    body+='</section>';
  }
  return '<div class="dv" data-mode="'+viewMode+'">'+bar+'<div class="dv-body">'+cols+body+'</div></div>';
}
function rerenderDiffs(){
  for(const [key,v] of diffCache){const el=document.getElementById(key);if(el&&!el.hidden&&el.innerHTML)el.innerHTML=diffView(v.text,v.id,v.single);}
}
function navDiff(btn){
  const dv=btn.closest('.dv');if(!dv)return;
  const body=dv.querySelector('.dv-body');
  const sel=dv.dataset.mode==='split'?'.dv-split>.dv-pane:first-child [data-ch]':'[data-ch]';
  const marks=Array.from(dv.querySelectorAll(sel));if(!marks.length)return;
  const off=(dv.dataset.mode==='split'?26:0)+(dv.querySelector('.dv-fh')?30:0)+42,base=body.getBoundingClientRect().top+off;
  const dir=+btn.dataset.nav;let idx=-1;
  if(dir>0){idx=marks.findIndex(m=>m.getBoundingClientRect().top>base+2);if(idx<0)idx=0;}
  else{for(let k=marks.length-1;k>=0;k--)if(marks[k].getBoundingClientRect().top<base-2){idx=k;break;}if(idx<0)idx=marks.length-1;}
  const m=marks[idx];
  if(body.scrollHeight>body.clientHeight)body.scrollTop+=m.getBoundingClientRect().top-base;
  else m.scrollIntoView({block:'center'});
  dv.querySelectorAll('.r.hit').forEach(x=>x.classList.remove('hit'));
  const row=m.parentElement.children,pos=Array.prototype.indexOf.call(row,m);
  dv.querySelectorAll('.dv-lines').forEach(ls=>{if(ls.closest('.dv-f')===m.closest('.dv-f')&&ls.children[pos])ls.children[pos].classList.add('hit');});
  setTimeout(()=>dv.querySelectorAll('.r.hit').forEach(x=>x.classList.remove('hit')),900);
}
document.addEventListener('scroll',e=>{
  const p=e.target;
  if(!p||!p.classList||!p.classList.contains('dv-pane'))return;
  for(const q of p.parentElement.children)if(q!==p&&q.scrollLeft!==p.scrollLeft)q.scrollLeft=p.scrollLeft;
},true);
function render(){
  const el=document.getElementById('list');
  if(!rows.length){el.innerHTML='<div class="empty">暂无检查点。AI 下一次修改文件时会自动创建。</div>';return;}
  el.innerHTML=rows.map(r=>{
    const isOpen=open.has(r.id);
    const files=(r.files||[]).map(f=>{
      const mk=markOf(f.status),key=ck(r.id,f.path);
      const stat=f.binary?'二进制':(f.added===null?'新增文件':'<span class="add">+'+f.added+'</span> <span class="del">-'+f.removed+'</span>');
      return '<div class="file"><span class="mark '+mk[1]+'">'+mk[0]+'</span><span class="fname">'+esc(f.path)+'</span><span class="fstat">'+stat+'</span><button class="ghost" data-diff="'+r.id+'" data-file="'+esc(f.path)+'">对比</button><button class="ghost" data-rb="'+r.id+'" data-file="'+esc(f.path)+'">回滚此文件</button></div><div class="sbs" id="'+key+'" hidden></div>';
    }).join('');
    return '<div class="cp"><div class="cp-head" data-t="'+r.id+'"><span class="dot"></span><div class="cp-main"><div class="cp-time">'+when(r.at)+'</div><div class="cp-sum">'+esc(r.summary)+'</div></div><div class="cp-acts"><button class="ghost" data-diff="'+r.id+'">全量差异</button><button class="ghost" data-rb="'+r.id+'">回滚</button></div></div>'+
      (isOpen?'<div class="cp-body">'+(r.files&&r.files.length?'<div class="tally">自该检查点以来 '+(r.files||[]).length+' 个文件变更，<span class="add">+'+r.added+'</span> <span class="del">-'+r.removed+'</span>'+(r.binary?'，二进制 '+r.binary+' 个':'')+'</div>':'<div class="tally">该检查点与当前内容一致，无需回滚。</div>')+'<div class="sbs" id="d-'+r.id+'" hidden></div>'+files+'</div>':'')+'</div>';
  }).join('');
}
document.addEventListener('click',e=>{
  const mb=e.target.closest('button[data-mode]');if(mb){if(mb.dataset.mode!==viewMode){viewMode=mb.dataset.mode;const st=(api.getState&&api.getState())||{};st.viewMode=viewMode;api.setState(st);rerenderDiffs();}return;}
  const nb=e.target.closest('button[data-nav]');if(nb){navDiff(nb);return;}
  const h=e.target.closest('.cp-head');
  if(h&&!e.target.closest('button')){const id=h.dataset.t;open.has(id)?open.delete(id):open.add(id);render();return;}
  const d=e.target.closest('[data-diff]');
  if(d){
    const key=d.dataset.file?ck(d.dataset.diff,d.dataset.file):('d-'+d.dataset.diff);
    const el=document.getElementById(key);
    if(el){
      if(!el.hidden&&el.innerHTML){el.hidden=true;el.innerHTML='';return;}
      el.hidden=false;el.innerHTML='<div class="sbs-load">正在读取差异…</div>';
    }
    api.postMessage({command:'diff',id:d.dataset.diff,file:d.dataset.file||null});
    return;
  }
  const rb=e.target.closest('[data-rb]');
  if(rb){
    const row=rows.find(x=>x.id===rb.dataset.rb);
    const list=rb.dataset.file?[rb.dataset.file]:((row&&row.files)?row.files.map(f=>f.path):[]);
    const del=rb.dataset.file?((row&&(row.files||[]).some(f=>f.path===rb.dataset.file&&f.status==='A'))?1:0):((row&&row.files)?row.files.filter(f=>f.status==='A').length:0);
    api.postMessage({command:'restore',id:rb.dataset.rb,file:rb.dataset.file||null,files:list,deletes:del});
    return;
  }
  if(e.target.id==='refresh'){refresh();return;}
  if(e.target.id==='clear'){api.postMessage({command:'clear'});}
});
window.addEventListener('message',e=>{
  const m=e.data;
  if(m.type==='loadError'){clearTimeout(loadTimer);document.getElementById('stat').textContent='载入失败：'+m.message;return;}
  if(m.type==='data'){
    clearTimeout(loadTimer);
    rows=m.list||[];
    if(!m.offline)document.getElementById('policy').textContent='始终开启 \xB7 保留最近 '+m.keep+' 条检查点 \xB7 单文件上限 '+m.maxFileMb+' MB';
    document.getElementById('stat').textContent=m.offline?'服务已停止，请启动后刷新。':m.error?'最近一次检查点失败：'+m.error:'共 '+rows.length+' 条检查点 \xB7 占用 '+kb(m.usage||0);
    render();return;
  }
  if(m.type==='diff'){
    const key=m.file?ck(m.id,m.file):('d-'+m.id);
    const el=document.getElementById(key);
    if(!el)return;
    diffCache.set(key,{text:m.text||'',id:m.id,single:!!m.file});
    el.innerHTML=diffView(m.text||'',m.id,!!m.file);
    el.hidden=false;
  }
});
refresh();
</script></body></html>`;
    }
    async openSkills() {
      let { Skills: e } = require("./skills"),
        r = new e(path.join(this.context.extensionPath, "skills")),
        n = [];
      try {
        n = (await r.index()).skills;
      } catch {
        n = [];
      }
      let o = [];
      for (let c of n)
        try {
          let l = await r.get(c.name);
          o.push({ ...c, instructions: l.instructions, truncated: l.truncated });
        } catch {
          o.push({ ...c, instructions: "", truncated: !1 });
        }
      if (this.skillsPanel) {
        (this.skillsPanel.reveal(vscode.ViewColumn.Active),
          this.skillsPanel.webview.postMessage({ type: "skills", skills: o }));
        return;
      }
      let s = vscode.window.createWebviewPanel(
        "lanternBridge.skills",
        "Anvil Bridge — 技能管理",
        vscode.ViewColumn.Active,
        { enableScripts: !0, retainContextWhenHidden: !0, localResourceRoots: [] },
      );
      this.skillsPanel = s;
      let i = crypto.randomBytes(20).toString("hex");
      s.webview.html = this.skillsHtml(i, o);
      let a = [];
      (a.push(
        s.webview.onDidReceiveMessage(async (c) => {
          if (c?.command === "reload") {
            let l = [];
            try {
              for (let u of (await r.index(!0)).skills) {
                let d = await r.get(u.name);
                l.push({ ...u, instructions: d.instructions, truncated: d.truncated });
              }
            } catch {}
            s.webview.postMessage({ type: "skills", skills: l });
            return;
          }
          c?.command === "copy" &&
            typeof c.text == "string" &&
            (await vscode.env.clipboard.writeText(c.text.slice(0, 1e5)),
            this.event("技能已复制", c.name || ""));
        }),
      ),
        a.push(
          s.onDidDispose(() => {
            this.skillsPanel === s && (this.skillsPanel = null);
            for (let c of a) c.dispose();
          }),
        ));
    }
    skillsHtml(e, r) {
      let n = r.length
        ? r
            .map(
              (o, s) =>
                `<article class="card"><header class="card-head"><div class="card-title"><span class="badge">${s + 1}</span><h2>${esc(o.name)}</h2>${o.truncated ? '<span class="warn">已截断</span>' : ""}</div><div class="card-actions"><button class="ghost" data-copy="${s}">复制</button><button class="ghost" data-toggle="${s}" aria-expanded="false">查看</button></div></header><p class="desc">${esc(o.description)}</p><pre class="body" id="body-${s}" hidden>${esc(o.instructions || "（无内容）")}</pre></article>`,
            )
            .join("")
        : '<div class="empty"><p>未找到任何技能。</p><p class="muted">技能是扩展内置的 Markdown 文件，位于安装目录的 <code>skills/</code> 下。</p></div>';
      return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${e}'; script-src 'nonce-${e}';">
<style nonce="${e}">
*{box-sizing:border-box}body{margin:0;padding:20px 22px 32px;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background)}
h1{font-size:17px;margin:0 0 4px}h2{font-size:13px;margin:0;font-weight:600}
.lead{margin:0 0 18px;font-size:12px;color:var(--vscode-descriptionForeground);line-height:1.6;max-width:70ch}
.toolbar{display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap}
.count{font-size:11px;color:var(--vscode-descriptionForeground)}
button{font:inherit;cursor:pointer;border-radius:3px;padding:5px 12px;border:1px solid transparent;background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
button:hover{background:var(--vscode-button-hoverBackground)}
button.ghost{background:transparent;color:var(--vscode-foreground);border-color:var(--vscode-panel-border,#444);padding:3px 10px;font-size:12px}
button.ghost:hover{background:var(--vscode-list-hoverBackground)}
button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}
.card{border:1px solid var(--vscode-panel-border,#3a3a3a);border-radius:6px;padding:13px 15px;margin-bottom:11px;background:var(--vscode-editorWidget-background,transparent)}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.card-title{display:flex;align-items:center;gap:9px;min-width:0}
.card-actions{display:flex;gap:6px;flex:none}
.badge{display:inline-flex;align-items:center;justify-content:center;min-width:19px;height:19px;padding:0 5px;border-radius:9px;font-size:11px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
.warn{font-size:10px;padding:1px 6px;border-radius:8px;background:var(--vscode-inputValidation-warningBackground,#5a4a00);color:var(--vscode-foreground)}
.desc{margin:8px 0 0;font-size:12px;color:var(--vscode-descriptionForeground);line-height:1.55}
pre.body{margin:11px 0 0;padding:11px 13px;background:var(--vscode-textCodeBlock-background,rgba(127,127,127,.12));border-radius:4px;font-family:var(--vscode-editor-font-family,monospace);font-size:12px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;max-height:420px;overflow-y:auto;overflow-x:hidden;user-select:text}
.empty{padding:34px 20px;text-align:center;border:1px dashed var(--vscode-panel-border,#444);border-radius:6px}
.empty p{margin:0 0 6px}.muted{font-size:11px;color:var(--vscode-descriptionForeground)}
code{font-family:var(--vscode-editor-font-family,monospace);font-size:11px}
.note{margin:18px 0 0;font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.6;max-width:70ch}

body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC",var(--vscode-font-family),sans-serif !important;-webkit-font-smoothing:antialiased;padding:24px 28px 36px !important}
h1{font-size:22px !important;font-weight:700;letter-spacing:-.4px}
button{border-radius:8px !important;padding:5px 13px !important;font-weight:500;background:#0a84ff !important;color:#fff !important;box-shadow:inset 0 .5px 0 rgba(255,255,255,.3),0 1px 2px rgba(0,0,0,.25);transition:filter .15s,transform .1s}
button:hover{filter:brightness(1.08)}button:active{transform:scale(.97)}
button.ghost{background:color-mix(in srgb,var(--vscode-foreground) 10%,transparent) !important;color:var(--vscode-foreground) !important;border:0 !important}
button.danger{background:color-mix(in srgb,#ff453a 18%,transparent) !important;color:#ff453a !important;border:0 !important}
.card,.cp,.cfg{border:0 !important;border-radius:12px !important;background:color-mix(in srgb,var(--vscode-foreground) 6%,transparent) !important;box-shadow:inset 0 0 0 .5px color-mix(in srgb,var(--vscode-foreground) 13%,transparent)}
.badge{background:#0a84ff !important;color:#fff !important}
pre.body,pre.diff{border-radius:9px !important;font-family:"SF Mono",Menlo,var(--vscode-editor-font-family),monospace !important}
.empty{border-radius:14px !important;border-style:solid !important;border-color:color-mix(in srgb,var(--vscode-foreground) 12%,transparent) !important}
.dot{background:#30d158}
</style></head><body>
<h1>技能管理</h1>
<p class="lead">技能是随扩展发布的专家工作流。AI 通过 <code>skill</code> 工具按需加载：不带参数获取索引，带名字加载正文。正文不进入会话提示词，因此未使用的技能不占用上下文。</p>
<div class="toolbar"><button id="reload">重新加载</button><span class="count" id="count">共 ${r.length} 个技能</span></div>
<div id="list">${n}</div>
<p class="note">技能内置于扩展安装目录，只读。</p>
<script nonce="${e}">
const api=acquireVsCodeApi();
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let data=${JSON.stringify(r).replace(/</g, "\\u003c")};
document.addEventListener('click',e=>{
  const t=e.target.closest('[data-toggle]');
  if(t){const i=t.dataset.toggle;const pre=document.getElementById('body-'+i);if(pre){const open=!pre.hidden;pre.hidden=open;t.textContent=open?'查看':'收起';t.setAttribute('aria-expanded',String(!open));}return;}
  const c=e.target.closest('[data-copy]');
  if(c){const i=Number(c.dataset.copy);const s=data[i];if(s){api.postMessage({command:'copy',text:s.instructions||'',name:s.name});c.textContent='已复制';setTimeout(()=>{c.textContent='复制';},1400);}return;}
  if(e.target.id==='reload'){api.postMessage({command:'reload'});}
});
window.addEventListener('message',e=>{
  if(e.data?.type!=='skills')return;
  data=e.data.skills||[];
  document.getElementById('count').textContent='共 '+data.length+' 个技能';
  document.getElementById('list').innerHTML=data.length?data.map((s,i)=>'<article class="card"><header class="card-head"><div class="card-title"><span class="badge">'+(i+1)+'</span><h2>'+esc(s.name)+'</h2>'+(s.truncated?'<span class="warn">已截断</span>':'')+'</div><div class="card-actions"><button class="ghost" data-copy="'+i+'">复制</button><button class="ghost" data-toggle="'+i+'" aria-expanded="false">查看</button></div></header><p class="desc">'+esc(s.description)+'</p><pre class="body" id="body-'+i+'" hidden>'+esc(s.instructions||'（无内容）')+'</pre></article>').join(''):'<div class="empty"><p>未找到任何技能。</p></div>';
});
</script></body></html>`;
    }
    async openPanel() {
      (await vscode.commands.executeCommand("workbench.view.extension.lanternBridge"),
        await vscode.commands.executeCommand("lanternBridge.sidebar.focus"),
        this.changed());
    }
    resolveWebviewView(e) {
      ((this.panel = e),
        (e.title = "Anvil Bridge"),
        (e.webview.options = { enableScripts: !0, localResourceRoots: [] }));
      let r = crypto.randomBytes(20).toString("hex");
      e.webview.html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${r}'; script-src 'nonce-${r}'; img-src data:;">
<style nonce="${r}">
:root{
  --font:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro SC","PingFang SC","Helvetica Neue",var(--vscode-font-family),sans-serif;
  --mono:"SF Mono",ui-monospace,Menlo,var(--vscode-editor-font-family,monospace);
  --accent:#0a84ff;--green:#30d158;--orange:#ff9f0a;--red:#ff453a;--purple:#bf5af2;--teal:#40c8e0;--indigo:#5e5ce6;--yellow:#ffd60a;--gray:#8e8e93;--anvil:#f36f2b;
  --bg:var(--vscode-sideBar-background,#1e1e1e);
  --fg:var(--vscode-foreground,#e5e5e7);
  --fg2:color-mix(in srgb,var(--fg) 62%,transparent);
  --fg3:color-mix(in srgb,var(--fg) 40%,transparent);
  --mat:color-mix(in srgb,var(--fg) 6%,transparent);
  --mat2:color-mix(in srgb,var(--fg) 10%,transparent);
  --mat3:color-mix(in srgb,var(--fg) 15%,transparent);
  --sep:color-mix(in srgb,var(--fg) 10%,transparent);
  --hair:color-mix(in srgb,var(--fg) 13%,transparent);
  --r-lg:14px;--r:10px;--r-sm:7px;
  --ease:cubic-bezier(.32,.72,0,1);
  --shadow:0 0 0 .5px rgba(0,0,0,.35),0 8px 28px rgba(0,0,0,.28),0 1px 3px rgba(0,0,0,.2);
  --thumb:color-mix(in srgb,var(--fg) 22%,transparent);
}
*{box-sizing:border-box}
html,body{height:100%;margin:0;overflow:hidden}
body{font-family:var(--font);font-size:12.5px;line-height:1.45;color:var(--fg);background:var(--bg);-webkit-font-smoothing:antialiased;letter-spacing:-.08px}
#state{height:100%;display:flex;flex-direction:column;overflow:hidden}
button{font:inherit;color:inherit;cursor:pointer;border:0;background:none;padding:0}
button:disabled{opacity:.4;cursor:default}
button:focus-visible,summary:focus-visible,[role=button]:focus-visible,input:focus-visible{outline:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 45%,transparent)}
p{margin:0;overflow-wrap:anywhere}
h2{margin:0}
.muted{color:var(--fg2)}

/* scrollbars: thin overlay-style like macOS */
.feed,.dock,pre{scrollbar-width:thin;scrollbar-color:var(--thumb) transparent}
.feed::-webkit-scrollbar,.dock::-webkit-scrollbar,pre::-webkit-scrollbar{width:9px;height:9px}
.feed::-webkit-scrollbar-thumb,.dock::-webkit-scrollbar-thumb,pre::-webkit-scrollbar-thumb{background:transparent;border-radius:9px;border:2px solid transparent;background-clip:padding-box}
.feed:hover::-webkit-scrollbar-thumb,.dock:hover::-webkit-scrollbar-thumb,pre:hover::-webkit-scrollbar-thumb{background:var(--thumb);background-clip:padding-box}

/* ===== Control Center (dock) — now pinned at the top ===== */
.dock{order:-1;flex:none;position:relative;z-index:2;margin:10px 10px 0;padding:12px;border-radius:18px;max-height:70vh;overflow-y:auto;overflow-x:hidden;
  background:color-mix(in srgb,var(--bg) 70%,var(--fg) 5%);
  box-shadow:inset 0 0 0 .5px var(--hair),0 10px 30px rgba(0,0,0,.18);
  -webkit-backdrop-filter:saturate(180%) blur(24px);backdrop-filter:saturate(180%) blur(24px)}
.dock.is-animating{display:flex;flex-direction:column;overflow:hidden}
.dock.is-animating .dock-body{display:block;flex:1 1 auto;min-height:0;overflow:hidden}
.dock.collapsed .dock-body{display:none}
.connection-heading{display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none}
.app-icon{flex:none;width:34px;height:34px;border-radius:9px;display:grid;place-items:center;
  background:linear-gradient(180deg,#3a3a3c,#1c1c1e);box-shadow:inset 0 .5px 0 rgba(255,255,255,.18),0 1px 3px rgba(0,0,0,.4)}
.app-icon svg{width:22px;height:22px}
.app-title{flex:1;min-width:0;display:flex;flex-direction:column}
.app-title strong{font-size:13.5px;font-weight:600;letter-spacing:-.25px}
.connection-state{font-size:11px;color:var(--fg2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;gap:6px}
.dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--gray)}
.dot.online{background:var(--green);box-shadow:0 0 0 3px color-mix(in srgb,var(--green) 22%,transparent)}
.dot.pending{background:var(--orange);animation:blink 1.2s ease-in-out infinite}
@keyframes blink{50%{opacity:.35}}
.dock-toggle{flex:none;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;color:var(--fg2);transition:background .2s,color .2s}
.dock-toggle:hover{background:var(--mat2);color:var(--fg)}
.dock-toggle .chev{width:14px;height:14px;transition:transform .35s var(--ease)}
.dock.collapsed .dock-toggle .chev{transform:rotate(-90deg)}
.dock-body{padding-top:12px}

/* big tiles like Control Center */
.tiles{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px}.tile{min-width:0}
.tile{display:flex;align-items:center;gap:9px;padding:9px 10px;border-radius:var(--r-lg);background:var(--mat);box-shadow:inset 0 0 0 .5px var(--hair);text-align:left;transition:background .2s,transform .15s var(--ease)}
.tile:hover:not(:disabled){background:var(--mat2)}
.tile:active:not(:disabled){transform:scale(.97)}
.tile .glyph{flex:none;width:30px;height:30px;border-radius:50%;display:grid;place-items:center;background:var(--mat3);color:var(--fg);transition:background .25s,color .25s}
.tile .glyph svg{width:15px;height:15px}
.tile .t{display:flex;flex-direction:column;min-width:0}
.tile .t b{font-size:12px;font-weight:600}
.tile .t span{font-size:10.5px;color:var(--fg2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tile.on .glyph{background:var(--accent);color:#fff}
.tile.on.green .glyph{background:var(--green)}
.tile.busy .glyph{background:var(--orange);color:#fff}
.tile.busy .glyph svg{animation:spin 1.2s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

/* URL field */
.mcp-address{margin-top:10px}
.mcp-address label{display:block;font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;color:var(--fg3);margin:0 0 5px 2px}
.mcp-address-row{display:flex;align-items:center;gap:4px;padding:3px 3px 3px 10px;border-radius:var(--r);background:color-mix(in srgb,var(--bg) 60%,#000 20%);box-shadow:inset 0 0 0 .5px var(--hair),inset 0 1px 2px rgba(0,0,0,.2)}
.mcp-address-row input{flex:1;min-width:0;width:0;border:0;background:transparent;color:var(--fg);font:11px/1.4 var(--mono);padding:5px 0;outline:none;user-select:text}
.mcp-address-row button{flex:none;height:24px;padding:0 10px;border-radius:7px;font-size:11px;font-weight:500;background:var(--mat2)}
.mcp-address-row button:hover{background:var(--mat3)}
.mcp-address p{margin:5px 2px 0;font-size:10.5px;color:var(--fg2);display:flex;gap:5px;align-items:center}
.mcp-address p.public::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--green)}
.mcp-address p.local::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--orange)}

/* push buttons */
.actions{display:flex;gap:6px;margin-top:10px}
.actions button,.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 12px;border-radius:8px;font-size:12px;font-weight:500;background:var(--mat2);box-shadow:inset 0 0 0 .5px var(--hair),0 .5px 1px rgba(0,0,0,.2);transition:background .15s,transform .1s}
.actions button{flex:1}
.actions button:hover:not(:disabled),.btn:hover:not(:disabled){background:var(--mat3)}
.actions button:active:not(:disabled),.btn:active:not(:disabled){transform:scale(.97)}
.btn-primary,.actions .btn-copy-prompt{background:linear-gradient(180deg,color-mix(in srgb,var(--accent) 100%,#fff 12%),var(--accent)) !important;color:#fff;box-shadow:inset 0 .5px 0 rgba(255,255,255,.3),0 1px 2px rgba(0,0,0,.25) !important}
.actions .btn-copy-prompt:hover:not(:disabled){filter:brightness(1.08)}
.actions .btn-copy-prompt.copied{background:var(--green) !important}
.btn-icon{flex:none;pointer-events:none}
.check-animated{animation:pop .3s var(--ease)}
.check-animated .check-path{stroke-dasharray:24;stroke-dashoffset:24;animation:draw .35s .05s ease-out forwards}
@keyframes pop{0%{transform:scale(.5);opacity:0}100%{transform:scale(1);opacity:1}}
@keyframes draw{to{stroke-dashoffset:0}}

/* grouped inset list (System Settings) */
.group{margin-top:12px;border-radius:var(--r);background:var(--mat);box-shadow:inset 0 0 0 .5px var(--hair);overflow:hidden}
.group-title{margin:14px 4px 5px;font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;color:var(--fg3)}
.group-title + .group{margin-top:0}
.row{display:flex;align-items:center;gap:9px;min-height:36px;padding:7px 10px;position:relative}
.row + .row::before{content:"";position:absolute;top:0;left:10px;right:0;height:.5px;background:var(--sep)}
.row .lbl{flex:1;min-width:0;display:flex;flex-direction:column}
.row .lbl b{font-weight:500;font-size:12px}
.row .lbl span{font-size:10.5px;color:var(--fg2);overflow-wrap:anywhere}
.row .val{flex:none;font-size:11.5px;color:var(--fg2);max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sq{flex:none;width:22px;height:22px;border-radius:6px;display:grid;place-items:center;color:#fff}
.sq svg{width:13px;height:13px}
.sq.blue{background:var(--accent)}.sq.green{background:var(--green)}.sq.orange{background:var(--orange)}.sq.gray{background:var(--gray)}.sq.purple{background:var(--purple)}.sq.red{background:var(--red)}.sq.indigo{background:var(--indigo)}
.row button.link{color:var(--accent);font-size:11.5px;font-weight:500}
.row button.link:hover{text-decoration:underline}
.row button.btn{height:22px;padding:0 9px;font-size:11px;border-radius:6px}

/* segmented control */
.access-control{padding:8px 10px 10px}
.mode-buttons{display:grid;grid-template-columns:1fr 1fr;padding:2px;border-radius:8px;background:color-mix(in srgb,var(--bg) 55%,#000 22%);box-shadow:inset 0 0 0 .5px var(--hair)}
.mode-button{height:24px;border-radius:6px;font-size:11.5px;font-weight:500;color:var(--fg2);transition:all .25s var(--ease)}
.mode-button:hover:not(:disabled){color:var(--fg)}
.mode-button[aria-pressed="true"]{background:color-mix(in srgb,var(--fg) 20%,var(--bg));color:var(--fg);box-shadow:0 1px 3px rgba(0,0,0,.3),inset 0 .5px 0 rgba(255,255,255,.12)}
.full-mode[aria-pressed="true"]{background:var(--orange);color:#1c1c1e}
.access-note{margin-top:7px;font-size:10.5px;color:var(--fg2);line-height:1.5}
.access-note.warning{color:var(--orange)}

/* cloudflared */
.cf-badge{flex:none;font-size:10px;font-weight:600;padding:2px 7px;border-radius:99px}
.cf-badge.ok{background:color-mix(in srgb,var(--green) 18%,transparent);color:var(--green)}
.cf-badge.bad{background:color-mix(in srgb,var(--red) 18%,transparent);color:var(--red)}
.cf-badge.working{background:color-mix(in srgb,var(--accent) 18%,transparent);color:var(--accent)}
.cf-badge.unknown{background:var(--mat2);color:var(--fg2)}
.cf-actions{display:flex;gap:6px;padding:0 10px 9px 41px}

/* details disclosure */
#connectionDetails{margin-top:12px;border-radius:var(--r);background:var(--mat);box-shadow:inset 0 0 0 .5px var(--hair);overflow:hidden}
#connectionDetails summary{list-style:none;display:flex;align-items:center;gap:9px;padding:8px 10px;cursor:pointer;user-select:none;font-weight:500}
#connectionDetails summary::-webkit-details-marker{display:none}
#connectionDetails summary::after{content:"";margin-left:auto;width:6px;height:6px;border-right:1.5px solid var(--fg3);border-bottom:1.5px solid var(--fg3);transform:rotate(-45deg);transition:transform .25s var(--ease)}
#connectionDetails[open] summary::after{transform:rotate(45deg)}
#connectionDetails .row:first-of-type::before{content:"";position:absolute;top:0;left:10px;right:0;height:.5px;background:var(--sep)}
#connectionDetails .foot{padding:4px 10px 10px;display:flex;flex-direction:column;gap:6px}
#connectionDetails .foot .btn{align-self:flex-start}
#connectionDetails .foot p{font-size:10.5px;color:var(--fg2)}
.footnote{margin:10px 2px 0;font-size:10px;color:var(--fg3);text-align:center}

/* ===== Feed ===== */
.feed{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:4px 10px 16px}
#activityFeed{overflow-anchor:none}
.section-heading,.tasks > h2{display:flex;align-items:center;margin:16px 4px 6px;font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;color:var(--fg3)}
.section-heading h2{font:inherit}
.section-heading .quiet{margin-left:auto;font-size:11px;font-weight:500;text-transform:none;letter-spacing:0;color:var(--accent)}
.section-heading .quiet:hover{text-decoration:underline}

/* empty state */
.empty{text-align:center;padding:22px 16px 18px;border-radius:var(--r-lg);background:var(--mat);box-shadow:inset 0 0 0 .5px var(--hair)}
.empty strong{display:block;font-size:13px;font-weight:600;margin-bottom:4px}
.empty p{font-size:11.5px;color:var(--fg2);line-height:1.55}
.empty-icon{display:flex;justify-content:center;margin-bottom:10px}
.waiting-shape{position:relative;width:52px;height:52px;display:inline-grid;place-items:center}
.waiting-shape .ws-ring{position:absolute;inset:0;border-radius:50%;background:conic-gradient(from 0deg,transparent 0 55%,color-mix(in srgb,var(--anvil) 70%,transparent) 85%,var(--anvil));-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 2px),#000 calc(100% - 1.5px));mask:radial-gradient(farthest-side,transparent calc(100% - 2px),#000 calc(100% - 1.5px));animation:wsSpin 1.6s linear infinite}
.waiting-shape .ws-mark{width:30px;height:30px;animation:wsBreath 2.4s ease-in-out infinite;filter:drop-shadow(0 0 6px color-mix(in srgb,var(--anvil) 45%,transparent))}
@keyframes wsSpin{to{transform:rotate(360deg)}}
@keyframes wsBreath{0%,100%{transform:scale(.92);opacity:.85}50%{transform:scale(1.04);opacity:1}}
@media (prefers-reduced-motion:reduce){.waiting-shape .ws-ring,.waiting-shape .ws-mark{animation:none}}
@keyframes ring{0%{transform:scale(.55);opacity:.9}100%{transform:scale(1.35);opacity:0}}

/* task cards */
.tasks article{margin-bottom:8px;border-radius:var(--r-lg);background:var(--mat);box-shadow:inset 0 0 0 .5px var(--hair);overflow:hidden}
.task-card-header{display:block;padding:10px 12px;cursor:pointer;user-select:none;border-radius:inherit;transition:background .15s}
.task-card-header:hover{background:var(--mat)}
.task-heading{display:flex;align-items:center;gap:8px}
.task-heading strong{flex:1;min-width:0;font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.count-badge{flex:none;font-size:10.5px;font-weight:600;padding:1px 7px;border-radius:99px;background:var(--mat2);color:var(--fg2);font-variant-numeric:tabular-nums}
.count-badge.completed{background:color-mix(in srgb,var(--green) 18%,transparent);color:var(--green)}
.count-badge.in-progress{background:color-mix(in srgb,var(--accent) 18%,transparent);color:var(--accent)}
.task-chev{flex:none;width:13px;height:13px;color:var(--fg3);transition:transform .35s var(--ease)}
.tasks article.collapsed .task-chev{transform:rotate(-90deg)}
.session-label{margin-top:3px;font-size:10.5px;color:var(--fg2)}
.task-body{display:grid;grid-template-rows:1fr;transition:grid-template-rows .35s var(--ease),opacity .25s}
.tasks article.collapsed .task-body{grid-template-rows:0fr;opacity:0}
.task-body-inner{min-height:0;overflow:hidden;padding:0 12px}
.task-body-divider{height:.5px;background:var(--sep);margin-bottom:8px}
.progress{margin-bottom:6px}
.progress-text{display:flex;align-items:center;gap:6px;font-size:11.5px}
.phase-chip{flex:none;font-size:9.5px;font-weight:700;padding:1px 6px;border-radius:5px;text-transform:uppercase;letter-spacing:.3px;background:color-mix(in srgb,var(--accent) 20%,transparent);color:var(--accent)}
.progress-meter{display:flex;align-items:center;gap:8px;margin-top:6px}
.progress-track{flex:1;height:5px;border-radius:99px;background:var(--mat3);overflow:hidden}
.progress-fill{height:100%;border-radius:99px;background:linear-gradient(90deg,var(--accent),var(--teal));transition:width .4s var(--ease)}
.progress-pct{font-size:10.5px;color:var(--fg2);font-variant-numeric:tabular-nums}
.task-list{list-style:none;margin:0;padding:0 0 10px}
.task{display:flex;align-items:flex-start;gap:8px;padding:4px 0;font-size:12px;line-height:1.45}
.task-icon{flex:none;width:15px;height:15px;margin-top:1px;border-radius:50%;box-shadow:inset 0 0 0 1.5px var(--fg3);font-size:0;position:relative}
.task.completed>.task-icon{background:var(--green);box-shadow:none}
.task.completed>.task-icon::after{content:"";position:absolute;left:5px;top:2.5px;width:3.5px;height:7px;border:solid #fff;border-width:0 1.6px 1.6px 0;transform:rotate(45deg)}
.task.in_progress>.task-icon{box-shadow:inset 0 0 0 1.5px var(--accent)}
.task.in_progress>.task-icon::after{content:"";position:absolute;inset:4px;border-radius:50%;background:var(--accent)}
.task.completed>span:last-child{color:var(--fg2);text-decoration:line-through;text-decoration-color:var(--fg3)}
.task.reported>span:last-child{font-weight:600}
.task-list .muted{font-size:11.5px;padding:2px 0}

/* activity list — notification-center style */
.activity-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px}
.activity-list>.event-item{margin:0;padding:0}
.event-card{border-radius:12px;background:var(--mat);box-shadow:inset 0 0 0 .5px var(--hair);overflow:hidden;transition:background .15s;interpolate-size:allow-keywords}
.event-card:hover{background:var(--mat2)}
.event-card[open]{background:var(--mat2)}
.event-card::details-content{height:0;overflow:hidden;opacity:0;transition:height .3s var(--ease),opacity .25s,content-visibility .3s allow-discrete}
.event-card[open]::details-content{height:auto;opacity:1}
.event-summary{display:flex;align-items:center;gap:8px;padding:7px 9px;list-style:none;cursor:pointer;user-select:none;outline:none}
.event-summary::-webkit-details-marker{display:none}
.client-chip{flex:none;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-left:6px;padding:1px 7px;border-radius:999px;font-size:10.5px;font-weight:500;color:var(--vscode-descriptionForeground);background:color-mix(in srgb,var(--vscode-foreground) 8%,transparent)}
.sheet-backdrop{position:fixed;inset:0;z-index:50;display:grid;place-items:center;padding:16px;background:rgba(0,0,0,.45);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);animation:sheetFade .18s ease-out}
.sheet{width:100%;max-width:300px;padding:18px 16px 14px;border-radius:14px;text-align:center;background:color-mix(in srgb,var(--vscode-sideBar-background,#1e1e1e) 88%,#fff 6%);box-shadow:0 12px 40px rgba(0,0,0,.45),inset 0 0 0 .5px rgba(255,255,255,.12);animation:sheetPop .22s cubic-bezier(.2,.9,.3,1.2)}
.sheet-icon{width:36px;height:36px;margin:0 auto 8px;border-radius:10px;display:grid;place-items:center;background:var(--orange,#ff9f0a);color:#fff}
.sheet-icon svg{width:18px;height:18px}
.sheet h3{margin:0 0 4px;font-size:14px;font-weight:600}
.sheet-path{margin:0 0 10px;font-size:11px;opacity:.65;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sheet-list{margin:0 0 14px;padding:10px 12px;list-style:none;text-align:left;font-size:12px;line-height:1.7;border-radius:10px;background:color-mix(in srgb,var(--vscode-foreground) 6%,transparent)}
.sheet-list li::before{content:"•";color:var(--orange,#ff9f0a);margin-right:6px}
.sheet-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.sheet-actions .btn{height:30px;justify-content:center}
.btn-danger{background:var(--orange,#ff9f0a) !important;color:#fff !important;border-color:transparent !important}
.btn-danger:hover{filter:brightness(1.08)}
@keyframes sheetFade{from{opacity:0}}
@keyframes sheetPop{from{opacity:0;transform:scale(.94)}}
.tool-badge{flex:none;width:22px;height:22px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;font-size:0;line-height:0;overflow:hidden;color:#fff;background:var(--gray)}
.tool-badge .badge-icon{width:12px;height:12px;flex:none;display:block}
.tool-badge.read{background:var(--accent)}
.tool-badge.edit{background:var(--purple)}
.tool-badge.command{background:#3a3a3c;color:var(--green);box-shadow:inset 0 0 0 .5px var(--hair)}
.tool-badge.search{background:var(--teal)}
.tool-badge.diag{background:var(--indigo)}
.tool-badge.session{background:var(--green)}
.tool-badge.psst{background:var(--orange)}
.tool-badge.system{background:var(--gray)}
.tool-badge.error{background:var(--red)}
.event-title{flex:1;min-width:0;font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.event-time{flex:none;font-size:10.5px;color:var(--fg3);font-variant-numeric:tabular-nums}
.event-chev{flex:none;width:12px;height:12px;color:var(--fg3);transition:transform .3s var(--ease)}
.event-card[open] .event-chev{transform:rotate(90deg)}
.event-count{flex:none;font-size:10px;font-weight:600;padding:0 6px;border-radius:99px;background:var(--mat3);color:var(--fg2)}
.event-body{padding:2px 9px 9px 39px;font-size:11px}
.diff-tag{display:inline-flex;gap:4px;font:600 10px var(--mono);flex:none}
.diff-add{color:var(--green)}.diff-del{color:var(--red)}.diff-neutral{color:var(--fg2)}
.event-diff-stat{padding:1px 5px;border-radius:5px;background:var(--mat2)}
.file-group-title{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.3px;color:var(--fg3);margin:4px 0}
.file-list{display:flex;flex-direction:column;gap:2px}
.file-link-btn{display:flex;align-items:center;gap:6px;width:100%;padding:4px 6px;border-radius:6px;text-align:left;font-size:11px}
.file-link-btn:hover{background:var(--accent);color:#fff}
.file-link-btn .file-icon{flex:none;opacity:.7}
.file-link-btn .file-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono)}
.file-link-btn .file-action{flex:none;font-size:10px;opacity:0}
.file-link-btn:hover .file-action{opacity:.85}
.code-block{margin:4px 0 0;padding:7px 9px;border-radius:7px;background:color-mix(in srgb,var(--bg) 50%,#000 30%);font:11px/1.5 var(--mono);white-space:pre-wrap;word-break:break-all;color:var(--fg)}
.detail-text{margin:0;color:var(--fg2);white-space:pre-wrap;word-break:break-word;line-height:1.5}
.event-times{display:flex;flex-wrap:wrap;gap:4px;list-style:none;padding:0;margin:5px 0 0}
.event-times li{font:10px var(--mono);padding:1px 6px;border-radius:5px;background:var(--mat2);color:var(--fg2)}
.search-heading{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}
.search-count,.search-location,.search-scope{font-size:10.5px;color:var(--fg2)}
.search-scope{margin:0 0 6px;overflow-wrap:anywhere}
.search-matches{display:flex;flex-direction:column;gap:3px}
.search-match{display:flex;flex-direction:column;gap:3px;width:100%;padding:6px 8px;border-radius:7px;text-align:left}
.search-match:hover{background:var(--mat3)}
.search-snippet{font:11px/1.5 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere}
.empty-log{list-style:none}
.empty-carousel{display:grid;min-height:40px;align-items:center;padding:8px 10px;text-align:center;border-radius:12px;background:var(--mat)}
.empty-phrase{grid-area:1/1;margin:0;font-size:11.5px;opacity:0;transform:translateY(6px);transition:opacity .8s,transform .8s var(--ease)}
.empty-phrase.is-active{opacity:1;transform:none}
.empty-phrase.is-leaving{opacity:0;transform:translateY(-6px)}
.empty-phrase-text{color:var(--fg2)}
@media(prefers-reduced-motion:reduce){*,*::before,*::after,.event-card::details-content{animation:none !important;transition:none !important}}
@media(max-width:260px){.tiles{grid-template-columns:1fr}.actions{flex-wrap:wrap}}
</style></head><body><div id="state"${this.uiUnlocked ? "" : " hidden inert"}>${this.uiUnlocked ? this.stateHtml() : ""}</div><script nonce="${r}">
const api = acquireVsCodeApi();
const remembered = api.getState() || {};
const root = document.getElementById('state');
let uiUnlocked = ${this.uiUnlocked ? "true" : "false"};
let copyPromptTimer = null;
let copyPromptOriginalHtml = null;
const checkSvg = '<svg class="btn-icon check-animated" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path class="check-path" d="M20 6 9 17 4 12"/></svg><span>已复制</span>';
function handleCopyPrompt(btn) {
  if (!btn) return;
  // Success feedback only; the extension host owns the clipboard operation.
  if (!copyPromptTimer) copyPromptOriginalHtml = btn.innerHTML;
  btn.classList.add('copied');
  btn.innerHTML = checkSvg;
  if (copyPromptTimer) clearTimeout(copyPromptTimer);
  copyPromptTimer = setTimeout(() => {
    const currentBtn = root.querySelector('button[data-command="copyPrompt"]');
    if (currentBtn) {
      currentBtn.classList.remove('copied');
      currentBtn.innerHTML = copyPromptOriginalHtml;
    }
    copyPromptTimer = null;
  }, 2000);
}
function handleClearLog(btn) {
  const list = root.querySelector('.activity-list');
  const items = list ? Array.from(list.querySelectorAll('.event-item')) : [];
  if (!items.length || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    api.postMessage({ command: 'clearLog' });
    return;
  }
  btn.disabled = true;
  const count = items.length;
  const stepDelay = Math.max(18, Math.min(42, 320 / count));
  let completed = 0;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    api.postMessage({ command: 'clearLog' });
  };
  const safetyTimer = setTimeout(finish, (count - 1) * stepDelay + 360);
  items.forEach((item, index) => {
    item.style.pointerEvents = 'none';
    const delay = index * stepDelay;
    const anim = item.animate([
      { transform: 'translateX(0)', opacity: '1' },
      { transform: 'translateX(60px)', opacity: '0.2', offset: 0.65 },
      { transform: 'translateX(105%)', opacity: '0' }
    ], {
      duration: 260,
      delay: delay,
      easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      fill: 'forwards'
    });
    anim.onfinish = () => {
      completed++;
      if (completed >= count) {
        clearTimeout(safetyTimer);
        finish();
      }
    };
  });
}
let dockCollapsed = !!remembered.collapsed;
let dockTransition = null;
function applyDock(animate = false) {
  const dock = root.querySelector('.dock'); if (!dock) return;
  const body = dock.querySelector('.dock-body'), toggle = dock.querySelector('.dock-toggle');
  const fromHeight = dock.getBoundingClientRect().height;
  const fromOpacity = body && getComputedStyle(body).display !== 'none' ? Number(getComputedStyle(body).opacity) : 0;
  if (dockTransition) { dockTransition.cancel(); dockTransition = null; }
  if (body) for (const animation of body.getAnimations()) animation.cancel();
  dock.classList.remove('is-animating');
  dock.classList.toggle('collapsed', dockCollapsed);
  if (toggle) {
    toggle.setAttribute('aria-expanded', String(!dockCollapsed));
    toggle.title = dockCollapsed ? '展开连接面板' : '折叠连接面板';
    toggle.setAttribute('aria-label', toggle.title);
  }
  if (body) {
    if (dockCollapsed && body.contains(document.activeElement)) toggle?.focus({preventScroll:true});
    body.inert = dockCollapsed;
    body.setAttribute('aria-hidden', String(dockCollapsed));
  }
  const toHeight = dock.getBoundingClientRect().height;
  root.style.setProperty('--dock-height', toHeight + 'px');
  if (!animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  dock.classList.add('is-animating');
  const options = { duration: 260, easing: 'cubic-bezier(.16, 1, .3, 1)', fill: 'both' };
  const motion = dock.animate([{height:fromHeight+'px'},{height:toHeight+'px'}], options);
  const fade = body?.animate([{opacity:fromOpacity},{opacity:dockCollapsed?0:1}], options);
  dockTransition = motion;
  motion.onfinish = () => {
    if (dockTransition !== motion) return;
    dock.classList.remove('is-animating');
    motion.cancel(); fade?.cancel(); dockTransition = null;
    root.style.setProperty('--dock-height', dock.getBoundingClientRect().height + 'px');
  };
}

function remember() { const openEvents=Array.from(root.querySelectorAll('.event-card[open]')).map(el=>el.dataset.eventId).filter(Boolean); const collapsedTasks=Array.from(root.querySelectorAll('.tasks article.collapsed')).map(a=>a.dataset.client).filter(Boolean); const expandedTasks=Array.from(root.querySelectorAll('.tasks article:not(.collapsed)')).map(a=>a.dataset.client).filter(Boolean); api.setState({ scroll: document.getElementById('activityFeed')?.scrollTop || 0, details: !!document.getElementById('connectionDetails')?.open, collapsed: dockCollapsed, openEvents, collapsedTasks, expandedTasks }); }
function restore(data) {
  const feed=document.getElementById('activityFeed'), details=document.getElementById('connectionDetails');
  if(details) details.open=!!data.details;
  // This script is embedded in an outer template literal: do not nest raw backticks.
  // Match dataset values directly rather than interpolating IDs into CSS selectors.
  const openIds=new Set(Array.isArray(data.openEvents)?data.openEvents.filter(id=>typeof id==='string'):[]);
  // Restoring persisted state must not animate; a re-render would otherwise
  // replay every previously expanded card at once.
  for(const card of root.querySelectorAll('.event-card')) card.open=openIds.has(card.dataset.eventId);
  const collapsedSet=new Set(Array.isArray(data?.collapsedTasks)?data.collapsedTasks:[]);
  const expandedSet=new Set(Array.isArray(data?.expandedTasks)?data.expandedTasks:[]);
  for(const a of root.querySelectorAll('.tasks article[data-client]')){const c=a.dataset.client;if(collapsedSet.has(c)){a.classList.add('collapsed');a.querySelector('.task-card-header')?.setAttribute('aria-expanded','false');}else if(expandedSet.has(c)){a.classList.remove('collapsed');a.querySelector('.task-card-header')?.setAttribute('aria-expanded','true');}}
  applyDock();
  if(feed) feed.scrollTop=data.scroll||0;
}
// Empty-state carousel. The phrase index lives outside the DOM so a re-render (every state message) resumes
// where it was instead of snapping back to the first phrase.
let emptyPhraseIndex=0, emptyTimer=null;
const EMPTY_ROTATE_MS=4200;
function startEmptyCarousel(){
  if(emptyTimer){clearInterval(emptyTimer);emptyTimer=null;}
  const phrases=Array.from(root.querySelectorAll('.empty-phrase'));
  if(!phrases.length)return;
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const show=(i,animate)=>{const prev=(i+phrases.length-1)%phrases.length;phrases.forEach((p,k)=>{p.classList.toggle('is-active',k===i);p.classList.toggle('is-leaving',animate&&k===prev);});};
  emptyPhraseIndex%=phrases.length;
  // Defer one frame so the first phrase transitions in from the hidden state instead of appearing instantly.
  requestAnimationFrame(()=>show(emptyPhraseIndex,false));
  emptyTimer=setInterval(()=>{if(!root.contains(phrases[0])){clearInterval(emptyTimer);emptyTimer=null;return;}emptyPhraseIndex=(emptyPhraseIndex+1)%phrases.length;show(emptyPhraseIndex,!reduced);},EMPTY_ROTATE_MS);
}
restore(remembered);
startEmptyCarousel();
root.addEventListener('click', e => { const taskHeader=e.target.closest('.task-card-header');if(taskHeader){const article=taskHeader.closest('article');if(article){const isCollapsed=article.classList.toggle('collapsed');taskHeader.setAttribute('aria-expanded',String(!isCollapsed));taskHeader.title=isCollapsed?'点击展开任务详情':'点击折叠任务详情';remember();return;}} const matchBtn=e.target.closest('[data-search-event]');if(matchBtn){e.preventDefault();e.stopPropagation();api.postMessage({command:'openSearchMatch',eventId:matchBtn.dataset.searchEvent,index:Number(matchBtn.dataset.searchIndex)});return;} const fileBtn=e.target.closest('[data-open-file]'); if(fileBtn){e.preventDefault();e.stopPropagation();api.postMessage({command:'openFile',path:fileBtn.dataset.openFile});return;} const t=e.target.closest('[data-toggle="dock"]') || (e.target.closest('.connection-heading') && !e.target.closest('button, a')); if(t){dockCollapsed=!dockCollapsed;applyDock(true);remember();return;} const b=e.target.closest('button[data-command]'); if(b&&!b.disabled){if(b.dataset.command==='copyPrompt'){api.postMessage({command:'copyPrompt'});return;}if(b.dataset.command==='clearLog'){handleClearLog(b);return;}api.postMessage({command:b.dataset.command});} });
root.addEventListener('keydown', e => { if((e.key==='Enter'||e.key===' ')&&e.target.classList?.contains('task-card-header')){e.preventDefault();e.target.click();} });
root.addEventListener('scroll', remember, true);root.addEventListener('toggle', remember, true);
window.addEventListener('resize', () => { const d = root.querySelector('.dock'); if (d) root.style.setProperty('--dock-height', d.getBoundingClientRect().height + 'px'); });
// Snapshot visual positions before replacing state HTML; only new IDs enter.
let activityReady = !!document.getElementById('activityFeed');
const activityMotions = new Map();
const activityReduced = window.matchMedia('(prefers-reduced-motion: reduce)');
activityReduced.addEventListener('change', () => {
  for (const motion of activityMotions.values()) motion.cancel();
  activityMotions.clear();
});
function captureActivity() {
  const feed = document.getElementById('activityFeed');
  const top = feed?.getBoundingClientRect().top || 0;
  const rows = new Map();
  for (const card of root.querySelectorAll('.activity-list .event-card')) {
    const item = card.closest('.event-item'), rect = item.getBoundingClientRect();
    rows.set(card.dataset.eventId, { top: rect.top, bottom: rect.bottom,
      opacity: Number(getComputedStyle(item).opacity), moving: activityMotions.has(card.dataset.eventId) });
  }
  for (const motion of activityMotions.values()) motion.cancel();
  activityMotions.clear();
  return { rows, top, scroll: feed?.scrollTop || 0, ready: activityReady };
}
function transitionActivity(before) {
  const feed = document.getElementById('activityFeed');
  activityReady = !!feed;
  if (!feed || !before.ready) return;
  const items = new Map(Array.from(root.querySelectorAll('.activity-list .event-card'),
    card => [card.dataset.eventId, card.closest('.event-item')]));
  const added = Array.from(items.keys()).some(id => !before.rows.has(id));
  // Anchor the first surviving visible row, not the numerical scroll offset.
  if (before.scroll > 2) {
    const anchor = Array.from(before.rows).find(([id, row]) => row.bottom > before.top && items.has(id));
    if (anchor) {
      const [id, row] = anchor;
      feed.scrollTop += items.get(id).getBoundingClientRect().top - feed.getBoundingClientRect().top - (row.top - before.top);
    }
  } else feed.scrollTop = 0;
  if (document.hidden) return;
  const viewport = feed.getBoundingClientRect();
  for (const [id, item] of items) {
    const old = before.rows.get(id), rect = item.getBoundingClientRect();
    if (rect.bottom < viewport.top || rect.top > viewport.bottom) continue;
    const entering = !old;
    if (!entering && (!added && !old.moving || activityReduced.matches)) continue;
    const dy = entering ? -8 : old.top - rect.top;
    if (!entering && Math.abs(dy) < .5 && old.opacity >= 1) continue;
    const frames = activityReduced.matches
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [{ opacity: entering ? 0 : old.opacity, transform: 'translateY(' + dy + 'px)' },
         { opacity: 1, transform: 'translateY(0)' }];
    const motion = item.animate(frames, { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' });
    activityMotions.set(id, motion);
    motion.onfinish = () => { if (activityMotions.get(id) === motion) activityMotions.delete(id); };
  }
}
window.addEventListener('message', e => {
  if(e.data?.type==='copyPromptCopied'){handleCopyPrompt(root.querySelector('button[data-command="copyPrompt"]'));return;}
  if(e.data?.type!=='state')return;
  const activityBefore = captureActivity();
  const previous={scroll:document.getElementById('activityFeed')?.scrollTop||0,details:!!document.getElementById('connectionDetails')?.open,openEvents:Array.from(root.querySelectorAll('.event-card[open]')).map(card=>card.dataset.eventId).filter(Boolean),collapsedTasks:Array.from(root.querySelectorAll('.tasks article.collapsed')).map(a=>a.dataset.client).filter(Boolean),expandedTasks:Array.from(root.querySelectorAll('.tasks article:not(.collapsed)')).map(a=>a.dataset.client).filter(Boolean)};
  const command=document.activeElement?.dataset?.command;
  const toggled=document.activeElement?.dataset?.toggle;
  const input=document.activeElement?.id==='mcpUrl'?document.activeElement:null;
  const selection=input?{value:input.value,start:input.selectionStart,end:input.selectionEnd,scroll:input.scrollLeft}:null;
  const waitingShape=root.querySelector('.waiting-shape');
  root.innerHTML=e.data.html;
  if(copyPromptTimer){const promptBtn=root.querySelector('button[data-command="copyPrompt"]');if(promptBtn){promptBtn.classList.add('copied');promptBtn.innerHTML=checkSvg;}}
  const nextShape=root.querySelector('.waiting-shape');
  if(waitingShape&&nextShape)nextShape.replaceWith(waitingShape);
  restore(previous);
  transitionActivity(activityBefore);
  remember();
  startEmptyCarousel();
  if(selection){const field=document.getElementById('mcpUrl');if(field){field.focus({preventScroll:true});if(field.value===selection.value){field.setSelectionRange(selection.start,selection.end);field.scrollLeft=selection.scroll;}}}
  if(command){const b=[...root.querySelectorAll('[data-command]')].find(x=>x.dataset.command===command&&!x.disabled);b?.focus({preventScroll:true});}
  if(toggled){root.querySelector('[data-toggle="'+toggled+'"]')?.focus({preventScroll:true});}
});
api.postMessage({command:'refresh'});
</script></body></html>`;
      let n = [];
      (n.push(
        e.webview.onDidReceiveMessage((o) => {
          if (o?.command === "refresh") {
            this.changed();
            return;
          }
          if (this.uiUnlocked) {
            if (o?.command === "openSearchMatch") {
              this.safe(() => this.openSearchMatch(o.eventId, o.index));
              return;
            }
            if (o?.command === "openFile" && o.path) {
              this.openFile(o.path);
              return;
            }
            [
              "start",
              "stop",
              "copyUrl",
              "copyPrompt",
              "copyReconnectPrompt",
              "rotate",
              "tunnel",
              "stopTunnel",
              "checkCloudflared",
              "installCloudflared",
              "terminals",
              "clearLog",
              "approvalMode",
              "fullAccessMode",
              "confirmFullAccess",
              "cancelFullAccess",
              "skills",
              "checkpoints",
            ].includes(o?.command) && vscode.commands.executeCommand(`lanternBridge.${o.command}`);
          }
        }),
      ),
        n.push(
          e.onDidChangeVisibility(() => {
            e.visible && this.changed();
          }),
        ),
        n.push(
          e.onDidDispose(() => {
            this.panel === e && (this.panel = null);
            for (let o of n) o.dispose();
          }),
        ));
    }
    async dispose() {
      (this.renderTimer && (clearTimeout(this.renderTimer), (this.renderTimer = null)),
        await this.stop(),
        (this.panel = null),
        this.skillsPanel?.dispose(),
        (this.skillsPanel = null),
        this.cpPanel?.dispose(),
        (this.cpPanel = null));
    }
  };
function activate(t) {
  controller = new Controller(t);
}
async function deactivate() {
  await controller?.dispose();
}
module.exports = { activate, deactivate };
