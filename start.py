#!/usr/bin/env python3
"""
start.py - Launch script for H0 Checker Panel
Works on Termux (Android), Linux, macOS, and Windows.

Usage:
    python start.py              # Interactive menu: pick Production / Dev / Bot Mode
    python start.py --prod       # Build + run production
    python start.py --dev        # Run dev mode (skip install)
    python start.py --bot-mode   # Telegram bot only (lightweight)
    python start.py --install    # Install dependencies only
    python start.py --build      # Build only
    python start.py --reset-db   # Reset database
    python start.py --port 3000  # Custom port
    python start.py --help       # Show help
"""

import subprocess
import sys
import os
import shutil
import time
import signal
import platform
import argparse
import json

# ─── Constants ────────────────────────────────────────────────────────────────

SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
IS_TERMUX    = os.path.exists("/data/data/com.termux") or \
               os.environ.get("PREFIX", "").startswith("/data/data/com.termux")
IS_WINDOWS   = platform.system() == "Windows"
IS_MACOS     = platform.system() == "Darwin"
IS_LINUX     = platform.system() == "Linux"
DEFAULT_PORT = 5000
DB_NAME      = "h0checker"

PREFIX       = os.environ.get("PREFIX", "/data/data/com.termux/files/usr") if IS_TERMUX else ""
TERMUX_HOME  = os.environ.get("HOME",   "/data/data/com.termux/files/home") if IS_TERMUX else ""

if IS_TERMUX:
    PG_SOCKET_DIR = os.path.join(PREFIX, "var", "run", "postgresql")
    PG_DATA_DIR   = os.path.join(PREFIX, "var", "lib", "postgresql")
else:
    PG_SOCKET_DIR = "/tmp"
    PG_DATA_DIR   = os.path.join(SCRIPT_DIR, ".pgdata")

# WORK_DIR is where we actually run npm / node from.
# It starts as SCRIPT_DIR but is updated to ~/h0-panel when the project
# lives on Android shared storage (which forbids symlinks).
WORK_DIR = SCRIPT_DIR


# ─── Colors ───────────────────────────────────────────────────────────────────

class C:
    RESET   = "\033[0m"
    BOLD    = "\033[1m"
    RED     = "\033[91m"
    GREEN   = "\033[92m"
    YELLOW  = "\033[93m"
    CYAN    = "\033[96m"
    MAGENTA = "\033[95m"
    DIM     = "\033[2m"

def log(msg, color=C.CYAN):
    print(f"{color}{C.BOLD}[H0]{C.RESET} {msg}")

def log_step(msg):
    print(f"\n{C.MAGENTA}{C.BOLD}{'='*60}{C.RESET}")
    print(f"{C.MAGENTA}{C.BOLD}  {msg}{C.RESET}")
    print(f"{C.MAGENTA}{C.BOLD}{'='*60}{C.RESET}\n")

def log_ok(msg):   log(f"{C.GREEN}{msg}{C.RESET}")
def log_warn(msg): log(f"{C.YELLOW}{msg}{C.RESET}")
def log_err(msg):  log(f"{C.RED}{msg}{C.RESET}")
def log_dim(msg):  print(f"  {C.DIM}{msg}{C.RESET}")


# ─── Helpers ──────────────────────────────────────────────────────────────────

def run(cmd, check=True, capture=False, extra_env=None, cwd=None):
    """Run a shell command, inheriting full os.environ + optional extras."""
    merged_env = os.environ.copy()
    if extra_env:
        merged_env.update(extra_env)
    kwargs = dict(shell=True, cwd=cwd or WORK_DIR, env=merged_env)
    if capture:
        kwargs["stdout"] = subprocess.PIPE
        kwargs["stderr"] = subprocess.PIPE
        kwargs["text"]   = True
    result = subprocess.run(cmd, check=False, **kwargs)
    if check and result.returncode != 0:
        if capture:
            return result
        raise subprocess.CalledProcessError(result.returncode, cmd)
    return result

def cmd_exists(name):
    return shutil.which(name) is not None

def get_node_version():
    try:
        r = run("node --version", capture=True)
        if r.returncode == 0:
            return r.stdout.strip()
    except Exception:
        pass
    return None

def get_npm_cmd():
    for c in ("npm", "pnpm", "yarn"):
        if cmd_exists(c):
            return c
    return None

def get_npm_version():
    try:
        r = run("npm --version", capture=True)
        if r.returncode == 0:
            return r.stdout.strip()
    except Exception:
        pass
    return None

MIN_NPM_VERSION = "9"   # project needs npm 9+ for workspaces/lockfile v3

# ─── Critical runtime deps ────────────────────────────────────────────────────
# These MUST be present or the server will crash at import time.
CRITICAL_NPM_DEPS = [
    "user-agents",    # dynamic UA generation (server/ua-generator.ts)
    "express",        # web framework
    "vite",           # dev server
    "tsx",            # TypeScript runner
    "drizzle-orm",    # DB ORM
    "@tanstack/react-query",  # data fetching
    "cheerio",        # HTML parsing (server/form-parser.ts)
    "form-data",      # multipart forms (server/form-data.ts)
    "@faker-js/faker", # billing data (server/billing-generator.ts)
]

def _verify_user_agents_package():
    """Verify user-agents package is installed and working correctly."""
    ua_path = os.path.join(WORK_DIR, "node_modules", "user-agents")
    if not os.path.isdir(ua_path):
        return False
    
    # Check if the package has the expected structure
    pkg_json = os.path.join(ua_path, "package.json")
    if not os.path.exists(pkg_json):
        return False
    
    try:
        with open(pkg_json, "r", encoding="utf-8") as f:
            data = json.load(f)
        # Verify it's the correct package (intoli/user-agents)
        return data.get("name") == "user-agents"
    except (OSError, json.JSONDecodeError):
        return False

