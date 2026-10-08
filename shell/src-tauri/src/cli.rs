//! The command line of the shell, parsed by hand:
//! `sidecr-shell --url <url> [--x N --y N --w N --h N] [--no-topmost] [--effect E] [--tint N]`.
//! Position and size are CSS pixels, as the page reports them (`screenX/Y`, `outerWidth/Height`).
//! Also: which URLs the shell accepts, the navigation guard, and what a second start does.

use tauri::Url;

#[derive(Debug, Clone, PartialEq)]
pub struct Args {
    pub url: String,
    /// Top-left corner in CSS pixels, when both `--x` and `--y` were given.
    pub position: Option<(f64, f64)>,
    /// Outer size in CSS pixels, when both `--w` and `--h` were given.
    pub size: Option<(f64, f64)>,
    pub topmost: bool,
    /// The window effect to start with (from the user's settings): acrylic, mica, blur or none. None: acrylic.
    pub effect: Option<StartEffect>,
    /// The alpha (0-255) of the effect's tint colour. None: the default 150.
    pub tint: Option<u8>,
    /// Arguments that were ignored (unknown flags, stray values), for a warning on stderr.
    pub ignored: Vec<String>,
}

pub const USAGE: &str = "usage: sidecr-shell --url <url> [--x N --y N --w N --h N] [--no-topmost] [--effect acrylic|mica|blur|none] [--tint 0-255]";

/// The window effect the shell starts with. The page applies the same settings again once it has loaded.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum StartEffect {
    Acrylic,
    Mica,
    Blur,
    None,
}

impl StartEffect {
    fn parse(v: &str) -> Option<StartEffect> {
        match v {
            "acrylic" => Some(StartEffect::Acrylic),
            "mica" => Some(StartEffect::Mica),
            "blur" => Some(StartEffect::Blur),
            "none" => Some(StartEffect::None),
            _ => None,
        }
    }
}

/// The default tint alpha (the shell's original look, the settings' default strength 60).
pub const DEFAULT_TINT: u8 = 150;

fn number(flag: &str, value: Option<&String>) -> Result<f64, String> {
    let v = value.ok_or_else(|| format!("{flag} needs a value"))?;
    match v.trim().parse::<f64>() {
        Ok(n) if n.is_finite() => Ok(n),
        _ => Err(format!("{flag}: not a number: {v}")),
    }
}

/// Parses the arguments after the program name. Both `--flag value` and `--flag=value` are accepted.
/// Unknown flags (with the value that follows them, if it is not a flag) and stray values are ignored and listed
/// in `ignored`: a newer launcher passing a flag this binary does not know must still get a window.
/// A missing or empty `--url`, or a known number flag with a bad value, is an error.
pub fn parse(args: &[String]) -> Result<Args, String> {
    let mut url: Option<String> = None;
    let (mut x, mut y, mut w, mut h) = (None, None, None, None);
    let mut topmost = true;
    let (mut effect, mut tint) = (None, None);
    let mut ignored = Vec::new();

    // Split "--flag=value" into two tokens first.
    let mut tokens: Vec<String> = Vec::with_capacity(args.len());
    for a in args {
        match a.split_once('=') {
            Some((flag, value)) if flag.starts_with("--") => {
                tokens.push(flag.to_string());
                tokens.push(value.to_string());
            }
            _ => tokens.push(a.clone()),
        }
    }

    let mut it = tokens.iter().peekable();
    while let Some(flag) = it.next() {
        match flag.as_str() {
            "--url" => {
                let v = it.next().ok_or("--url needs a value")?;
                if v.is_empty() {
                    return Err("--url is empty".into());
                }
                url = Some(v.clone());
            }
            "--x" => x = Some(number(flag, it.next())?),
            "--y" => y = Some(number(flag, it.next())?),
            "--w" => w = Some(number(flag, it.next())?),
            "--h" => h = Some(number(flag, it.next())?),
            "--no-topmost" => topmost = false,
            // A value this binary does not know (a newer launcher) is ignored like an unknown flag: the page applies
            // the setting itself once it has loaded.
            "--effect" => match it.next() {
                Some(v) => match StartEffect::parse(v) {
                    Some(e) => effect = Some(e),
                    None => ignored.extend([flag.clone(), v.clone()]),
                },
                None => ignored.push(flag.clone()),
            },
            "--tint" => match it.next() {
                Some(v) => match v.trim().parse::<u8>() {
                    Ok(n) => tint = Some(n),
                    Err(_) => ignored.extend([flag.clone(), v.clone()]),
                },
                None => ignored.push(flag.clone()),
            },
            other if other.starts_with("--") => {
                ignored.push(other.to_string());
                if it.peek().is_some_and(|v| !v.starts_with("--")) {
                    ignored.push(it.next().unwrap().clone());
                }
            }
            other => ignored.push(other.to_string()),
        }
    }

    let url = url.ok_or("--url is required")?;
    let position = match (x, y) {
        (Some(x), Some(y)) => Some((x, y)),
        _ => None,
    };
    let size = match (w, h) {
        (Some(w), Some(h)) if w > 0.0 && h > 0.0 => Some((w, h)),
        _ => None,
    };
    Ok(Args { url, position, size, topmost, effect, tint, ignored })
}

