//! Sidecar lifecycle for the embedded `ark web` server.
//!
//! As of v0.17.1 the `ark` binary is bundled inside the app via Tauri's
//! `externalBin` mechanism. At build time the binary is placed at
//! `src-tauri/binaries/ark-<target-triple>` and Tauri copies it into
//! the app bundle. At runtime `find_ark_binary()` resolves it through
//! the resource directory, falling back to the user's PATH in dev mode
//! or if the sidecar is absent.
//!
//! The spawn logic uses its own `std::process::Command` (not the shell
//! plugin's `Command`) because we need the child to run in its own
//! process group (setsid on Unix, CREATE_NEW_PROCESS_GROUP on Windows)
//! so we can reap the whole tree on quit. The Electron build is known
//! to leak `bun` grandchildren (tracked in PR #102); fixing that leak
//! on this side is part of scope.

use anyhow::{anyhow, Context, Result};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;
use tracing::{debug, info, warn};

/// Handle to the spawned `ark web` process + the port it is bound to.
pub struct Sidecar {
    child: Mutex<Option<Child>>,
    pid: u32,
    port: u16,
}

impl Sidecar {
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Spawn `ark web --with-daemon --port <port>` in its own process group.
    pub fn spawn(ark_bin: &Path, port: u16) -> Result<Self> {
        let mut cmd = Command::new(ark_bin);
        cmd.arg("web")
            .arg("--with-daemon")
            .arg("--port")
            .arg(port.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Augment PATH so the ark bash wrapper can locate `bun`.
        let path_with_bun = augmented_path();
        cmd.env("PATH", path_with_bun);

        // Unix: create a new session (setsid) so the child + all its
        // descendants share a process group we can SIGTERM as one unit.
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            unsafe {
                cmd.pre_exec(|| {
                    // SAFETY: setsid(2) just detaches from controlling terminal
                    // and starts a new session. Safe to call in pre_exec.
                    if libc::setsid() == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }

        // Windows: CREATE_NEW_PROCESS_GROUP so we can broadcast a group kill.
        // The Job Object trick for deeper cleanup is a follow-up; for now
        // `taskkill /T /F /PID <pid>` does the right thing in `shutdown()`.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            cmd.creation_flags(CREATE_NEW_PROCESS_GROUP);
        }

        info!(port, bin = %ark_bin.display(), "spawning ark web");
        let mut child = cmd
            .spawn()
            .with_context(|| format!("failed to spawn {} web", ark_bin.display()))?;
        let pid = child.id();

        // Drain stdout/stderr on background threads so the child does not block
        // on a full pipe. Lines are forwarded via tracing.
        if let Some(stdout) = child.stdout.take() {
            std::thread::spawn(move || forward_stream("[ark]", stdout, false));
        }
        if let Some(stderr) = child.stderr.take() {
            std::thread::spawn(move || forward_stream("[ark]", stderr, true));
        }

        Ok(Self {
            child: Mutex::new(Some(child)),
            pid,
            port,
        })
    }

    /// Poll `/api/health` every 250ms until it returns 200 or `timeout` hits.
    pub async fn wait_healthy(&self, timeout: Duration) -> Result<()> {
        let url = format!("http://localhost:{}/api/health", self.port);
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()?;
        let start = Instant::now();
        let mut attempts = 0u32;
        loop {
            attempts += 1;
            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => {
                    debug!(attempts, "health check passed");
                    return Ok(());
                }
                Ok(resp) => {
                    debug!(attempts, status = %resp.status(), "health check non-200");
                }
                Err(e) => {
                    debug!(attempts, error = %e, "health check error (expected at boot)");
                }
            }
            if start.elapsed() > timeout {
                return Err(anyhow!(
                    "health check timed out after {:?} ({} attempts)",
                    timeout,
                    attempts
                ));
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    /// Kill the entire sidecar process group. Idempotent.
    pub fn shutdown(self) -> Result<()> {
        let mut guard = self.child.lock().unwrap();
        let Some(mut child) = guard.take() else {
            return Ok(());
        };

        #[cfg(unix)]
        {
            // SIGTERM the whole group (negative pid = pgid).
            let pgid = self.pid as i32;
            unsafe {
                if libc::kill(-pgid, libc::SIGTERM) == -1 {
                    let err = std::io::Error::last_os_error();
                    warn!(error = %err, pgid, "SIGTERM group failed");
                }
            }
        }

        #[cfg(windows)]
        {
            // On Windows, taskkill /T /F reliably reaps the child tree.
            let _ = Command::new("taskkill")
                .args(["/PID", &self.pid.to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }

        // Give the process up to 2s to exit cleanly; then escalate.
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    info!(?status, "sidecar exited");
                    return Ok(());
                }
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(100));
                }
                Ok(None) => {
                    warn!(
                        pid = self.pid,
                        "sidecar still alive after SIGTERM; sending SIGKILL"
                    );
                    #[cfg(unix)]
                    unsafe {
                        let pgid = self.pid as i32;
                        if libc::kill(-pgid, libc::SIGKILL) == -1 {
                            let err = std::io::Error::last_os_error();
                            warn!(error = %err, "SIGKILL group failed");
                        }
                    }
                    // Best-effort direct kill of the parent too.
                    let _ = child.kill();
                    let _ = child.wait();
                    return Ok(());
                }
                Err(e) => {
                    return Err(e.into());
                }
            }
        }
    }
}

/// Find the `ark` CLI binary on disk.
///
/// Resolution order:
///   1. **Bundled sidecar** -- the externalBin binary inside the app bundle.
///      Tauri places it at `<resource_dir>/binaries/ark-<target-triple>`.
///      This is the production path for the self-contained app.
///   2. **Repo-relative** (dev mode) -- `<cwd>/../../../ark` when running
///      from `packages/desktop/src-tauri` via `tauri dev`.
///   3. **Common install paths** -- `/usr/local/bin/ark`,
///      `~/.bun/bin/ark`, `~/.ark/bin/ark`.
///   4. **$PATH lookup** -- whatever the user has on PATH.
pub fn find_ark_binary(handle: &tauri::AppHandle) -> Result<PathBuf> {
    // 1. Bundled sidecar via externalBin.
    if let Some(path) = resolve_sidecar_path(handle) {
        if is_executable(&path) {
            info!(path = %path.display(), "using bundled sidecar");
            return Ok(path);
        }
        debug!(path = %path.display(), "sidecar path resolved but not executable");
    }

    let mut candidates: Vec<PathBuf> = Vec::new();

    // 2. Repo-relative (dev mode). CWD is the crate dir when running `tauri dev`.
    if let Ok(cwd) = std::env::current_dir() {
        // src-tauri -> desktop -> packages -> repo root
        let repo_root = cwd
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent());
        if let Some(root) = repo_root {
            candidates.push(root.join("ark"));
        }
    }