def _ensure_package_json_deps():
    """Ensure critical packages are listed in package.json deps."""
    pkg_json = os.path.join(WORK_DIR, "package.json")
    if not os.path.exists(pkg_json):
        return False
    try:
        with open(pkg_json, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return False
    deps = data.get("dependencies", {})
    changed = False
    for pkg in CRITICAL_NPM_DEPS:
        if pkg not in deps:
            # Use a recent compatible version
            versions = {
                "user-agents": "^1.1.0",
                "express": "^4.18.2",
                "vite": "^5.0.0",
                "tsx": "^4.7.0",
                "drizzle-orm": "^0.30.0",
                "@tanstack/react-query": "^5.0.0",
                "cheerio": "^1.0.0",
                "form-data": "^4.0.0",
                "@faker-js/faker": "^9.0.0",
            }
            deps[pkg] = versions.get(pkg, "^1.0.0")
            changed = True
    if changed:
        data["dependencies"] = deps
        try:
            with open(pkg_json, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
            log_ok("Updated package.json with critical dependencies")
            return True
        except OSError:
            pass
    return False

def _verify_npm_deps():
    """Verify all critical npm packages are installed. Auto-install if missing."""
    missing = []
    for pkg in CRITICAL_NPM_DEPS:
        pkg_path = os.path.join(WORK_DIR, "node_modules", pkg)
        if not os.path.isdir(pkg_path):
            missing.append(pkg)
    
    # Special verification for user-agents package
    if "user-agents" not in missing and not _verify_user_agents_package():
        log_warn("user-agents package is corrupted or incompatible — reinstalling...")
        missing.append("user-agents")
    
    if not missing:
        return True

    log_warn(f"Missing critical packages: {', '.join(missing)} — installing...")
    npm = get_npm_cmd()
    if not npm:
        log_err("npm not found")
        return False
    env = _npm_env()
    # Install only the missing ones
    for pkg in missing:
        log(f"Installing {pkg}...")
        r = run(f"{npm} install {pkg}@latest", capture=True, extra_env=_npm_env())
        if r.returncode != 0:
            log_warn(f"Failed to install {pkg}: {(r.stderr or '')[-200:]}")
            return False
    log_ok("All critical packages installed")
    return True

def verify_npm():
    """Ensure npm exists, works, and is recent enough for this project."""
    npm = get_npm_cmd()
    if not npm:
        return None

    ver = get_npm_version()
    if ver is None:
        # npm binary exists but `npm --version` fails — broken install
        log_warn("npm found but not responding — reinstalling ...")
        if IS_TERMUX:
            run("pkg install -y nodejs-lts", check=False)
            npm = get_npm_cmd()
            ver = get_npm_version()
        if ver is None:
            log_err("npm is broken — try: pkg reinstall nodejs-lts")
            return None

    # Version check (compare as integers: "10.2.3" → 10)
    try:
        major = int(ver.split(".")[0])
    except (ValueError, IndexError):
        major = 0

    if major < int(MIN_NPM_VERSION):
        log_warn(f"npm {ver} is too old (need >= {MIN_NPM_VERSION})")
        if IS_TERMUX:
            log("Upgrading nodejs-lts ...")
            run("pkg install -y nodejs-lts", check=False)
            ver = get_npm_version()
            npm = get_npm_cmd()
            log_ok(f"npm now: {get_npm_version()}")
        else:
            log_dim(f"  Upgrade: npm install -g npm@latest")

    return npm

def configure_npm_termux():
    """Set Termux-friendly npm defaults. Idempotent."""
    if not IS_TERMUX:
        return
    configs = [
        ("unsafe-perm",  "true"),   # allow postinstall scripts as non-root
        ("prefer-offline", "true"), # reduce network calls on spotty mobile
        ("maxsockets",   "2"),      # limit parallel connections (battery/RAM)
        ("fetch-retries", "5"),     # mobile networks are flaky
        ("fetch-timeout",  "60000"),
    ]
    for key, val in configs:
        run(f"npm config set {key} {val}", check=False)

def pg_isready():
    if IS_TERMUX:
        r = run(f"pg_isready -h {PG_SOCKET_DIR}", capture=True)
    else:
        r = run("pg_isready", capture=True)
        if r.returncode != 0:
            r = run("pg_isready -h /tmp", capture=True)
    return r.returncode == 0

def get_total_ram_mb():
    """Return total system RAM in MB, or None if we can't read it."""
    # Linux / Termux — /proc/meminfo is the most reliable source
    try:
        with open("/proc/meminfo", "r") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    kb = int(line.split()[1])
                    return kb // 1024
    except (OSError, ValueError):
        pass
    # macOS / Windows fallback via stdlib (only works if psutil isn't around)
    try:
        import ctypes
        if IS_WINDOWS:
            class MS(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong),
                            ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong),
                            ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong),
                            ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong),
                            ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("ullExtendedVirtual", ctypes.c_ulonglong)]
            s = MS(); s.dwLength = ctypes.sizeof(s)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(s))
            return s.ullTotalPhys // (1024 * 1024)
    except Exception:
        pass
    return None


def is_low_memory():
    """True when device has < 3 GB RAM — triggers prod-mode default + heap cap."""
    ram = get_total_ram_mb()
    return ram is not None and ram < 3072


def get_local_ip():
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "0.0.0.0"


# ─── Termux: relocate off shared storage ─────────────────────────────────────

def is_shared_storage(path):
    """True when path is on Android shared storage (no real symlink support)."""
    return path.startswith("/storage/") or path.startswith("/sdcard/")


def ensure_symlink_capable_dir():
    """
    Android shared storage (/storage/emulated/0, /sdcard) uses a FUSE layer
    that does NOT support symlinks at the kernel level.  Python's os.symlink()
    may succeed (the FUSE layer lies), but npm's internal libuv symlink call
    fails with EACCES, so node_modules/.bin/ can never be created there.

    When the project lives on shared storage we copy it to
    ~/h0-panel (internal ext4 storage, full symlink support) and work from there.
    All subsequent operations use WORK_DIR so the original files are untouched.
    """
    global WORK_DIR

    if not IS_TERMUX:
        return
    if not is_shared_storage(SCRIPT_DIR):
        return   # already on internal storage — fine

    target = os.path.join(TERMUX_HOME, "h0-panel")

    log_step("Relocating to internal storage")
    log_warn(f"Source on shared storage: {SCRIPT_DIR}")
    log_warn("(shared storage blocks symlinks — npm install would fail)")
    log(f"Copying project to {C.GREEN}{target}{C.RESET} ...")

    # rsync is fastest for incremental updates; fall back to shutil
    if cmd_exists("rsync"):
        os.makedirs(target, exist_ok=True)
        run(
            f'rsync -a --delete '
            f'--exclude node_modules --exclude .pgdata --exclude dist '
            f'"{SCRIPT_DIR}/" "{target}/"',
            cwd=SCRIPT_DIR,
        )
    else:
        if os.path.isdir(target):
            shutil.rmtree(target, ignore_errors=True)
        try:
            shutil.copytree(
                SCRIPT_DIR, target,
                ignore=shutil.ignore_patterns("node_modules", ".pgdata", "dist"),
            )
        except FileExistsError:
            # Target appeared between rmtree and copytree (race); use rsync fallback
            os.makedirs(target, exist_ok=True)
            run(
                f'rsync -a --delete '
                f'--exclude node_modules --exclude .pgdata --exclude dist '
                f'"{SCRIPT_DIR}/" "{target}/"',
                cwd=SCRIPT_DIR,
            )

    WORK_DIR = target
    # Also change the process cwd so any tool that reads it directly
    # (e.g. npx resolution) also lands in the right place.
    os.chdir(WORK_DIR)

    log_ok(f"Working from: {WORK_DIR}")
    log_dim("Source files on shared storage are unchanged.")


# ─── Termux initial bootstrap ────────────────────────────────────────────────

