// Sidecr native shell: one frameless, translucent, always-on-top window around the local Sidecr page.
// The Bun server and the page do all the work; this only opens the window, keeps one instance and
// turns an OS close (Alt+F4, the taskbar) into the page's own close, so the page can say bye first.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cli;
mod lightbox;
mod placement;
#[cfg(windows)]
mod webview_args;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[cfg(windows)]
use tauri::{utils::config::WindowEffectsConfig, window::Effect};
use tauri::{window::Color, Emitter, Manager, PhysicalPosition, PhysicalSize, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};

/// The page listens for this and runs its unload steps (draft, bounds, bye), then destroys the window.
const CLOSE_REQUESTED_EVENT: &str = "sidecr:close-requested";
/// A page that does not answer the close request (hung) is destroyed after this long.
const CLOSE_GRACE: Duration = Duration::from_millis(1500);

/// Sent to the main page when the lightbox window has closed, so the composer gets the focus back.
const LIGHTBOX_CLOSED_EVENT: &str = "sidecr:lightbox-closed";

static CLOSING: AtomicBool = AtomicBool::new(false);
/// Set when the main window is destroyed: a lightbox still being created must not outlive it.
static MAIN_GONE: AtomicBool = AtomicBool::new(false);
/// One lightbox creation at a time: a second call waits, then finds the window and loads its images into it.
static LIGHTBOX_OPENING: Mutex<()> = Mutex::new(());

/// Sidecr is closing or closed: no lightbox may be created now.
fn main_gone(app: &tauri::AppHandle) -> bool {
    CLOSING.load(Ordering::SeqCst) || MAIN_GONE.load(Ordering::SeqCst) || app.get_webview_window("main").is_none()
}

/// The URL the main window was last told to load: the navigation guards of both windows allow only its origin.
struct Launch(Arc<Mutex<Url>>);

/// The window effect from the start arguments (the user's settings; the page re-applies them once loaded).
#[cfg(windows)]
fn start_effects(args: &cli::Args) -> Option<WindowEffectsConfig> {
    let effect = match args.effect.unwrap_or(cli::StartEffect::Acrylic) {
        cli::StartEffect::Acrylic => Effect::Acrylic,
        cli::StartEffect::Mica => Effect::MicaDark,
        cli::StartEffect::Blur => Effect::Blur,
        cli::StartEffect::None => return None,
    };
    Some(WindowEffectsConfig {
        effects: vec![effect],
        state: None,
        radius: None,
        color: Some(Color(20, 20, 20, args.tint.unwrap_or(cli::DEFAULT_TINT))),
        interactive: false,
    })
}

/// Opens (or reuses) the lightbox: a second window covering the monitor the main window is on, black, showing the
/// page's images. The only app command; its permission (`allow-open-lightbox`) is granted to the main window's
/// loopback page alone. Async: creating a window from a synchronous command deadlocks on Windows.
#[tauri::command]
async fn open_lightbox(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    launch: tauri::State<'_, Launch>,
    srcs: Vec<String>,
    index: usize,
) -> Result<(), String> {
    if !lightbox::allowed_caller(window.label()) {
        return Err("only the main window opens the lightbox".into());
    }
    let _one = LIGHTBOX_OPENING.lock().map_err(|_| "lightbox unavailable".to_string())?;
    let shared = Arc::clone(&launch.0);
    let origin = shared.lock().map_err(|_| "launch URL unavailable".to_string())?.clone();
    let page = lightbox::page_url(&origin, &srcs, index)?;
    // Shift+click then Alt+S at once: the main window may be closing or gone already.
    if main_gone(&app) {
        return Err("Sidecr is closing".into());
    }
    // Opening another image while one is shown replaces the content.
    if let Some(open) = app.get_webview_window(lightbox::LABEL) {
        open.navigate(page).map_err(|e| e.to_string())?;
        let _ = open.set_focus();
        return Ok(());
    }
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten())
        .ok_or("no monitor")?;
    let (pos, size) = (*monitor.position(), *monitor.size());
    let signal_app = app.clone();
    let w = WebviewWindowBuilder::new(&app, lightbox::LABEL, WebviewUrl::External(page))
        .title("Sidecr image")
        .decorations(false)
        .resizable(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .background_color(Color(0, 0, 0, 255))
        .disable_drag_drop_handler()
        .on_navigation(move |to| {
            let Ok(origin) = shared.lock().map(|l| l.clone()) else { return false };
            // The close chord in the lightbox page: cancel the navigation and close Sidecr through the main
            // window's own close path (its page says bye; its Destroyed then takes the lightbox down too).
            if lightbox::is_close_signal(to, &origin) {
                let handle = signal_app.clone();
                std::thread::spawn(move || match handle.get_webview_window("main") {
                    Some(main) => {
                        let _ = main.close();
                    }
                    None => {
                        if let Some(lb) = handle.get_webview_window(lightbox::LABEL) {
                            let _ = lb.destroy();
                        }
                    }
                });
                return false;
            }
            cli::same_origin(to, &origin)
        })
        .visible(false);
    // The same browser arguments as the main window: webviews with different ones cannot share a data directory.
    #[cfg(windows)]
    let w = w.additional_browser_args(&webview_args::arguments());
    let w = w
        .build()
        .map_err(|e| e.to_string())?;
    // The main window went away while this one was being built: its Destroyed found nothing to take down.
    if main_gone(&app) {
        let _ = w.destroy();
        return Err("Sidecr is closing".into());
    }
    // Cover the monitor exactly. Move first, so a monitor with another scale has already rescaled the window
    // (WM_DPICHANGED) before the size is set; the size is set until the window measures it (tao's first set_size on
    // a new undecorated window can be off); then the position again, in case the size change moved it.
    let _ = w.set_position(pos);
    for _ in 0..3 {
        let _ = w.set_size(size);
        if w.outer_size().map(|s| s == size).unwrap_or(true) {
            break;
        }
    }
    let _ = w.set_position(pos);
    w.show().map_err(|e| e.to_string())?;
    let _ = w.set_focus();
    Ok(())
}

