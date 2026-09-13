use crate::settings::SharedSettings;
use crate::spotify::credentials::{decrypt_data, encrypt_data};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::Mutex,
    thread,
    time::Duration,
};

const LASTFM_API_ROOT: &str = "https://ws.audioscrobbler.com/2.0/";
const LISTENBRAINZ_VALIDATE_ROOT: &str = "https://api.listenbrainz.org/1/validate-token";
const LASTFM_AUTH_ROOT: &str = "https://www.last.fm/api/auth/";
const MAX_REQUEST_BYTES: usize = 16 * 1024;
static SECRET_STORE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ScrobbleSecrets {
    pub lastfm_api_key: Option<String>,
    pub lastfm_api_secret: Option<String>,
    pub lastfm_session_key: Option<String>,
    pub listenbrainz_token: Option<String>,
}

pub fn load() -> ScrobbleSecrets {
    let _guard = SECRET_STORE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    load_unlocked()
}

fn load_unlocked() -> ScrobbleSecrets {
    let Some(path) = credentials_path() else {
        return ScrobbleSecrets::default();
    };
    load_from_path(&path)
}

fn load_from_path(path: &Path) -> ScrobbleSecrets {
    let Some(encrypted) = fs::read(path).ok() else {
        return ScrobbleSecrets::default();
    };
    decrypt_data(&encrypted)
        .ok()
        .and_then(|data| serde_json::from_slice(&data).ok())
        .unwrap_or_default()
}

fn save_to_path(path: &Path, secrets: &ScrobbleSecrets) -> Result<(), String> {
    let data = serde_json::to_vec(secrets).map_err(|e| e.to_string())?;
    let encrypted = encrypt_data(&data)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, encrypted).map_err(|e| e.to_string())?;
    fs::rename(&temporary, path).map_err(|e| e.to_string())
}

// serialize provider credential updates
fn update_secrets(update: impl FnOnce(&mut ScrobbleSecrets)) -> Result<(), String> {
    let path = credentials_path().ok_or_else(|| "no app data directory".to_string())?;
    update_secrets_at(&path, update)
}

fn update_secrets_at(path: &Path, update: impl FnOnce(&mut ScrobbleSecrets)) -> Result<(), String> {
    let _guard = SECRET_STORE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut secrets = load_from_path(path);
    update(&mut secrets);
    save_to_path(path, &secrets)
}

pub fn save_lastfm(api_key: String, api_secret: String, session_key: String) -> Result<(), String> {
    update_secrets(|secrets| {
        secrets.lastfm_api_key = Some(api_key);
        secrets.lastfm_api_secret = Some(api_secret);
        secrets.lastfm_session_key = Some(session_key);
    })
}

pub fn save_listenbrainz(token: String) -> Result<(), String> {
    update_secrets(|secrets| secrets.listenbrainz_token = Some(token))
}

pub fn clear_lastfm() -> Result<(), String> {
    update_secrets(|secrets| {
        secrets.lastfm_api_key = None;
        secrets.lastfm_api_secret = None;
        secrets.lastfm_session_key = None;
    })
}

pub fn clear_listenbrainz() -> Result<(), String> {
    update_secrets(|secrets| secrets.listenbrainz_token = None)
}

pub fn start_lastfm(settings: SharedSettings) -> Result<(), String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let nonce = random_token();
    thread::spawn(move || serve_lastfm(listener, port, nonce, settings));
    if crate::platform::open_url(&format!("http://127.0.0.1:{port}/")) {
        Ok(())
    } else {
        Err("could not open the local Last.fm setup page".to_string())
    }
}

pub fn start_listenbrainz(settings: SharedSettings) -> Result<(), String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let nonce = random_token();
    thread::spawn(move || serve_listenbrainz(listener, port, nonce, settings));
    if crate::platform::open_url(&format!("http://127.0.0.1:{port}/")) {
        Ok(())
    } else {
        Err("could not open the local ListenBrainz setup page".to_string())
    }
}

#[derive(Default)]
struct LastFmFlow {
    nonce: String,
    api_key: Option<String>,
    api_secret: Option<String>,
    token: Option<String>,
}

fn serve_lastfm(listener: TcpListener, port: u16, nonce: String, settings: SharedSettings) {
    let _ = listener.set_nonblocking(true);
    let deadline = std::time::Instant::now() + Duration::from_secs(600);
    let mut flow = LastFmFlow {
        nonce,
        ..Default::default()
    };
    while std::time::Instant::now() < deadline {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let request = match read_request(&mut stream, port) {
                    Ok(request) => request,
                    Err(error) => {
                        write_html(
                            &mut stream,
                            400,
                            &error_html(&format!("Last.fm setup request was invalid: {error}")),
                        );
                        continue;
                    }
                };
                let (body, done) = handle_lastfm(&mut flow, port, &request, &settings);
                write_html(&mut stream, 200, &body);
                if done {
                    break;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(75))
            }
            Err(_) => break,
        }
    }
}