def termux_bootstrap():
    """
    First-run bootstrap for Termux. Handles the most common fresh-install
    issues: interrupted dpkg, stale package lists, missing storage access.
    Safe to re-run — idempotent.
    """
    log_step("Termux bootstrap")

    # 1. Fix interrupted dpkg (common after force-close or failed install)
    dpkg_status = os.path.join(PREFIX, "var", "lib", "dpkg", "status")
    if not os.path.exists(dpkg_status) or os.path.getsize(dpkg_status) == 0:
        log("Fixing interrupted dpkg ...")
        run("dpkg --configure -a", check=False)

    # 2. Update & upgrade package lists (Termux wiki: always do this first)
    log("Updating package lists ...")
    r = run("pkg update -y", capture=True, check=False)
    if r.returncode != 0:
        log_warn("pkg update failed — offering mirror switch ...")
        try:
            ans = input(
                f"  {C.YELLOW}Switch to a different mirror? [Y/n] {C.RESET}"
            ).strip().lower()
        except (EOFError, KeyboardInterrupt, OSError):
            ans = "y"
        if ans in ("", "y", "yes"):
            run("termux-change-repo", check=False)
            run("pkg update -y", check=False)

    log("Upgrading installed packages ...")
    run("pkg upgrade -y", check=False)

    # 3. Grant storage access if not already available
    storage_marker = os.path.join(TERMUX_HOME, ".storage_permission_granted")
    shared_storage_exists = os.path.exists("/storage/emulated/0")
    if shared_storage_exists and not os.path.exists(storage_marker):
        log("Requesting storage access ...")
        log_dim("  (A system dialog will appear — tap Allow)")
        run("termux-setup-storage", check=False)
        try:
            with open(storage_marker, "w") as f:
                f.write("ok")
        except OSError:
            pass
        log_ok("Storage access granted")

    log_ok("Termux bootstrap complete")


# ─── Chromium detection + auto-install ──────────────────────────────────────

def find_chromium():
    """Search every known install location; return path or None."""
    # Explicit override wins immediately
    override = os.environ.get("CHROMIUM_PATH")
    if override and os.path.exists(override):
        return override

    prefix = os.environ.get("PREFIX", "")
    candidates = [
        # ── Termux / Android ─────────────────────────────────────────────
        # tur-repo:  pkg install tur-repo && pkg install chromium
        f"{prefix}/bin/chromium",
        f"{prefix}/bin/chromium-browser",
        # proot-distro Ubuntu / Debian rootfs
        f"{prefix}/var/lib/proot-distro/installed-rootfs/ubuntu/usr/bin/chromium-browser",
        f"{prefix}/var/lib/proot-distro/installed-rootfs/ubuntu/usr/bin/chromium",
        f"{prefix}/var/lib/proot-distro/installed-rootfs/debian/usr/bin/chromium",
        f"{prefix}/var/lib/proot-distro/installed-rootfs/debian/usr/bin/chromium-browser",
        # ── Standard Linux ────────────────────────────────────────────────
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/google-chrome",
        "/snap/bin/chromium",
        # ── Replit / Nix ─────────────────────────────────────────────────
        "/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium",
        # ── macOS ─────────────────────────────────────────────────────────
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]

    for p in candidates:
        if p and os.path.exists(p):
            return p

    # PATH-based fallback — catches non-standard or future install locations
    for cmd in ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]:
        found = shutil.which(cmd)
        if found:
            return found

    return None


def setup_chromium():
    """
    Find Chromium, set CHROMIUM_PATH env var, and offer auto-install on Termux.
    Returns the path string or None (server still starts; browser-mode disabled).
    """
    log_step("Chromium  (browser-mode checker)")

    path = find_chromium()

    if path:
        log_ok(f"Chromium: {path}")
        os.environ["CHROMIUM_PATH"] = path
        return path

    # ── Not found ────────────────────────────────────────────────────────────
    log_err("Chromium not found — browser-mode hits will be disabled")

    if IS_TERMUX:
        log_dim("  Install: pkg install tur-repo && pkg install chromium")
        log_dim("  Or set:  export CHROMIUM_PATH=/path/to/chrome")
        print()
        try:
            ans = input(
                f"  {C.YELLOW}Auto-install Chromium now? [Y/n] {C.RESET}"
            ).strip().lower()
        except (EOFError, KeyboardInterrupt, OSError):
            ans = "n"

        if ans in ("", "y", "yes"):
            log("Installing tur-repo ...")
            r1 = run("pkg install tur-repo -y", check=False)
            if r1.returncode == 0:
                log("Installing chromium ...")
                r2 = run("pkg install chromium -y", check=False)
                if r2.returncode == 0:
                    path = find_chromium()
                    if path:
                        log_ok(f"Chromium installed: {path}")
                        os.environ["CHROMIUM_PATH"] = path
                        return path
                    else:
                        log_warn("Installed but binary not found — set manually:")
                        log_dim("  export CHROMIUM_PATH=$(which chromium)")
                else:
                    log_warn("chromium install failed")
            else:
                log_warn("tur-repo install failed — try manually:")
                log_dim("  pkg install tur-repo && pkg install chromium")
        else:
            log_warn("Skipped — browser-mode hits disabled until Chromium is installed")

    elif IS_LINUX:
        log_dim("  Install: sudo apt install chromium-browser")
        log_dim("       or: snap install chromium")
        log_dim("       or: export CHROMIUM_PATH=/path/to/chrome")
    elif IS_MACOS:
        log_dim("  Install: brew install --cask chromium")
        log_dim("       or: export CHROMIUM_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'")
    elif IS_WINDOWS:
        log_dim(r"  Install Chrome/Chromium then:")
        log_dim(r"  set CHROMIUM_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe")

    return None


# ─── Termux package install ──────────────────────────────────────────────────

def setup_termux_packages():
    log_step("Setting up Termux packages")
    needed = []

    if not cmd_exists("node"):
        needed.append("nodejs-lts")
    else:
        log_ok(f"Node.js: {get_node_version()}")

    if not cmd_exists("initdb"):
        needed.append("postgresql")
    else:
        log_ok("PostgreSQL found")

    for tool, pkg in [
        ("git",        "git"),
        ("make",       "make"),
        ("clang",      "clang"),
        ("pkg-config", "pkg-config"),
        ("rsync",      "rsync"),
        ("python",     "python"),
        ("gcc",        "build-essential"),
    ]:
        if not cmd_exists(tool):
            needed.append(pkg)

    if needed:
        log(f"Installing: {', '.join(needed)}")
        r = run(f"pkg install -y {' '.join(needed)}", capture=True, check=False)
        if r.returncode != 0:
            log_warn("Some packages failed — offering mirror switch ...")
            try:
                ans = input(
                    f"  {C.YELLOW}Switch mirror and retry? [Y/n] {C.RESET}"
                ).strip().lower()
            except (EOFError, KeyboardInterrupt, OSError):
                ans = "y"
            if ans in ("", "y", "yes"):
                run("termux-change-repo", check=False)
                run("pkg update -y", check=False)
                run(f"pkg install -y {' '.join(needed)}", check=False)
        log_ok("System packages installed")
    else:
        log_ok("All system packages present")


