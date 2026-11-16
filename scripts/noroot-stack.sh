#!/usr/bin/env bash
#
# PDF Tools — rootless local stack (no Docker, no sudo).
#
# Runs PostgreSQL 16 + Redis 7 + the Bun API + worker pool(s) + the Vite web app
# as the current user, so this checkout can be run on a machine whose Docker
# socket is not reachable without root — the same reason Auth-Platform ships
# `scripts/noroot-stack.sh`. Where Docker *is* available, prefer
# `docker compose up -d` (README §Quick start) or `node scripts/run-local.mjs`
# with native datastores; this script is the "nothing global is installed" path.
#
# Usage: scripts/noroot-stack.sh {up|down|status|logs|check|engines|env}
#
#   up       datastores → deps → migrations → API → workers → web (idempotent)
#   engines  provision the light pool's engines under $SHARE/engines by
#            extracting Ubuntu .debs (no root): qpdf, mutool, magick — plus the
#            Python bridge (pikepdf, pymupdf) in a venv under $SHARE/py
#   check    ports, binaries, engines, ports-in-use — starts nothing
#   down     stop everything this script started
#   status   what is up, plus API health
#   logs     tail the stack logs
#   env      print exports for tools that run *outside* the stack — the E2E
#            readers and the fixture scripts — so they use these engines too:
#              eval "$(scripts/noroot-stack.sh env)"
#            then `bun run e2e:merge` inspects documents locally instead of
#            through `docker compose exec worker-light`.
#
# Layout (all under $HOME, nothing global is touched):
#   ~/.local/lib/bun/bun                     Bun (runtime; see .bun-version)
#   ~/.local/lib/pg16                        portable PostgreSQL 16 (shared
#                                            binaries; each project keeps its
#                                            own cluster + port)
#   ~/.local/lib/redis/redis-7.2.5/src/      Redis built from source
#   ~/.local/share/pdf-tools/{pg,redis,run,jobs,staging,engines,py,*.log}
#
# Ports sit beside the sibling stacks on purpose: Auth Platform owns
# 5433/6379/5100/3000, Procurement 5434/6381/4000/5173 — PDF Tools keeps
# 5435/6382/8080/5180 exactly as docker-compose.yml and the docs say.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK_BUILT="${STACK_BUILT:-0}"
STACK_BUILT_DIR="${STACK_BUILT_DIR:-$ROOT/artifacts}"

SHARE="${PDFTOOLS_SHARE:-$HOME/.local/share/pdf-tools}"
PG_DATA="$SHARE/pg/data"
PG_SOCK="$SHARE/pg/sock"
PG_LOG="$SHARE/pg/postgres.log"
REDIS_DIR="$SHARE/redis"
REDIS_LOG="$SHARE/redis.log"
RUN_DIR="$SHARE/run"
JOBS_PATH="$SHARE/jobs"
STAGING_PATH="$SHARE/staging"
ENGINES_DIR="$SHARE/engines"
ENGINE_CACHE="$SHARE/deb-cache"
ENGINES_ENV="$ENGINES_DIR/engines.env"
# The Python bridge (pikepdf/PyMuPDF) the `compress` and `extract-fields`
# handlers reach through `ENGINE_PYTHON_PATH`; see provision_python.
PY_DIR="$SHARE/py"
PY_VENV="$PY_DIR/venv"

# `up` prints where each log lives; keep them in one place.
API_LOG="$SHARE/api.log"
WEB_LOG="$SHARE/web.log"

PG_PORT="${PG_PORT:-5435}"
REDIS_PORT="${REDIS_PORT:-6382}"
API_PORT="${API_PORT:-8080}"
WEB_PORT="${WEB_PORT:-5180}"

BUN="${BUN_BIN:-}"
if [ -z "$BUN" ]; then
  if [ -x "$HOME/.local/lib/bun/bun" ]; then BUN="$HOME/.local/lib/bun/bun"
  elif command -v bun >/dev/null 2>&1; then BUN="$(command -v bun)"
  else BUN=""
  fi
fi

PG_BIN="${PG_BIN:-$HOME/.local/lib/pg16/bin}"
PG_LIB="${PG_LIB:-$HOME/.local/lib/pg16/lib}"

find_redis() {
  if [ -n "${REDIS_BIN:-}" ]; then printf '%s' "$REDIS_BIN"; return; fi
  local candidate
  candidate="$(ls -1d "$HOME"/.local/lib/redis/redis-*/src/redis-server 2>/dev/null | sort -V | tail -n1 || true)"
  if [ -n "$candidate" ]; then printf '%s' "$candidate"; return; fi
  command -v redis-server 2>/dev/null || true
}
REDIS_BIN="$(find_redis)"

