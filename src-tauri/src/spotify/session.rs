use super::client;
use super::credentials;
use super::local_auth::BrowserAuthMode;
use super::models::SpotifySession;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::webview::{NewWindowResponse, WebviewWindowBuilder};
use tauri::{AppHandle, Manager, Theme, WebviewUrl};

const LOGIN_WINDOW_LABEL: &str = "spotify_login";
const COOKIE_POLL_INTERVAL: Duration = Duration::from_millis(750);
const COOKIE_POLL_LIMIT: usize = 400;
const TOKEN_REFRESH_SKEW_SECS: u64 = 60;
static POPUP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Default)]
pub struct SpotifyController {
    current_session: Arc<Mutex<Option<SpotifySession>>>,
    auth_generation: Arc<AtomicU64>,
}

impl SpotifyController {
    pub fn new() -> Self {
        Self {
            current_session: Arc::new(Mutex::new(credentials::load_session())),
            auth_generation: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn is_authenticated(&self) -> bool {
        let session = self
            .current_session
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        session.as_ref().is_some_and(|session| {
            (!session.access_token.is_empty()
                && (session.expires_at_unix == 0
                    || session.expires_at_unix > unix_now() + TOKEN_REFRESH_SKEW_SECS))
                || session.has_refresh_credential()
        })
    }

    pub fn get_session(&self) -> Option<SpotifySession> {
        self.current_session
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn get_token(&self) -> Result<String, String> {
        let mut session_guard = self
            .current_session
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let session = session_guard
            .as_mut()
            .ok_or_else(|| "Spotify is not connected".to_string())?;

        if !session.access_token.is_empty()
            && (session.expires_at_unix == 0
                || session.expires_at_unix > unix_now() + TOKEN_REFRESH_SKEW_SECS)
        {
            return Ok(session.access_token.clone());
        }

        if let Some(sp_dc) = session.sp_dc.clone().filter(|value| !value.is_empty()) {
            let refreshed = client::resolve_token_or_cookie(&format!("sp_dc={sp_dc}"))?;
            session.access_token = refreshed.access_token;
            session.expires_at_unix = refreshed.expires_at_unix;
            credentials::save_session(session)?;
            return Ok(session.access_token.clone());
        }

        if let (Some(client_id), Some(refresh_token)) = (
            session
                .oauth_client_id
                .clone()
                .filter(|value| !value.is_empty()),
            session
                .refresh_token
                .clone()
                .filter(|value| !value.is_empty()),
        ) {
            let refreshed = client::refresh_oauth_token(&client_id, &refresh_token)?;
            session.access_token = refreshed.access_token;
            session.expires_at_unix = unix_now() + refreshed.expires_in.max(60);
            if let Some(next_refresh_token) = refreshed.refresh_token {
                session.refresh_token = Some(next_refresh_token);
            }
            credentials::save_session(session)?;
            return Ok(session.access_token.clone());
        }

        Err("The Spotify session expired. Connect Spotify again.".to_string())
    }

    pub fn open_login_window(&self, app: &AppHandle) -> Result<(), String> {
        if let Some(existing) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
            existing.show().map_err(|e| e.to_string())?;
            existing.set_focus().map_err(|e| e.to_string())?;
            return Ok(());
        }

        let login_url = url::Url::parse("https://open.spotify.com/").map_err(|e| e.to_string())?;
        let app_for_popups = app.clone();
        let generation = self.auth_generation.fetch_add(1, Ordering::SeqCst) + 1;

        let app_handle_for_title = app.clone();
        let controller_for_title = self.clone();

        let window =
            WebviewWindowBuilder::new(app, LOGIN_WINDOW_LABEL, WebviewUrl::External(login_url))
                .title("Spotify Sign In")
                .inner_size(900.0, 760.0)
                .min_inner_size(560.0, 620.0)
                .theme(Some(Theme::Dark))
                .center()
                .incognito(true)
                .user_agent(client::DESKTOP_USER_AGENT)
                .initialization_script(
                    r#"
                    (() => {
                        function checkSpotifySession() {
                            try {
                                if (window.location.hostname.includes("spotify.com")) {
                                    fetch("https://open.spotify.com/api/token?reason=transport&productType=web-player", { credentials: "include" })
                                        .then(r => r.ok ? r.json() : null)
                                        .then(data => {
                                            if (data && data.accessToken && typeof data.accessToken === "string" && data.accessToken.length > 20) {
                                                document.title = "YTMSPOTIFY_CAPTURED:" + data.accessToken;
                                            }
                                        })
                                        .catch(() => {});
                                }
                            } catch (_) {}
                        }
                        setInterval(checkSpotifySession, 1000);
                        window.addEventListener("load", checkSpotifySession);
                    })();
                    "#,
                )
                .on_document_title_changed(move |_win, title| {
                    if let Some(token) = title.strip_prefix("YTMSPOTIFY_CAPTURED:") {
                        let token_str = token.trim().to_string();
                        if !token_str.is_empty() {
                            eprintln!("[SPOTIFY AUTH] token captured via in-page session query");
                            let _ = controller_for_title.handle_captured_token(&app_handle_for_title, &token_str);
                        }
                    }
                })
                .on_navigation(|url| {
                    if crate::url_policy::is_allowed_spotify_auth_url(url) {
                        true
                    } else {
                        if url.scheme() == "https" {
                            crate::platform::open_url(url.as_str());
                        }
                        false
                    }
                })
                .on_new_window(move |url, features| {
                    if !crate::url_policy::is_allowed_spotify_auth_url(&url) {
                        if url.scheme() == "https" {
                            crate::platform::open_url(url.as_str());
                        }
                        return NewWindowResponse::Deny;
                    }

                    let popup_id = POPUP_COUNTER.fetch_add(1, Ordering::Relaxed) + 1;
                    let label = format!("spotify_login_popup_{popup_id}");
                    let blank_url = match url::Url::parse("about:blank") {
                        Ok(url) => url,
                        Err(_) => return NewWindowResponse::Deny,
                    };
                    let popup = WebviewWindowBuilder::new(
                        &app_for_popups,
                        label,
                        WebviewUrl::External(blank_url),
                    )
                    .window_features(features)
                    .title("Spotify Sign In")
                    .theme(Some(Theme::Dark))
                    .user_agent(client::DESKTOP_USER_AGENT)
                    .on_navigation(|popup_url| {
                        if crate::url_policy::is_allowed_spotify_auth_url(popup_url) {
                            true
                        } else {
                            if popup_url.scheme() == "https" {
                                crate::platform::open_url(popup_url.as_str());
                            }
                            false
                        }
                    })
                    .build();

                    match popup {
                        Ok(window) => NewWindowResponse::Create { window },
                        Err(error) => {
                            eprintln!("[SPOTIFY AUTH] failed to create login popup: {error}");
                            NewWindowResponse::Deny
                        }
                    }
                })
                .build()
                .map_err(|e| e.to_string())?;

        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        self.spawn_cookie_monitor(app.clone(), generation);
        Ok(())
    }

    fn spawn_cookie_monitor(&self, app: AppHandle, generation: u64) {
        let controller = self.clone();
        thread::spawn(move || {
            let cookie_urls = [
                url::Url::parse("https://open.spotify.com/").ok(),
                url::Url::parse("https://spotify.com/").ok(),
                url::Url::parse("https://accounts.spotify.com/").ok(),
            ];
            let mut rejected_cookie: Option<String> = None;

            for _ in 0..COOKIE_POLL_LIMIT {
                if controller.auth_generation.load(Ordering::SeqCst) != generation {
                    break;
                }
                let Some(window) = app.get_webview_window(LOGIN_WINDOW_LABEL) else {
                    break;
                };

                let mut found_sp_dc: Option<String> = None;
                for candidate in cookie_urls.iter().flatten() {
                    if let Ok(cookies) = window.cookies_for_url(candidate.clone()) {
                        if let Some(cookie) = cookies.into_iter().find(|cookie| {
                            cookie.name() == "sp_dc" && !cookie.value().trim().is_empty()
                        }) {
                            found_sp_dc = Some(cookie.value().to_string());
                            break;
                        }
                    }
                }

                if let Some(value) = found_sp_dc {
                    if rejected_cookie.as_deref() != Some(value.as_str()) {
                        eprintln!("[SPOTIFY AUTH] captured sp_dc cookie, validating...");
                        match controller.handle_captured_token(&app, &format!("sp_dc={value}")) {
                            Ok(_) => {
                                eprintln!("[SPOTIFY AUTH] successfully validated and stored Spotify session");
                                break;
                            }
                            Err(error) => {
                                eprintln!(
                                    "[SPOTIFY AUTH] failed validating captured sp_dc: {error}"
                                );
                                rejected_cookie = Some(value);
                                emit_auth_error(&app, &error);
                            }
                        }
                    }
                }
                thread::sleep(COOKIE_POLL_INTERVAL);
            }
        });
    }

    pub fn open_browser_login(&self, app: &AppHandle) -> Result<BrowserAuthMode, String> {
        let login = super::local_auth::start_browser_login(app.clone(), self.clone())?;
        if !crate::platform::open_url(&login.url) {
            return Err("Windows could not open the Spotify sign-in page".to_string());
        }
        Ok(login.mode)
    }

    pub fn handle_captured_token(
        &self,
        app: &AppHandle,
        token_or_cookie: &str,
    ) -> Result<SpotifySession, String> {
        let resolved = client::resolve_token_or_cookie(token_or_cookie)?;
        let (user_id, display_name) = client::get_user_profile(&resolved.access_token)
            .unwrap_or_else(|_| ("spotify_user".to_string(), Some("Spotify User".to_string())));
        let session = SpotifySession {
            access_token: resolved.access_token,
            expires_at_unix: resolved.expires_at_unix,
            refresh_token: None,
            oauth_client_id: None,
            sp_dc: resolved.sp_dc,
            user_id: Some(user_id),
            user_name: display_name,
        };
        self.store_session(app, session)
    }

    pub fn handle_oauth_token(
        &self,
        app: &AppHandle,
        token: client::OAuthTokenResponse,
        client_id: &str,
    ) -> Result<SpotifySession, String> {
        let (user_id, display_name) = client::get_user_profile(&token.access_token)
            .unwrap_or_else(|_| ("spotify_user".to_string(), Some("Spotify User".to_string())));
        let session = SpotifySession {
            access_token: token.access_token,
            expires_at_unix: unix_now() + token.expires_in.max(60),
            refresh_token: token.refresh_token,
            oauth_client_id: Some(client_id.to_string()),
            sp_dc: None,
            user_id: Some(user_id),
            user_name: display_name,
        };
        self.store_session(app, session)
    }

    fn store_session(
        &self,
        app: &AppHandle,
        session: SpotifySession,
    ) -> Result<SpotifySession, String> {
        credentials::save_session(&session)?;
        *self
            .current_session
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(session.clone());
        self.auth_generation.fetch_add(1, Ordering::SeqCst);
        close_auth_windows(app);
        emit_connected(app, session.user_name.as_deref().unwrap_or("Spotify User"));
        Ok(session)
    }

    pub fn logout(&self, app: &AppHandle) {
        self.auth_generation.fetch_add(1, Ordering::SeqCst);
        *self
            .current_session
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        credentials::clear_session();
        close_auth_windows(app);
    }
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn close_auth_windows(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if label == LOGIN_WINDOW_LABEL || label.starts_with("spotify_login_popup_") {
            let _ = window.close();
        }
    }
}

fn emit_connected(app: &AppHandle, user_name: &str) {
    let payload = serde_json::json!({ "user_name": user_name });
    emit_to_main(app, "session_connected", &payload);
}

fn emit_auth_error(app: &AppHandle, error: &str) {
    let payload = serde_json::json!({ "error": error });
    emit_to_main(app, "session_error", &payload);
}

fn emit_to_main(app: &AppHandle, event: &str, payload: &serde_json::Value) {
    let Some(main) = app.get_webview_window("main") else {
        return;
    };
    let Ok(event_json) = serde_json::to_string(event) else {
        return;
    };
    let script = format!("window.__ytmSpotify?.emit?.({event_json}, {});", payload);
    let _ = main.eval(&script);
}