# ─── PostgreSQL ───────────────────────────────────────────────────────────────

def setup_postgresql():
    log_step("Setting up PostgreSQL")

    ext = os.environ.get("DATABASE_URL")
    if ext:
        log_ok("DATABASE_URL already set (external DB)")
        log_dim(ext[:60] + ("..." if len(ext) > 60 else ""))
        return ext

    if not os.path.exists(os.path.join(PG_DATA_DIR, "PG_VERSION")):
        log("Initializing PostgreSQL cluster...")
        os.makedirs(PG_DATA_DIR, exist_ok=True)
        r = run(f"initdb -D {PG_DATA_DIR}", capture=True)
        if r.returncode != 0:
            log_err(f"initdb failed: {(r.stderr or '').strip()}")
            sys.exit(1)
        log_ok("Cluster initialized")

    if IS_TERMUX:
        os.makedirs(PG_SOCKET_DIR, exist_ok=True)

    if not pg_isready():
        log("Starting PostgreSQL...")
        if IS_TERMUX:
            start_cmd = (
                f"pg_ctl -D {PG_DATA_DIR} "
                f"-l {PG_DATA_DIR}/logfile "
                f'-o "-k {PG_SOCKET_DIR}" start'
            )
        elif IS_WINDOWS:
            start_cmd = f'pg_ctl -D "{PG_DATA_DIR}" -l "{PG_DATA_DIR}/logfile" start'
        else:
            start_cmd = f"pg_ctl -D '{PG_DATA_DIR}' -l '{PG_DATA_DIR}/logfile' start"

        run(start_cmd, check=False)
        for _ in range(15):
            if pg_isready():
                break
            time.sleep(1)
        else:
            log_warn("PostgreSQL not ready after 15 s — check logfile")
            log_dim(f"  {PG_DATA_DIR}/logfile")

    if pg_isready():
        log_ok("PostgreSQL is running")
    else:
        log_warn("PostgreSQL status unclear — continuing anyway")

    h_flag = f"-h {PG_SOCKET_DIR}" if IS_TERMUX else ""
    r = run(f"psql {h_flag} -lqt", capture=True)
    if DB_NAME not in (r.stdout or ""):
        log(f"Creating database '{DB_NAME}'...")
        run(f"createdb {h_flag} {DB_NAME}", check=False)

    db_url = (
        f"postgresql:///{DB_NAME}?host={PG_SOCKET_DIR}"
        if IS_TERMUX else
        f"postgresql://localhost:5432/{DB_NAME}"
    )
    log_ok(f"Database ready: {DB_NAME}")
    log_dim(f"URL: {db_url}")
    return db_url


# ─── Node dependencies ───────────────────────────────────────────────────────

def _npm_env():
    """Base npm env for Termux — skip Puppeteer Chromium download + native build flags."""
    env = {}
    if IS_TERMUX:
        env["PUPPETEER_SKIP_DOWNLOAD"]          = "true"
        env["PUPPETEER_SKIP_CHROMIUM_DOWNLOAD"] = "true"
        # Tell node-gyp to use Termux's clang (not gcc) for native modules
        env["CC"]  = "clang"
        env["CXX"] = "clang++"
        # Prevent npm from trying to download prebuilt binaries that don't exist for ARM
        env["npm_config_platform"] = "android"
        env["npm_config_arch"]     = "arm64"
    # Cap npm's helper Node processes too — npm/esbuild/postinstall scripts
    # otherwise inherit V8's ~1.5 GB default which OOM-kills on 2 GB devices.
    # Skip if the user has already specified --max-old-space-size in their env.
    if is_low_memory():
        existing = os.environ.get("NODE_OPTIONS", "").strip()
        if "--max-old-space-size" not in existing:
            env["NODE_OPTIONS"] = (existing + " --max-old-space-size=512").strip()
    return env


def _npm_install_flags():
    """Memory- and bandwidth-friendly install flags. Critical on Termux/2 GB."""
    flags = ["--no-audit", "--no-fund", "--prefer-offline"]
    if is_low_memory():
        # maxsockets=2 caps parallel downloads (each tarball extract uses ~50 MB);
        # --no-optional skips bufferutil compile, which fails on Termux anyway.
        flags += ["--maxsockets=2", "--no-optional"]
    return " ".join(flags)


def _ensure_bcryptjs():
    """
    On ARM/Termux, bcrypt has no prebuilt native binary.
    npm install may return exit 0 (success) but bcrypt silently installs
    without a compiled .node file — it crashes at runtime.

    This function detects that situation and fixes it unconditionally:
      1. Uninstall bcrypt (removes the broken native package)
      2. Install bcryptjs (pure-JS, identical API)
      3. Patch all server/*.ts imports: "bcrypt" → "bcryptjs"
    """
    if not IS_TERMUX:
        return  # non-ARM: native bcrypt works fine

    bcrypt_dir   = os.path.join(WORK_DIR, "node_modules", "bcrypt")
    bcryptjs_dir = os.path.join(WORK_DIR, "node_modules", "bcryptjs")

    # Check if bcrypt is installed but has no compiled native binary
    native_exists = False
    if os.path.isdir(bcrypt_dir):
        import glob as _glob
        native_exists = bool(_glob.glob(
            os.path.join(bcrypt_dir, "**", "*.node"), recursive=True
        ))

    if not os.path.isdir(bcrypt_dir):
        return  # bcrypt not installed at all — nothing to do

    if native_exists and not os.path.isdir(bcryptjs_dir):
        return  # bcrypt native compiled successfully — fine

    # bcrypt is present but native binary is missing (or bcryptjs already there)
    if os.path.isdir(bcryptjs_dir):
        # bcryptjs already installed; just make sure imports are patched
        _patch_bcrypt_import(silent=True)
        return

    npm = get_npm_cmd()
    env = _npm_env()
    log_warn("bcrypt has no ARM binary — replacing with bcryptjs (pure-JS)...")
    run(f"{npm} uninstall bcrypt", check=False, extra_env=env)
    run(f"{npm} install bcryptjs@latest", check=False, extra_env=env)
    _patch_bcrypt_import()
    log_ok("bcrypt → bcryptjs swap complete")