# ── Pools ────────────────────────────────────────────────────────────────────
# One pool per queue, exactly as compose runs them. `light` is the default
# because it is the only pool the engines directory below can satisfy on a
# machine with no root; `--pools=light,office,ocr` adds the others when their
# engines are installed (`check` reports which are present).
POOLS_RAW=""
for arg in "$@"; do
  case "$arg" in
    --pools=*) POOLS_RAW="${arg#--pools=}" ;;
  esac
done
POOLS="${POOLS_RAW:-${WORKER_POOLS:-${WORKER_POOL:-light}}}"

listening() {
  local table
  # Capture first: `ss | grep -q` can make ss die with SIGPIPE, and with
  # `set -o pipefail` that turns a real listener into a random false negative.
  table="$(ss -ltn 2>/dev/null || true)"
  grep -q ":$1 " <<< "$table"
}

require_built_artifacts() {
  [ "$STACK_BUILT" = "1" ] || return 0
  if [ ! -f "$ROOT/apps/web/dist/index.html" ]; then
    echo "[stack] missing built web app: $ROOT/apps/web/dist/index.html" >&2
    echo "[stack] run scripts/build-local.sh first." >&2
    exit 1
  fi
}

# Kill $1 and every descendant, children first: `bun run` keeps the real server
# as a grandchild, so a plain kill leaves a process holding the port.
kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

kill_pidfile() {
  local file="$1" pid
  [ -f "$file" ] || return 0
  pid="$(tr -dc '0-9' < "$file" 2>/dev/null || true)"
  [ -n "$pid" ] || { rm -f "$file"; return 0; }
  kill_tree "$pid"
  rm -f "$file"
  return 0
}

wait_for_port() {
  local port="$1" seconds="${2:-60}" i
  for i in $(seq 1 "$seconds"); do
    listening "$port" && return 0
    sleep 1
  done
  return 1
}

http_code() { # $1 = URL
  command -v curl >/dev/null 2>&1 || return 1
  curl -s -m 5 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null
}

require_bun() {
  if [ -z "$BUN" ] || [ ! -x "$BUN" ]; then
    cat >&2 <<'NOBUN'
[stack] Bun is not installed. PDF Tools runs on Bun (`bun install`, `bun run`).
        Install it without root, e.g.:
          mkdir -p ~/.local/lib/bun && cd /tmp \
            && curl -fsSL -o bun.zip https://github.com/oven-sh/bun/releases/download/bun-v1.3.5/bun-linux-x64.zip \
            && unzip -o bun.zip -d /tmp/bunx \
            && install -m 0755 /tmp/bunx/bun-linux-x64/bun ~/.local/lib/bun/bun
        (version from .bun-version). Then re-run this script.
NOBUN
    exit 1
  fi
}

# ── Engines ──────────────────────────────────────────────────────────────────
# The engines are native binaries, and the light pool needs four of them:
# qpdf, mutool, magick, pdfinfo. Poppler (`pdfinfo`, `pdftoppm`, `pdftotext`) is
# already a host package here; `engines` provisions the other three by
# downloading .deb files and unpacking them under $SHARE/engines — apt lets a
# normal user `apt-get download`, and extracting a .deb needs no root either.
# Heavier pools (office/heavy/ocr) stay the operator's job: see docs/0-CONFIG.md.
ENGINE_PACKAGES=(qpdf mupdf-tools libgumbo2 libmujs3 imagemagick-6.q16 imagemagick-6-common)

# The Python packages the light pool's handlers import: `compress` reads a
# document's signature and form state before its first pass, and `extract-fields`
# reads the form. The worker image gets them from apt's `python3-pip`
# (`infra/docker/Dockerfile.workers`); see provision_python for the rootless half.
PY_PACKAGES=(pikepdf pymupdf)

# Load the provisioned engine paths (`engines.env`) when they exist. Called by
# `up`, `check` and `engines` itself so all three answer "is this engine here?"
# with the same PATH.
load_engines_env() {
  if [ -f "$ENGINES_ENV" ]; then
    # shellcheck disable=SC1090
    . "$ENGINES_ENV"
  fi
}

