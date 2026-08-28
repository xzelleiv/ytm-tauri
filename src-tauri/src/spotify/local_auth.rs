use super::client;
use super::SpotifyController;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::{Duration, Instant};
use tauri::AppHandle;

const AUTH_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_REQUEST_BYTES: usize = 16 * 1024;
const SPOTIFY_SCOPES: &str =
    "playlist-read-private playlist-read-collaborative user-library-read user-read-private";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BrowserAuthMode {
    OAuthPkce,
    ManualCredential,
}

impl BrowserAuthMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OAuthPkce => "oauth_pkce",
            Self::ManualCredential => "manual_credential",
        }
    }
}

pub struct BrowserLogin {
    pub url: String,
    pub mode: BrowserAuthMode,
}

enum ServerMode {
    OAuth {
        client_id: String,
        redirect_uri: String,
        verifier: String,
        state: String,
    },
    Manual {
        nonce: String,
    },
}

struct HttpRequest {
    method: String,
    target: String,
    body: Vec<u8>,
}

pub fn start_browser_login(
    app: AppHandle,
    controller: SpotifyController,
) -> Result<BrowserLogin, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    let (url, mode) = if let Some(client_id) = configured_client_id() {
        let redirect_uri = format!("http://127.0.0.1:{port}/callback");
        let verifier = random_urlsafe(32);
        let state = random_urlsafe(24);
        let challenge = pkce_challenge(&verifier);
        let url = build_authorize_url(&client_id, &redirect_uri, &challenge, &state)?;
        (
            url,
            ServerMode::OAuth {
                client_id,
                redirect_uri,
                verifier,
                state,
            },
        )
    } else {
        let nonce = random_urlsafe(24);
        (
            format!("http://127.0.0.1:{port}/"),
            ServerMode::Manual { nonce },
        )
    };

    let auth_mode = match mode {
        ServerMode::OAuth { .. } => BrowserAuthMode::OAuthPkce,
        ServerMode::Manual { .. } => BrowserAuthMode::ManualCredential,
    };
    thread::spawn(move || serve(listener, app, controller, mode));

    Ok(BrowserLogin {
        url,
        mode: auth_mode,
    })
}

fn configured_client_id() -> Option<String> {
    std::env::var("YTM_SPOTIFY_CLIENT_ID")
        .ok()
        .or_else(|| option_env!("YTM_SPOTIFY_CLIENT_ID").map(str::to_string))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn random_urlsafe(byte_count: usize) -> String {
    let mut bytes = vec![0u8; byte_count];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn build_authorize_url(
    client_id: &str,
    redirect_uri: &str,
    challenge: &str,
    state: &str,
) -> Result<String, String> {
    let mut url =
        url::Url::parse("https://accounts.spotify.com/authorize").map_err(|e| e.to_string())?;
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", SPOTIFY_SCOPES)
        .append_pair("code_challenge_method", "S256")
        .append_pair("code_challenge", challenge)
        .append_pair("state", state);
    Ok(url.into())
}

fn serve(listener: TcpListener, app: AppHandle, controller: SpotifyController, mode: ServerMode) {
    let _ = listener.set_nonblocking(true);
    let deadline = Instant::now() + AUTH_TIMEOUT;

    while Instant::now() < deadline {
        match listener.accept() {
            Ok((mut stream, peer)) if peer.ip().is_loopback() => {
                let should_stop = handle_connection(&mut stream, &app, &controller, &mode);
                let _ = stream.flush();
                if should_stop {
                    break;
                }
            }
            Ok((_stream, _peer)) => {}
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(75));
            }
            Err(_) => break,
        }
    }
}

