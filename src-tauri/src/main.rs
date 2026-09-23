// Tauri 2 desktop shell for TBAi.
//
// Architecture: Tauri window (no system title bar) -> loads the origin of the
// verified web port, served by a bundled Bun sidecar running the existing
// Hono API + SPA.
//
// Startup invariant (hard): a listening TCP port is NEVER sufficient
// readiness evidence. Every boot mints a fresh UUID, the sidecar serves it
// at GET /api/server/instance, and the WebView navigates ONLY on an exact
// match. Anything else (foreign server, old build, timeout, sidecar exit)
// renders the bundled local error page — never another process's content.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::OpenOptions;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use fs2::FileExt;
use tauri::{AppHandle, Manager, State, WindowEvent};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Bundled startup-failure page. Rendered with zero backend availability.
const STARTUP_ERROR_HTML: &str = include_str!("../resources/startup-error.html");

/// Overall budget for one startup attempt (spawn → verified → navigate).
const STARTUP_TIMEOUT: Duration = Duration::from_secs(25);
/// Identity re-poll cadence, and the background re-verify cadence.
const POLL_INTERVAL: Duration = Duration::from_millis(250);
/// Per-probe HTTP timeout against the candidate port.
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
/// How far above the configured port the pre-heal scan may go.
const HEAL_SCAN_LIMIT: u32 = 100;
/// Bounded sidecar diagnostics: forward at most this many stderr lines.
const STDERR_LINE_CAP: usize = 200;

/// Fixed launch inputs, resolved once per app boot.
struct StartupConfig {
    data_dir: PathBuf,
    backend: PathBuf,
    web_dist: PathBuf,
}

/// Owned runtime state: exactly one folder lock, one sidecar, one exit note.
/// The lock file handle is HELD here for the instance lifetime — Windows
/// releases it automatically if this process dies, so a crash never wedges
/// the next launch.
struct StartupOwned {
    lock: Mutex<Option<std::fs::File>>,
    child: Mutex<Option<CommandChild>>,
    exited: Mutex<Option<String>>,
    /// Set once an identity-verified navigation happens; the backstop only
    /// re-attempts while this is false.
    verified: Mutex<bool>,
    /// Start of the most recent attempt; the backstop never overlaps a
    /// running attempt (attempts budget 25 s, backstop requires 30 s idle).
    last_start: Mutex<Instant>,
}

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

/// Port mirror written by the backend on every boot and every port change.
/// Rejects non-numeric/out-of-range content so a corrupt file can never
/// produce a broken origin URL. Absent/unreadable → the default.
fn read_mirror_port(data_dir: &PathBuf) -> u32 {
    if let Ok(raw) = std::fs::read_to_string(data_dir.join("port")) {
        if let Ok(n) = raw.trim().parse::<u32>() {
            if (1..=65535).contains(&n) {
                return n;
            }
        }
    }
    3000
}

fn write_mirror_port(data_dir: &PathBuf, port: u32) {
    let _ = std::fs::create_dir_all(data_dir);
    let _ = std::fs::write(data_dir.join("port"), format!("{port}\n"));
}

/// True when nothing accepts TCP on the port (local probe only).
fn port_free(port: u32) -> bool {
    std::net::TcpStream::connect(format!("127.0.0.1:{port}")).is_err()
}

/// Ask the candidate port who it is. Returns the reported instance id, or a
/// short diagnostic class when the answer is anything but a verifiable match.
fn fetch_instance(port: u32) -> Result<String, &'static str> {
    let url = format!("127.0.0.1:{port}/api/server/instance");
    // ureq 2 surfaces non-2xx as Error::Status: a 404 here means "a server,
    // but not a current TBAi one" (old build or foreign process) — which is
    // exactly as unverified as silence, and must never be navigated to.
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

fn read_minimized(data_dir: &PathBuf) -> bool {
    std::fs::read_to_string(data_dir.join("start-minimized"))
        .map(|s| s.trim() == "1")
        .unwrap_or(false)
}

/// Full quit: stop the owned sidecar, then end the process (the folder lock
/// releases via handle drop). Used by the tray menu and the Settings Quit
/// button — the ONLY desktop paths that end the server. Window ❌ does NOT
/// come here: close hides to tray and the server keeps running.
fn quit_owned(app: &AppHandle) {
    if let Some(owned) = app.try_state::<StartupOwned>() {
        if let Some(child) = owned.child.lock().expect("child lock").take() {
            let _ = child.kill();
        }
    }
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    quit_owned(&app);
}

fn render_error(win: &tauri::WebviewWindow, port: u32, state: &str, sidecar: &str, reason: &str) {
    let page = STARTUP_ERROR_HTML
        .replace("{{PORT}}", &port.to_string())
        .replace("{{STATE}}", state)
        .replace("{{SIDECAR}}", sidecar)
        .replace("{{REASON}}", reason);
    // document.write through eval: no navigation happens, so no URL-capability
    // policy is involved and this works with zero backend availability. The
    // payload is JSON-encoded, never interpolated raw into script.
    let encoded = serde_json::to_string(&page).unwrap_or_else(|_| "\"\"".to_string());
    let _ = win.eval(format!("document.open();document.write({encoded});document.close();"));
    let _ = win.show();
    let _ = win.set_focus();
}