fetch_and_extract() {
  local pkg="$1"
  ( cd "$ENGINE_CACHE" && apt-get download "$pkg" >/dev/null 2>&1 ) || return 1
  local deb
  deb="$(ls -1t "$ENGINE_CACHE/${pkg}"_*.deb 2>/dev/null | head -n1 || true)"
  [ -n "$deb" ] || return 1
  dpkg-deb -x "$deb" "$ENGINES_DIR/pkg/$pkg" 2>/dev/null || return 1
  # Binaries and libraries are collected into one bin/ + lib/ so a single PATH
  # and LD_LIBRARY_PATH entry is all a worker needs.
  mkdir -p "$ENGINES_DIR/bin" "$ENGINES_DIR/lib"
  if [ -d "$ENGINES_DIR/pkg/$pkg/usr/bin" ]; then
    find "$ENGINES_DIR/pkg/$pkg/usr/bin" -maxdepth 1 -type f -exec cp -f {} "$ENGINES_DIR/bin/" \;
  fi
  if [ -d "$ENGINES_DIR/pkg/$pkg/usr/lib/x86_64-linux-gnu" ]; then
    find "$ENGINES_DIR/pkg/$pkg/usr/lib/x86_64-linux-gnu" -maxdepth 1 \( -type f -o -type l \) \
      -exec cp -af {} "$ENGINES_DIR/lib/" \;
  fi
  return 0
}

# Install the Python bridge into a venv under $SHARE and point the engines at it.
#
# A venv rather than `pip install --user`, which is the shorter command and does
# not work here: the engine spawn sets `HOME` and `TMPDIR` inside the job
# directory (`packages/engines/src/run.ts`) so an engine cannot leave files the
# sweeper never sees, and Python's user site is derived from `HOME` — so
# everything in `~/.local/lib/python3.12/site-packages` becomes invisible to the
# child. A venv is found by its own `pyvenv.cfg`, wherever `$HOME` points.
#
# `--without-pip` because Ubuntu's python3 ships no `ensurepip`, and then pip is
# bootstrapped from PyPA's installer, which is the one path that needs no root.
provision_python() {
  command -v python3 >/dev/null 2>&1 || { echo "[stack] python3 not found — the Python bridge needs it." >&2; return 1; }
  mkdir -p "$PY_DIR"
  if [ ! -x "$PY_VENV/bin/python" ]; then
    echo "[stack] creating venv $PY_VENV ..."
    python3 -m venv "$PY_VENV" --without-pip
  fi
  if [ ! -x "$PY_VENV/bin/pip" ]; then
    local get_pip="$PY_DIR/get-pip.py"
    [ -f "$get_pip" ] || curl -fsSL -o "$get_pip" https://bootstrap.pypa.io/get-pip.py
    "$PY_VENV/bin/python" "$get_pip" >/dev/null
  fi
  if ! "$PY_VENV/bin/python" -c 'import pikepdf, pymupdf' >/dev/null 2>&1; then
    echo "[stack] pip install ${PY_PACKAGES[*]} (into $PY_VENV) ..."
    "$PY_VENV/bin/python" -m pip install --quiet --disable-pip-version-check "${PY_PACKAGES[@]}" || {
      echo "[stack] WARN: could not install the Python bridge; compress/extract-fields will fail." >&2
      return 1
    }
  fi
  return 0
}

# Whether the venv can import both packages, as a one-line answer for `check`.
python_bridge_report() {
  if [ ! -x "$PY_VENV/bin/python" ]; then printf '%s' 'missing (run: scripts/noroot-stack.sh engines)'; return; fi
  if "$PY_VENV/bin/python" -c 'import pikepdf, pymupdf' >/dev/null 2>&1; then
    printf '%s' "$PY_VENV/bin/python ($("$PY_VENV/bin/python" -c 'import pikepdf, pymupdf; print("pikepdf " + pikepdf.__version__ + ", pymupdf " + pymupdf.__version__)' 2>/dev/null))"
    return
  fi
  printf '%s' "$PY_VENV/bin/python — pikepdf/pymupdf missing (run: scripts/noroot-stack.sh engines)"
}

