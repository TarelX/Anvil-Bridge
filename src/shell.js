"use strict";
var fs = require("node:fs"),
  path = require("node:path"),
  HINTS = {
    pwsh: "PowerShell 7+ (pwsh): '&&' and '||' work; ';' separates statements; native exit code is in $LASTEXITCODE, cmdlet success in $?.",
    powershell:
      "Windows PowerShell 5.1: '&&' and '||' are NOT supported - separate statements with ';' and check $LASTEXITCODE (native) or $? (cmdlet). Quoting follows PowerShell rules, not cmd.exe.",
    bash: "bash: '&&', '||' and ';' work; exit code is in $?. No profile/rc files are loaded.",
    sh: "POSIX sh (/bin/sh): '&&', '||' and ';' work; exit code is in $?. Avoid bash-only syntax such as arrays, [[ ]] and process substitution.",
  };
function onPath(t) {
  for (let e of (process.env.PATH || "").split(path.delimiter)) {
    if (!e) continue;
    let r = path.join(e, t);
    try {
      if (fs.statSync(r).isFile()) return r;
    } catch {}
  }
  return null;
}
var pwshCache;
function hasPwsh() {
  return (
    pwshCache === void 0 && (pwshCache = (process.platform === "win32" && onPath("pwsh.exe")) || null),
    pwshCache
  );
}
function describeShell(t) {
  return { name: t, hint: HINTS[t] || HINTS.sh };
}
function shellFor(t, e = "auto") {
  if (process.platform === "win32") {
    let r = e === "powershell" ? null : hasPwsh(),
      n = r || e === "pwsh" ? "pwsh" : "powershell",
      o =
        r ||
        (e === "pwsh"
          ? "pwsh.exe"
          : (process.env.SystemRoot || "C:\\Windows") +
            "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"),
      s =
        t === "pty"
          ? ["-NoLogo", "-NoProfile", "-NoExit"]
          : ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"];
    return { ...describeShell(n), path: o, args: s };
  }
  return t === "pty"
    ? { ...describeShell("bash"), path: "/bin/bash", args: ["--noprofile", "--norc", "-i"] }
    : { ...describeShell("sh"), path: "/bin/sh", args: ["-c"] };
}
function shellSummary(t = "auto") {
  let e = shellFor("pty", t),
    r = shellFor("direct", t);
  return e.name === r.name
    ? `Shell on this host: ${e.name} (${e.path}). ${e.hint}`
    : `Shells on this host: pty=${e.name}, direct=${r.name}. ${e.hint} ${r.hint}`;
}
module.exports = { shellFor, describeShell, shellSummary, HINTS };