def install_dependencies():
    log_step("Installing Node.js dependencies")

    npm = verify_npm()
    if not npm:
        log_err("npm not found or broken — install Node.js first")
        if IS_TERMUX:
            log_dim("  pkg install nodejs-lts")
        sys.exit(1)

    log(f"Node.js {get_node_version()}  |  npm {get_npm_version()}  |  cwd: {WORK_DIR}")

    env = _npm_env()

    # Critical: check that .bin symlinks actually exist, not just package dirs.
    # If npm install ever ran on Android shared storage (FUSE), package folders
    # copy fine but .bin/ symlinks fail silently — express exists but tsx,
    # vite, drizzle-kit don't. We detect that here and force `npm rebuild` to
    # restore the binary links without re-downloading every package.
    nm = os.path.join(WORK_DIR, "node_modules")
    critical_bins = ["tsx", "vite", "drizzle-kit"]
    bins_present  = all(
        os.path.isfile(os.path.join(nm, ".bin", b))
        or os.path.islink(os.path.join(nm, ".bin", b))
        for b in critical_bins
    )

    if os.path.isdir(os.path.join(nm, "express")) and bins_present:
        log_ok("node_modules present (express + bin symlinks found)")
        _ensure_bcryptjs()   # ← always fix bcrypt even on subsequent runs
        return

    if os.path.isdir(os.path.join(nm, "express")) and not bins_present:
        log_warn("node_modules present but .bin/ symlinks are missing")
        log_dim("  (likely cause: previous npm install ran on shared storage)")
        log("Running `npm rebuild` to restore binary links ...")
        r_rebuild = run(f"{npm} rebuild", capture=True, extra_env=env)
        if r_rebuild.returncode == 0 and os.path.isfile(os.path.join(nm, ".bin", "tsx")):
            log_ok("Binary links restored")
            _ensure_bcryptjs()
            return
        log_warn("npm rebuild didn't restore tsx — falling through to full install")
        log_dim((r_rebuild.stderr or "")[-300:])

    log("Installing dependencies (first run may take a few minutes)...")
    flags = _npm_install_flags()
    if is_low_memory():
        log_dim(f"  low-memory mode: {flags}")

    # Attempt 1: standard full install
    r = run(f"{npm} install {flags}", capture=True, extra_env=env)
    if r.returncode == 0:
        log_ok("Dependencies installed")
        _ensure_bcryptjs()   # ← npm may have succeeded but bcrypt has no ARM binary
        return

    log_warn("npm install failed — retrying with --ignore-scripts ...")
    log_dim((r.stderr or "")[-300:])

    # Attempt 2: skip native build scripts entirely
    env2 = {**env, "npm_config_ignore_scripts": "true"}
    r2 = run(f"{npm} install {flags}", capture=True, extra_env=env2)
    if r2.returncode != 0:
        log_err("npm install failed even with --ignore-scripts")
        log_dim((r2.stderr or "")[-400:])
        sys.exit(1)

    # Install pure-JS bcrypt replacement directly
    log("Installing bcryptjs (pure-JS bcrypt replacement)...")
    run(f"{npm} install bcryptjs@latest", check=False, extra_env=env)
    _patch_bcrypt_import()
    log_ok("Dependencies installed (bcryptjs fallback active)")

    # Verify all critical deps are present
    _ensure_package_json_deps()
    _verify_npm_deps()


def _patch_bcrypt_import(silent=False):
    """Rewrite  from "bcrypt"  →  from "bcryptjs"  in every server/**/*.ts"""
    if not silent:
        log("Patching bcrypt → bcryptjs in server files...")
    server_dir = os.path.join(WORK_DIR, "server")
    patched = 0
    for root, _dirs, files in os.walk(server_dir):
        for fname in files:
            if not fname.endswith(".ts"):
                continue
            fpath = os.path.join(root, fname)
            try:
                with open(fpath, "r", encoding="utf-8") as f:
                    src = f.read()
            except OSError:
                continue
            if 'from "bcrypt"' not in src and "from 'bcrypt'" not in src:
                continue
            src = src.replace('from "bcrypt"', 'from "bcryptjs"')
            src = src.replace("from 'bcrypt'", "from 'bcryptjs'")
            try:
                with open(fpath, "w", encoding="utf-8") as f:
                    f.write(src)
            except OSError:
                continue
            if not silent:
                rel = os.path.relpath(fpath, server_dir)
                log_dim(f"  patched {rel}")
            patched += 1
    if not silent and patched > 0:
        log_ok("bcrypt → bcryptjs done")


# ─── Build ────────────────────────────────────────────────────────────────────

def build_project():
    log_step("Building for production")
    npm = get_npm_cmd()
    if not npm:
        log_err("npm not found"); sys.exit(1)

    dist = os.path.join(WORK_DIR, "dist")
    if os.path.isdir(dist):
        shutil.rmtree(dist, ignore_errors=True)

    log("Building client + server bundle ...")
    build_env = {}
    if is_low_memory():
        # vite + tsx build are the highest-memory step in the whole pipeline.
        # On 2 GB Termux it WILL OOM without a cap — 768 MB is the sweet spot:
        # tight enough to leave room for the system, loose enough to let
        # rollup finish bundling the React app.
        existing = os.environ.get("NODE_OPTIONS", "").strip()
        if "--max-old-space-size" not in existing:
            build_env["NODE_OPTIONS"] = (existing + " --max-old-space-size=768").strip()
            log_dim(f"  low-memory: NODE_OPTIONS={build_env['NODE_OPTIONS']}")
        else:
            log_dim(f"  (keeping user-set NODE_OPTIONS: {existing})")
    run(f"{npm} run build", extra_env=build_env)
    log_ok("Build complete -> dist/")


# ─── Helpers for running Node ─────────────────────────────────────────────────

def get_tsx_cmd():
    """Prefer the project-local tsx binary over npx (faster, no network).
    Three-step fallback because Termux shared-storage installs may break
    different layers — symlinks first, then direct CLI script, then npx."""
    nm = os.path.join(WORK_DIR, "node_modules")
    local = os.path.join(nm, ".bin", "tsx")
    if os.path.isfile(local) or os.path.islink(local):
        return local
    # .bin/tsx missing — try the actual CLI script that bin/tsx normally points to
    for entry in ("dist/cli.mjs", "dist/cli.js"):
        direct = os.path.join(nm, "tsx", entry)
        if os.path.isfile(direct):
            return f"node {direct}"
    return "npx tsx"


def _run_server(cmd, env, label="Server"):
    """Run a server process; suppress Python traceback on normal exits."""
    # Normal exit codes: 0=clean, 1=tsx error, 130=SIGINT(Ctrl+C), 143=SIGTERM
    NORMAL_EXIT_CODES = {0, 1, 130, 143}
    try:
        result = run(cmd, extra_env=env, check=False)
        if result.returncode in NORMAL_EXIT_CODES:
            print()
            log_warn(f"{label} stopped (exit {result.returncode})")
        else:
            print()
            log_err(f"{label} crashed (exit {result.returncode})")
            log_dim("Check logs above for the error message.")
    except KeyboardInterrupt:
        print()
        log_warn(f"{label} stopped by user")


# ─── Run ──────────────────────────────────────────────────────────────────────