provision_engines() {
  provision_python || true
  command -v apt-get >/dev/null 2>&1 || { echo "[stack] apt-get not available — install qpdf/mutool/magick by hand." >&2; exit 1; }
  command -v dpkg-deb >/dev/null 2>&1 || { echo "[stack] dpkg-deb not available — cannot unpack .debs." >&2; exit 1; }
  mkdir -p "$ENGINE_CACHE" "$ENGINES_DIR/bin" "$ENGINES_DIR/lib"
  local pkg ok=0
  for pkg in "${ENGINE_PACKAGES[@]}"; do
    if fetch_and_extract "$pkg"; then
      echo "[stack] engine package $pkg → $ENGINES_DIR/pkg/$pkg"
      ok=$((ok + 1))
    else
      echo "[stack] WARN: could not fetch/unpack $pkg" >&2
    fi
  done

  # ImageMagick 6 ships `convert-im6.q16`; the engine contract calls `magick`
  # (ImageMagick 7's single entry point). A shim keeps the engine name honest:
  # if a job uses a flag only IM7 knows, it fails as that job — it does not
  # silently run the wrong tool.
  if [ -x "$ENGINES_DIR/bin/convert-im6.q16" ] && [ ! -e "$ENGINES_DIR/bin/magick" ]; then
    cat > "$ENGINES_DIR/bin/magick" <<'SHIM'
#!/bin/sh
# ImageMagick 6 under the `magick` name the engine registry asks for.
exec "$(dirname "$0")/convert-im6.q16" "$@"
SHIM
    chmod 0755 "$ENGINES_DIR/bin/magick"
  fi

  # `if` rather than the shorter `[ -x ... ] && export ...`: this file is *sourced* by
  # `up`/`check`/`status`, all of which run under `set -e`, and a standalone `&&`
  # whose test fails is a command that exits 1 — so a stack whose engines were never
  # provisioned would die while loading its own engine paths instead of reporting
  # them as missing.
  cat > "$ENGINES_ENV" <<ENV
# Generated by scripts/noroot-stack.sh engines — sourced by \`up\`.
export PATH="$ENGINES_DIR/bin:\$PATH"
export LD_LIBRARY_PATH="$ENGINES_DIR/lib\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"
if [ -x "$ENGINES_DIR/bin/qpdf" ]; then export ENGINE_QPDF_PATH="$ENGINES_DIR/bin/qpdf"; fi
if [ -x "$ENGINES_DIR/bin/mutool" ]; then export ENGINE_MUTOOL_PATH="$ENGINES_DIR/bin/mutool"; fi
if [ -x "$ENGINES_DIR/bin/magick" ]; then export ENGINE_MAGICK_PATH="$ENGINES_DIR/bin/magick"; fi
if [ -x "$PY_VENV/bin/python" ]; then export ENGINE_PYTHON_PATH="$PY_VENV/bin/python"; fi
ENV

  echo "[stack] wrote $ENGINES_ENV ($ok/${#ENGINE_PACKAGES[@]} packages)"
  load_engines_env
  echo "[stack] python bridge: $(python_bridge_report)"
  echo "[stack] now: $(engine_report | tr '\n' ' ')"
}

# Presence of each engine the light pool expects, using the same names the API
# resolves (`ENGINE_*_PATH`, else PATH).
engine_report() {
  local qpdf mutool magick gs soffice pdfinfo tesseract ocrmypdf verapdf found=()
  qpdf="${ENGINE_QPDF_PATH:-$(command -v qpdf 2>/dev/null || true)}"
  mutool="${ENGINE_MUTOOL_PATH:-$(command -v mutool 2>/dev/null || true)}"
  magick="${ENGINE_MAGICK_PATH:-$(command -v magick 2>/dev/null || true)}"
  gs="$(command -v gs 2>/dev/null || true)"
  soffice="$(command -v soffice 2>/dev/null || true)"
  pdfinfo="$(command -v pdfinfo 2>/dev/null || true)"
  tesseract="$(command -v tesseract 2>/dev/null || true)"
  ocrmypdf="$(command -v ocrmypdf 2>/dev/null || true)"
  verapdf="${ENGINE_VERAPDF_PATH:-$(command -v verapdf 2>/dev/null || true)}"
  for pair in "qpdf:$qpdf" "mutool:$mutool" "magick:$magick" "gs:$gs" "soffice:$soffice" \
              "pdfinfo:$pdfinfo" "tesseract:$tesseract" "ocrmypdf:$ocrmypdf" "verapdf:$verapdf"; do
    local name="${pair%%:*}" path="${pair#*:}"
    if [ -n "$path" ]; then found+=("$name=$path"); else found+=("$name=(missing)"); fi
  done
  # Not a binary, but the same kind of prerequisite: the interpreter the two
  # Python-backed handlers are spawned with.
  found+=("python=${ENGINE_PYTHON_PATH:-$(command -v python3 2>/dev/null || echo '(missing)')}")
  printf '%s\n' "${found[@]}"
}

# ── Datastores ───────────────────────────────────────────────────────────────

# Run SQL against a *stopped* cluster with no client binary. The portable
# PostgreSQL build ships initdb/pg_ctl/postgres and no `psql`, so `--single` is
# the only way to create the role's password and the database itself. It prints
# `ERROR:` for a failed statement and still exits 0, so the log is what decides
# — and a failed bootstrap deletes the half-initialised cluster, because a
# cluster that exists without its database would be silently skipped next run.
bootstrap_sql() { # $1 = database; SQL on stdin
  local db="$1" log="$SHARE/pg/bootstrap.log"
  mkdir -p "$(dirname "$log")"
  LD_LIBRARY_PATH="$PG_LIB" "$PG_BIN/postgres" --single -D "$PG_DATA" "$db" > "$log" 2>&1 || true
  if grep -q "^ERROR" "$log"; then
    echo "[stack] bootstrap SQL for '$db' failed:" >&2
    grep "^ERROR" "$log" >&2 || true
    rm -rf "$PG_DATA"
    echo "[stack] removed the half-initialised cluster at $PG_DATA — re-run 'up' to retry." >&2
    return 1
  fi
  return 0
}

