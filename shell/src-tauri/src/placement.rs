//! Where the window goes, in physical pixels, from the CSS-pixel bounds the page reported last time.
//!
//! The page reports `screenX/Y` and `outerWidth/Height`, which Chromium (and WebView2) give in DIPs: on a
//! monitor with scale factor `s`, `physical = css * s`. With every monitor at the same scale this is exact,
//! origins included. With mixed scales Chromium lays the monitors out in DIP space its own way; the monitor
//! is picked by where the CSS point falls once each monitor's physical area is divided by its own scale,
//! which matches for the monitor the window was on in the common side-by-side layouts.

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Monitor {
    /// The whole monitor, physical pixels.
    pub area: Rect,
    /// The monitor minus the taskbar, physical pixels.
    pub work: Rect,
    pub scale: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Placement {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

pub const DEFAULT_SIZE: (f64, f64) = (520.0, 760.0);
pub const MIN_SIZE: (f64, f64) = (360.0, 420.0);
/// Less than this many CSS px visible on a monitor, horizontally or vertically, counts as off the screen.
const MIN_VISIBLE: f64 = 80.0;
/// How far inside the primary monitor's work area a recovered window is put, CSS px.
const MARGIN: f64 = 40.0;

fn contains(r: &Rect, x: f64, y: f64) -> bool {
    x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h
}

fn overlap(a0: f64, a1: f64, b0: f64, b1: f64) -> f64 {
    (a1.min(b1) - a0.max(b0)).max(0.0)
}

/// The monitor under a CSS point: its physical area divided by its scale contains the point.
fn monitor_at_css(monitors: &[Monitor], x: f64, y: f64) -> Option<usize> {
    monitors.iter().position(|m| {
        let s = m.scale;
        contains(&Rect { x: m.area.x / s, y: m.area.y / s, w: m.area.w / s, h: m.area.h / s }, x, y)
    })
}

fn visible_somewhere(r: &Rect, monitors: &[Monitor]) -> bool {
    monitors.iter().any(|m| {
        let need = MIN_VISIBLE * m.scale;
        overlap(r.x, r.x + r.w, m.work.x, m.work.x + m.work.w) >= need
            && overlap(r.y, r.y + r.h, m.work.y, m.work.y + m.work.h) >= need
    })
}

fn clamp_size(w: f64, h: f64) -> (f64, f64) {
    (w.max(MIN_SIZE.0), h.max(MIN_SIZE.1))
}

fn round(r: Rect) -> Placement {
    Placement { x: r.x.round() as i32, y: r.y.round() as i32, w: r.w.round().max(1.0) as u32, h: r.h.round().max(1.0) as u32 }
}

/// On the primary monitor: `css_size` scaled, shrunk to the work area, `MARGIN` in from its top-left corner
/// when `inset`, else centred.
fn on_primary(p: &Monitor, css_size: (f64, f64), inset: bool) -> Placement {
    let s = p.scale;
    let w = (css_size.0 * s).min(p.work.w);
    let h = (css_size.1 * s).min(p.work.h);
    let (x, y) = if inset {
        ((p.work.x + MARGIN * s).min(p.work.x + p.work.w - w), (p.work.y + MARGIN * s).min(p.work.y + p.work.h - h))
    } else {
        (p.work.x + (p.work.w - w) / 2.0, p.work.y + (p.work.h - h) / 2.0)
    };
    round(Rect { x, y, w, h })
}

/// Physical placement for the window. No monitors known: None (the OS decides).
/// No saved position: the saved (or default) size, centred on the primary monitor.
/// A saved position that is no longer on any monitor (it was unplugged): moved to the primary monitor.
pub fn place(position: Option<(f64, f64)>, size: Option<(f64, f64)>, monitors: &[Monitor], primary: usize) -> Option<Placement> {
    let p = monitors.get(primary).or_else(|| monitors.first())?;
    let (cw, ch) = clamp_size(size.unwrap_or(DEFAULT_SIZE).0, size.unwrap_or(DEFAULT_SIZE).1);
    let Some((cx, cy)) = position else {
        return Some(on_primary(p, (cw, ch), false));
    };
    // The monitor under the top-left corner, else under the centre (a window pushed a little past the left
    // or top edge), else the primary's scale.
    let m = monitor_at_css(monitors, cx, cy)
        .or_else(|| monitor_at_css(monitors, cx + cw / 2.0, cy + ch / 2.0))
        .map(|i| &monitors[i])
        .unwrap_or(p);
    let s = m.scale;
    let r = Rect { x: cx * s, y: cy * s, w: cw * s, h: ch * s };
    if visible_somewhere(&r, monitors) {
        Some(round(r))
    } else {
        Some(on_primary(p, (cw, ch), true))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mon(x: f64, y: f64, w: f64, h: f64, scale: f64) -> Monitor {
        Monitor { area: Rect { x, y, w, h }, work: Rect { x, y, w, h: h - 48.0 * scale }, scale }
    }

    #[test]
    fn same_scale_round_trips() {
        let ms = [mon(0.0, 0.0, 1920.0, 1080.0, 1.0), mon(1920.0, 0.0, 1920.0, 1080.0, 1.0)];
        assert_eq!(place(Some((3226.0, 159.0)), Some((600.0, 800.0)), &ms, 0), Some(Placement { x: 3226, y: 159, w: 600, h: 800 }));
    }

    #[test]
    fn scale_150_converts_css_to_physical() {
        let ms = [mon(0.0, 0.0, 2880.0, 1620.0, 1.5)];
        assert_eq!(place(Some((100.0, 50.0)), Some((520.0, 760.0)), &ms, 0), Some(Placement { x: 150, y: 75, w: 780, h: 1140 }));
    }

    #[test]
    fn mixed_scale_uses_the_monitor_under_the_point() {
        // A 4K at 200% on the left (1920x1080 CSS), a 1080p at 100% on the right starting at physical 3840.
        let ms = [mon(0.0, 0.0, 3840.0, 2160.0, 2.0), mon(3840.0, 0.0, 1920.0, 1080.0, 1.0)];
        // CSS (100, 100) is on the 4K: doubled.
        assert_eq!(place(Some((100.0, 100.0)), Some((500.0, 700.0)), &ms, 0).unwrap(), Placement { x: 200, y: 200, w: 1000, h: 1400 });
        // CSS (3900, 100) is on the 1080p (its CSS area starts at 3840): as is.
        assert_eq!(place(Some((3900.0, 100.0)), Some((500.0, 700.0)), &ms, 0).unwrap(), Placement { x: 3900, y: 100, w: 500, h: 700 });
    }

    #[test]
    fn off_screen_goes_to_the_primary() {
        let ms = [mon(0.0, 0.0, 1920.0, 1080.0, 1.0)];
        // It was on a second monitor that is gone.
        assert_eq!(place(Some((2500.0, 100.0)), Some((600.0, 800.0)), &ms, 0), Some(Placement { x: 40, y: 40, w: 600, h: 800 }));
        // Only 20 px left on screen.
        assert_eq!(place(Some((1900.0, 100.0)), Some((600.0, 800.0)), &ms, 0).unwrap().x, 40);
    }

    #[test]
    fn mostly_visible_stays() {
        let ms = [mon(0.0, 0.0, 1920.0, 1080.0, 1.0)];
        assert_eq!(place(Some((-100.0, 10.0)), Some((600.0, 800.0)), &ms, 0).unwrap().x, -100);
    }

    #[test]
    fn recovered_window_is_shrunk_to_the_work_area() {
        let ms = [mon(0.0, 0.0, 1280.0, 720.0, 1.0)];
        let p = place(Some((5000.0, 5000.0)), Some((600.0, 2000.0)), &ms, 0).unwrap();
        assert_eq!((p.y, p.h), (0, 672));
    }

    #[test]
    fn no_position_centres_on_the_primary() {
        let ms = [mon(0.0, 0.0, 1920.0, 1080.0, 1.0), mon(1920.0, 0.0, 1920.0, 1080.0, 1.0)];
        assert_eq!(place(None, None, &ms, 0), Some(Placement { x: 700, y: 136, w: 520, h: 760 }));
        let ms = [mon(0.0, 0.0, 2880.0, 1620.0, 1.5)];
        assert_eq!(place(None, None, &ms, 0).unwrap().w, 780);
    }

    #[test]
    fn tiny_sizes_are_raised_to_the_minimum() {
        let ms = [mon(0.0, 0.0, 1920.0, 1080.0, 1.0)];
        let p = place(Some((10.0, 10.0)), Some((100.0, 100.0)), &ms, 0).unwrap();
        assert_eq!((p.w, p.h), (360, 420));
    }

    #[test]
    fn no_monitors_lets_the_os_decide() {
        assert_eq!(place(Some((10.0, 10.0)), None, &[], 0), None);
    }
}