def _runtime_node_options():
    """Cap V8 heap when device has < 3 GB RAM, otherwise leave default.
    Honors a user-set --max-old-space-size in NODE_OPTIONS — only appends our
    512 MB default when the user hasn't already specified one. This means
    `NODE_OPTIONS='--max-old-space-size=1024' python start.py` is respected."""
    existing = os.environ.get("NODE_OPTIONS", "").strip()
    if not is_low_memory():
        return existing
    # User already set a heap cap — don't shadow it
    if "--max-old-space-size" in existing:
        log_dim(f"  (keeping user-set NODE_OPTIONS: {existing})")
        return existing
    return (existing + " --max-old-space-size=512").strip()


def _preflight_check():
    """Verify all critical runtime deps are installed before starting."""
    log_dim("Preflight check: verifying critical dependencies...")
    if not _verify_npm_deps():
        log_err("Critical dependencies missing — cannot start")
        sys.exit(1)
    log_ok("Preflight check passed")


def run_dev(port, db_url):
    _preflight_check()
    log_step("Starting Development Server (full mode)")
    _print_mode_capabilities("DEV (full)", [
        ("Telegram bot (polling)",              True),
        ("Web dashboard UI (live)",             True),
        ("Vite hot reload",                     True),
        ("REST API",                            True),
        ("lightningcss native binding",         True),
        ("Heap cap (512 MB) — low-mem only",    is_low_memory()),
        ("Browser-mode hits (Puppeteer)",       bool(os.environ.get("CHROMIUM_PATH"))),
    ])
    if is_low_memory():
        ram = get_total_ram_mb() or 0
        log_warn(f"Device has only {ram} MB RAM — dev mode runs Vite + tsx and may OOM.")
        log_dim("  Strongly consider:  python start.py --prod  OR  --bot-mode")
        log_dim("  (Build once for --prod; or skip vite entirely with --bot-mode.)")
    env = {
        "DATABASE_URL":             db_url,
        "PORT":                     str(port),
        "NODE_ENV":                 "development",
        "PUPPETEER_SKIP_DOWNLOAD":  "true",
        "PUPPETEER_SKIP_CHROMIUM_DOWNLOAD": "true",
    }
    node_opts = _runtime_node_options()
    if node_opts:
        env["NODE_OPTIONS"] = node_opts
    # Inject Chromium path if found during setup
    if os.environ.get("CHROMIUM_PATH"):
        env["CHROMIUM_PATH"] = os.environ["CHROMIUM_PATH"]
    tsx = get_tsx_cmd()
    ip = get_local_ip()
    log(f"Dev server on port {C.GREEN}{C.BOLD}{port}{C.RESET}")
    log_dim(f"  Local:   http://localhost:{port}")
    log_dim(f"  Network: http://{ip}:{port}")
    log_dim(f"  Cwd:     {WORK_DIR}")
    log_dim(f"  tsx:     {tsx}")
    if node_opts:
        log_dim(f"  NODE_OPTIONS: {node_opts}")
    print()
    _run_server(f"{tsx} server/index.ts", env, "Dev server")


def run_prod(port, db_url):
    log_step("Starting Production Server (full mode)")
    dist_index = os.path.join(WORK_DIR, "dist", "index.cjs")
    _print_mode_capabilities("PROD (full)", [
        ("Telegram bot (polling)",              True),
        ("Web dashboard UI (bundled)",          True),
        ("REST API",                            True),
        ("Heap cap (512 MB) — low-mem only",    is_low_memory()),
        ("Browser-mode hits (Puppeteer)",       bool(os.environ.get("CHROMIUM_PATH"))),
        ("Vite dev server (off in prod)",       False),
    ])
    if not os.path.exists(dist_index):
        log("No build found — building now ...")
        build_project()
    env = {
        "DATABASE_URL": db_url,
        "PORT":         str(port),
        "NODE_ENV":     "production",
        "PUPPETEER_SKIP_DOWNLOAD":          "true",
        "PUPPETEER_SKIP_CHROMIUM_DOWNLOAD": "true",
    }
    node_opts = _runtime_node_options()
    if node_opts:
        env["NODE_OPTIONS"] = node_opts
    # Inject Chromium path if found during setup
    if os.environ.get("CHROMIUM_PATH"):
        env["CHROMIUM_PATH"] = os.environ["CHROMIUM_PATH"]
    ip = get_local_ip()
    log(f"Production server on port {C.GREEN}{C.BOLD}{port}{C.RESET}")
    log_dim(f"  Local:   http://localhost:{port}")
    log_dim(f"  Network: http://{ip}:{port}")
    if node_opts:
        log_dim(f"  NODE_OPTIONS: {node_opts}")
    print()
    _run_server("node dist/index.cjs", env, "Production server")


def db_has_bot_token(db_url):
    """Best-effort check: does bot_settings.bot_token already have a value?
    Returns True if a token is configured, False if empty/missing/unknown.
    On any error we return False so the prompt still appears (safe fallback)."""
    if not cmd_exists("psql"):
        return False
    h_flag = f"-h {PG_SOCKET_DIR}" if IS_TERMUX else ""
    # Quote the single-line query so PowerShell + bash both accept it.
    sql = (
        "SELECT CASE WHEN bot_token IS NOT NULL AND bot_token <> '' "
        "THEN 'YES' ELSE 'NO' END FROM bot_settings WHERE id='default';"
    )
    r = run(f'psql {h_flag} -d {DB_NAME} -tA -c "{sql}"', capture=True, check=False)
    if r.returncode != 0:
        return False
    return "YES" in (r.stdout or "")


_BOT_TOKEN_RE = __import__("re").compile(r"^\d+:[A-Za-z0-9_-]{30,}$")


def prompt_bot_credentials(db_url):
    """Interactive bot-mode bootstrap. Mirrors the Chromium auto-install
    prompt so the user never needs psql to set bot_token / owner_id.
    Returns (token, owner_id) — either may be None if user chose to skip."""
    log_step("Telegram Bot Configuration")
    already_set = db_has_bot_token(db_url)
    if already_set:
        log_ok("Bot token already configured in DB — press Enter at both prompts to keep it.")
    else:
        log("This is a fresh install — you'll need:")
        log_dim("  1. A bot token from @BotFather (looks like 123456789:ABCdef…)")
        log_dim("  2. Your Telegram user ID — get it from @userinfobot (a number, e.g. 7654321)")

    token = None
    owner = None

    # ── Token ────────────────────────────────────────────────────────────
    for attempt in range(3):
        try:
            entered = input(f"  {C.YELLOW}Bot token{' (Enter = keep)' if already_set else ''}: {C.RESET}").strip()
        except (EOFError, KeyboardInterrupt, OSError):
            log_warn("Skipped — bot will fail to start without a token.")
            return None, None
        if not entered:
            if already_set:
                break  # keep DB value
            log_warn("Token required for first-time setup.")
            continue
        if not _BOT_TOKEN_RE.match(entered):
            log_warn("Doesn't look like a bot token (expected NNN:XXXX… ~35+ chars). Try again or paste exactly what @BotFather gave you.")
            continue
        token = entered
        break

    # ── Owner ID ─────────────────────────────────────────────────────────
    for attempt in range(3):
        try:
            entered = input(f"  {C.YELLOW}Your Telegram ID (numeric){' (Enter = keep)' if already_set else ''}: {C.RESET}").strip()
        except (EOFError, KeyboardInterrupt, OSError):
            log_warn("Skipped — no owner set; you can use /login PASSWORD inside the bot instead.")
            return token, None
        if not entered:
            if already_set:
                break  # keep DB value
            log_warn("Without an owner ID, only /login (password) grants admin access — continuing anyway.")
            break
        if not entered.isdigit():
            log_warn("Telegram IDs are pure numbers (no @, no quotes). Try again.")
            continue
        owner = entered
        break

    if token:
        log_ok(f"Token will be saved to DB on first server boot: {token[:12]}…")
    if owner:
        log_ok(f"Owner ID will be saved to DB: {owner}")
    return token, owner