start_postgres() {
  if listening "$PG_PORT"; then
    echo "[stack] postgres already listening on :$PG_PORT"
    return 0
  fi
  if [ ! -x "$PG_BIN/pg_ctl" ]; then
    echo "[stack] PostgreSQL binaries not found at $PG_BIN (set PG_BIN=/path/to/bin)." >&2
    return 1
  fi
  mkdir -p "$SHARE" "$PG_SOCK" "$RUN_DIR"

  if [ ! -d "$PG_DATA/base" ]; then
    echo "[stack] initialising PostgreSQL cluster in $PG_DATA ..."
    LD_LIBRARY_PATH="$PG_LIB" "$PG_BIN/initdb" -D "$PG_DATA" -U pdftools \
      --auth-local=trust --auth-host=scram-sha-256 --encoding=UTF8 >/dev/null
    # `infra/postgres/init.sql` carries the same two settings for the container
    # path. They live in postgresql.conf here because `autovacuum_*` is a
    # SIGHUP parameter: `ALTER DATABASE ... SET` refuses it.
    cat >> "$PG_DATA/postgresql.conf" <<'CONF'

# Added by scripts/noroot-stack.sh (mirrors docker-compose.yml + infra/postgres/init.sql).
autovacuum_vacuum_scale_factor = 0.05
CONF
    # `postgres --single` needs the server *stopped*, so the bootstrap happens
    # before it is started: the role gets the password the app's DATABASE_URL
    # carries, then the database and the extension `infra/postgres/init.sql`
    # creates in the image are created here.
    bootstrap_sql postgres <<'SQL'
ALTER ROLE pdftools PASSWORD 'pdftools';
CREATE DATABASE pdftools OWNER pdftools;
SQL
    bootstrap_sql pdftools <<'SQL'
CREATE EXTENSION IF NOT EXISTS pg_trgm;
ALTER DATABASE pdftools SET timezone TO 'UTC';
SQL
  fi
  LD_LIBRARY_PATH="$PG_LIB" "$PG_BIN/pg_ctl" -D "$PG_DATA" -l "$PG_LOG" \
    -o "-p $PG_PORT -k $PG_SOCK -c listen_addresses=127.0.0.1" start >/dev/null
  wait_for_port "$PG_PORT" 30 || { echo "[stack] postgres did not start — see $PG_LOG" >&2; return 1; }
  echo "[stack] postgres listening on :$PG_PORT (data: $PG_DATA)"
}

stop_postgres() {
  [ -x "$PG_BIN/pg_ctl" ] || return 0
  [ -d "$PG_DATA" ] || return 0
  LD_LIBRARY_PATH="$PG_LIB" "$PG_BIN/pg_ctl" -D "$PG_DATA" -m fast stop >/dev/null 2>&1 || true
}

start_redis() {
  if listening "$REDIS_PORT"; then
    echo "[stack] redis already listening on :$REDIS_PORT"
    return 0
  fi
  if [ -z "$REDIS_BIN" ] || [ ! -x "$REDIS_BIN" ]; then
    echo "[stack] redis-server not found (set REDIS_BIN=/path/to/redis-server)." >&2
    return 1
  fi
  mkdir -p "$REDIS_DIR" "$RUN_DIR"
  # The repository's own redis.conf is the source of truth (AOF everysec, 512 MB
  # noeviction, slowlog, renamed FLUSH*/CONFIG). Only its container lines are
  # rewritten — `dir /data` does not exist here, and 0.0.0.0 with
  # `protected-mode no` should not listen on a developer's LAN. The copy is
  # written rather than passed as flags because Redis aborts while *parsing* the
  # file when `dir` is missing, so no command-line flag would ever be reached.
  local conf="$REDIS_DIR/redis.conf"
  sed -E \
    -e "s|^dir .*|dir $REDIS_DIR|" \
    -e "s|^port .*|port $REDIS_PORT|" \
    -e "s|^bind .*|bind 127.0.0.1|" \
    "$ROOT/infra/redis/redis.conf" > "$conf"
  setsid -f "$REDIS_BIN" "$conf" --daemonize no > "$REDIS_LOG" 2>&1 < /dev/null
  local i
  for i in $(seq 1 20); do
    if listening "$REDIS_PORT"; then break; fi
    sleep 1
  done
  if listening "$REDIS_PORT"; then
    local pid
    pid="$(pgrep -f "redis-server 127.0.0.1:$REDIS_PORT" 2>/dev/null | head -n1 || true)"
    if [ -n "$pid" ]; then echo "$pid" > "$RUN_DIR/redis.pid"; fi
  else
    echo "[stack] redis did not start — see $REDIS_LOG" >&2
    return 1
  fi
  echo "[stack] redis listening on :$REDIS_PORT (data: $REDIS_DIR)"
}

