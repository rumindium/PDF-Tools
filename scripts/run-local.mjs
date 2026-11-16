#!/usr/bin/env node
/**
 * PDF Tools — native runner (no Docker): API + worker pool(s) + web in one command.
 *
 * Usage:
 *   node scripts/run-local.mjs                  # api :8080 + light worker + web :5180
 *   node scripts/run-local.mjs --pools=light,office
 *   node scripts/run-local.mjs --api-only       # just the API
 *   node scripts/run-local.mjs --no-web         # skip vite dev server
 *   node scripts/run-local.mjs --check          # verify toolchain/ports/engines, run nothing
 *   node scripts/run-local.mjs --no-install     # skip 'bun install'
 *
 * Works on Windows / macOS / Linux. Needs Bun 1.3.5 (see .bun-version).
 * Datastores natively: PostgreSQL :5435, Redis :6382.
 * Engines are native binaries (qpdf, gs, mutool, soffice, magick, ocrmypdf,
 * tesseract, verapdf, python3): --check reports which are present per pool,
 * missing engines only fail the jobs that need them, not the boot.
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, def) => {
  const eq = args.find((a) => a.startsWith(name + "="));
  return eq ? eq.slice(name.length + 1) : def;
};
if (args.includes("--help") || args.includes("-h")) {
  console.log(`PDF Tools native runner (no Docker)

  node scripts/run-local.mjs [options]

Options:
  --pools=<list>  worker pools, comma-separated (default light)
                  light | office | heavy | ocr (repeat --pools or comma-join)
  --api-only      only the API on :8080
  --no-web        skip the vite dev server on :5180
  --no-install    skip 'bun install'
  --check         verify toolchain, ports and engines, then exit
  --help          this text

Needs: Bun 1.3.5, PostgreSQL :5435, Redis :6382.
URLs: API http://localhost:8080  Web http://localhost:5180`);
  process.exit(0);
}
const CHECK_ONLY = args.includes("--check");
const NO_INSTALL = args.includes("--no-install");
const API_ONLY = args.includes("--api-only");
const WANT_WEB = !API_ONLY && !args.includes("--no-web");
const POOLS = API_ONLY ? [] : [...new Set(
  (opt("--pools", process.env.WORKER_POOLS ?? process.env.WORKER_POOL ?? "light"))
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
)];

const log = (m) => console.log(`[run-local] ${m}`);
const warn = (m) => console.warn(`[run-local] WARN: ${m}`);

function checkBin(bin, verArgs, hint) {
  const r = spawnSync(bin, verArgs, { encoding: "utf8", shell: process.platform === "win32" });
  if (r.status !== 0) { warn(`'${bin}' not found on PATH (${hint})`); return null; }
  log(`${bin}: ${(r.stdout || r.stderr || "").split("\n")[0].trim()}`);
  return true;
}
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => { s.end(); resolve(false); });
    s.once("error", () => resolve(true));
  });
}
function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const t = () => {
      const s = net.connect(port, "127.0.0.1");
      s.once("connect", () => { s.end(); resolve(true); });
      s.once("error", () => (Date.now() > deadline ? resolve(false) : setTimeout(t, 1000)));
    };
    t();
  });
}

const POOL_ENGINES = {
  light: ["qpdf", "gs", "mutool", "magick"],
  office: ["soffice"],
  heavy: ["python3", "verapdf"],
  ocr: ["ocrmypdf", "tesseract"],
};

async function main() {
  const bun = checkBin("bun", ["--version"], "Bun 1.3.5 (https://bun.sh, see .bun-version)");
  if (!bun && !CHECK_ONLY) { console.error("[run-local] Bun missing."); process.exit(1); }

  let storesOk = true;
  for (const [port, name, hint] of [
    [5435, "PostgreSQL :5435", "winget install PostgreSQL.16 / brew install postgresql@16 / apt install postgresql"],
    [6382, "Redis :6382", "winget install Redis.Redis / brew install redis / apt install redis-server"],
  ]) {
    if (await portFree(port)) { warn(`${name} not reachable — ${hint}.`); storesOk = false; }
    else log(`${name} reachable.`);
  }
  for (const [p, n] of [[8080, "API"], [5180, "web"]]) {
    if (!(await portFree(p))) warn(`port ${p} (${n}) already in use.`);
  }

  // Engine presence per requested pool (informational — boot anyway)
  for (const pool of POOLS) {
    for (const eng of POOL_ENGINES[pool] ?? []) {
      const r = spawnSync(process.platform === "win32" ? "where" : "which", [eng],
        { encoding: "utf8", shell: process.platform === "win32" });
      if (r.status !== 0) warn(`engine '${eng}' (pool ${pool}) not on PATH — ${pool} jobs needing it will fail.`);
      else log(`engine ${eng} (pool ${pool}): ${r.stdout.split(/\r?\n/)[0].trim()}`);
    }
  }

  if (!existsSync(join(ROOT, ".env")) && existsSync(join(ROOT, ".env.example"))) {
    cpSync(join(ROOT, ".env.example"), join(ROOT, ".env"));
    log("created .env from .env.example (ALLOW_ANONYMOUS=true for local use).");
  }

  if (CHECK_ONLY) { log(storesOk ? "check OK." : "check done with warnings."); process.exit(storesOk ? 0 : 2); }
  if (!storesOk) { console.error("[run-local] start PostgreSQL/Redis first (see warnings)."); process.exit(1); }

  const shell = process.platform === "win32";
  if (!NO_INSTALL) {
    log("bun install ...");
    const r = spawnSync("bun", ["install"], { cwd: ROOT, stdio: "inherit", shell });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
  log("bun run db:migrate ...");
  const mg = spawnSync("bun", ["run", "db:migrate"], {
    cwd: ROOT, stdio: "inherit", shell,
    env: { ...process.env, ALLOW_ANONYMOUS: process.env.ALLOW_ANONYMOUS ?? "true" },
  });
  if (mg.status !== 0) process.exit(mg.status ?? 1);

  const children = [];
  const onExit = (c) => { for (const k of children) try { k.kill(); } catch {} process.exit(c ?? 0); };
  process.on("SIGINT", () => onExit(0));
  process.on("SIGTERM", () => onExit(0));
  const baseEnv = {
    ...process.env,
    ALLOW_ANONYMOUS: process.env.ALLOW_ANONYMOUS ?? "true",
    DATABASE_URL: process.env.DATABASE_URL ?? "postgres://pdftools:pdftools@localhost:5435/pdftools",
    REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6382",
  };

  log("starting API :8080 ...");
  children.push(spawn("bun", ["run", "--hot", "src/server.ts"], {
    cwd: join(ROOT, "apps", "api"), env: baseEnv, stdio: "inherit", shell,
  }));
  if (!(await waitForPort(8080, 120000))) warn("API :8080 not open yet — watch the bun output above.");

  for (const pool of POOLS) {
    log(`starting worker pool '${pool}' ...`);
    children.push(spawn("bun", ["run", "--hot", "src/index.ts"], {
      cwd: join(ROOT, "workers", pool),
      env: { ...baseEnv, WORKER_POOL: pool },
      stdio: "inherit", shell,
    }));
  }
  if (WANT_WEB) {
    log("starting web :5180 ...");
    children.push(spawn("bun", ["run", "dev"], {
      cwd: join(ROOT, "apps", "web"), env: baseEnv, stdio: "inherit", shell,
    }));
  }
  log(`up: API http://localhost:8080${WANT_WEB ? "  Web http://localhost:5180" : ""}  pools [${POOLS.join(",") || "none"}]  (Ctrl+C stops all)`);
  for (const c of children) c.on("exit", (code) => { if (code !== 0 && code !== null) onExit(code); });
}

main().catch((e) => { console.error("[run-local]", e?.message ?? e); process.exit(1); });
