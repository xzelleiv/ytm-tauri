#[cfg(windows)]
use webview2_com::{
    take_pwstr, ClearBrowsingDataCompletedHandler,
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment, ICoreWebView2Profile2, ICoreWebView2_13,
        COREWEBVIEW2_BROWSING_DATA_KINDS_CACHE_STORAGE,
        COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
    },
    WebResourceRequestedEventHandler,
};

#[cfg(windows)]
use windows::core::{Interface, HSTRING, PWSTR};

use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};

const BLOCKED_AD_HOSTS: &[&str] = &[
    "2mdn.net",
    "ad.doubleclick.net",
    "adservice.google.com",
    "ads.youtube.com",
    "doubleclick.net",
    "googleadservices.com",
    "googlesyndication.com",
    "pagead-googlehosted.l.google.com",
];

#[derive(Clone)]
pub struct AdBlockController {
    enabled: Arc<AtomicBool>,
    blocked_requests: Arc<AtomicU64>,
}

impl AdBlockController {
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled: Arc::new(AtomicBool::new(enabled)),
            blocked_requests: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
    }

    pub fn blocked_requests(&self) -> u64 {
        self.blocked_requests.load(Ordering::Relaxed)
    }

    #[cfg(windows)]
    pub fn install(&self, webview: tauri::webview::PlatformWebview) {
        unsafe {
            let Ok(core_webview) = webview.controller().CoreWebView2() else {
                return;
            };
            let environment = webview.environment();

            // Never register "*" here. WebResourceRequested runs on WebView2's UI
            // thread, and intercepting Google Video streaming stalled playback.
            // Host-scoped filters keep media requests out of this callback.
            for filter in request_filter_patterns() {
                let filter = HSTRING::from(filter);
                let _ = core_webview
                    .AddWebResourceRequestedFilter(&filter, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
            }

            let enabled = self.enabled.clone();
            let blocked_requests = self.blocked_requests.clone();
            let handler = WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else {
                    return Ok(());
                };
                let request = args.Request()?;
                let mut uri = PWSTR::null();
                request.Uri(&mut uri)?;
                let url = take_pwstr(uri);

                if enabled.load(Ordering::Relaxed) && should_block_url(&url) {
                    args.SetResponse(&blocked_response(&environment)?)?;
                    blocked_requests.fetch_add(1, Ordering::Relaxed);
                }

                Ok(())
            }));
            let mut token = 0;
            let _ = core_webview.add_WebResourceRequested(&handler, &mut token);
        }
    }

    #[cfg(not(windows))]
    pub fn install(&self, _webview: tauri::webview::PlatformWebview) {}
}

#[cfg(windows)]
pub fn clear_cache(
    webview: tauri::webview::PlatformWebview,
    on_complete: impl FnOnce() + Send + 'static,
) {
    unsafe {
        let Ok(core_webview) = webview.controller().CoreWebView2() else {
            on_complete();
            return;
        };
        let Ok(profile) = core_webview
            .cast::<ICoreWebView2_13>()
            .and_then(|webview| webview.Profile())
            .and_then(|profile| profile.cast::<ICoreWebView2Profile2>())
        else {
            on_complete();
            return;
        };
        let kinds = COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE
            | COREWEBVIEW2_BROWSING_DATA_KINDS_CACHE_STORAGE;
        let mut on_complete = Some(on_complete);
        let _ = profile.ClearBrowsingData(
            kinds,
            &ClearBrowsingDataCompletedHandler::create(Box::new(move |_| {
                if let Some(on_complete) = on_complete.take() {
                    on_complete();
                }
                Ok(())
            })),
        );
    }
}

#[cfg(not(windows))]
pub fn clear_cache(
    _webview: tauri::webview::PlatformWebview,
    on_complete: impl FnOnce() + Send + 'static,
) {
    on_complete();
}

#[cfg(windows)]
unsafe fn blocked_response(
    environment: &ICoreWebView2Environment,
) -> windows::core::Result<
    webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2WebResourceResponse,
> {
    let status = HSTRING::from("No Content");
    let headers = HSTRING::from(
        "Access-Control-Allow-Origin: https://music.youtube.com\r\n\
         Access-Control-Allow-Credentials: true\r\n\
         Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
         Access-Control-Allow-Headers: *\r\n\
         Cache-Control: no-store\r\n",
    );
    environment.CreateWebResourceResponse(None, 204, &status, &headers)
}

fn request_filter_patterns() -> Vec<String> {
    BLOCKED_AD_HOSTS
        .iter()
        .flat_map(|host| [format!("https://{host}/*"), format!("https://*.{host}/*")])
        .collect()
}

pub fn should_block_url(url: &str) -> bool {
    let Ok(url) = tauri::Url::parse(url) else {
        return false;
    };
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }

    url.host_str().is_some_and(|host| {
        BLOCKED_AD_HOSTS
            .iter()
            .any(|blocked| host_matches_domain(host, blocked))
    })
}

fn host_matches_domain(host: &str, domain: &str) -> bool {
    host == domain
        || host
            .strip_suffix(domain)
            .is_some_and(|prefix| prefix.ends_with('.'))
}

#[cfg(test)]
mod tests {
    use super::{request_filter_patterns, should_block_url};

    #[test]
    fn blocks_known_third_party_ad_hosts() {
        assert!(should_block_url(
            "https://googleads.g.doubleclick.net/pagead/id"
        ));
        assert!(should_block_url(
            "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"
        ));
    }

    #[test]
    fn allows_youtube_pages_and_media_hosts() {
        assert!(!should_block_url("https://music.youtube.com/"));
        assert!(!should_block_url(
            "https://rr1---sn.googlevideo.com/videoplayback?expire=1&mime=audio/webm"
        ));
    }

    #[test]
    fn does_not_match_ad_domain_text_outside_the_hostname() {
        assert!(!should_block_url(
            "https://example.com/?next=https://googleads.g.doubleclick.net/pagead/id"
        ));
        assert!(!should_block_url(
            "https://googleads.g.doubleclick.net.example.com/pagead/id"
        ));
    }

    #[test]
    fn native_request_filters_never_intercept_all_webview_traffic() {
        let filters = request_filter_patterns();

        assert!(!filters.is_empty());
        assert!(!filters.iter().any(|filter| filter == "*"));
        assert!(!filters.iter().any(|filter| filter.contains("googlevideo")));
        assert!(!filters
            .iter()
            .any(|filter| filter.contains("music.youtube.com")));
    }
}
