//! The lightbox window: which images the main page may ask it to show, and the page it loads.
//! The page passes same-origin image URLs (`/api/file?...`, `/api/image?...`), never a full URL or a file path;
//! the window loads `/lightbox.html` from the launch origin with those URLs in its query.

use tauri::Url;

use crate::cli::same_origin;

/// The label of the second window. Its capability allows only closing and destroying itself.
pub const LABEL: &str = "lightbox";
/// The page the lightbox window loads, served by the Sidecr server (cookie auth like everything else).
pub const PAGE_PATH: &str = "/lightbox.html";
/// The image endpoints of the Sidecr server.
const IMAGE_PATHS: [&str; 2] = ["/api/file", "/api/image"];
pub const MAX_IMAGES: usize = 64;
/// The query the lightbox page navigates to when the close chord (Alt+S, Ctrl+Shift+J) is pressed in it. The page
/// may only close itself; this navigation is how it asks the shell to close Sidecr too. The navigation guard
/// recognises it, cancels it, and closes the main window through its normal close path.
pub const CLOSE_SIDECR_QUERY: (&str, &str) = ("close", "sidecr");
pub const MAX_SRC_LEN: usize = 4096;

/// Only the main window's page may open the lightbox.
pub fn allowed_caller(label: &str) -> bool {
    label == "main"
}

/// One image URL from the page: a same-origin absolute path to an image endpoint, with a query and no fragment.
/// Returns it as "path?query" (resolved against the launch origin, so dot segments and encoding are normalised).
pub fn validate_src(origin: &Url, src: &str) -> Result<String, String> {
    if src.is_empty() || src.len() > MAX_SRC_LEN {
        return Err("image URL is empty or too long".into());
    }
    // A path on this origin only: not "//host", not "http:...", not a Windows path.
    if !src.starts_with('/') || src.starts_with("//") || src.contains('\\') || src.chars().any(|c| c.is_control()) {
        return Err(format!("not a same-origin path: {src}"));
    }
    let u = origin.join(src).map_err(|e| e.to_string())?;
    if !same_origin(&u, origin) {
        return Err(format!("not the Sidecr origin: {src}"));
    }
    if !IMAGE_PATHS.contains(&u.path()) {
        return Err(format!("not an image endpoint: {}", u.path()));
    }
    if u.fragment().is_some() {
        return Err("no fragment allowed".into());
    }
    match u.query() {
        Some(q) if !q.is_empty() => Ok(format!("{}?{}", u.path(), q)),
        _ => Err("an image URL needs its query".into()),
    }
}

/// Whether a navigation of the lightbox window is its "close Sidecr" signal: the lightbox page on the launch origin
/// with `close=sidecr` in the query.
pub fn is_close_signal(to: &Url, origin: &Url) -> bool {
    same_origin(to, origin) && to.path() == PAGE_PATH && to.query_pairs().any(|(k, v)| k == CLOSE_SIDECR_QUERY.0 && v == CLOSE_SIDECR_QUERY.1)
}

