// Tauri 2 desktop shell for TBAi.
//
// Architecture:
// 1. Desktop frontend is loaded independently from Bun via custom Tauri protocol
//    `app://localhost`, which maps to the loose `<exe_dir>/web/` directory.
// 2. Bun sidecar (`tbai-server`) starts asynchronously in the background and is
//    the sole authority for backend port binding and self-healing.
// 3. Rust verifies the running Bun instance via GET /api/server/instance with
//    the per-launch `TBAI_INSTANCE_ID` and exposes `get_api_endpoint`.
// 4. Unexpected sidecar exits trigger bounded recovery (max 3 restarts in 30s).
//    The WebView is never navigated or reloaded during recovery or port change.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use fs2::FileExt;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Overall budget for one backend startup attempt.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(25);
/// Identity re-poll cadence.
const POLL_INTERVAL: Duration = Duration::from_millis(250);
/// Per-probe HTTP timeout against the candidate port.
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
/// Highest valid TCP port.
const MAX_PORT: u32 = 65535;
/// Bounded sidecar diagnostics: forward at most this many stderr lines.
const STDERR_LINE_CAP: usize = 200;

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct EndpointInfo {
    pub port: u32,
    pub base_url: String,
    pub instance_id: String,
}

/// Fixed launch inputs, resolved once per app boot.
struct StartupConfig {
    data_dir: PathBuf,
}

/// Owned runtime state: process lock, sidecar child, endpoint and crash tracking.
struct StartupOwned {
    lock: Mutex<Option<std::fs::File>>,
    child: Mutex<Option<CommandChild>>,
    exited: Mutex<Option<String>>,
    verified: Mutex<bool>,
    verified_endpoint: Mutex<Option<EndpointInfo>>,
    status: Mutex<String>,
    crash_count: Mutex<u32>,
    crash_window_start: Mutex<Instant>,
    is_quitting: AtomicBool,
    is_starting: AtomicBool,
    last_start: Mutex<Instant>,
}

/// Resolve the loose web directory containing frontend assets.
fn resolve_web_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let base = exe.parent()?;
    let candidates = [
        base.join("web"),
        base.join("resources").join("web"),
        base.join("..").join("web"),
        base.join("..").join("dist").join("web"),
    ];
    candidates.into_iter().find(|p| p.is_dir())
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

/// Port mirror written by the Bun backend on every boot and every port change.
fn read_mirror_port(data_dir: &Path) -> u32 {
    if let Ok(raw) = std::fs::read_to_string(data_dir.join("port")) {
        if let Ok(n) = raw.trim().parse::<u32>() {
            if (1..=MAX_PORT).contains(&n) {
                return n;
            }
        }
    }
    3000
}

fn read_minimized(data_dir: &Path) -> bool {
    std::fs::read_to_string(data_dir.join("start-minimized"))
        .map(|s| s.trim() == "1")
        .unwrap_or(false)
}

/// Decode a percent-encoded URL string without external dependencies.
fn percent_decode(input: &str) -> String {
    let mut bytes = Vec::with_capacity(input.len());
    let mut chars = input.bytes();
    while let Some(b) = chars.next() {
        if b == b'%' {
            let h1 = chars.next();
            let h2 = chars.next();
            if let (Some(h1), Some(h2)) = (h1, h2) {
                let hex_str = [h1, h2];
                if let Ok(s) = std::str::from_utf8(&hex_str) {
                    if let Ok(val) = u8::from_str_radix(s, 16) {
                        bytes.push(val);
                        continue;
                    }
                }
            }
        }
        bytes.push(b);
    }
    String::from_utf8_lossy(&bytes).to_string()
}

/// Map file extensions emitted by Vite to MIME types.
fn get_mime_type(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "wasm" => "application/wasm",
        "json" => "application/json; charset=utf-8",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        _ => "application/octet-stream",
    }
}