stop_redis() {
  local cli
  cli="$(dirname "${REDIS_BIN:-/nonexistent}")/redis-cli"
  [ -x "$cli" ] || cli="$(command -v redis-cli 2>/dev/null || true)"
  if [ -n "$cli" ]; then
    "$cli" -h 127.0.0.1 -p "$REDIS_PORT" shutdown nosave >/dev/null 2>&1 || true
  fi
  kill_pidfile "$RUN_DIR/redis.pid"
}

# ── App processes ────────────────────────────────────────────────────────────

stack_env() {
  export DATABASE_URL="${DATABASE_URL:-postgres://pdftools:pdftools@127.0.0.1:$PG_PORT/pdftools}"
  export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:$REDIS_PORT}"
  # `/var/lib/pdf-tools` is the container path; a rootless run keeps job files
  # under $HOME (same volume for TEMP_DIR and STAGING_DIR, as the contract asks).
  export TEMP_DIR="${TEMP_DIR:-$JOBS_PATH}"
  export STAGING_DIR="${STAGING_DIR:-$STAGING_PATH}"
  export CORS_ORIGINS="${CORS_ORIGINS:-http://localhost:$WEB_PORT}"
  export PUBLIC_API_URL="${PUBLIC_API_URL:-http://localhost:$API_PORT}"
  # Development profile: the golden/property/browser harnesses all start from an
  # anonymous session, and the shipped default is tenant-first (`0-TENANT-FIRST`
  # §3.2). A stack with neither an anonymous allowance nor a reachable platform
  # refuses to boot — so this is stated rather than inherited.
  export ALLOW_ANONYMOUS="${ALLOW_ANONYMOUS:-true}"
  # Auth Platform integration. The browser-facing URL is the web app (:3000);
  # the *internal* URL must be the API (:5100) — `/sso/exchange` and `/auth/me`
  # are API routes and are not proxied by the web server (docs CROSS-MODULE §5).
  export AUTH_PLATFORM_URL="${AUTH_PLATFORM_URL:-http://localhost:3000}"
  export AUTH_PLATFORM_INTERNAL_URL="${AUTH_PLATFORM_INTERNAL_URL:-http://localhost:5100}"
  export API_PORT API_HOST="${API_HOST:-127.0.0.1}"
  load_engines_env
  export PATH="$(dirname "$BUN"):$PATH"
}

ensure_deps() {
  if [ ! -d "$ROOT/node_modules" ]; then
    echo "[stack] bun install ..."
    ( cd "$ROOT" && "$BUN" install )
  fi
}

run_migrations() {
  echo "[stack] db:migrate ..."
  ( cd "$ROOT" && "$BUN" run db:migrate )
}

start_api() {
  if listening "$API_PORT"; then
    echo "[stack] API already listening on :$API_PORT"
    return 0
  fi
  mkdir -p "$RUN_DIR" "$JOBS_PATH" "$STAGING_PATH"
  local api_cmd="'$BUN' run --hot src/server.ts"
  if [ "$STACK_BUILT" = "1" ]; then
    api_cmd="'$BUN' run src/server.ts"
  fi
  ( cd "$ROOT/apps/api" && \
    setsid -f sh -c "echo \$\$ > '$RUN_DIR/api.pid'; exec $api_cmd" \
      > "$API_LOG" 2>&1 < /dev/null )
  wait_for_port "$API_PORT" 90 || {
    echo "[stack] API did not open :$API_PORT — last log lines:" >&2
    tail -n 20 "$API_LOG" >&2 || true
    return 1
  }
  echo "[stack] API listening on :$API_PORT (log: $API_LOG)"
}