/// The lightbox page URL for these images, showing `index` first. Every image must pass `validate_src`.
pub fn page_url(origin: &Url, srcs: &[String], index: usize) -> Result<Url, String> {
    if srcs.is_empty() || srcs.len() > MAX_IMAGES {
        return Err(format!("between 1 and {MAX_IMAGES} images"));
    }
    if index >= srcs.len() {
        return Err("index out of range".into());
    }
    let clean = srcs.iter().map(|s| validate_src(origin, s)).collect::<Result<Vec<_>, _>>()?;
    let mut u = origin.join(PAGE_PATH).map_err(|e| e.to_string())?;
    u.set_query(None);
    u.set_fragment(None);
    {
        let mut q = u.query_pairs_mut();
        q.append_pair("i", &index.to_string());
        for c in &clean {
            q.append_pair("src", c);
        }
    }
    Ok(u)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn origin() -> Url {
        "http://localhost:47631/?t=tok&pane=w1%3Ap1".parse().unwrap()
    }

    #[test]
    fn only_main_opens_it() {
        assert!(allowed_caller("main"));
        assert!(!allowed_caller("lightbox"));
        assert!(!allowed_caller(""));
    }

    #[test]
    fn accepts_the_image_endpoints() {
        let o = origin();
        assert_eq!(
            validate_src(&o, "/api/file?pane=w1%3Ap1&path=C%3A%5Cx.png").unwrap(),
            "/api/file?pane=w1%3Ap1&path=C%3A%5Cx.png"
        );
        assert_eq!(validate_src(&o, "/api/image?pane=w1%3Ap1&ex=u3&block=u1").unwrap(), "/api/image?pane=w1%3Ap1&ex=u3&block=u1");
        // Dot segments resolve to the real path first, which then has to be an image endpoint.
        assert_eq!(validate_src(&o, "/x/../api/file?path=a").unwrap(), "/api/file?path=a");
    }

    #[test]
    fn refuses_everything_else() {
        let o = origin();
        for bad in [
            "",
            "http://localhost:47631/api/file?path=a",
            "https://evil.example/api/file?path=a",
            "//evil.example/api/file?path=a",
            "/api/file",
            "/api/file?",
            "/api/file?path=a#frag",
            "/api/send?pane=x",
            "/api/settings?x=1",
            "/lightbox.html?src=x",
            "/api/file/../settings?x=1",
            "api/file?path=a",
            "\\\\server\\share\\x.png",
            "/api/file?path=a\nb",
            "file:///C:/x.png",
            "javascript:alert(1)",
            "data:image/png;base64,AAAA",
        ] {
            assert!(validate_src(&o, bad).is_err(), "{bad:?} must be refused");
        }
        let long = format!("/api/file?path={}", "a".repeat(MAX_SRC_LEN));
        assert!(validate_src(&o, &long).is_err());
    }

    #[test]
    fn builds_the_page_url_on_the_launch_origin() {
        let o = origin();
        let srcs = vec!["/api/file?path=a.png".to_string(), "/api/image?pane=p&ex=u1&block=u0".to_string()];
        let u = page_url(&o, &srcs, 1).unwrap();
        assert!(same_origin(&u, &o));
        assert_eq!(u.path(), "/lightbox.html");
        let pairs: Vec<(String, String)> = u.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        assert_eq!(
            pairs,
            vec![
                ("i".into(), "1".into()),
                ("src".into(), "/api/file?path=a.png".into()),
                ("src".into(), "/api/image?pane=p&ex=u1&block=u0".into()),
            ]
        );
        assert!(!u.as_str().contains("t=tok"), "the launch token is not carried over");
    }

    #[test]
    fn close_signal() {
        let o = origin();
        assert!(is_close_signal(&"http://localhost:47631/lightbox.html?close=sidecr".parse().unwrap(), &o));
        assert!(is_close_signal(&"http://localhost:47631/lightbox.html?i=0&close=sidecr".parse().unwrap(), &o));
        assert!(!is_close_signal(&"http://localhost:47631/lightbox.html?close=other".parse().unwrap(), &o));
        assert!(!is_close_signal(&"http://localhost:47631/?close=sidecr".parse().unwrap(), &o));
        assert!(!is_close_signal(&"http://localhost:47632/lightbox.html?close=sidecr".parse().unwrap(), &o));
        assert!(!is_close_signal(&"http://localhost:47631/lightbox.html?i=0&src=%2Fapi%2Ffile%3Fa".parse().unwrap(), &o));
    }

    #[test]
    fn page_url_refuses_bad_lists() {
        let o = origin();
        let one = vec!["/api/file?path=a.png".to_string()];
        assert!(page_url(&o, &[], 0).is_err());
        assert!(page_url(&o, &one, 1).is_err());
        assert!(page_url(&o, &[one[0].clone(), "https://evil.example/x?y".into()], 0).is_err());
        let many = vec![one[0].clone(); MAX_IMAGES + 1];
        assert!(page_url(&o, &many, 0).is_err());
        assert!(page_url(&o, &many[..MAX_IMAGES], MAX_IMAGES - 1).is_ok());
    }
}
