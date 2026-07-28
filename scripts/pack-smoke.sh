#!/usr/bin/env bash
# Packs the publishable tarball, installs it into a scratch project, and
# requires the installed `fusion-mcp` binary to answer an MCP `initialize`
# request over stdio. Guards against publishing a DOA binary (broken bin
# entry, missing dist files, bad shebang) that unit tests cannot see.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

cd "$repo_root"
pnpm pack --out "$workdir/package.tgz" >/dev/null

cd "$workdir"
printf '{"name":"pack-smoke","private":true}\n' > package.json
pnpm add ./package.tgz --silent >/dev/null

node - <<'EOF'
const { spawn } = require("node:child_process");

const child = spawn("./node_modules/.bin/fusion-mcp", ["--stdio"], {
  stdio: ["pipe", "pipe", "inherit"],
});

const request =
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "pack-smoke", version: "0.0.0" },
    },
  }) + "\n";

const timer = setTimeout(() => {
  console.error("pack-smoke: no initialize response within 15s");
  child.kill();
  process.exit(1);
}, 15_000);

let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk;
  if (output.includes('"serverInfo"')) {
    clearTimeout(timer);
    child.kill();
    console.log("pack-smoke: OK");
    process.exit(0);
  }
});

child.on("exit", (code) => {
  clearTimeout(timer);
  console.error(`pack-smoke: binary exited before responding (code ${code})`);
  process.exit(1);
});

child.stdin.write(request);
EOF