def _print_mode_capabilities(mode_name, items):
    """Render a uniform 'Mode: X' header with [✓]/[✗] capability rows."""
    print(f"  {C.BOLD}Mode:{C.RESET} {mode_name}")
    for label, on in items:
        mark = f"{C.GREEN}[✓]{C.RESET}" if on else f"{C.DIM}[ ]{C.RESET}"
        print(f"    {mark} {label}")
    print()


def run_bot_mode(port, db_url, bot_token=None, owner_id=None):
    """LOW-DEVICE / TERMUX mode: telegram-only server.

    Why this mode exists:
    • @tailwindcss/vite (Tailwind v4) → lightningcss has NO Android binary
      So dev mode and `npm run build` both crash on Termux ARM
    • server/index.ts:119 imports setupVite ONLY when NODE_ENV !== 'production'
      → we set NODE_ENV=production so the import never happens at all
    • Telegram bot + REST API + DB all work without vite

    Disabled: web dashboard UI (returns 404 unless dist/public exists)
    Enabled:  /addgate, /editgate, /chk, /mass, all admin commands
    Robust against low RAM: NODE_OPTIONS heap cap, throttled polling logs,
    polling auto-stops on terminal errors (401/409) instead of looping."""
    _preflight_check()
    log_step("Starting Bot Mode (low-device / vite-free)")
    has_dist = os.path.isdir(os.path.join(WORK_DIR, "dist", "public"))
    _print_mode_capabilities("BOT (low-device)", [
        ("Telegram bot (polling)",              True),
        ("REST API (POST /api/check, /api/gates, ...)", True),
        ("PostgreSQL + drizzle schema",         True),
        ("Heap cap (512 MB)",                   is_low_memory()),
        ("Web dashboard UI",                    has_dist),
        ("Vite dev server / hot reload",        False),
        ("lightningcss native binding",         False),
        ("Browser-mode hits (Puppeteer)",       bool(os.environ.get("CHROMIUM_PATH"))),
    ])
    env = {
        "DATABASE_URL":             db_url,
        "PORT":                     str(port),
        "NODE_ENV":                 "production",  # skips setupVite import
        "PUPPETEER_SKIP_DOWNLOAD":  "true",
        "PUPPETEER_SKIP_CHROMIUM_DOWNLOAD": "true",
        "H0_AUTO_START_BOT":        "true",  # server boots → calls startBot()
    }
    # Hand off bot credentials so the server bootstraps them into bot_settings.
    # CLI flag wins over env so the user can override via --bot-token explicitly.
    if bot_token or os.environ.get("BOT_TOKEN"):
        env["BOT_TOKEN"] = bot_token or os.environ["BOT_TOKEN"]
    if owner_id or os.environ.get("OWNER_ID"):
        env["OWNER_ID"] = owner_id or os.environ["OWNER_ID"]
    node_opts = _runtime_node_options()
    if node_opts:
        env["NODE_OPTIONS"] = node_opts
    if os.environ.get("CHROMIUM_PATH"):
        env["CHROMIUM_PATH"] = os.environ["CHROMIUM_PATH"]
    tsx = get_tsx_cmd()
    ip = get_local_ip()
    log(f"Bot-mode server on port {C.GREEN}{C.BOLD}{port}{C.RESET}")
    log_dim(f"  Local:   http://localhost:{port}")
    log_dim(f"  Network: http://{ip}:{port}")
    log_dim(f"  Cwd:     {WORK_DIR}")
    log_dim(f"  tsx:     {tsx}")
    if node_opts:
        log_dim(f"  NODE_OPTIONS: {node_opts}")
    print()
    _run_server(f"{tsx} server/index.ts", env, "Bot-mode server")


# ─── Database reset ───────────────────────────────────────────────────────────

def reset_database():
    log_step("Resetting Database")
    log_warn("This will DELETE ALL DATA!")
    try:
        ans = input(f"  {C.YELLOW}Type 'yes' to confirm: {C.RESET}")
    except (EOFError, KeyboardInterrupt, OSError):
        log("Cancelled"); return
    if ans.strip().lower() != "yes":
        log("Cancelled"); return
    h = f"-h {PG_SOCKET_DIR}" if IS_TERMUX else ""
    run(f"dropdb {h} --if-exists {DB_NAME}", check=False)
    run(f"createdb {h} {DB_NAME}", check=False)
    log_ok("Database reset complete")


# ─── Banner ───────────────────────────────────────────────────────────────────

