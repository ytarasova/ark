//! CLI install helpers -- symlink the embedded sidecar to /usr/local/bin/ark.
//!
//! On macOS the first-launch flow calls `check_and_offer_cli_install()` which
//! shows a native dialog asking the user to install the `ark` CLI. If they
//! accept, `install_cli()` creates the symlink using `osascript` for privilege
//! elevation (no raw `sudo`).
//!
//! The same `install_cli()` function is exposed as the Tauri IPC command
//! `install_cli_command` so the web UI can wire a "Install CLI Tools..." menu
//! item that re-runs the flow on demand.

use crate::sidecar;
use std::path::Path;
use tracing::{info, warn};

const CLI_PATH: &str = "/usr/local/bin/ark";

/// Check if the CLI is already on PATH and offer to install if not.
/// Called once after the sidecar boots successfully. macOS only.
#[cfg(target_os = "macos")]
pub fn check_and_offer_cli_install(handle: &tauri::AppHandle) {
    // Already installed?
    if Path::new(CLI_PATH).exists() {
        info!("ark CLI already installed at {}", CLI_PATH);
        return;
    }

    // Do we have a sidecar to symlink to?
    let Some(sidecar_path) = sidecar::sidecar_binary_path(handle) else {
        info!("no bundled sidecar found -- skipping CLI install offer");
        return;
    };

    // Show native dialog via osascript. This is non-blocking on the Rust
    // side because it runs in a background thread.
    let sidecar_str = sidecar_path.to_string_lossy().to_string();
    std::thread::spawn(move || {
        let script = format!(
            r#"display dialog "Install Ark CLI?\n\nThis makes the `ark` command available in your terminal by creating a symlink at {}." buttons {{"Not Now", "Install"}} default button "Install" with title "Ark Desktop" with icon note"#,
            CLI_PATH
        );
        let output = std::process::Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output();
        match output {
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                if stdout.contains("Install") {
                    match create_symlink_with_auth(&sidecar_str) {
                        Ok(()) => {
                            info!("CLI installed at {}", CLI_PATH);
                            let _ = std::process::Command::new("osascript")
                                .arg("-e")
                                .arg(format!(
                                    r#"display dialog "Ark CLI installed.\n\nOpen a new terminal and run `ark --version` to verify." buttons {{"OK"}} default button "OK" with title "Ark Desktop" with icon note"#
                                ))
                                .output();
                        }
                        Err(e) => {
                            warn!(error = %e, "CLI install failed");
                        }
                    }
                } else {
                    info!("user declined CLI install");
                }
            }
            Err(e) => {
                warn!(error = %e, "failed to show CLI install dialog");
            }
        }
    });
}

/// Install the CLI by symlinking the embedded sidecar binary to /usr/local/bin/ark.
/// Uses osascript on macOS for privilege elevation. Returns a human-readable
/// status message.
pub fn install_cli(handle: &tauri::AppHandle) -> Result<String, anyhow::Error> {
    let sidecar_path = sidecar::sidecar_binary_path(handle)
        .ok_or_else(|| anyhow::anyhow!("No bundled sidecar binary found in this app bundle"))?;

    // If already installed and pointing to the right place, report success.
    if let Ok(target) = std::fs::read_link(CLI_PATH) {
        if target == sidecar_path {
            return Ok(format!("CLI already installed at {} (symlink OK)", CLI_PATH));
        }
    }

    let sidecar_str = sidecar_path.to_string_lossy().to_string();

    #[cfg(target_os = "macos")]
    {
        create_symlink_with_auth(&sidecar_str)?;
    }

    #[cfg(target_os = "linux")]
    {
        // On Linux, try direct symlink first (works if /usr/local/bin is writable).
        if std::os::unix::fs::symlink(&sidecar_str, CLI_PATH).is_err() {
            // Fall back to pkexec for privilege elevation.
            let status = std::process::Command::new("pkexec")
                .args(["ln", "-sf", &sidecar_str, CLI_PATH])
                .status()?;
            if !status.success() {
                return Err(anyhow::anyhow!("pkexec ln failed with status {}", status));
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        // Windows: copy the binary rather than symlink (symlinks need admin on
        // older Windows). The NSIS installer can handle PATH manipulation.
        let dest = dirs_home_win()
            .map(|h| h.join(".ark").join("bin").join("ark.exe"))
            .ok_or_else(|| anyhow::anyhow!("could not determine home directory"))?;
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(&sidecar_path, &dest)?;
        return Ok(format!(
            "CLI copied to {}. Add this directory to your PATH.",
            dest.display()
        ));
    }

    Ok(format!("CLI installed at {}", CLI_PATH))
}

/// Create a symlink using osascript's `do shell script ... with administrator privileges`.
/// This shows the standard macOS auth dialog -- no raw sudo.
#[cfg(target_os = "macos")]
fn create_symlink_with_auth(sidecar_path: &str) -> Result<(), anyhow::Error> {
    // Ensure /usr/local/bin exists.
    let script = format!(
        r#"do shell script "mkdir -p /usr/local/bin && ln -sf '{}' '{}'" with administrator privileges"#,
        sidecar_path, CLI_PATH
    );
    let output = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // User cancelled the auth dialog -- not an error.
        if stderr.contains("User canceled") || stderr.contains("-128") {
            return Err(anyhow::anyhow!("User cancelled authentication"));
        }
        return Err(anyhow::anyhow!("osascript failed: {}", stderr.trim()));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn dirs_home_win() -> Option<std::path::PathBuf> {
    std::env::var_os("USERPROFILE").map(std::path::PathBuf::from)
}