fn navigate_verified(win: &tauri::WebviewWindow, port: u32, minimized: bool) {
    let origin = format!("http://localhost:{port}");
    if let Some(tray) = win.app_handle().tray_by_id("main") {
        let _ = tray.set_tooltip(format!("TBAi · port {port}").into());
    }
    if minimized {
        // Tray-only boot: the window stays hidden until the user Opens it.
        return;
    }
    let _ = win.eval(format!("location.href='{origin}'"));
    let _ = win.show();
    let _ = win.set_focus();
}

/// One startup attempt: kill any previous sidecar, hold the folder lock, pick
/// a free port, spawn exactly one owned sidecar, and navigate ONLY on an
/// instance-id match. Every other outcome renders the local error page.
fn attempt(app: &AppHandle) {
    let cfg: State<StartupConfig> = app.state();
    let owned: State<StartupOwned> = app.state();
    let win = match app.get_webview_window("main") {
        Some(win) => win,
        None => return,
    };

    // Exactly one owned sidecar: stop the previous attempt's child first.
    if let Some(child) = owned.child.lock().expect("child lock").take() {
        let _ = child.kill();
    }
    *owned.exited.lock().expect("exited lock") = None;
    *owned.last_start.lock().expect("start lock") = Instant::now();

    // Held OS file lock on the data dir: a second copy pointed at the same
    // folder fails here instead of sharing one SQLite file. The handle stays
    // in `owned` for the instance lifetime; Windows releases it on crash.
    let lock_path = cfg.data_dir.join(".lock");
    let _ = std::fs::create_dir_all(&cfg.data_dir);
    let lock_file = match OpenOptions::new().create(true).write(true).open(&lock_path) {
        Ok(file) => file,
        Err(err) => {
            render_error(
                &win,
                0,
                "locked",
                "not started",
                &format!("Could not open the data lock ({err}). The data folder may not be writable."),
            );
            return;
        }
    };
    if lock_file.try_lock_exclusive().is_err() {
        render_error(
            &win,
            0,
            "locked",
            "not started",
            "Another TBAi copy is already running from this data folder. Duplicate the portable folder for a second copy.",
        );
        return;
    }
    *owned.lock.lock().expect("folder lock") = Some(lock_file);

    // Fresh identity for this attempt only — never persisted, never reused.
    let expected = uuid::Uuid::new_v4().to_string();

    // Self-healing rendezvous: ensure the mirror names a free port BEFORE
    // spawning (no PORT env is passed, so the Settings UI stays editable).
    // The backend re-heals on a TOCTOU collision, so the poll loop below
    // re-reads the mirror every iteration instead of trusting this value.
    let mut port = read_mirror_port(&cfg.data_dir);
    for _ in 0..=HEAL_SCAN_LIMIT {
        if port_free(port) {
            break;
        }
        port += 1;
    }
    write_mirror_port(&cfg.data_dir, port);

    let sidecar = match app.shell().sidecar("bun") {
        Ok(sidecar) => sidecar,
        Err(err) => {
            render_error(&win, port, "spawn_failed", "not started",
                &format!("Sidecar binary missing or not executable ({err})."));
            return;
        }
    };
    let (mut rx, child) = match sidecar
        .args(["run", &cfg.backend.to_string_lossy()])
        .env("TBAI_INSTANCE_ID", &expected)
        .env("WEB_DIST_DIR", cfg.web_dist.to_string_lossy().to_string())
        .env("DATA_DIR", cfg.data_dir.to_string_lossy().to_string())
        .spawn()
    {
        Ok(pair) => pair,
        Err(err) => {
            render_error(&win, port, "spawn_failed", "not started",
                &format!("Could not start the local server ({err})."));
            return;
        }
    };
    *owned.child.lock().expect("child lock") = Some(child);

    // Bounded diagnostics + sidecar-exit watch on the event channel.
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = 0usize;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stderr(line) => {
                    lines += 1;
                    if lines <= STDERR_LINE_CAP {
                        eprintln!("[bun] {}", String::from_utf8_lossy(&line));
                    } else if lines == STDERR_LINE_CAP + 1 {
                        eprintln!("[bun] (further sidecar output suppressed)");
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let note = format!("exited (code {:?}, signal {:?})", payload.code, payload.signal);
                    if let Some(owned) = app_handle.try_state::<StartupOwned>() {
                        *owned.exited.lock().expect("exited lock") = Some(note);
                    }
                    break;
                }
                _ => {}
            }
        }
    });

    // Identity verification: poll until match, sidecar exit, or timeout.
    // The mirror is re-read every pass — the backend may have healed past a
    // last-moment collision to a different port than we spawned for.
    let start = Instant::now();
    let mut last_state = "no_listener";
    let mut verified_port: Option<u32> = None;
    while start.elapsed() < STARTUP_TIMEOUT {
        if owned.exited.lock().expect("exited lock").is_some() {
            break;
        }
        let candidate = read_mirror_port(&cfg.data_dir);
        match fetch_instance(candidate) {
            Ok(id) if id == expected => {
                verified_port = Some(candidate);
                break;
            }
            Ok(_) => {
                last_state = "identity_mismatch";
                break;
            }
            Err(state) => {
                last_state = state;
            }
        }
        std::thread::sleep(POLL_INTERVAL);
    }

    match verified_port {
        Some(port) => {
            *owned.verified.lock().expect("verified lock") = true;
            navigate_verified(&win, port, read_minimized(&cfg.data_dir));
        }
        None => {
            let (state, sidecar, reason) =
                match owned.exited.lock().expect("exited lock").clone() {
                    Some(note) => ("sidecar_exited", note, "The local server process ended before it could be verified. Its port (if any) was left alone — TBAi did not connect to whatever else may be listening there.".to_string()),
                    None if last_state == "identity_mismatch" => (
                        "identity_mismatch",
                        "running (foreign)".to_string(),
                        "The port answered with a different instance id — likely a development or another copy's server. TBAi refused to connect to it.".to_string(),
                    ),
                    None if last_state == "old_build_or_foreign" => (
                        "unverified_server",
                        "running (unverified)".to_string(),
                        "The port serves HTTP but has no instance identity (old build or another application). TBAi refused to connect to it.".to_string(),
                    ),
                    None => (
                        "timeout",
                        "unknown".to_string(),
                        "The owned server did not answer in time. It may still be starting — Retry makes a fresh attempt.".to_string(),
                    ),
                };
            render_error(&win, read_mirror_port(&cfg.data_dir), state, &sidecar, &reason);
        }
    }
}