fn handle_lastfm(
    flow: &mut LastFmFlow,
    port: u16,
    request: &HttpRequest,
    settings: &SharedSettings,
) -> (String, bool) {
    if request.method == "GET" && request.target == "/" {
        flow.api_key = flow
            .api_key
            .take()
            .or_else(|| env_value("YTM_LASTFM_API_KEY"));
        flow.api_secret = flow
            .api_secret
            .take()
            .or_else(|| env_value("YTM_LASTFM_API_SECRET"));
        return match (&flow.api_key, &flow.api_secret) {
            (Some(api_key), Some(api_secret)) => match request_token(api_key, api_secret) {
                Ok(token) => {
                    flow.token = Some(token.clone());
                    (
                        lastfm_approval_html(api_key, &token, port, &flow.nonce),
                        false,
                    )
                }
                Err(error) => (error_html(&error), true),
            },
            _ => (lastfm_credentials_html(&flow.nonce), false),
        };
    }
    if request.method == "POST" && request.target == "/credentials" {
        let fields = form_fields(&request.body);
        if fields.get("nonce").map(String::as_str) != Some(flow.nonce.as_str()) {
            return (
                error_html("The Last.fm setup session expired. Start again."),
                true,
            );
        }
        flow.api_key = fields
            .get("api_key")
            .cloned()
            .filter(|v| !v.trim().is_empty());
        flow.api_secret = fields
            .get("api_secret")
            .cloned()
            .filter(|v| !v.trim().is_empty());
        return match (&flow.api_key, &flow.api_secret) {
            (Some(api_key), Some(api_secret)) => match request_token(api_key, api_secret) {
                Ok(token) => {
                    flow.token = Some(token.clone());
                    (
                        lastfm_approval_html(api_key, &token, port, &flow.nonce),
                        false,
                    )
                }
                Err(error) => (error_html(&error), true),
            },
            _ => (
                error_html("Enter both the Last.fm API key and API secret."),
                false,
            ),
        };
    }
    if request.method == "GET" && request.target == format!("/approved/{}", flow.nonce) {
        return match (&flow.api_key, &flow.api_secret, &flow.token) {
            (Some(api_key), Some(api_secret), Some(token)) => {
                match complete_lastfm(api_key, api_secret, token) {
                    Ok((user, session_key)) => {
                        if let Err(error) =
                            save_lastfm(api_key.clone(), api_secret.clone(), session_key.clone())
                        {
                            return (
                                error_html(&format!("Could not save Last.fm credentials: {error}")),
                                true,
                            );
                        } else {
                            if let Ok(mut value) = settings.lock() {
                                value.lastfm_session_key = Some(session_key);
                            }
                        }
                        (success_html("Last.fm", &user), true)
                    }
                    Err(error) => (error_html(&error), true),
                }
            }
            _ => (
                error_html("The Last.fm setup session expired. Start again."),
                true,
            ),
        };
    }
    (
        error_html("The local Last.fm setup page was not found."),
        false,
    )
}

fn serve_listenbrainz(listener: TcpListener, port: u16, nonce: String, settings: SharedSettings) {
    let _ = listener.set_nonblocking(true);
    let deadline = std::time::Instant::now() + Duration::from_secs(600);
    while std::time::Instant::now() < deadline {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let request = match read_request(&mut stream, port) {
                    Ok(request) => request,
                    Err(error) => {
                        write_html(
                            &mut stream,
                            400,
                            &error_html(&format!(
                                "ListenBrainz setup request was invalid: {error}"
                            )),
                        );
                        continue;
                    }
                };
                let (body, done) = if request.method == "GET" && request.target == "/" {
                    (listenbrainz_form_html(&nonce), false)
                } else if request.method == "POST" && request.target == "/submit" {
                    let fields = form_fields(&request.body);
                    if fields.get("nonce").map(String::as_str) != Some(nonce.as_str()) {
                        (
                            error_html("The ListenBrainz setup session expired. Start again."),
                            true,
                        )
                    } else if let Some(token) = fields
                        .get("token")
                        .map(String::as_str)
                        .map(str::trim)
                        .filter(|v| !v.is_empty())
                    {
                        match validate_listenbrainz(token) {
                            Ok(user) => {
                                if let Err(error) = save_listenbrainz(token.to_string()) {
                                    (
                                        error_html(&format!(
                                            "Could not save ListenBrainz credentials: {error}"
                                        )),
                                        true,
                                    )
                                } else {
                                    if let Ok(mut value) = settings.lock() {
                                        value.listenbrainz_token = Some(token.to_string());
                                    }
                                    (success_html("ListenBrainz", &user), true)
                                }
                            }
                            Err(error) => (error_html(&error), true),
                        }
                    } else {
                        (error_html("Enter a ListenBrainz user token."), false)
                    }
                } else {
                    (
                        error_html("The local ListenBrainz setup page was not found."),
                        false,
                    )
                };
                write_html(&mut stream, 200, &body);
                if done {
                    break;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(75))
            }
            Err(_) => break,
        }
    }
}

