"use strict";
const path = require("node:path"),
  fs = require("node:fs"),
  os = require("node:os"),
  crypto = require("node:crypto"),
  https = require("node:https"),
  { execFile } = require("node:child_process"),
  WINGET_PACKAGE = "Cloudflare.cloudflared",
  PROBE_TIMEOUT_MS = 1e4,
  INSTALL_TIMEOUT_MS = 600 * 1e3,
  RELEASE_API = "https://api.github.com/repos/cloudflare/cloudflared/releases/latest",
  MAX_ASSET_BYTES = 80 * 1024 * 1024,
  BREW_ENV = {
    NONINTERACTIVE: "1",
    HOMEBREW_NO_AUTO_UPDATE: "1",
    HOMEBREW_NO_ENV_HINTS: "1",
    HOMEBREW_NO_ANALYTICS: "1",
  };

function run(cmd, args, timeout, extraEnv) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        windowsHide: true,
        timeout,
        maxBuffer: 2 * 1024 * 1024,
        shell: false,
        env: extraEnv ? { ...process.env, ...extraEnv } : undefined,
      },
      (err, stdout, stderr) => {
        resolve({ ok: !err, code: err?.code, stdout: String(stdout || ""), stderr: String(stderr || "") });
      },
    );
  });
}

function tail(text) {
  return String(text || "")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-3)
    .join(" ")
    .slice(0, 300);
}

function darwinAssetName(arch = process.arch) {
  return `cloudflared-darwin-${arch === "arm64" ? "arm64" : "amd64"}.tgz`;
}

function localBinaryPath() {
  if (process.platform !== "darwin") return null;
  return path.join(os.homedir(), "Library", "Application Support", "anvil-bridge", "bin", "cloudflared");
}

function isGitHubHost(hostname) {
  return hostname === "github.com" || hostname === "api.github.com" || hostname.endsWith(".githubusercontent.com");
}

function candidates(configured) {
  let list = [configured, "cloudflared"];
  if (process.platform === "win32") {
    let local = process.env.LOCALAPPDATA,
      programFiles = process.env.ProgramFiles,
      programFilesX86 = process.env["ProgramFiles(x86)"];
    local &&
      (list.push(path.join(local, "Microsoft", "WinGet", "Links", "cloudflared.exe")),
      list.push(path.join(local, "Microsoft", "WindowsApps", "cloudflared.exe")));
    programFiles && list.push(path.join(programFiles, "cloudflared", "cloudflared.exe"));
    programFilesX86 && list.push(path.join(programFilesX86, "cloudflared", "cloudflared.exe"));
    if (local) {
      let packages = path.join(local, "Microsoft", "WinGet", "Packages");
      try {
        for (let name of fs.readdirSync(packages))
          name.toLowerCase().startsWith("cloudflare.cloudflared") && list.push(path.join(packages, name, "cloudflared.exe"));
      } catch {}
    }
    for (let dir of freshWindowsPath()) list.push(path.join(dir, "cloudflared.exe"));
  } else {
    let local = localBinaryPath();
    local && list.push(local);
    list.push("/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared", "/usr/bin/cloudflared");
  }
  return [...new Set(list.filter(Boolean))];
}

function freshWindowsPath() {
  let out = [];
  for (let key of ["HKCU\\Environment", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"]) {
    try {
      let text = require("node:child_process").execFileSync("reg", ["query", key, "/v", "Path"], {
        windowsHide: true,
        encoding: "utf8",
        timeout: 5e3,
      });
      let match = /Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i.exec(text);
      match &&
        out.push(
          ...match[1]
            .trim()
            .split(";")
            .map((entry) => entry.replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? _))
            .filter(Boolean),
        );
    } catch {}
  }
  return out;
}

async function detect(configured) {
  for (let executable of candidates(configured)) {
    let result = await run(executable, ["--version"], PROBE_TIMEOUT_MS);
    if (!result.ok) continue;
    let version = (result.stdout || result.stderr).trim().split(/\r?\n/)[0] || "cloudflared";
    return { installed: true, executable, version };
  }
  return { installed: false, executable: null, version: null };
}

async function install(configured) {
  let found = await detect(configured);
  if (found.installed) return { ...found, alreadyInstalled: true };
  if (process.platform === "win32") return installWindows(configured);
  if (process.platform === "darwin") return installDarwin(configured);
  return {
    installed: false,
    error: "一键安装目前支持 Windows（winget）和 macOS（Homebrew 或官方二进制）。其他系统请手动安装 cloudflared。",
  };
}

async function installWindows(configured) {
  if (!(await run("winget", ["--version"], PROBE_TIMEOUT_MS)).ok)
    return { installed: false, error: "未检测到 winget。请升级“应用安装程序”或改用官方安装包。" };
  let installed = await run(
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
  );
  let found = await detect(configured);
  if (found.installed) return { ...found, installedNow: true, via: "winget" };
  let detail = tail(installed.stderr || installed.stdout);
  return {
    installed: false,
    error: detail ? `安装未完成：${detail}` : "安装命令已结束，但仍未找到 cloudflared。请重启窗口后重试。",
  };
}

async function findBrew() {
  for (let brew of ["/opt/homebrew/bin/brew", "/usr/local/bin/brew", "brew"]) {
    let result = await run(brew, ["--version"], PROBE_TIMEOUT_MS, BREW_ENV);
    if (result.ok && /homebrew/i.test(`${result.stdout}\n${result.stderr}`)) return brew;
  }
  return null;
}

