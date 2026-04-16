//! Ark Desktop -- Tauri v2 shell.
//!
//! This is a thin Rust wrapper around the Ark web UI:
//!
//!   1. Find the `ark` CLI binary (bundled sidecar or PATH fallback).
//!   2. Find a free port starting at 8420.
//!   3. Spawn `ark web --port <port> --with-daemon` as a child process in a
//!      fresh process group so we can cleanly kill the whole tree on quit.
//!   4. Poll `GET http://localhost:<port>/api/health` until 200 OK.
//!   5. Navigate the main window to that URL and show it.
//!   6. On app quit: SIGTERM the entire process group, SIGKILL after 2s.
//!
//! As of v0.17.1 the `ark` binary is embedded inside the app bundle via
//! Tauri's `externalBin` mechanism, so users do not need to install
//! anything separately. On first launch the app offers to symlink the
//! embedded binary to `/usr/local/bin/ark` for terminal access.
//!
//! Logging is via `tracing`; set `RUST_LOG=ark_desktop_lib=debug` for
//! verbose output during development.

mod cli_install;
mod sidecar;
mod window;

use anyhow::{Context, Result};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, RunEvent};
use tracing::{error, info, warn};

use crate::sidecar::Sidecar;

/// Entry point reused by both the binary (`main.rs`) and integration tests.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize tracing. `RUST_LOG=ark_desktop_lib=debug` for dev output.
    // In release builds we still respect the env var but default to `info`.
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(false)
        .try_init();

    // Shared sidecar handle: populated by `setup` once the server is healthy,
    // taken by the `RunEvent::Exit` handler on quit.
    let sidecar: Arc<Mutex<Option<Sidecar>>> = Arc::new(Mutex::new(None));
    let sidecar_for_setup = sidecar.clone();
    let sidecar_for_event = sidecar.clone();

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![install_cli_command]);

    // Single-instance is desktop only -- no-op on mobile targets.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Another launch: focus the existing window instead of spawning a
            // second server.
            info!("second-instance attempted; focusing existing window");
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
            // Emit for any listeners (e.g. future deep-link handlers).
            let _ = app.emit("single-instance", ());
        }));
    }

    builder
        .setup(move |app| {
            let handle = app.handle().clone();
            let sidecar_slot = sidecar_for_setup.clone();

            // Boot the sidecar + wait for /api/health on a background task so
            // we don't block the main thread. The main window stays hidden
            // (configured `visible: false`) until the probe completes, so
            // users don't see a flash of unstyled content.
            tauri::async_runtime::spawn(async move {
                match boot_sidecar(&handle).await {
                    Ok(sc) => {
                        info!(port = sc.port(), "ark web ready");
                        let url = format!("http://localhost:{}/", sc.port());
                        {
                            let mut slot = sidecar_slot.lock().unwrap();
                            *slot = Some(sc);
                        }
                        if let Err(e) = window::show_main_window(&handle, &url) {
                            error!(error = %e, "failed to show main window");
                        }

                        // After the UI is up, check if the CLI is installed.
                        // On macOS, offer to symlink the embedded binary to
                        // /usr/local/bin/ark on first launch.
                        #[cfg(target_os = "macos")]
                        cli_install::check_and_offer_cli_install(&handle);
                    }
                    Err(e) => {
                        error!(error = %e, "sidecar boot failed");
                        window::show_error(
                            &handle,
                            "Startup Error",
                            &format!("Ark server failed to start:\n\n{e}"),
                        );
                        handle.exit(1);
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Ark desktop")
        .run(move |_app, event| match event {
            RunEvent::ExitRequested { .. } | RunEvent::Exit => {
                // Clean shutdown: kill the whole sidecar process group.
                if let Ok(mut slot) = sidecar_for_event.lock() {
                    if let Some(sc) = slot.take() {
                        info!("shutting down sidecar");
                        if let Err(e) = sc.shutdown() {
                            warn!(error = %e, "sidecar shutdown error");
                        }
                    }
                }
            }
            _ => {}
        });
}

/// Tauri IPC command: install the CLI by symlinking the embedded sidecar.
/// Wired as a menu item "Install CLI Tools..." in the app.
#[tauri::command]
async fn install_cli_command(handle: tauri::AppHandle) -> std::result::Result<String, String> {
    cli_install::install_cli(&handle).map_err(|e| e.to_string())
}

/// Find ark, pick a port, launch the server, wait for health.
async fn boot_sidecar(handle: &tauri::AppHandle) -> Result<Sidecar> {
    let ark_bin = sidecar::find_ark_binary(handle).context(
        "Could not find the `ark` CLI. The bundled sidecar is missing and ark is not on PATH.",
    )?;
    info!(path = %ark_bin.display(), "found ark binary");

    let port = sidecar::pick_port(8420).context("No free port available")?;
    info!(port, "selected port");

    let sc = Sidecar::spawn(&ark_bin, port).context("Failed to spawn `ark web`")?;
    sc.wait_healthy(std::time::Duration::from_secs(30))
        .await
        .context("Ark server did not become healthy within 30s")?;
    Ok(sc)
}