def print_banner():
    node = get_node_version() or "not installed"
    ram_mb = get_total_ram_mb()
    ram_str = f"{ram_mb} MB" if ram_mb else "unknown"
    low_warn = f"  {C.YELLOW}⚠ Low memory — use --prod (not dev). Heap will be capped to 512 MB.{C.RESET}\n" if is_low_memory() else ""
    print(f"""
{C.CYAN}{C.BOLD}  $$$ H0 CHECKER PANEL $$${C.RESET}
{C.DIM}
  Platform : {platform.system()} {'(Termux)' if IS_TERMUX else ''} {platform.machine()}
  Python   : {platform.python_version()}
  Node.js  : {node}
  RAM      : {ram_str}
  Source   : {SCRIPT_DIR}
{C.RESET}{low_warn}""")


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    global WORK_DIR

    parser = argparse.ArgumentParser(
        description="H0 Checker Panel - Start Script",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python start.py                  Interactive menu (pick 1/2/3)
  python start.py --prod           Build + production server
  python start.py --dev            Dev mode with Vite hot-reload
  python start.py --bot-mode       Telegram bot only, no vite/build
  python start.py --bot-mode --bot-token 123:abc --owner-id 7654321
                                  Bootstrap bot credentials on first run
  python start.py --port 3000      Custom port
  python start.py --install        Install deps only
  python start.py --build          Build client+server only
  python start.py --reset-db       Wipe database
  python start.py --skip-pg        Use DATABASE_URL env (skip local PG)
"""
    )
    parser.add_argument("--prod",         action="store_true")
    parser.add_argument("--dev",          action="store_true", help="Skip install, run directly")
    parser.add_argument("--bot-mode",     action="store_true",
                        help="Run server with NODE_ENV=production via tsx — skips Vite/lightningcss "
                             "(required on Termux ARM where lightningcss has no native binary). "
                             "Web dashboard 404s without a prior build; Telegram bot works fully.")
    parser.add_argument("--bot-token",    type=str, default=None,
                        help="Telegram bot token. Stored to DB on startup if bot_settings.botToken is empty. "
                             "Also reads BOT_TOKEN env var. Use once per fresh install; persists in DB.")
    parser.add_argument("--owner-id",     type=str, default=None,
                        help="Telegram user ID of the bot owner (numeric, e.g. 123456789). "
                             "Stored to DB on startup if bot_settings.ownerId is empty. Also reads OWNER_ID env var.")
    parser.add_argument("--install",      action="store_true")
    parser.add_argument("--build",        action="store_true")
    parser.add_argument("--reset-db",     action="store_true")
    parser.add_argument("--port",         type=int, default=DEFAULT_PORT)
    parser.add_argument("--skip-pg",      action="store_true")
    parser.add_argument("--skip-install", action="store_true")

    args = parser.parse_args()

    signal.signal(signal.SIGINT,
                  lambda *_: (print(f"\n{C.YELLOW}Shutting down...{C.RESET}"),
                              sys.exit(0)))

    print_banner()

    # ── STEP 0: On Termux, relocate off shared storage FIRST ──────────────
    # This must happen before any npm/node operations.
    # Android /storage/emulated/0 (FUSE/sdcardfs) does not support symlinks
    # at the libuv/kernel level even though Python's os.symlink() may succeed.
    # npm install always fails there with EACCES on node_modules/.bin/
    if IS_TERMUX:
        ensure_symlink_capable_dir()
        # WORK_DIR is now either SCRIPT_DIR (internal) or ~/h0-panel (relocated)

    # ── STEP 1: System packages (Termux only) ─────────────────────────────
    if IS_TERMUX and not args.dev:
        termux_bootstrap()        # dpkg fix, pkg update/upgrade, storage access
        setup_termux_packages()   # install nodejs, postgresql, build tools, etc.
        configure_npm_termux()    # set unsafe-perm, fetch-retries, etc.

    # ── STEP 2: Non-Termux preflight ──────────────────────────────────────
    if not IS_TERMUX and not cmd_exists("node"):
        log_err("Node.js not found — install it first")
        if IS_LINUX:     log_dim("  sudo apt install nodejs npm")
        elif IS_MACOS:   log_dim("  brew install node")
        else:            log_dim("  https://nodejs.org/")
        sys.exit(1)

    # ── install-only shortcut ─────────────────────────────────────────────
    if args.install:
        install_dependencies()
        log_ok("Done!"); return

    # ── build-only shortcut ───────────────────────────────────────────────
    if args.build:
        install_dependencies()
        build_project()
        log_ok("Done!"); return

    # ── STEP 3: PostgreSQL ────────────────────────────────────────────────
    if args.skip_pg:
        db_url = os.environ.get("DATABASE_URL")
        if not db_url:
            log_err("--skip-pg requires DATABASE_URL to be set")
            sys.exit(1)
        log_ok("Using external DATABASE_URL")
    elif cmd_exists("initdb") or IS_TERMUX:
        db_url = setup_postgresql()
    else:
        db_url = os.environ.get("DATABASE_URL")
        if not db_url:
            log_err("PostgreSQL not installed and DATABASE_URL not set!")
            if IS_LINUX:     log_dim("  sudo apt install postgresql")
            elif IS_MACOS:   log_dim("  brew install postgresql")
            elif IS_WINDOWS: log_dim("  https://postgresql.org/download/windows/")
            log_dim("  Or: export DATABASE_URL=postgresql://user:pass@host/db")
            sys.exit(1)
        log_ok("Using DATABASE_URL from env")

    if args.reset_db:
        reset_database(); return

    # ── STEP 4: npm install ───────────────────────────────────────────────
    if not args.dev and not args.skip_install:
        install_dependencies()

    os.environ["DATABASE_URL"] = db_url

    # ── STEP 4.5: Chromium ────────────────────────────────────────────────
    setup_chromium()

    # ── STEP 5: run ───────────────────────────────────────────────────────
    # Mode selection: show numbered menu when no mode flag is provided.
    #   1 = Production  (--prod)  — built bundle, no Vite
    #   2 = Dev         (--dev)   — Vite hot-reload, full dashboard
    #   3 = Bot Mode    (--bot-mode) — telegram-only, no Vite, lightweight
    needs_prompt = not args.bot_mode and not args.prod and not args.dev
    if needs_prompt:
        log_step("Choose a run mode")
        if IS_TERMUX:
            log_warn("Termux detected — full mode may be unsupported (lightningcss has no Android binary).")
        if is_low_memory():
            ram = get_total_ram_mb() or 0
            log_warn(f"Low memory ({ram} MB) — dev mode may OOM.")
        print(f"  {C.BOLD}{C.GREEN}1{C.RESET}{C.BOLD}) Production{C.RESET}  — built bundle, no Vite, best for low RAM")
        print(f"  {C.BOLD}{C.GREEN}2{C.RESET}{C.BOLD}) Dev{C.RESET}         — Vite hot-reload, full dashboard, needs ~1.5 GB RAM")
        print(f"  {C.BOLD}{C.GREEN}3{C.RESET}{C.BOLD}) Bot Mode{C.RESET}    — telegram-only, no Vite, lightweight  {C.GREEN}[recommended]{C.RESET}")
        print()
        try:
            ans = input(f"  {C.YELLOW}Pick a mode [1-3, default=3]: {C.RESET}").strip()
        except (EOFError, KeyboardInterrupt, OSError):
            ans = "3"
        if ans == "1":
            args.prod = True
        elif ans == "2":
            args.dev = True
        else:
            if ans not in ("", "3"):
                log_warn(f"Unrecognized choice '{ans}' — defaulting to bot mode.")
            args.bot_mode = True

    if args.bot_mode:
        # Interactive bootstrap — when neither CLI flag nor env var provides
        # the token, prompt the user the same way we prompt for Chromium.
        # This is the easy path on Termux where editing the DB via psql is
        # cumbersome. If the user already has a token in the DB, they can
        # just press Enter at both prompts to keep it.
        token = args.bot_token or os.environ.get("BOT_TOKEN")
        owner = args.owner_id  or os.environ.get("OWNER_ID")
        if not token or not owner:
            ptoken, powner = prompt_bot_credentials(db_url)
            if not token:  token = ptoken
            if not owner:  owner = powner
        run_bot_mode(args.port, db_url, bot_token=token, owner_id=owner)
    elif args.prod:
        run_prod(args.port, db_url)
    else:
        run_dev(args.port, db_url)


if __name__ == "__main__":
    main()