/// The page URL the shell agrees to open: `http` on `localhost` or `127.0.0.1` (any port), nothing else.
/// The capability that lets the page close and drag the window is scoped to exactly those origins.
pub fn validate_url(raw: &str) -> Result<Url, String> {
    let u: Url = raw.parse().map_err(|e| format!("--url: {e}"))?;
    if u.scheme() != "http" {
        return Err(format!("--url: only http is allowed, not {}", u.scheme()));
    }
    match u.host_str() {
        Some("localhost") | Some("127.0.0.1") => {}
        other => return Err(format!("--url: only localhost or 127.0.0.1 is allowed, not {}", other.unwrap_or("(no host)"))),
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err("--url: no user name or password allowed".into());
    }
    Ok(u)
}

/// Same scheme, host and port. The navigation guard lets the webview go only to the launch origin.
pub fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme() && a.host_str() == b.host_str() && a.port_or_known_default() == b.port_or_known_default()
}

#[derive(Debug, Clone, PartialEq)]
pub enum SecondStart {
    /// Only bring the open window forward.
    Focus,
    /// The launcher passed another page URL (a new token or port after a server restart, another pane):
    /// load it in the open window, then bring it forward.
    Navigate(Url),
}

/// What a second `sidecr-shell` start (forwarded by the single-instance plugin) does to the open window.
/// `argv` is the second process's command line, with or without the program name; `current` is the URL the open
/// window was last told to load. The page itself drops the token from its address bar, so the window's live URL
/// is not compared. Anything that does not parse, or is not an allowed URL, only focuses.
pub fn second_start(argv: &[String], current: &Url) -> SecondStart {
    let rest: Vec<String> = argv.iter().skip_while(|a| !a.starts_with("--")).cloned().collect();
    let Ok(args) = parse(&rest) else { return SecondStart::Focus };
    let Ok(url) = validate_url(&args.url) else { return SecondStart::Focus };
    if url == *current {
        SecondStart::Focus
    } else {
        SecondStart::Navigate(url)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn url_only() {
        let a = parse(&s(&["--url", "http://localhost:1/?t=a&pane=w1%3Ap1"])).unwrap();
        assert_eq!(a.url, "http://localhost:1/?t=a&pane=w1%3Ap1");
        assert_eq!(a.position, None);
        assert_eq!(a.size, None);
        assert!(a.topmost);
        assert!(a.ignored.is_empty());
    }

    #[test]
    fn bounds_and_no_topmost() {
        let a = parse(&s(&["--url", "http://x/", "--x", "-1500", "--y", "40", "--w", "600", "--h", "800", "--no-topmost"])).unwrap();
        assert_eq!(a.position, Some((-1500.0, 40.0)));
        assert_eq!(a.size, Some((600.0, 800.0)));
        assert!(!a.topmost);
    }

    #[test]
    fn equals_form() {
        let a = parse(&s(&["--url=http://x/?a=b", "--x=10", "--y=20"])).unwrap();
        assert_eq!(a.url, "http://x/?a=b");
        assert_eq!(a.position, Some((10.0, 20.0)));
    }

    #[test]
    fn half_a_pair_is_ignored() {
        let a = parse(&s(&["--url", "http://x/", "--x", "10", "--w", "600"])).unwrap();
        assert_eq!(a.position, None);
        assert_eq!(a.size, None);
    }

    #[test]
    fn unknown_flags_are_ignored_not_fatal() {
        let a = parse(&s(&["--url", "http://x/", "--theme", "dark", "--frame", "--x", "1", "--y", "2", "stray"])).unwrap();
        assert_eq!(a.url, "http://x/");
        assert_eq!(a.position, Some((1.0, 2.0)));
        assert_eq!(a.ignored, s(&["--theme", "dark", "--frame", "stray"]));
        let b = parse(&s(&["--newflag=3", "--url", "http://x/"])).unwrap();
        assert_eq!(b.url, "http://x/");
        assert_eq!(b.ignored, s(&["--newflag", "3"]));
        // A boolean flag written with a value: the value is ignored, the flag still applies.
        let c = parse(&s(&["--url", "http://x/", "--no-topmost=1"])).unwrap();
        assert!(!c.topmost);
    }

    #[test]
    fn effect_and_tint() {
        let a = parse(&s(&["--url", "http://x/", "--effect", "mica", "--tint", "30"])).unwrap();
        assert_eq!(a.effect, Some(StartEffect::Mica));
        assert_eq!(a.tint, Some(30));
        let b = parse(&s(&["--url", "http://x/", "--effect=none", "--tint=255"])).unwrap();
        assert_eq!(b.effect, Some(StartEffect::None));
        assert_eq!(b.tint, Some(255));
        let c = parse(&s(&["--url", "http://x/"])).unwrap();
        assert_eq!((c.effect, c.tint), (None, None));
        // Unknown values are ignored with a warning, never fatal.
        let d = parse(&s(&["--url", "http://x/", "--effect", "plasma", "--tint", "300"])).unwrap();
        assert_eq!((d.effect, d.tint), (None, None));
        assert_eq!(d.ignored, s(&["--effect", "plasma", "--tint", "300"]));
    }

    #[test]
    fn errors() {
        assert!(parse(&s(&[])).is_err());
        assert!(parse(&s(&["--url"])).is_err());
        assert!(parse(&s(&["--url="])).is_err());
        assert!(parse(&s(&["--url", "http://x/", "--x", "abc"])).is_err());
        assert!(parse(&s(&["--url", "http://x/", "--x", "NaN"])).is_err());
        assert!(parse(&s(&["--frame"])).is_err()); // still needs --url
    }

    #[test]
    fn only_loopback_http_urls() {
        assert!(validate_url("http://localhost:47631/?t=a&pane=w1%3Ap1").is_ok());
        assert!(validate_url("http://127.0.0.1:47792/").is_ok());
        assert!(validate_url("http://localhost/").is_ok());
        for bad in [
            "https://localhost:47631/",
            "file:///C:/Windows/win.ini",
            "http://evil.example/",
            "http://localhost.evil.example/",
            "http://192.168.1.2:47631/",
            "http://[::1]:47631/",
            "http://user:pw@localhost:47631/",
            "javascript:alert(1)",
            "not a url",
        ] {
            assert!(validate_url(bad).is_err(), "{bad} must be refused");
        }
    }

    #[test]
    fn origin_comparison() {
        let a: Url = "http://localhost:47631/?t=a".parse().unwrap();
        assert!(same_origin(&a, &"http://localhost:47631/api/file?x=1".parse().unwrap()));
        assert!(!same_origin(&a, &"http://localhost:47632/".parse().unwrap()));
        assert!(!same_origin(&a, &"http://127.0.0.1:47631/".parse().unwrap()));
        assert!(!same_origin(&a, &"https://localhost:47631/".parse().unwrap()));
        assert!(!same_origin(&a, &"file:///C:/x.png".parse().unwrap()));
        assert!(same_origin(&"http://localhost/".parse().unwrap(), &"http://localhost:80/".parse().unwrap()));
    }

    #[test]
    fn second_start_decision() {
        let current: Url = "http://localhost:47631/?t=old&pane=w1%3Ap1".parse().unwrap();
        let exe = "C:\\plugin\\sidecr-shell.exe";
        // The same launch: focus only.
        assert_eq!(second_start(&s(&[exe, "--url", "http://localhost:47631/?t=old&pane=w1%3Ap1"]), &current), SecondStart::Focus);
        // A new token after a server restart, with bounds and without the program name.
        let fresh = "http://localhost:47631/?t=new&pane=w1%3Ap1";
        assert_eq!(
            second_start(&s(&["--url", fresh, "--x", "1", "--y", "2"]), &current),
            SecondStart::Navigate(fresh.parse().unwrap())
        );
        // A new port.
        assert!(matches!(second_start(&s(&[exe, "--url", "http://localhost:50000/?t=x"]), &current), SecondStart::Navigate(_)));
        // Refused or broken input only focuses.
        assert_eq!(second_start(&s(&[exe, "--url", "https://evil.example/"]), &current), SecondStart::Focus);
        assert_eq!(second_start(&s(&[exe]), &current), SecondStart::Focus);
        assert_eq!(second_start(&s(&[exe, "--x", "abc", "--url", fresh]), &current), SecondStart::Focus);
    }
}
