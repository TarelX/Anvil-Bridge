const assert = require("node:assert");
const { darwinAssetName } = require("../src/cloudflared");

assert.strictEqual(darwinAssetName("arm64"), "cloudflared-darwin-arm64.tgz");
assert.strictEqual(darwinAssetName("x64"), "cloudflared-darwin-amd64.tgz");
assert.strictEqual(darwinAssetName("ia32"), "cloudflared-darwin-amd64.tgz");
console.log("cloudflared ok");