/// Safe custom protocol handler serving loose `<exe_dir>/web/` assets.
fn handle_asset_request(request: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let Some(web_dir) = resolve_web_dir() else {
        return tauri::http::Response::builder()
            .status(500)
            .body(b"Web assets directory not found".to_vec())
            .unwrap();
    };
    let Ok(canonical_root) = web_dir.canonicalize() else {
        return tauri::http::Response::builder()
            .status(500)
            .body(b"Could not canonicalize web assets directory".to_vec())
            .unwrap();
    };

    let path_raw = request.uri().path();
    let decoded_path = percent_decode(path_raw);
    let trimmed = decoded_path.trim_start_matches('/');
    let rel_str = if trimmed.is_empty() { "index.html" } else { trimmed };

    // Baseline security check: reject traversal and illegal characters
    if rel_str.contains("..") || rel_str.contains(':') || rel_str.contains('\0') {
        return tauri::http::Response::builder()
            .status(403)
            .body(b"Forbidden".to_vec())
            .unwrap();
    }

    let target_candidate = canonical_root.join(rel_str);
    if let Ok(canonical_target) = target_candidate.canonicalize() {
        if canonical_target.starts_with(&canonical_root) && canonical_target.is_file() {
            if let Ok(bytes) = std::fs::read(&canonical_target) {
                let mime = get_mime_type(&canonical_target);
                return tauri::http::Response::builder()
                    .status(200)
                    .header("content-type", mime)
                    .header("access-control-allow-origin", "*")
                    .body(bytes)
                    .unwrap();
            }
        }
    }

    // Distinguish missing asset from SPA route:
    // If the path has a file extension (.js, .css, .png, etc.), it was a specific asset -> return 404.
    let has_extension = Path::new(rel_str)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| !ext.is_empty())
        .unwrap_or(false);

    if has_extension {
        return tauri::http::Response::builder()
            .status(404)
            .body(b"Not Found".to_vec())
            .unwrap();
    }

    // Extensionless SPA route: fall back to index.html
    let index_path = canonical_root.join("index.html");
    if let Ok(bytes) = std::fs::read(&index_path) {
        return tauri::http::Response::builder()
            .status(200)
            .header("content-type", "text/html; charset=utf-8")
            .header("access-control-allow-origin", "*")
            .body(bytes)
            .unwrap();
    }

    tauri::http::Response::builder()
        .status(404)
        .body(b"Not Found".to_vec())
        .unwrap()
}

/// Ask the candidate port who it is.
fn fetch_instance(port: u32) -> Result<String, &'static str> {
    let url = format!("127.0.0.1:{port}/api/server/instance");
    let resp = match ureq::get(&format!("http://{url}"))
        .timeout(PROBE_TIMEOUT)
        .call()
    {
        Ok(resp) => resp,
        Err(ureq::Error::Status(404, _)) => return Err("old_build_or_foreign"),
        Err(_) => return Err("no_listener"),
    };
    let value: serde_json::Value = resp.into_json().map_err(|_| "bad_response")?;
    value
        .get("instanceId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or("bad_response")
}

/// Full quit: stop the owned sidecar, then end the process.
fn quit_owned(app: &AppHandle) {
    if let Some(owned) = app.try_state::<StartupOwned>() {
        owned.is_quitting.store(true, Ordering::SeqCst);
        if let Some(child) = owned.child.lock().expect("child lock").take() {
            let _ = child.kill();
        }
        *owned.exited.lock().expect("exited lock") = Some("user quit".to_string());
    }
    app.exit(0);
}

fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

fn is_tray_left_click_up(event: &TrayIconEvent) -> bool {
    matches!(
        event,
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        }
    )
}