    // 3. Common install paths.
    candidates.push(PathBuf::from("/usr/local/bin/ark"));
    if let Some(home) = dirs_home() {
        candidates.push(home.join(".bun/bin/ark"));
        candidates.push(home.join(".ark/bin/ark"));
    }

    // 4. PATH lookup.
    if let Ok(path_var) = std::env::var("PATH") {
        for p in std::env::split_paths(&path_var) {
            candidates.push(p.join("ark"));
        }
    }

    for c in candidates {
        if is_executable(&c) {
            info!(path = %c.display(), "found ark on PATH (sidecar not bundled)");
            return Ok(c);
        }
    }
    Err(anyhow!(
        "ark CLI not found -- the bundled sidecar is missing and ark is not on PATH"
    ))
}

/// Resolve the absolute path to the sidecar binary that Tauri's externalBin
/// would place inside the app bundle.
///
/// Tauri v2 puts externalBin entries in `<resource_dir>/<path>-<triple>` where
/// `<path>` is from `tauri.conf.json > bundle > externalBin` (here:
/// `binaries/ark`). At runtime the file is at
/// `<resource_dir>/binaries/ark-<triple>`.
fn resolve_sidecar_path(handle: &tauri::AppHandle) -> Option<PathBuf> {
    let res_dir = handle.path().resource_dir().ok()?;

    let triple = current_target_triple();
    let suffixed = res_dir.join("binaries").join(format!("ark-{triple}"));
    if suffixed.exists() {
        return Some(suffixed);
    }

    // On Windows, Tauri appends .exe.
    #[cfg(windows)]
    {
        let suffixed_exe = res_dir
            .join("binaries")
            .join(format!("ark-{triple}.exe"));
        if suffixed_exe.exists() {
            return Some(suffixed_exe);
        }
    }

    // Fallback: unsuffixed name (useful during manual testing).
    let base = res_dir.join("binaries").join("ark");
    if base.exists() {
        return Some(base);
    }

    None
}

