use serde::{Deserialize, Serialize};
use std::{collections::HashMap, thread, time::Duration};
use tauri::{Url, WebviewWindow};

const PREFIX: &str = "YTMFEATURE:";
const MAX_REQUEST_BODY: usize = 256 * 1024;
const MAX_RESPONSE_BODY: usize = 2 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct FeatureRequest {
    id: u64,
    kind: String,
    url: String,
    #[serde(default = "default_method")]
    method: String,
    body: Option<String>,
    #[serde(default)]
    headers: HashMap<String, String>,
}

#[derive(Serialize)]
struct FeatureResponse {
    ok: bool,
    status: Option<u16>,
    body: Option<String>,
    headers: HashMap<String, String>,
    error: Option<String>,
}

fn default_method() -> String {
    "GET".to_string()
}

pub fn is_feature_title_message(title: &str) -> bool {
    title.starts_with(PREFIX)
}

pub fn handle_title(window: &WebviewWindow, title: &str) {
    let Some(request) = parse_request(title) else {
        return;
    };
    let window = window.clone();

    thread::spawn(move || {
        let response = execute_request(&request);
        let Ok(payload) = serde_json::to_string(&response) else {
            return;
        };
        let script = format!(
            "window.__ytmFeatures?.receive?.({}, {});",
            request.id, payload
        );
        let _ = window.eval(&script);
    });
}

fn parse_request(title: &str) -> Option<FeatureRequest> {
    let raw = title.strip_prefix(PREFIX)?;
    let request: FeatureRequest = serde_json::from_str(raw).ok()?;

    if request.kind != "http" || !matches!(request.method.as_str(), "GET" | "POST") {
        return None;
    }
    if request
        .body
        .as_ref()
        .is_some_and(|body| body.len() > MAX_REQUEST_BODY)
    {
        return None;
    }
    let url = Url::parse(&request.url).ok()?;
    if url.scheme() != "https" || !url.host_str().is_some_and(is_allowed_host) {
        return None;
    }

    Some(request)
}

fn execute_request(request: &FeatureRequest) -> FeatureResponse {
    let client = match reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(5))
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .user_agent(concat!("ytm-tauri/", env!("CARGO_PKG_VERSION")))
        .build()
    {
        Ok(client) => client,
        Err(error) => return error_response(error.to_string()),
    };

    let mut builder = match request.method.as_str() {
        "POST" => client.post(&request.url),
        _ => client.get(&request.url),
    };

    for (name, value) in &request.headers {
        if is_allowed_header(name) {
            builder = builder.header(name, value);
        }
    }
    if let Some(body) = &request.body {
        builder = builder.body(body.clone());
    }

    let response = match builder.send() {
        Ok(response) => response,
        Err(error) => return error_response(error.to_string()),
    };
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_string(), value.to_string()))
        })
        .collect();
    let body = match response.text() {
        Ok(body) if body.len() <= MAX_RESPONSE_BODY => body,
        Ok(_) => return error_response("response too large".to_string()),
        Err(error) => return error_response(error.to_string()),
    };

    FeatureResponse {
        ok: (200..300).contains(&status),
        status: Some(status),
        body: Some(body),
        headers,
        error: None,
    }
}

fn error_response(error: String) -> FeatureResponse {
    FeatureResponse {
        ok: false,
        status: None,
        body: None,
        headers: HashMap::new(),
        error: Some(error),
    }
}

fn is_allowed_host(host: &str) -> bool {
    matches!(
        host,
        "lrclib.net"
            | "genius.com"
            | "www.genius.com"
            | "megalobiz.com"
            | "www.megalobiz.com"
            | "apic-desktop.musixmatch.com"
            | "ytmbrowseproxy.zvz.be"
            | "b-ytmbrowseproxy.zvz.be"
            | "sponsor.ajay.app"
    )
}

fn is_allowed_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "accept" | "content-type" | "cookie" | "authority"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_provider_hosts_are_allowed() {
        assert!(is_allowed_host("lrclib.net"));
        assert!(is_allowed_host("genius.com"));
        assert!(is_allowed_host("apic-desktop.musixmatch.com"));
        assert!(!is_allowed_host("example.com"));
        assert!(!is_allowed_host("lrclib.net.example.com"));
    }

    #[test]
    fn bridge_rejects_unknown_urls_and_methods() {
        let external = r#"YTMFEATURE:{"id":1,"kind":"http","url":"https://example.com/"}"#;
        let method = r#"YTMFEATURE:{"id":1,"kind":"http","url":"https://lrclib.net/api/search","method":"DELETE"}"#;

        assert!(parse_request(external).is_none());
        assert!(parse_request(method).is_none());
    }

    #[test]
    fn bridge_accepts_known_provider_requests() {
        let request =
            r#"YTMFEATURE:{"id":7,"kind":"http","url":"https://lrclib.net/api/search?q=test"}"#;
        let parsed = parse_request(request).expect("request");

        assert_eq!(parsed.id, 7);
        assert_eq!(parsed.method, "GET");
    }
}
