//! Window navigation + display helpers.
//!
//! The main window is declared in `tauri.conf.json` with `visible: false` so
//! there is no flash of unstyled content while we boot the sidecar. Once the
//! health probe passes, `show_main_window` navigates it to the live URL and
//! toggles visibility on.

use anyhow::{anyhow, Context, Result};
use tauri::{AppHandle, Manager};
use tracing::{info, warn};

pub fn show_main_window(handle: &AppHandle, url: &str) -> Result<()> {
    let window = handle
        .get_webview_window("main")
        .ok_or_else(|| anyhow!("main window missing"))?;

    let target: tauri::Url = url
        .parse()
        .with_context(|| format!("could not parse sidecar URL: {url}"))?;

    info!(%target, "navigating main window");
    window
        .navigate(target)
        .context("failed to navigate main window")?;
    window.show().context("failed to show main window")?;
    let _ = window.set_focus();
    Ok(())
}

/// Display a minimal blocking dialog on a critical failure and log it.
///
/// Uses a tiny webview window rather than dialog boxes so we do not take
/// a dependency on `tauri-plugin-dialog` for this one error path. The
/// message is embedded as a data URL.
pub fn show_error(handle: &AppHandle, title: &str, message: &str) {
    warn!(title, message, "showing error window");
    let html = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{title}</title>\
         <style>body{{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;\
         background:#1a1b26;color:#c0caf5;padding:32px;line-height:1.5}}\
         h1{{color:#f7768e;margin:0 0 12px 0;font-size:18px}}\
         pre{{background:#16161e;padding:12px;border-radius:6px;white-space:pre-wrap;\
         font-family:'SF Mono',Menlo,monospace;font-size:13px}}</style></head>\
         <body><h1>{title}</h1><pre>{msg}</pre></body></html>",
        title = html_escape(title),
        msg = html_escape(message)
    );
    let data_url = format!("data:text/html;base64,{}", base64_standard(&html));
    // The main window is declared in tauri.conf.json so it always exists at
    // this point. If navigation fails for any reason, we just log -- a
    // follow-up PR can add `tauri-plugin-dialog` for a proper native dialog.
    if let Some(window) = handle.get_webview_window("main") {
        match data_url.parse::<tauri::Url>() {
            Ok(u) => {
                let _ = window.navigate(u);
                let _ = window.show();
            }
            Err(e) => {
                warn!(error = %e, "failed to build error data URL");
            }
        }
    } else {
        warn!("main window missing when attempting to show error");
    }
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Tiny dependency-free base64 encoder (RFC 4648 standard alphabet).
/// Used only for the error dialog data URL, so perf does not matter.
fn base64_standard(input: &str) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = if chunk.len() > 1 { chunk[1] } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] } else { 0 };
        let n = ((b0 as u32) << 16) | ((b1 as u32) << 8) | (b2 as u32);
        out.push(ALPHABET[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 0x3f) as usize] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[((n >> 6) & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[(n & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}