fn monitors(app: &tauri::App) -> (Vec<placement::Monitor>, usize) {
    let list = app.available_monitors().unwrap_or_default();
    let primary = app.primary_monitor().ok().flatten();
    let rect = |x: i32, y: i32, w: u32, h: u32| placement::Rect { x: x as f64, y: y as f64, w: w as f64, h: h as f64 };
    let out: Vec<placement::Monitor> = list
        .iter()
        .map(|m| placement::Monitor {
            area: rect(m.position().x, m.position().y, m.size().width, m.size().height),
            work: rect(m.work_area().position.x, m.work_area().position.y, m.work_area().size.width, m.work_area().size.height),
            scale: m.scale_factor(),
        })
        .collect();
    let primary_index = primary
        .and_then(|p| list.iter().position(|m| m.position() == p.position() && m.size() == p.size()))
        .unwrap_or(0);
    (out, primary_index)
}

/// Puts the client area (what the page sees: `screenX/Y`, `outerWidth/Height`) at the placement, so the bounds the
/// page reports and the bounds restored next time are the same numbers. An undecorated window with a shadow keeps an
/// invisible resize border (8 px left, right and bottom, 1 px top at 100 %): the position is corrected by the measured
/// offset between the window and its client area. For the size, tao measures that border on every `set_size`, and on
/// a window that was just created the measure still includes the caption it does not have (the client comes out
/// 30 px too tall at 100 %); from the second call on it is right. Each call is synchronous on this thread, so the size
/// is set again until the client area matches (twice in practice).
fn place_client_area(window: &tauri::WebviewWindow, p: placement::Placement) {
    let target = PhysicalSize::new(p.w, p.h);
    for _ in 0..3 {
        let _ = window.set_size(target);
        if window.inner_size().map(|s| s == target).unwrap_or(true) {
            break;
        }
    }
    let (dx, dy) = match (window.outer_position(), window.inner_position()) {
        (Ok(o), Ok(i)) => (i.x - o.x, i.y - o.y),
        _ => (0, 0),
    };
    let _ = window.set_position(PhysicalPosition::new(p.x - dx, p.y - dy));
}