/// Return the Rust target triple for the current build. Injected by build.rs.
fn current_target_triple() -> &'static str {
    env!("TARGET_TRIPLE")
}

/// Return the path to the embedded sidecar binary if it exists.
/// Used by the CLI install feature to know where to symlink from.
pub fn sidecar_binary_path(handle: &tauri::AppHandle) -> Option<PathBuf> {
    resolve_sidecar_path(handle).filter(|p| is_executable(p))
}

/// Find a free port starting at `start`. Walks up to `start + 1000` then asks
/// the OS for any free port.
pub fn pick_port(start: u16) -> Result<u16> {
    for port in start..start.saturating_add(1000) {
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Ok(port);
        }
    }
    let listener = TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

fn is_executable(p: &Path) -> bool {
    if !p.exists() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        match std::fs::metadata(p) {
            Ok(m) => m.permissions().mode() & 0o111 != 0,
            Err(_) => false,
        }
    }
    #[cfg(windows)]
    {
        p.extension()
            .map(|e| {
                let e = e.to_string_lossy().to_lowercase();
                matches!(e.as_str(), "exe" | "cmd" | "bat")
            })
            .unwrap_or(true)
    }
}

fn dirs_home() -> Option<PathBuf> {
    #[cfg(unix)]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
}

/// PATH with `~/.bun/bin` prepended so the ark bash wrapper can find `bun`.
fn augmented_path() -> std::ffi::OsString {
    let mut out = std::ffi::OsString::new();
    if let Some(home) = dirs_home() {
        out.push(home.join(".bun/bin"));
        #[cfg(unix)]
        out.push(":");
        #[cfg(windows)]
        out.push(";");
    }
    if let Ok(p) = std::env::var("PATH") {
        out.push(p);
    }
    out
}

fn forward_stream<R: std::io::Read + Send + 'static>(tag: &'static str, mut r: R, is_err: bool) {
    let mut buf = [0u8; 4096];
    let mut leftover = Vec::new();
    loop {
        match r.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                leftover.extend_from_slice(&buf[..n]);
                while let Some(pos) = leftover.iter().position(|&b| b == b'\n') {
                    let line: Vec<u8> = leftover.drain(..=pos).collect();
                    let s = String::from_utf8_lossy(&line);
                    if is_err {
                        warn!(target: "ark_sidecar", "{} {}", tag, s.trim_end());
                    } else {
                        info!(target: "ark_sidecar", "{} {}", tag, s.trim_end());
                    }
                }
            }
        }
    }
    if !leftover.is_empty() {
        let s = String::from_utf8_lossy(&leftover);
        if is_err {
            warn!(target: "ark_sidecar", "{} {}", tag, s.trim_end());
        } else {
            info!(target: "ark_sidecar", "{} {}", tag, s.trim_end());
        }
    }
}