fn request_token(api_key: &str, secret: &str) -> Result<String, String> {
    let body = lastfm_call(api_key, secret, "auth.getToken", None)?;
    body.get("token")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .ok_or_else(|| "Last.fm did not return an authorization token.".to_string())
}

fn complete_lastfm(api_key: &str, secret: &str, token: &str) -> Result<(String, String), String> {
    let body = lastfm_call(api_key, secret, "auth.getSession", Some(token))?;
    let session = body
        .get("session")
        .ok_or_else(|| "Last.fm did not return an account session.".to_string())?;
    let name = session
        .get("name")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "Last.fm did not return an account name.".to_string())?;
    let key = session
        .get("key")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "Last.fm did not return a session key.".to_string())?;
    Ok((name.to_string(), key.to_string()))
}

fn lastfm_call(
    api_key: &str,
    secret: &str,
    method: &str,
    token: Option<&str>,
) -> Result<serde_json::Value, String> {
    let mut params = BTreeMap::from([
        ("api_key".to_string(), api_key.to_string()),
        ("method".to_string(), method.to_string()),
    ]);
    if let Some(token) = token {
        params.insert("token".to_string(), token.to_string());
    }
    let mut signed = String::new();
    for (name, value) in &params {
        signed.push_str(name);
        signed.push_str(value);
    }
    signed.push_str(secret);
    params.insert(
        "api_sig".to_string(),
        format!("{:x}", md5::compute(signed.as_bytes())),
    );
    params.insert("format".to_string(), "json".to_string());
    let response = Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?
        .post(LASTFM_API_ROOT)
        .form(&params)
        .send()
        .map_err(|_| {
            "Last.fm request failed. Check your network and app credentials.".to_string()
        })?;
    if !response.status().is_success() {
        return Err("Last.fm rejected the request.".to_string());
    }
    let body: serde_json::Value = response
        .json()
        .map_err(|_| "Last.fm returned an unreadable response.".to_string())?;
    if body.get("error").is_some() {
        return Err("Last.fm rejected the request. Check the API credentials.".to_string());
    }
    Ok(body)
}

fn validate_listenbrainz(token: &str) -> Result<String, String> {
    let response = Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?
        .get(LISTENBRAINZ_VALIDATE_ROOT)
        .header("Authorization", format!("Token {token}"))
        .send()
        .map_err(|_| "ListenBrainz request failed. Check your network.".to_string())?;
    if !response.status().is_success() {
        return Err("ListenBrainz rejected this token.".to_string());
    }
    let body: serde_json::Value = response
        .json()
        .map_err(|_| "ListenBrainz returned an unreadable response.".to_string())?;
    if body.get("valid").and_then(|value| value.as_bool()) != Some(true) {
        return Err("ListenBrainz rejected this token.".to_string());
    }
    Ok(body
        .get("user_name")
        .and_then(|value| value.as_str())
        .unwrap_or("ListenBrainz user")
        .to_string())
}

fn credentials_path() -> Option<PathBuf> {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("USERPROFILE").map(|p| PathBuf::from(p).join("AppData\\Roaming"))
        })
        .map(|dir| {
            dir.join("app.ytmusic.desktop")
                .join("scrobble_credentials.bin")
        })
}

fn env_value(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}
fn random_token() -> String {
    format!("{:032x}", rand::random::<u128>())
}

struct HttpRequest {
    method: String,
    target: String,
    body: Vec<u8>,
}