async function installDarwin(configured) {
  let brew = await findBrew(),
    brewNote = "";
  if (brew) {
    let installed = await run(brew, ["install", "cloudflared"], INSTALL_TIMEOUT_MS, BREW_ENV);
    let prefix = await run(brew, ["--prefix"], PROBE_TIMEOUT_MS, BREW_ENV);
    let brewBin = prefix.ok && prefix.stdout.trim() ? path.join(prefix.stdout.trim(), "bin", "cloudflared") : null;
    let found = await detect(brewBin || configured);
    if (found.installed) return { ...found, installedNow: true, via: "homebrew" };
    brewNote = tail(installed.stderr || installed.stdout);
  }
  try {
    let bin = await downloadOfficialBinary();
    let found = await detect(bin);
    if (found.installed) return { ...found, installedNow: true, via: "official" };
    return { installed: false, error: "官方二进制已下载，但仍无法运行 cloudflared。" };
  } catch (err) {
    let why = err?.message || String(err);
    let extra = brewNote ? ` Homebrew：${brewNote}` : brew ? "" : " 未检测到 Homebrew。";
    return { installed: false, error: `安装未完成：${why}${extra}`.slice(0, 400) };
  }
}

async function downloadOfficialBinary() {
  let asset = darwinAssetName(),
    meta = await fetchReleaseAsset(asset),
    dest = localBinaryPath(),
    dir = path.dirname(dest),
    tgz = path.join(dir, asset),
    unpack = path.join(dir, "unpack");
  fs.mkdirSync(dir, { recursive: true });
  await downloadToFile(meta.url, tgz);
  let digest = crypto.createHash("sha256").update(fs.readFileSync(tgz)).digest("hex");
  if (!meta.sha256 || digest !== meta.sha256) {
    fs.rmSync(tgz, { force: true });
    throw new Error("官方安装包校验失败，已中止");
  }
  fs.rmSync(unpack, { recursive: true, force: true });
  fs.mkdirSync(unpack, { recursive: true });
  let extracted = await run("/usr/bin/tar", ["-xf", tgz, "-C", unpack], 60e3);
  fs.rmSync(tgz, { force: true });
  if (!extracted.ok) throw new Error(tail(extracted.stderr || extracted.stdout) || "解压失败");
  let bin = findExtractedBinary(unpack);
  if (!bin) throw new Error("安装包里没有 cloudflared 可执行文件");
  fs.rmSync(dest, { force: true });
  fs.copyFileSync(bin, dest);
  fs.chmodSync(dest, 0o755);
  fs.rmSync(unpack, { recursive: true, force: true });
  await run("/usr/bin/xattr", ["-d", "com.apple.quarantine", dest], PROBE_TIMEOUT_MS);
  return dest;
}

async function fetchReleaseAsset(name) {
  let res = await getBuffer(RELEASE_API, {
    Accept: "application/vnd.github+json",
    "User-Agent": "anvil-bridge",
  });
  if (res.status !== 200) throw new Error(`无法获取 cloudflared 发布信息（HTTP ${res.status}）`);
  let json = JSON.parse(res.body.toString("utf8"));
  let asset = (json.assets || []).find((item) => item.name === name);
  if (!asset?.browser_download_url) throw new Error(`发布包里没有 ${name}`);
  let sha256 = String(asset.digest || "")
    .replace(/^sha256:/i, "")
    .toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("发布包没有可用的 SHA256 校验值");
  return { url: asset.browser_download_url, sha256 };
}

function findExtractedBinary(dir) {
  let stack = [dir];
  while (stack.length) {
    let current = stack.pop();
    for (let name of fs.readdirSync(current)) {
      let full = path.join(current, name);
      let stat = fs.statSync(full);
      if (stat.isDirectory()) stack.push(full);
      else if (name === "cloudflared") return full;
    }
  }
  return null;
}

function getBuffer(url, headers, redirects = 0) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }
    if (parsed.protocol !== "https:" || !isGitHubHost(parsed.hostname)) {
      reject(new Error("拒绝非 GitHub 下载地址"));
      return;
    }
    let req = https.get(url, { headers, timeout: 120000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode || 0) && res.headers.location) {
        res.resume();
        if (redirects >= 5) {
          reject(new Error("下载重定向过多"));
          return;
        }
        resolve(getBuffer(new URL(res.headers.location, url).href, headers, redirects + 1));
        return;
      }
      let chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("timeout", () => req.destroy(new Error("下载超时")));
    req.on("error", reject);
  });
}

function downloadToFile(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }
    if (parsed.protocol !== "https:" || !isGitHubHost(parsed.hostname)) {
      reject(new Error("拒绝非 GitHub 下载地址"));
      return;
    }
    let req = https.get(
      url,
      { headers: { "User-Agent": "anvil-bridge", Accept: "application/octet-stream" }, timeout: 120000 },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode || 0) && res.headers.location) {
          res.resume();
          if (redirects >= 5) {
            reject(new Error("下载重定向过多"));
            return;
          }
          resolve(downloadToFile(new URL(res.headers.location, url).href, dest, redirects + 1));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`下载失败（HTTP ${res.statusCode}）`));
          return;
        }
        let file = fs.createWriteStream(dest),
          size = 0,
          failed = false;
        let fail = (err) => {
          if (failed) return;
          failed = true;
          res.destroy();
          file.close(() => fs.rm(dest, { force: true }, () => reject(err)));
        };
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_ASSET_BYTES) fail(new Error("安装包过大，已中止"));
        });
        res.on("error", fail);
        file.on("error", fail);
        res.pipe(file);
        file.on("finish", () => {
          if (failed) return;
          file.close((err) => (err ? reject(err) : resolve()));
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("下载超时")));
    req.on("error", reject);
  });
}

module.exports = { detect, install, WINGET_PACKAGE, darwinAssetName };