/// One backend startup attempt: starts Bun sidecar in background, polls until verified.
fn attempt(app: &AppHandle) {
    let cfg: State<StartupConfig> = app.state();
    let owned: State<StartupOwned> = app.state();

    if owned.is_quitting.load(Ordering::SeqCst) {
        return;
    }
    if owned.is_starting.swap(true, Ordering::SeqCst) {
        // Prevent concurrent attempt calls
        return;
    }

    // Stop previous child if active
    if let Some(child) = owned.child.lock().expect("child lock").take() {
        let _ = child.kill();
    }
    *owned.exited.lock().expect("exited lock") = None;
    *owned.last_start.lock().expect("start lock") = Instant::now();
    *owned.status.lock().expect("status lock") = "starting".to_string();

    // Data folder lock
    {
        let mut lock_guard = owned.lock.lock().expect("folder lock");
        if lock_guard.is_none() {
            let lock_path = cfg.data_dir.join(".lock");
            let _ = std::fs::create_dir_all(&cfg.data_dir);
            if let Ok(file) = OpenOptions::new().create(true).write(true).open(&lock_path) {
                if file.try_lock_exclusive().is_ok() {
                    *lock_guard = Some(file);
                } else {
                    eprintln!("[lock] another TBAi instance is running with this data folder");
                    *owned.status.lock().expect("status lock") = "failed".to_string();
                    owned.is_starting.store(false, Ordering::SeqCst);
                    return;
                }
            }
        }
    }

    let expected = uuid::Uuid::new_v4().to_string();

    let sidecar = match app.shell().sidecar("tbai-server") {
        Ok(sidecar) => sidecar,
        Err(err) => {
            eprintln!("[server] sidecar binary missing or not executable ({err})");
            *owned.status.lock().expect("status lock") = "failed".to_string();
            let _ = app.emit(
                "backend-status",
                serde_json::json!({ "status": "failed", "reason": format!("Sidecar missing: {err}") }),
            );
            owned.is_starting.store(false, Ordering::SeqCst);
            return;
        }
    };

    let web_dist = resolve_web_dir().unwrap_or_else(|| cfg.data_dir.clone());
    let (mut rx, child) = match sidecar
        .env("TBAI_INSTANCE_ID", &expected)
        .env("WEB_DIST_DIR", web_dist.to_string_lossy().to_string())
        .env("DATA_DIR", cfg.data_dir.to_string_lossy().to_string())
        .spawn()
    {
        Ok(pair) => pair,
        Err(err) => {
            eprintln!("[server] spawn error: {err}");
            *owned.status.lock().expect("status lock") = "failed".to_string();
            let _ = app.emit(
                "backend-status",
                serde_json::json!({ "status": "failed", "reason": format!("Spawn error: {err}") }),
            );
            owned.is_starting.store(false, Ordering::SeqCst);
            return;
        }
    };
    *owned.child.lock().expect("child lock") = Some(child);

    // Diagnostics + termination watcher
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = 0usize;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stderr(line) => {
                    lines += 1;
                    if lines <= STDERR_LINE_CAP {
                        eprintln!("[server] {}", String::from_utf8_lossy(&line));
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let note = format!("exited (code {:?}, signal {:?})", payload.code, payload.signal);
                    eprintln!("[server] sidecar {note}");
                    if let Some(owned) = app_handle.try_state::<StartupOwned>() {
                        if owned.is_quitting.load(Ordering::SeqCst) {
                            break;
                        }
                        *owned.exited.lock().expect("exited lock") = Some(note);
                        *owned.verified.lock().expect("verified lock") = false;
                        *owned.verified_endpoint.lock().expect("endpoint lock") = None;

                        let mut count = owned.crash_count.lock().expect("crash count lock");
                        let mut window_start = owned.crash_window_start.lock().expect("window lock");
                        if window_start.elapsed() > Duration::from_secs(30) {
                            *window_start = Instant::now();
                            *count = 1;
                        } else {
                            *count += 1;
                        }
                        let current_count = *count;
                        drop(count);
                        drop(window_start);

                        if current_count > 3 {
                            *owned.status.lock().expect("status lock") = "failed".to_string();
                            let _ = app_handle.emit(
                                "backend-status",
                                serde_json::json!({
                                    "status": "failed",
                                    "reason": "Max crash retries exceeded (3 crashes within 30s)"
                                }),
                            );
                        } else {
                            *owned.status.lock().expect("status lock") = "recovering".to_string();
                            let _ = app_handle.emit(
                                "backend-status",
                                serde_json::json!({
                                    "status": "recovering",
                                    "reason": format!("Sidecar exited, retrying attempt {current_count}/3")
                                }),
                            );
                            let handle = app_handle.clone();
                            std::thread::spawn(move || {
                                std::thread::sleep(Duration::from_secs(1));
                                attempt(&handle);
                            });
                        }
                    }
                    break;
                }
                _ => {}
            }
        }
    });

    // Verification polling
    *owned.status.lock().expect("status lock") = "discovering".to_string();
    let start = Instant::now();
    let mut verified_port: Option<u32> = None;
    while start.elapsed() < STARTUP_TIMEOUT {
        if owned.exited.lock().expect("exited lock").is_some() {
            break;
        }
        let candidate = read_mirror_port(&cfg.data_dir);
        *owned.status.lock().expect("status lock") = "verifying".to_string();
        match fetch_instance(candidate) {
            Ok(id) if id == expected => {
                verified_port = Some(candidate);
                break;
            }
            Ok(_) => {
                // Foreign port or previous instance still shutting down
            }
            Err(_) => {}
        }
        std::thread::sleep(POLL_INTERVAL);
    }
    owned.is_starting.store(false, Ordering::SeqCst);

    match verified_port {
        Some(port) => {
            *owned.verified.lock().expect("verified lock") = true;
            *owned.status.lock().expect("status lock") = "ready".to_string();
            let endpoint = EndpointInfo {
                port,
                base_url: format!("http://127.0.0.1:{port}"),
                instance_id: expected,
            };
            *owned.verified_endpoint.lock().expect("endpoint lock") = Some(endpoint.clone());
            if let Some(tray) = app.tray_by_id("main") {
                let _ = tray.set_tooltip(format!("TBAi · port {port}").into());
            }
            let _ = app.emit("backend-ready", &endpoint);
            let _ = app.emit(
                "backend-status",
                serde_json::json!({ "status": "ready", "endpoint": endpoint }),
            );
        }
        None => {
            *owned.status.lock().expect("status lock") = "failed".to_string();
            let _ = app.emit(
                "backend-status",
                serde_json::json!({
                    "status": "failed",
                    "reason": "Backend failed to verify within startup timeout"
                }),
            );
        }
    }
}