/// Retry from the bundled error page: a completely fresh attempt (new UUID,
/// previous sidecar stopped first). Returns immediately; the attempt runs on
/// a worker thread. A background re-verify also runs so recovery does not
/// depend on this invoke succeeding.
#[tauri::command]
fn retry_startup(app: AppHandle) {
    std::thread::spawn(move || attempt(&app));
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let backend = resolve_resource("backend/index.js")
                .expect("backend bundle (dist/index.js) not found in resources");
            let web_dist = resolve_resource("web")
                .expect("web/dist not found in resources");
            let data_dir = resolve_data_dir();

            app.manage(StartupConfig { data_dir, backend, web_dist });
            app.manage(StartupOwned {
                lock: Mutex::new(None),
                child: Mutex::new(None),
                exited: Mutex::new(None),
                verified: Mutex::new(false),
                last_start: Mutex::new(Instant::now()),
            });

            // System tray: Open restores the window, Quit stops the owned
            // sidecar and ends the process. Best-effort by design — a missing
            // icon must never prevent boot, so failures only log.
            if let Some(icon) = app.default_window_icon().cloned() {
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
                        .on_menu_event(|app, event| match event.id.as_ref() {
                            "open" => {
                                if let Some(win) = app.get_webview_window("main") {
                                    let _ = win.show();
                                    let _ = win.set_focus();
                                }
                            }
                            "quit" => quit_owned(app),
                            _ => {}
                        })
                        .on_tray_icon_event(|tray, event| {
                            if matches!(event, TrayIconEvent::Click { .. }) {
                                let app = tray.app_handle();
                                if let Some(win) = app.get_webview_window("main") {
                                    let _ = win.show();
                                    let _ = win.set_focus();
                                }
                            }
                        })
                        .build(app)?;
                    Ok(())
                })();
                if let Err(err) = tray_result {
                    eprintln!("[tray] disabled: {err}");
                }
            }

            // Close hides to tray — the server keeps running. Full quit is
            // ONLY via tray Quit / Settings Quit (quit_owned), never ❌.
            if let Some(win) = app.get_webview_window("main") {
                let hidden = win.clone();
                win.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = hidden.hide();
                    }
                });
            }

            let handle = app.handle().clone();
            std::thread::spawn(move || attempt(&handle));
            // Backstop: recovery must not depend on the error page's Retry
            // invoke succeeding. Every 5 s, if nothing verified yet and no
            // attempt is still inside its budget, make a fresh attempt (new
            // UUID, previous child stopped first — the uniform recovery path).
            let watch = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(5));
                let (verified, idle) = match watch.try_state::<StartupOwned>() {
                    Some(owned) => (
                        *owned.verified.lock().expect("verified lock"),
                        owned.last_start.lock().expect("start lock").elapsed(),
                    ),
                    None => (true, Duration::ZERO),
                };
                if !verified && idle > Duration::from_secs(30) {
                    attempt(&watch);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![retry_startup, quit_app])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
