"use strict";
var EMPTY_PHRASES = [
  "暂无活动 \xB7 外部 AI 调用工具或系统事件将以卡片展示于此处",
  "启动服务并分享私有 MCP URL，等待客户端连接",
  "读取、编辑、搜索与命令都会记录在这里，点击卡片可打开对应文件",
  "连续多次相同的读取会合并为一张卡片，并列出每次调用的时间",
  "面板保留最近 50 条活动，「清空」只清除记录，不影响连接",
];
function groupEvents(t) {
  let e = [];
  for (let r = 0; r < t.length; r++) {
    let n = t[r],
      o = e[e.length - 1];
    if (
      o &&
      !n.search &&
      !o.event.search &&
      JSON.stringify(n.outcome || null) === JSON.stringify(o.event.outcome || null) &&
      n.title === o.event.title &&
      (n.detail || "") === (o.event.detail || "")
    ) {
      (o.times.push(n.time || ""), o.count++, (o.id = n.id));
      continue;
    }
    e.push({ event: n, index: r, count: 1, times: [n.time || ""], id: n.id });
  }
  return e;
}
function updateCommandEvent(t, e) {
  let r = e.outcome;
  if (!r || typeof r.command_id != "string" || !r.command_id || typeof r.status != "string") return !1;
  let n = "";
  (typeof r.command_text == "string" ? (n = r.command_text) : e.title === "执行命令" && (n = e.detail),
    (e.title = "执行命令"),
    (e.detail = String(n || "").slice(0, 1e3)));
  let o = t.find((a) => a.outcome?.command_id === r.command_id);
  if (!o) return !1;
  let s = new Set(["completed", "failed", "cancelled", "timed_out"]);
  return (
    (s.has(o.outcome.status) && !s.has(r.status)) || (o.outcome = { ...o.outcome, ...r }),
    e.detail && (o.detail = e.detail),
    (o.title = e.title),
    !0
  );
}
module.exports = { EMPTY_PHRASES, groupEvents, updateCommandEvent };