#[tauri::command]
fn get_api_endpoint(app: AppHandle) -> Result<EndpointInfo, String> {
    let owned = app.state::<StartupOwned>();
    if let Some(endpoint) = owned.verified_endpoint.lock().expect("endpoint lock").clone() {
        return Ok(endpoint);
    }
    let start = Instant::now();
    while start.elapsed() < STARTUP_TIMEOUT {
        std::thread::sleep(Duration::from_millis(100));
        if let Some(endpoint) = owned.verified_endpoint.lock().expect("endpoint lock").clone() {
            return Ok(endpoint);
        }
        let status = owned.status.lock().expect("status lock").clone();
        if status == "failed" {
            return Err("Backend failed to start".to_string());
        }
    }
    Err("Timeout waiting for backend endpoint".to_string())
}

#[tauri::command]
fn update_verified_port(app: AppHandle, port: u32) -> Result<(), String> {
    let owned = app.state::<StartupOwned>();
    let mut ep_guard = owned.verified_endpoint.lock().expect("endpoint lock");
    if let Some(endpoint) = ep_guard.as_mut() {
        endpoint.port = port;
        endpoint.base_url = format!("http://127.0.0.1:{port}");
        let updated = endpoint.clone();
        drop(ep_guard);
        if let Some(tray) = app.tray_by_id("main") {
            let _ = tray.set_tooltip(format!("TBAi · port {port}").into());
        }
        let _ = app.emit("backend-ready", &updated);
    }
    Ok(())
}

#[tauri::command]
fn retry_startup(app: AppHandle) {
    if let Some(owned) = app.try_state::<StartupOwned>() {
        *owned.crash_count.lock().expect("crash count lock") = 0;
        *owned.exited.lock().expect("exited lock") = None;
    }
    let handle = app.clone();
    std::thread::spawn(move || attempt(&handle));
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    quit_owned(&app);
}

