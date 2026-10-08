//! The browser arguments of the Windows webview (WebView2), set on every window of the shell.
//!
//! WebView2 takes its UI language from the system (the right-click menu says Copy / Paste / Inspect in the OS language),
//! and everything the user reads in Sidecr is English. `--lang=en-US` makes the webview's own UI English.
//!
//! wry replaces its default arguments when any are given, so they are repeated here: `msWebOOUI` (the mini menu on text
//! selection), `msPdfOOUI` and `msSmartScreenProtection`. Transparency, the acrylic effect and the drag-drop setting are
//! not browser arguments (window attributes and a controller setting), so they are untouched. Every window of the shell
//! must be built with the same arguments, because webviews with different arguments cannot share a data directory.
//!
//! The `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` environment variable (tests use it for `--remote-debugging-port`) is read by the
//! WebView2 loader and combined with these by the runtime.

/// wry's default, kept as it is: a copy of `src/webview2/mod.rs` of wry 0.57.0 (`create_environment`, the `unwrap_or_else` that is
/// replaced when arguments are given). The wry version this was checked against is `CHECKED_WRY`; a test fails when Cargo.lock
/// moves to another version, so an upgrade prompts a look at wry's defaults (it may add or drop arguments). Re-check, then update
/// `CHECKED_WRY` and this comment together.
pub const WRY_DEFAULT: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

/// The wry version the defaults above were copied from (checked 0.57.0: nothing else is added unless an autoplay or proxy option is set).
pub const CHECKED_WRY: &str = "0.57.0";

/// The language switch.
pub const LANGUAGE: &str = "--lang=en-US";

/// What `additional_browser_args` is given.
pub fn arguments() -> String {
    format!("{WRY_DEFAULT} {LANGUAGE}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_wrys_defaults_and_adds_english() {
        let a = arguments();
        assert!(a.starts_with(WRY_DEFAULT));
        assert!(a.split(' ').any(|x| x == "--lang=en-US"));
    }

    /// The version of a package in Cargo.lock.
    fn locked_version(lock: &str, name: &str) -> Option<String> {
        let lock = lock.replace("
", "
");
        let at = lock.find(&format!("name = \"{name}\"
version = \""))?;
        let rest = &lock[at..];
        let start = rest.find("version = \"")? + "version = \"".len();
        let end = rest[start..].find('"')?;
        Some(rest[start..start + end].to_string())
    }

    #[test]
    fn wrys_defaults_were_checked_against_the_locked_wry() {
        let locked = locked_version(include_str!("../Cargo.lock"), "wry").expect("wry is in Cargo.lock");
        assert_eq!(
            locked, CHECKED_WRY,
            "wry moved to {locked}: re-check its default browser arguments (src/webview2/mod.rs, create_environment), then update CHECKED_WRY and the comments of WRY_DEFAULT"
        );
        // the doc comment names the same version, so it cannot be left behind either
        let source = include_str!("webview_args.rs");
        assert!(source.contains(&format!("wry {CHECKED_WRY}")), "the comment of WRY_DEFAULT must name wry {CHECKED_WRY}");
    }

    #[test]
    fn is_one_flag_per_word_with_no_quotes() {
        let a = arguments();
        assert!(a.split(' ').all(|x| x.starts_with("--") && !x.contains('"')));
        assert_eq!(a.matches("--disable-features").count(), 1);
    }
}
