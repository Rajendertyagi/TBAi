// Tauri 2 desktop shell for TBAi.
//
// Architecture: Tauri window (no system title bar) -> loads http://localhost:3000
// which is served by a bundled Bun sidecar running the existing Hono API + SPA.
// No transport abstraction, no new backend event architecture, no changes to the
// existing AI streaming — the webview simply talks to the local Hono server like
// a normal browser would.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::time::{Duration, Instant};

use tauri::Manager;

/// Resolve a bundled resource by trying the common Tauri layout candidates
/// (resources next to the exe, or in a `resources` subfolder). Avoids depending
/// on the path plugin so the only runtime deps are shell + opener.
fn resolve_resource(rel: &str) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let base = exe.parent()?;
    let candidates = [
        base.join(rel),
        base.join("resources").join(rel),
        base.join("..").join("resources").join(rel),
        base.join("..").join(rel),
    ];
    candidates.into_iter().find(|p| p.exists())
}

/// Data dir: prefer a `data` folder next to the executable (portable, writable),
/// falling back to the current directory.
fn resolve_data_dir() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            return parent.join("data");
        }
    }
    PathBuf::from("data")
}

/// Block until the Bun sidecar's HTTP server accepts a TCP connection, or the
/// timeout elapses. Keeps the (initially hidden) window from flashing an error
/// page before the backend is up.
fn wait_for_port(addr: &str, timeout: Duration) {
    let start = Instant::now();
    loop {
        if std::net::TcpStream::connect(addr).is_ok() {
            return;
        }
        if start.elapsed() > timeout {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();

            let backend = resolve_resource("backend/index.js")
                .expect("backend bundle (dist/index.js) not found in resources");
            let web_dist = resolve_resource("web")
                .expect("web/dist not found in resources");
            let data_dir = resolve_data_dir();
            let _ = std::fs::create_dir_all(&data_dir);

            let sidecar = app
                .shell()
                .sidecar("bun")
                .expect("bun sidecar binary missing (src-tauri/binaries/bun-*.exe)");

            let (mut rx, _child) = sidecar
                .args(["run", &backend.to_string_lossy()])
                .env("PORT", "3000")
                .env("WEB_DIST_DIR", web_dist.to_string_lossy().to_string())
                .env("DATA_DIR", data_dir.to_string_lossy().to_string())
                .spawn()
                .expect("failed to spawn bun sidecar");

            // Forward sidecar stderr to the host console for diagnostics.
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    if let tauri_plugin_shell::ShellEvent::Stderr(line) = event {
                        eprintln!("[bun] {}", String::from_utf8_lossy(&line));
                    }
                }
            });

            // Reveal the window only once the backend is reachable.
            if let Some(win) = app.get_webview_window("main") {
                let win_clone = win.clone();
                std::thread::spawn(move || {
                    wait_for_port("127.0.0.1:3000", Duration::from_secs(20));
                    let _ = win_clone.eval("location.href='http://localhost:3000'");
                    let _ = win_clone.show();
                    let _ = win_clone.set_focus();
                });
            }

            let _ = handle;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