fn read_request(stream: &mut TcpStream, port: u16) -> Result<HttpRequest, String> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut bytes = Vec::with_capacity(2048);
    let mut buffer = [0u8; 2048];
    loop {
        let count = stream.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..count]);
        if bytes.len() > MAX_REQUEST_BYTES {
            return Err("request too large".to_string());
        }
        if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            let length = content_length(&bytes[..end])?;
            if bytes.len() >= end + 4 + length {
                break;
            }
        }
    }
    let end = bytes
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| "invalid request".to_string())?;
    let header = std::str::from_utf8(&bytes[..end]).map_err(|_| "invalid headers".to_string())?;
    let expected_host = format!("127.0.0.1:{port}");
    let host = header
        .lines()
        .find_map(|line| {
            line.split_once(':')
                .filter(|(name, _)| name.eq_ignore_ascii_case("host"))
                .map(|(_, value)| value.trim())
        })
        .ok_or_else(|| "missing host".to_string())?;
    if host != expected_host {
        return Err("invalid host".to_string());
    }
    let mut line = header.lines().next().unwrap_or_default().split_whitespace();
    let method = line.next().unwrap_or_default().to_string();
    let target = line.next().unwrap_or_default().to_string();
    if method.is_empty()
        || target.is_empty()
        || !target.starts_with('/')
        || !matches!(method.as_str(), "GET" | "POST")
    {
        return Err("invalid request line".to_string());
    }
    if method == "POST" {
        let expected_origin = format!("http://{expected_host}");
        if let Some(origin) = header.lines().find_map(|line| {
            line.split_once(':')
                .filter(|(name, _)| name.eq_ignore_ascii_case("origin"))
                .map(|(_, value)| value.trim())
        }) {
            // nonce validates opaque browser origins
            if origin != expected_origin && origin != "null" {
                return Err("invalid origin".to_string());
            }
        }
    }
    let length = content_length(&bytes[..end])?;
    let start = end + 4;
    if start + length > bytes.len() {
        return Err("incomplete body".to_string());
    }
    Ok(HttpRequest {
        method,
        target,
        body: bytes[start..start + length].to_vec(),
    })
}

fn content_length(header: &[u8]) -> Result<usize, String> {
    let header = std::str::from_utf8(header).map_err(|_| "invalid headers".to_string())?;
    let mut length = None;
    for line in header.lines() {
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                let value = value
                    .trim()
                    .parse::<usize>()
                    .map_err(|_| "invalid content length".to_string())?;
                if length
                    .replace(value)
                    .is_some_and(|previous| previous != value)
                {
                    return Err("conflicting content lengths".to_string());
                }
            }
        }
    }
    Ok(length.unwrap_or(0))
}
fn form_fields(body: &[u8]) -> std::collections::HashMap<String, String> {
    url::form_urlencoded::parse(body).into_owned().collect()
}

fn write_html(stream: &mut TcpStream, status: u16, body: &str) {
    let reason = if status == 200 { "OK" } else { "Error" };
    let response = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'\r\nReferrer-Policy: same-origin\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n{body}", body.len());
    let _ = stream.write_all(response.as_bytes());
}

