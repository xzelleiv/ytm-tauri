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
    token_refresh: Arc<Mutex<()>>,
}

impl SpotifyController {
    pub fn new() -> Self {
        Self {
            current_session: Arc::new(Mutex::new(credentials::load_session())),
            auth_generation: Arc::new(AtomicU64::new(0)),
            token_refresh: Arc::new(Mutex::new(())),
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
        let _refresh_guard = self
            .token_refresh
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let generation = self.auth_generation.load(Ordering::SeqCst);
        let mut session = self
            .current_session
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
            .ok_or_else(|| "Spotify is not connected".to_string())?;

        if !session.access_token.is_empty()
            && (session.expires_at_unix == 0
                || session.expires_at_unix > unix_now() + TOKEN_REFRESH_SKEW_SECS)
        {
            return Ok(session.access_token);
        }

        if let Some(sp_dc) = session.sp_dc.clone().filter(|value| !value.is_empty()) {
            let refreshed = client::resolve_token_or_cookie(&format!("sp_dc={sp_dc}"))?;
            session.access_token = refreshed.access_token;
            session.expires_at_unix = refreshed.expires_at_unix;
        } else if let (Some(client_id), Some(refresh_token)) = (
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
        } else {
            return Err("The Spotify session expired. Connect Spotify again.".to_string());
        }

        let mut current = self
            .current_session
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.auth_generation.load(Ordering::SeqCst) != generation || current.is_none() {
            return Err("The Spotify session changed while its token was refreshing.".to_string());
        }
        credentials::save_session(&session)?;
        let token = session.access_token.clone();
        *current = Some(session);
        Ok(token)
    }

    pub fn open_login_window(&self, app: &AppHandle) -> Result<(), String> {
        if let Some(existing) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
            let generation = self.begin_auth_attempt();
            existing.show().map_err(|e| e.to_string())?;
            existing.set_focus().map_err(|e| e.to_string())?;
            self.spawn_cookie_monitor(app.clone(), generation);
            return Ok(());
        }

        let login_url = url::Url::parse("https://open.spotify.com/").map_err(|e| e.to_string())?;
        let app_for_popups = app.clone();
        let generation = self.begin_auth_attempt();

        let window = match WebviewWindowBuilder::new(
            app,
            LOGIN_WINDOW_LABEL,
            WebviewUrl::External(login_url),
        )
        .title("Spotify Sign In")
        .inner_size(900.0, 760.0)
        .min_inner_size(560.0, 620.0)
        .theme(Some(Theme::Dark))
        .center()
        .incognito(true)
        .user_agent(client::DESKTOP_USER_AGENT)
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
            let popup =
                WebviewWindowBuilder::new(&app_for_popups, label, WebviewUrl::External(blank_url))
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
        {
            Ok(window) => window,
            Err(error) => {
                self.cancel_auth_attempt(generation);
                return Err(error.to_string());
            }
        };

        if let Err(error) = window.show().and_then(|_| window.set_focus()) {
            self.cancel_auth_attempt(generation);
            let _ = window.close();
            return Err(error.to_string());
        }
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
                        match controller.handle_captured_token_for_generation(
                            &app,
                            &format!("sp_dc={value}"),
                            generation,
                        ) {
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
            self.cancel_auth_attempt(login.generation);
            return Err("Windows could not open the Spotify sign-in page".to_string());
        }
        Ok(login.mode)
    }

    pub(crate) fn begin_auth_attempt(&self) -> u64 {
        let _session = self
            .current_session
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.auth_generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub(crate) fn auth_attempt_is_current(&self, generation: u64) -> bool {
        self.auth_generation.load(Ordering::SeqCst) == generation
    }

    pub(crate) fn cancel_auth_attempt(&self, generation: u64) {
        let _session = self
            .current_session
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _ = self.auth_generation.compare_exchange(
            generation,
            generation.saturating_add(1),
            Ordering::SeqCst,
            Ordering::SeqCst,
        );
    }

    pub(crate) fn handle_captured_token_for_generation(
        &self,
        app: &AppHandle,
        token_or_cookie: &str,
        generation: u64,
    ) -> Result<SpotifySession, String> {
        if !self.auth_attempt_is_current(generation) {
            return Err("This Spotify sign-in attempt was superseded.".to_string());
        }
        let resolved = client::resolve_token_or_cookie(token_or_cookie)?;
        let (user_id, display_name) = client::get_user_profile(&resolved.access_token)
            .map_err(|error| format!("Spotify session validation failed: {error}"))?;
        let session = SpotifySession {
            access_token: resolved.access_token,
            expires_at_unix: resolved.expires_at_unix,
            refresh_token: None,
            oauth_client_id: None,
            sp_dc: resolved.sp_dc,
            user_id: Some(user_id),
            user_name: display_name,
        };
        self.store_session(app, session, generation)
    }

    pub(crate) fn handle_oauth_token_for_generation(
        &self,
        app: &AppHandle,
        token: client::OAuthTokenResponse,
        client_id: &str,
        generation: u64,
    ) -> Result<SpotifySession, String> {
        if !self.auth_attempt_is_current(generation) {
            return Err("This Spotify sign-in attempt was superseded.".to_string());
        }
        let (user_id, display_name) = client::get_user_profile(&token.access_token)
            .map_err(|error| format!("Spotify session validation failed: {error}"))?;
        let session = SpotifySession {
            access_token: token.access_token,
            expires_at_unix: unix_now() + token.expires_in.max(60),
            refresh_token: token.refresh_token,
            oauth_client_id: Some(client_id.to_string()),
            sp_dc: None,
            user_id: Some(user_id),
            user_name: display_name,
        };
        self.store_session(app, session, generation)
    }

    fn store_session(
        &self,
        app: &AppHandle,
        session: SpotifySession,
        generation: u64,
    ) -> Result<SpotifySession, String> {
        let mut current = self
            .current_session
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.auth_generation.load(Ordering::SeqCst) != generation {
            return Err("This Spotify sign-in attempt was superseded.".to_string());
        }
        credentials::save_session(&session)?;
        *current = Some(session.clone());
        self.auth_generation.fetch_add(1, Ordering::SeqCst);
        drop(current);
        close_auth_windows(app);
        emit_connected(app, session.user_name.as_deref().unwrap_or("Spotify User"));
        Ok(session)
    }

    pub fn logout(&self, app: &AppHandle) {
        let mut current = self
            .current_session
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.auth_generation.fetch_add(1, Ordering::SeqCst);
        *current = None;
        credentials::clear_session();
        drop(current);
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

pub(super) fn emit_auth_error(app: &AppHandle, error: &str) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_auth_attempt_fences_older_attempts() {
        let controller = SpotifyController::default();
        let first = controller.begin_auth_attempt();
        let second = controller.begin_auth_attempt();

        assert!(!controller.auth_attempt_is_current(first));
        assert!(controller.auth_attempt_is_current(second));
        controller.cancel_auth_attempt(first);
        assert!(controller.auth_attempt_is_current(second));
        controller.cancel_auth_attempt(second);
        assert!(!controller.auth_attempt_is_current(second));
    }
}
