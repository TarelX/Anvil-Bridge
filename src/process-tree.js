"use strict";
var { spawn, execFile } = require("node:child_process"),
  sleep = (t) => new Promise((e) => setTimeout(e, t));
function tryKill(t, e) {
  try {
    return (process.kill(t, e), !0);
  } catch {
    return !1;
  }
}
async function descendants(t) {
  if (process.platform === "win32") return [];
  let r = (
      await new Promise((s) =>
        execFile("/bin/ps", ["-eo", "pid=,ppid="], { timeout: 1500, maxBuffer: 2 * 1024 * 1024 }, (i, a) =>
          s(i ? "" : a),
        ),
      )
    )
      .split(
        `
`,
      )
      .map((s) => s.trim().split(/\s+/).map(Number))
      .filter((s) => s.length === 2 && s.every(Number.isSafeInteger)),
    n = [],
    o = new Set([t]);
  for (let s = 0; s < 32; s++) {
    let i = !1;
    for (let [a, c] of r) a > 1 && o.has(c) && !o.has(a) && (o.add(a), n.push(a), (i = !0));
    if (!i) break;
  }
  return n.reverse();
}
async function terminateTree(t, e = () => {}) {
  if (!Number.isSafeInteger(t) || t <= 1) {
    e();
    return;
  }
  if (process.platform === "win32")
    await new Promise((r) => {
      let n = spawn(
          (process.env.SystemRoot || "C:\\Windows") + "\\System32\\taskkill.exe",
          ["/PID", String(t), "/T", "/F"],
          { windowsHide: !0, stdio: "ignore" },
        ),
        o = !1,
        s = () => {
          o || ((o = !0), clearTimeout(i), r());
        },
        i = setTimeout(() => {
          (n.kill(), e(), s());
        }, 4e3);
      (n.on("error", () => {
        (e(), s());
      }),
        n.on("close", (a) => {
          (a !== 0 && e(), s());
        }));
    });
  else {
    let r = await descendants(t);
    for (let n of r) tryKill(n, "SIGTERM");
    (tryKill(-t, "SIGTERM"), tryKill(t, "SIGTERM"), await sleep(1200));
    for (let n of r) tryKill(n, "SIGKILL");
    (tryKill(-t, "SIGKILL"), tryKill(t, "SIGKILL"), e());
  }
}
module.exports = { terminateTree };