fn shell(title: &str, content: &str) -> String {
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{}</title><style>body{{font-family:"Segoe UI",sans-serif;background:#121212;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box}}.card{{width:min(560px,100%);background:#1e1e1e;border:1px solid #343434;border-radius:14px;padding:30px;box-sizing:border-box;box-shadow:0 12px 32px #0008}}h1{{font-size:22px;margin:0 0 10px;color:#1db954}}p,li{{font-size:14px;line-height:1.5;color:#b3b3b3}}input{{width:100%;box-sizing:border-box;padding:11px 13px;border-radius:8px;border:1px solid #484848;background:#282828;color:#fff;margin:8px 0 12px}}button,a{{display:inline-block;border:0;border-radius:20px;background:#1db954;color:#000;font-weight:700;padding:11px 18px;cursor:pointer;text-decoration:none}}label{{font-size:13px;color:#ddd}}</style></head><body><main class="card">{}</main></body></html>"#,
        escape(title),
        content
    )
}
fn lastfm_credentials_html(nonce: &str) -> String {
    shell(
        "Connect Last.fm",
        &format!(
            r#"<h1>Connect Last.fm</h1><p>Enter your Last.fm application credentials. They stay on this local setup page and are stored encrypted by the desktop app.</p><form method="post" action="/credentials" autocomplete="off"><input type="hidden" name="nonce" value="{}"><label>API key</label><input name="api_key" required spellcheck="false"><label>API secret</label><input name="api_secret" type="password" required spellcheck="false"><button type="submit">Continue</button></form>"#,
            escape(nonce)
        ),
    )
}
fn lastfm_approval_html(api_key: &str, token: &str, port: u16, nonce: &str) -> String {
    let mut url = url::Url::parse(LASTFM_AUTH_ROOT).expect("constant URL");
    url.query_pairs_mut()
        .append_pair("api_key", api_key)
        .append_pair("token", token)
        .append_pair("cb", &format!("http://127.0.0.1:{port}/approved/{nonce}"));
    shell(
        "Authorize Last.fm",
        &format!(
            r#"<h1>Authorize Last.fm</h1><p>Approve access in Last.fm, then return here. The local page will finish the connection automatically.</p><p><a href="{}" target="_blank" rel="noreferrer">Open Last.fm authorization</a></p>"#,
            escape(url.as_str())
        ),
    )
}
fn listenbrainz_form_html(nonce: &str) -> String {
    shell(
        "Connect ListenBrainz",
        &format!(
            r#"<h1>Connect ListenBrainz</h1><p>Paste a ListenBrainz user token. It is validated locally and then stored encrypted by the desktop app.</p><form method="post" action="/submit" autocomplete="off"><input type="hidden" name="nonce" value="{}"><label>User token</label><input name="token" type="password" required spellcheck="false"><button type="submit">Connect</button></form>"#,
            escape(nonce)
        ),
    )
}
fn success_html(provider: &str, user: &str) -> String {
    shell("Connected", &format!("<h1>{provider} connected</h1><p>Connected as <strong>{}</strong>. You can close this page and return to YouTube Music.</p>", escape(user)))
}
fn error_html(error: &str) -> String {
    shell(
        "Connection error",
        &format!("<h1>Connection failed</h1><p>{}</p>", escape(error)),
    )
}
fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn credential_html_does_not_put_secrets_in_urls() {
        let html = lastfm_credentials_html("nonce");
        assert!(!html.contains("?api_key="));
        assert!(!html.contains("?api_secret="));
    }

    #[test]
    fn listenbrainz_form_escapes_nonce() {
        let html = listenbrainz_form_html("a&b");
        assert!(html.contains("a&amp;b"));
    }

    #[test]
    fn local_form_post_accepts_split_body_and_expected_origin() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
        let port = listener.local_addr().expect("address").port();
        let writer = std::thread::spawn(move || {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
            let head = format!("POST /submit HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: http://127.0.0.1:{port}\r\nContent-Length: 10\r\n\r\n");
            stream.write_all(head.as_bytes()).expect("headers");
            stream.write_all(b"nonce=abc\n").expect("body");
        });
        let (mut stream, _) = listener.accept().expect("accept");
        let request = read_request(&mut stream, port).expect("request");
        writer.join().expect("writer");
        assert_eq!(request.target, "/submit");
        assert_eq!(request.body, b"nonce=abc\n");
    }

    #[test]
    fn local_form_post_rejects_foreign_origin() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
        let port = listener.local_addr().expect("address").port();
        let writer = std::thread::spawn(move || {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
            let request = format!("POST /submit HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: http://evil.test\r\nContent-Length: 0\r\n\r\n");
            stream.write_all(request.as_bytes()).expect("request");
        });
        let (mut stream, _) = listener.accept().expect("accept");
        let error = match read_request(&mut stream, port) {
            Ok(_) => panic!("foreign origin accepted"),
            Err(error) => error,
        };
        assert_eq!(error, "invalid origin");
        writer.join().expect("writer");
    }

    #[test]
    fn concurrent_provider_updates_preserve_both_credentials() {
        let path = std::env::temp_dir().join(format!("ytm-scrobble-test-{}.bin", random_token()));
        let first_path = path.clone();
        let second_path = path.clone();
        let first = std::thread::spawn(move || {
            update_secrets_at(&first_path, |secrets| {
                secrets.lastfm_session_key = Some("synthetic-lastfm".into());
            })
        });
        let second = std::thread::spawn(move || {
            update_secrets_at(&second_path, |secrets| {
                secrets.listenbrainz_token = Some("synthetic-listenbrainz".into());
            })
        });
        let first_result = first.join().unwrap();
        let second_result = second.join().unwrap();
        let stored = load_from_path(&path);
        let temporary_exists = path.with_extension("tmp").exists();
        let _ = fs::remove_file(&path);
        first_result.unwrap();
        second_result.unwrap();
        assert_eq!(
            stored.lastfm_session_key.as_deref(),
            Some("synthetic-lastfm")
        );
        assert_eq!(
            stored.listenbrainz_token.as_deref(),
            Some("synthetic-listenbrainz")
        );
        assert!(!temporary_exists);
    }
}