fn handle_connection(
    stream: &mut TcpStream,
    app: &AppHandle,
    controller: &SpotifyController,
    mode: &ServerMode,
) -> bool {
    let request = match read_request(stream) {
        Ok(request) => request,
        Err(error) => {
            write_html(stream, 400, &error_html(&error));
            return false;
        }
    };

    match mode {
        ServerMode::OAuth {
            client_id,
            redirect_uri,
            verifier,
            state,
        } => handle_oauth_callback(
            stream,
            app,
            controller,
            &request,
            client_id,
            redirect_uri,
            verifier,
            state,
        ),
        ServerMode::Manual { nonce } => {
            handle_manual_request(stream, app, controller, &request, nonce)
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn handle_oauth_callback(
    stream: &mut TcpStream,
    app: &AppHandle,
    controller: &SpotifyController,
    request: &HttpRequest,
    client_id: &str,
    redirect_uri: &str,
    verifier: &str,
    expected_state: &str,
) -> bool {
    if request.method != "GET" {
        write_empty(stream, 405);
        return false;
    }

    let Ok(url) = url::Url::parse(&format!("http://127.0.0.1{}", request.target)) else {
        write_empty(stream, 400);
        return false;
    };
    if url.path() != "/callback" {
        write_empty(stream, 404);
        return false;
    }

    let params: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    if params.get("state").map(String::as_str) != Some(expected_state) {
        write_html(
            stream,
            400,
            &error_html("The Spotify sign-in state did not match."),
        );
        return true;
    }
    if let Some(error) = params.get("error") {
        write_html(
            stream,
            400,
            &error_html(&format!("Spotify sign-in was not completed: {error}")),
        );
        return true;
    }
    let Some(code) = params.get("code") else {
        write_html(
            stream,
            400,
            &error_html("Spotify did not return an authorization code."),
        );
        return true;
    };

    let result = client::exchange_oauth_code(client_id, code, redirect_uri, verifier)
        .and_then(|token| controller.handle_oauth_token(app, token, client_id));
    match result {
        Ok(session) => {
            let user_name = session.user_name.as_deref().unwrap_or("Spotify User");
            write_html(stream, 200, &success_html(user_name));
        }
        Err(error) => write_html(stream, 400, &error_html(&error)),
    }
    true
}

fn handle_manual_request(
    stream: &mut TcpStream,
    app: &AppHandle,
    controller: &SpotifyController,
    request: &HttpRequest,
    expected_nonce: &str,
) -> bool {
    if request.method == "GET" && (request.target == "/" || request.target == "/index.html") {
        write_html(stream, 200, &landing_html(expected_nonce));
        return false;
    }
    if request.method != "POST" || request.target != "/submit" {
        write_empty(
            stream,
            if request.target == "/submit" {
                405
            } else {
                404
            },
        );
        return false;
    }

    let fields: std::collections::HashMap<_, _> = url::form_urlencoded::parse(&request.body)
        .into_owned()
        .collect();
    if fields.get("nonce").map(String::as_str) != Some(expected_nonce) {
        write_html(stream, 400, &error_html("The local sign-in form expired."));
        return false;
    }
    let Some(raw_token) = fields
        .get("token")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        write_html(
            stream,
            400,
            &error_html("Enter an access token or sp_dc cookie."),
        );
        return false;
    };

    match controller.handle_captured_token(app, raw_token) {
        Ok(session) => {
            let user_name = session.user_name.as_deref().unwrap_or("Spotify User");
            write_html(stream, 200, &success_html(user_name));
            true
        }
        Err(error) => {
            write_html(stream, 400, &error_html(&error));
            false
        }
    }
}

fn read_request(stream: &mut TcpStream) -> Result<HttpRequest, String> {
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
            return Err("The local authentication request was too large.".to_string());
        }

        if let Some(header_end) = find_header_end(&bytes) {
            let content_length = parse_content_length(&bytes[..header_end])?;
            if bytes.len() >= header_end + 4 + content_length {
                break;
            }
        }
    }

    let header_end = find_header_end(&bytes).ok_or_else(|| "Invalid HTTP request.".to_string())?;
    let header = std::str::from_utf8(&bytes[..header_end])
        .map_err(|_| "Invalid HTTP request headers.".to_string())?;
    let mut request_line = header.lines().next().unwrap_or_default().split_whitespace();
    let method = request_line.next().unwrap_or_default().to_string();
    let target = request_line.next().unwrap_or_default().to_string();
    if method.is_empty() || target.is_empty() || !target.starts_with('/') {
        return Err("Invalid HTTP request line.".to_string());
    }
    let content_length = parse_content_length(&bytes[..header_end])?;
    let body_start = header_end + 4;
    let body_end = body_start + content_length;
    if body_end > bytes.len() {
        return Err("Incomplete HTTP request body.".to_string());
    }

    Ok(HttpRequest {
        method,
        target,
        body: bytes[body_start..body_end].to_vec(),
    })
}

fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n")
}

fn parse_content_length(header: &[u8]) -> Result<usize, String> {
    let header = std::str::from_utf8(header).map_err(|_| "Invalid HTTP headers.".to_string())?;
    for line in header.lines().skip(1) {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.trim().eq_ignore_ascii_case("content-length") {
            return value
                .trim()
                .parse::<usize>()
                .map_err(|_| "Invalid Content-Length header.".to_string());
        }
    }
    Ok(0)
}

fn write_html(stream: &mut TcpStream, status: u16, body: &str) {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Error",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
}

fn write_empty(stream: &mut TcpStream, status: u16) {
    let reason = if status == 405 {
        "Method Not Allowed"
    } else if status == 400 {
        "Bad Request"
    } else {
        "Not Found"
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Length: 0\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
    );
    let _ = stream.write_all(response.as_bytes());
}

fn page_shell(title: &str, content: &str) -> String {
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{}</title><style>
body{{font-family:"Segoe UI",sans-serif;background:#121212;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box}}.card{{width:min(520px,100%);background:#1e1e1e;border:1px solid #343434;border-radius:14px;padding:30px;box-sizing:border-box;box-shadow:0 12px 32px #0008}}h1{{font-size:22px;margin:0 0 10px;color:#1db954}}p,li{{font-size:14px;line-height:1.5;color:#b3b3b3}}code{{color:#fff;background:#2a2a2a;padding:2px 5px;border-radius:4px}}input{{width:100%;box-sizing:border-box;padding:11px 13px;border-radius:8px;border:1px solid #484848;background:#282828;color:#fff;margin:8px 0 12px}}button{{width:100%;border:0;border-radius:20px;background:#1db954;color:#000;font-weight:700;padding:11px 18px;cursor:pointer}}strong{{color:#fff}}
</style></head><body><main class="card">{}</main></body></html>"#,
        html_escape(title),
        content
    )
}

fn landing_html(nonce: &str) -> String {
    page_shell(
        "Connect Spotify",
        &format!(
            r#"<h1>Connect Spotify</h1><p>Sign in to <strong>open.spotify.com</strong> in your normal browser, then paste either the <code>sp_dc</code> cookie value or a web access token here. The credential is sent only to this local app and is protected with Windows DPAPI.</p><form method="post" action="/submit" autocomplete="off"><input type="hidden" name="nonce" value="{}"><label for="token">Spotify session credential</label><input id="token" name="token" type="password" required spellcheck="false" placeholder="sp_dc value or access token"><button type="submit">Connect to YouTube Music</button></form>"#,
            html_escape(nonce)
        ),
    )
}

fn success_html(user_name: &str) -> String {
    page_shell(
        "Spotify Connected",
        &format!(
            "<h1>Spotify Connected</h1><p>Successfully linked <strong>{}</strong>. You can close this tab and return to YouTube Music.</p>",
            html_escape(user_name)
        ),
    )
}

fn error_html(error: &str) -> String {
    page_shell(
        "Spotify Authentication Error",
        &format!(
            "<h1>Authentication Failed</h1><p>{}</p>",
            html_escape(error)
        ),
    )
}

fn html_escape(value: &str) -> String {
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

    #[test]
    fn pkce_challenge_matches_rfc_example() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn authorize_url_contains_required_security_fields() {
        let url = build_authorize_url(
            "client",
            "http://127.0.0.1:43821/callback",
            "challenge",
            "state",
        )
        .expect("authorize URL");
        assert!(url.starts_with("https://accounts.spotify.com/authorize?"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("state=state"));
        assert!(url.contains("user-library-read"));
    }

    #[test]
    fn manual_page_posts_secret_and_contains_no_emoji() {
        let html = landing_html("nonce");
        assert!(html.contains("method=\"post\""));
        assert!(html.contains("name=\"nonce\" value=\"nonce\""));
        assert!(!html.contains("/submit?token="));
        assert!(html.is_ascii());
    }

    #[test]
    fn html_values_are_escaped() {
        let html = success_html("<script>alert(1)</script>");
        assert!(!html.contains("<script>alert"));
        assert!(html.contains("&lt;script&gt;"));
    }
}