fn main() {
    tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("app", move |_ctx, request, responder| {
            std::thread::spawn(move || {
                let response = handle_asset_request(&request);
                responder.respond(response);
            });
        })
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .with_filename("window.json")
                .build(),
        )
        .setup(|app| {
            let data_dir = resolve_data_dir();
            app.manage(StartupConfig { data_dir: data_dir.clone() });
            app.manage(StartupOwned {
                lock: Mutex::new(None),
                child: Mutex::new(None),
                exited: Mutex::new(None),
                verified: Mutex::new(false),
                verified_endpoint: Mutex::new(None),
                status: Mutex::new("starting".to_string()),
                crash_count: Mutex::new(0),
                crash_window_start: Mutex::new(Instant::now()),
                is_quitting: AtomicBool::new(false),
                is_starting: AtomicBool::new(false),
                last_start: Mutex::new(Instant::now()),
            });

            // Start minimized if configured
            if read_minimized(&data_dir) {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.hide();
                }
            }

            // System tray
            let icon = match tauri::image::Image::from_bytes(include_bytes!("../app-icon.png")) {
                Ok(icon) => Some(icon),
                Err(err) => {
                    eprintln!("[tray] embedded icon decode failed: {err}");
                    app.default_window_icon().cloned()
                }
            };
            if let Some(icon) = icon {
                let tray_result: tauri::Result<()> = (|| {
                    let menu = Menu::with_items(
                        app,
                        &[
                            &MenuItem::with_id(app, "open", "Open TBAi", true, None::<&str>)?,
                            &MenuItem::with_id(app, "quit", "Quit TBAi", true, None::<&str>)?,
                        ],
                    )?;
                    TrayIconBuilder::with_id("main")
                        .icon(icon)
                        .tooltip("TBAi")
                        .menu(&menu)
                        .show_menu_on_left_click(false)
                        .on_menu_event(|app, event| match event.id.as_ref() {
                            "open" => show_main_window(app),
                            "quit" => quit_owned(app),
                            _ => {}
                        })
                        .on_tray_icon_event(|tray, event| {
                            if is_tray_left_click_up(&event) {
                                show_main_window(tray.app_handle());
                            }
                        })
                        .build(app)?;
                    Ok(())
                })();
                if let Err(err) = tray_result {
                    eprintln!("[tray] disabled: {err}");
                }
            }

            // Close hides to tray
            if let Some(win) = app.get_webview_window("main") {
                let hidden = win.clone();
                win.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = hidden.hide();
                    }
                });
            }

            // Asynchronously launch backend attempt
            let handle = app.handle().clone();
            std::thread::spawn(move || attempt(&handle));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_api_endpoint,
            update_verified_port,
            retry_startup,
            quit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::tray::TrayIconId;

    fn click(button: MouseButton, button_state: MouseButtonState) -> TrayIconEvent {
        TrayIconEvent::Click {
            id: TrayIconId::new("main"),
            position: tauri::PhysicalPosition::default(),
            rect: tauri::Rect::default(),
            button,
            button_state,
        }
    }

    #[test]
    fn left_click_up_is_the_reveal_gesture() {
        assert!(is_tray_left_click_up(&click(
            MouseButton::Left,
            MouseButtonState::Up
        )));
    }

    #[test]
    fn right_click_never_reveals() {
        assert!(!is_tray_left_click_up(&click(
            MouseButton::Right,
            MouseButtonState::Up
        )));
        assert!(!is_tray_left_click_up(&click(
            MouseButton::Right,
            MouseButtonState::Down
        )));
    }

    #[test]
    fn left_click_press_does_not_reveal() {
        assert!(!is_tray_left_click_up(&click(
            MouseButton::Left,
            MouseButtonState::Down
        )));
    }

    #[test]
    fn middle_click_never_reveals() {
        assert!(!is_tray_left_click_up(&click(
            MouseButton::Middle,
            MouseButtonState::Up
        )));
    }

    #[test]
    fn percent_decode_handles_basic_and_escaped() {
        assert_eq!(percent_decode("hello%20world"), "hello world");
        assert_eq!(percent_decode("assets/app%2Bicon.png"), "assets/app+icon.png");
        assert_eq!(percent_decode("/plain/path"), "/plain/path");
    }

    #[test]
    fn mime_type_mapping() {
        assert_eq!(get_mime_type(Path::new("index.html")), "text/html; charset=utf-8");
        assert_eq!(get_mime_type(Path::new("app.js")), "application/javascript; charset=utf-8");
        assert_eq!(get_mime_type(Path::new("app.css")), "text/css; charset=utf-8");
        assert_eq!(get_mime_type(Path::new("logo.svg")), "image/svg+xml");
        assert_eq!(get_mime_type(Path::new("icon.png")), "image/png");
        assert_eq!(get_mime_type(Path::new("font.woff2")), "font/woff2");
        assert_eq!(get_mime_type(Path::new("binary.wasm")), "application/wasm");
    }
}