fn main() {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    let args = match cli::parse(&raw) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("sidecr-shell: {e}\n{}", cli::USAGE);
            std::process::exit(2);
        }
    };
    // A newer launcher may pass flags this binary does not know: warn and carry on, a window is better than none.
    if !args.ignored.is_empty() {
        eprintln!("sidecr-shell: ignoring unknown arguments: {}", args.ignored.join(" "));
    }
    // Only the local Sidecr page: http on localhost or 127.0.0.1 (the capability's origins).
    let url = match cli::validate_url(&args.url) {
        Ok(u) => u,
        Err(e) => {
            eprintln!("sidecr-shell: {e}");
            std::process::exit(2);
        }
    };
    // The URL the window was last told to load. The navigation guard allows its origin only.
    let launch = Arc::new(Mutex::new(url.clone()));
    let guard = Arc::clone(&launch);
    let managed = Arc::clone(&launch);

    tauri::Builder::default()
        .manage(Launch(managed))
        .invoke_handler(tauri::generate_handler![open_lightbox])
        // A second start never closes this window (the server's toggle owns open and close) and then exits.
        // It brings the window forward, and when it carries another page URL (the server restarted with a new
        // token or port, so the open page talks to a dead server) it loads that URL here first. During an OS
        // close request (CLOSING) the window is going away and the start is dropped.
        .plugin(tauri_plugin_single_instance::init(move |app, argv, _cwd| {
            if CLOSING.load(Ordering::SeqCst) {
                return;
            }
            if let Some(w) = app.get_webview_window("main") {
                let current = launch.lock().map(|l| l.clone()).ok();
                if let Some(current) = current {
                    if let cli::SecondStart::Navigate(to) = cli::second_start(&argv, &current) {
                        if let Ok(mut l) = launch.lock() {
                            *l = to.clone(); // first, so the navigation guard lets the new origin through
                        }
                        let _ = w.navigate(to);
                    }
                }
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .setup(move |app| {
            let (mons, primary) = monitors(app);
            let place = placement::place(args.position, args.size, &mons, primary);

            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.clone()))
                .title("Sidecr")
                .inner_size(placement::DEFAULT_SIZE.0, placement::DEFAULT_SIZE.1)
                .min_inner_size(placement::MIN_SIZE.0, placement::MIN_SIZE.1)
                .resizable(true)
                .decorations(false)
                .transparent(true)
                .shadow(true)
                .always_on_top(args.topmost)
                // File drops go to the page (HTML5 drop → attachment chips). With Tauri's own handler on, wry
                // calls SetAllowExternalDrop(false) and emits tauri://drag-drop instead, which nothing listens to.
                .disable_drag_drop_handler()
                // The webview never leaves the launch origin: not for a link, a script, or a file dropped before
                // the page's own drop handler is in place (which would otherwise open file:///… in this window).
                .on_navigation(move |to| guard.lock().map(|l| cli::same_origin(to, &l)).unwrap_or(false))
                // Built hidden, placed in physical pixels, then shown: no jump from the default spot.
                .visible(false);
            // English webview UI (the right-click menu follows the OS language otherwise); see webview_args.rs.
            #[cfg(windows)]
            let builder = builder.additional_browser_args(&webview_args::arguments());
            // Acrylic is Windows only. Elsewhere the window is transparent and the page's translucent dark
            // background shows over whatever the compositor gives (Linux: untested, no blur promised).
            #[cfg(windows)]
            let builder = match start_effects(&args) {
                Some(effects) => builder.effects(effects),
                None => builder,
            };
            let window = builder.build()?;

            if let Some(p) = place {
                place_client_area(&window, p);
            }
            window.show()?;
            let _ = window.set_focus();
            Ok(())
        })
        .on_window_event(|window, event| {
            // The lightbox closes like any window. When it is gone the main window gets the focus back (and its
            // page puts it in the composer); when the main window is gone the lightbox goes too, so the process ends.
            if window.label() == lightbox::LABEL {
                if let WindowEvent::Destroyed = event {
                    if let Some(main) = window.app_handle().get_webview_window("main") {
                        let _ = main.set_focus();
                        let _ = main.emit_to("main", LIGHTBOX_CLOSED_EVENT, ());
                    }
                }
                return;
            }
            if let WindowEvent::Destroyed = event {
                MAIN_GONE.store(true, Ordering::SeqCst);
                if let Some(lb) = window.app_handle().get_webview_window(lightbox::LABEL) {
                    let _ = lb.destroy();
                }
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                // The page closes itself (destroy) after its unload steps; a page that never answers is
                // destroyed by the timer. A second request while one is pending only waits for the first.
                api.prevent_close();
                if CLOSING.swap(true, Ordering::SeqCst) {
                    return;
                }
                let _ = window.emit_to("main", CLOSE_REQUESTED_EVENT, ());
                let w = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(CLOSE_GRACE);
                    let _ = w.destroy();
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running the Sidecr shell");
}
