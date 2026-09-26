"use strict";
var path = require("node:path"),
  fs = require("node:fs"),
  { execFile } = require("node:child_process"),
  WINGET_PACKAGE = "Cloudflare.cloudflared",
  PROBE_TIMEOUT_MS = 1e4,
  INSTALL_TIMEOUT_MS = 600 * 1e3,
  run = (t, e, r) =>
    new Promise((n) => {
      execFile(t, e, { windowsHide: !0, timeout: r, maxBuffer: 2 * 1024 * 1024, shell: !1 }, (o, s, i) => {
        n({ ok: !o, code: o?.code, stdout: String(s || ""), stderr: String(i || "") });
      });
    });
function candidates(t) {
  let e = [t, "cloudflared"];
  if (process.platform === "win32") {
    let r = process.env.LOCALAPPDATA,
      n = process.env.ProgramFiles,
      o = process.env["ProgramFiles(x86)"];
    (r &&
      (e.push(path.join(r, "Microsoft", "WinGet", "Links", "cloudflared.exe")),
      e.push(path.join(r, "Microsoft", "WindowsApps", "cloudflared.exe"))),
      n && e.push(path.join(n, "cloudflared", "cloudflared.exe")),
      o && e.push(path.join(o, "cloudflared", "cloudflared.exe")));
    // winget 实际安装目录（Links 不在 PATH 时兜底）
    if (r) {
      let pk = path.join(r, "Microsoft", "WinGet", "Packages");
      try {
        for (let d of fs.readdirSync(pk))
          d.toLowerCase().startsWith("cloudflare.cloudflared") && e.push(path.join(pk, d, "cloudflared.exe"));
      } catch {}
    }
    // VS Code 启动后才写入注册表的新 PATH（winget 安装后进程 PATH 不会自动刷新）
    for (let d of freshWindowsPath()) e.push(path.join(d, "cloudflared.exe"));
  } else {
    e.push("/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared", "/usr/bin/cloudflared");
  }
  return [...new Set(e.filter(Boolean))];
}
function freshWindowsPath() {
  let out = [];
  for (let key of ["HKCU\\Environment", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"]) {
    try {
      let t = require("node:child_process").execFileSync("reg", ["query", key, "/v", "Path"], { windowsHide: !0, encoding: "utf8", timeout: 5e3 });
      let m = /Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i.exec(t);
      m && out.push(...m[1].trim().split(";").map((x) => x.replace(/%([^%]+)%/g, (_, v) => process.env[v] ?? _)).filter(Boolean));
    } catch {}
  }
  return out;
}
async function detect(t) {
  for (let e of candidates(t)) {
    let r = await run(e, ["--version"], PROBE_TIMEOUT_MS);
    if (!r.ok) continue;
    let n = (r.stdout || r.stderr).trim().split(/\r?\n/)[0] || "cloudflared";
    return { installed: !0, executable: e, version: n };
  }
  return { installed: !1, executable: null, version: null };
}
async function install(t) {
  let e = await detect(t);
  if (e.installed) return { ...e, alreadyInstalled: !0 };
  if (process.platform !== "win32")
    return {
      installed: !1,
      error: "一键安装目前仅支持 Windows（通过 winget）。其他系统请参考官方文档手动安装。",
    };
  if (!(await run("winget", ["--version"], PROBE_TIMEOUT_MS)).ok)
    return {
      installed: !1,
      error: "未检测到 winget。请升级“应用安装程序”或改用官方安装包。",
    };
  let n = await run(
      "winget",
      [
        "install",
        "--id",
        WINGET_PACKAGE,
        "--exact",
        "--source",
        "winget",
        "--silent",
        "--disable-interactivity",
        "--accept-package-agreements",
        "--accept-source-agreements",
      ],
      INSTALL_TIMEOUT_MS,
    ),
    o = await detect(t);
  if (o.installed) return { ...o, installedNow: !0 };
  let s = (n.stderr || n.stdout || "").trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" ");
  return {
    installed: !1,
    error: s
      ? `安装未完成：${s.slice(0, 300)}`
      : "安装命令已结束，但仍未找到 cloudflared。请重启窗口后重试。",
  };
}
module.exports = { detect, install, WINGET_PACKAGE };