start_workers() {
  local pool
  for pool in ${POOLS//,/ }; do
    [ -n "$pool" ] || continue
    if [ -f "$RUN_DIR/worker-$pool.pid" ] && kill -0 "$(cat "$RUN_DIR/worker-$pool.pid" 2>/dev/null)" 2>/dev/null; then
      echo "[stack] worker '$pool' already running"
      continue
    fi
    local log="$SHARE/worker-$pool.log"
    local worker_cmd="'$BUN' run --hot src/index.ts"
    if [ "$STACK_BUILT" = "1" ]; then
      worker_cmd="'$BUN' run src/index.ts"
    fi
    ( cd "$ROOT/workers/$pool" && \
      WORKER_POOL="$pool" setsid -f sh -c "echo \$\$ > '$RUN_DIR/worker-$pool.pid'; exec $worker_cmd" \
        > "$log" 2>&1 < /dev/null )
    echo "[stack] worker '$pool' started (log: $log)"
  done
}

start_web() {
  if listening "$WEB_PORT"; then
    echo "[stack] web already listening on :$WEB_PORT"
    return 0
  fi
  mkdir -p "$RUN_DIR"
  # Two launch paths for the same dev server. `bun run dev` is the repository's
  # script, but it resolves the `vite` bin through node_modules/.bin — and this
  # checkout's .bin holds Windows shims only (`vite.exe`/`vite.bunx`), which is a
  # re-install to fix and a hard failure for anyone running the stack as-is.
  # Vite's own entry point gives an identical server, so it is used in that case.
  # `VITE_API_PROXY` keeps the config's `/api` proxy pointed at this stack's API
  # when the port is overridden.
  local cmd
  if [ "$STACK_BUILT" = "1" ]; then
    cmd="'$BUN' run node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port $WEB_PORT"
  elif [ -x "$ROOT/apps/web/node_modules/.bin/vite" ]; then
    cmd="'$BUN' run dev"
  else
    cmd="'$BUN' run node_modules/vite/bin/vite.js --host 127.0.0.1 --port $WEB_PORT"
  fi
  ( cd "$ROOT/apps/web" && \
    VITE_API_PROXY="http://127.0.0.1:$API_PORT" \
    setsid -f sh -c "echo \$\$ > '$RUN_DIR/web.pid'; exec $cmd" \
      > "$WEB_LOG" 2>&1 < /dev/null )
  wait_for_port "$WEB_PORT" 90 || {
    echo "[stack] web did not open :$WEB_PORT — last log lines:" >&2
    tail -n 20 "$WEB_LOG" >&2 || true
    return 1
  }
  echo "[stack] web listening on :$WEB_PORT (log: $WEB_LOG)"
}

stop_workers() {
  local file
  for file in "$RUN_DIR"/worker-*.pid; do
    [ -e "$file" ] || continue
    kill_pidfile "$file"
  done
}

# ── Commands ─────────────────────────────────────────────────────────────────

cmd_up() {
  require_bun
  [ "$STACK_BUILT" = "1" ] && require_built_artifacts
  stack_env
  [ -f "$ENGINES_ENV" ] || echo "[stack] note: no $ENGINES_ENV yet — run 'scripts/noroot-stack.sh engines' to provision qpdf/mutool/magick."
  # `compress` fails every job without the Python bridge (it reads a document's
  # signature and form state before its first pass), so say so before the user
  # meets it as a job error.
  if [ -z "${ENGINE_PYTHON_PATH:-}" ]; then
    echo "[stack] note: no Python bridge — run 'scripts/noroot-stack.sh engines' (compress/extract-fields need pikepdf+pymupdf)."
  fi
  # The heavy pool's boot check expects veraPDF while `PDFA_VALIDATE` is on, and the worker exits immediately when an
  # engine it expects is missing. Say which switch turns that off, rather than letting the log read as a broken pool.
  if [[ ",$POOLS," == *",heavy,"* ]] && [ -z "${ENGINE_VERAPDF_PATH:-}" ] && ! command -v verapdf >/dev/null 2>&1; then
    if [ "${PDFA_VALIDATE:-true}" != "false" ]; then
      echo "[stack] note: the heavy pool expects verapdf while PDFA_VALIDATE is on (the default);"
      echo "        it is a JRE tool this script cannot provision. Run with PDFA_VALIDATE=false to skip validation,"
      echo "        or put verapdf on PATH / set ENGINE_VERAPDF_PATH."
    fi
  fi
  start_postgres
  start_redis
  ensure_deps
  run_migrations
  start_api
  start_workers
  start_web

  local health
  health="$(http_code "http://localhost:$API_PORT/health/live" || true)"
  echo "[stack] api health GET /health/live -> ${health:-no response}"
  echo "[stack] web: http://localhost:$WEB_PORT   api: http://localhost:$API_PORT   pools: [$POOLS]"
  echo "[stack] engines: $(engine_report | tr '\n' ' ')"
  echo "[stack] logs: tail -f $API_LOG $WEB_LOG $SHARE/worker-*.log $PG_LOG $REDIS_LOG"
}

cmd_down() {
  kill_pidfile "$RUN_DIR/web.pid"
  kill_pidfile "$RUN_DIR/api.pid"
  stop_workers
  stop_redis
  stop_postgres
  echo "[stack] stopped."
}

cmd_status() {
  # The engine report reads the provisioned paths (`ENGINE_*_PATH`), which live in
  # `engines.env`; without this the answer is what the *current shell* can see,
  # not what `up` gives the workers — so qpdf/mutool/magick would read as missing
  # on a stack that is running them.
  load_engines_env
  local p
  for p in "$PG_PORT" "$REDIS_PORT" "$API_PORT" "$WEB_PORT"; do
    if listening "$p"; then echo "  :$p  UP"; else echo "  :$p  down"; fi
  done
  if listening "$API_PORT"; then
    echo "  api health GET /health/live -> $(http_code "http://localhost:$API_PORT/health/live" || echo 'no response')"
  fi
  if listening "$WEB_PORT"; then
    echo "  web GET / -> $(http_code "http://localhost:$WEB_PORT/" || echo 'no response')"
  fi
  echo "  engines:"
  engine_report | sed 's/^/    /'
}

cmd_check() {
  load_engines_env
  echo "[stack] bun: ${BUN:-not found}"
  if [ -n "$BUN" ] && "$BUN" --version >/dev/null 2>&1; then
    echo "[stack]   version $("$BUN" --version) (repo pins $(cat "$ROOT/.bun-version" 2>/dev/null || echo '?'))"
  fi
  echo "[stack] postgres binaries: $PG_BIN $( [ -x "$PG_BIN/pg_ctl" ] && echo present || echo MISSING )"
  echo "[stack] redis binary: ${REDIS_BIN:-MISSING}"
  echo "[stack] ports:"
  local p
  for p in "$PG_PORT" "$REDIS_PORT" "$API_PORT" "$WEB_PORT"; do
    if listening "$p"; then echo "    :$p  in use"; else echo "    :$p  free"; fi
  done
  echo "[stack] engines:"
  engine_report | sed 's/^/    /'
  echo "[stack] python bridge: $(python_bridge_report)"
  echo "[stack] pools requested: [$POOLS]"
  echo "[stack] expected per pool: $(POOL_ENGINES_hint)"
}

POOL_ENGINES_hint() {
  # `verapdf` is on the heavy line because the heavy worker's boot check expects it while `PDFA_VALIDATE` is on (its
  # default): the validator is what `pdf-to-pdfa` reports conformance with, and the check exists so a deployment that
  # asks for validation fails at startup rather than at the first archival job. A pool that cannot have it runs with
  # `PDFA_VALIDATE=false`, exactly like the container image built without veraPDF (`packages/config/src/env.ts`).
  echo "light=[qpdf,mutool,magick,pdfinfo] office=[soffice] heavy=[gs,mutool,pdftohtml,pdffonts,pdfimages$(command -v verapdf >/dev/null 2>&1 || [ -n "${ENGINE_VERAPDF_PATH:-}" ] || printf ',verapdf while PDFA_VALIDATE is on')] ocr=[tesseract,ocrmypdf]"
}

cmd_logs() {
  tail -n 40 "$API_LOG" "$WEB_LOG" "$SHARE"/worker-*.log "$PG_LOG" "$REDIS_LOG" 2>/dev/null
}

# The environment a *sibling* process needs to use the same engines as the
# stack. `up` gives the API and the workers these paths; the test harnesses are
# a separate process started from the user's own shell, and without this they
# fall back to "no container was reachable" on a stack that is plainly up.
#
# Printed rather than applied, so a caller opts in with `eval`.
cmd_env() {
  load_engines_env
  echo "# PDF Tools — engines for tools run outside the stack (eval this output)."
  echo "# From: $ENGINES_ENV"
  printf 'export PATH=%q\n' "$PY_VENV/bin:$ENGINES_DIR/bin:$PATH"
  printf 'export LD_LIBRARY_PATH=%q\n' "${LD_LIBRARY_PATH:-$ENGINES_DIR/lib}"
  local var
  for var in ENGINE_QPDF_PATH ENGINE_MUTOOL_PATH ENGINE_MAGICK_PATH ENGINE_PYTHON_PATH; do
    [ -n "${!var:-}" ] && printf 'export %s=%q\n' "$var" "${!var}"
  done
  # Tells `e2e/lib/pdf-inspect.ts` to read documents with these binaries rather
  # than through `docker compose exec worker-light`, which this stack has no
  # Docker for. Set explicitly: a machine can have a Docker daemon running for
  # something else, and then the probe alone would pick the wrong transport.
  printf 'export PDFTOOLS_INSPECT_TRANSPORT=local\n'
}

case "${1:-up}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  check) cmd_check ;;
  env) cmd_env ;;
  engines)
    provision_engines
    ;;
  *)
    echo "usage: $0 {up|down|status|logs|check|engines|env} [--pools=light,office,heavy,ocr]" >&2
    exit 2
    ;;
esac
