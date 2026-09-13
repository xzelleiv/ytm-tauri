use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SpotifyTrack {
    pub id: String,
    pub title: String,
    pub artists: Vec<String>,
    pub album: Option<String>,
    pub duration_ms: u64,
    pub is_explicit: bool,
    pub preview_url: Option<String>,
    pub uri: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SpotifyPlaylist {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub track_count: usize,
    pub image_url: Option<String>,
    pub owner_name: Option<String>,
    pub is_liked_songs: bool,
    pub is_collaborative: bool,
    pub is_owner: bool,
    pub snapshot_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpotifySession {
    #[serde(default)]
    pub access_token: String,
    #[serde(default)]
    pub expires_at_unix: u64,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub oauth_client_id: Option<String>,
    #[serde(default)]
    pub sp_dc: Option<String>,
    #[serde(default)]
    pub user_id: Option<String>,
    #[serde(default)]
    pub user_name: Option<String>,
    // encrypt native web player metadata
    #[serde(default)]
    pub web_client_id: Option<String>,
    #[serde(default)]
    pub web_client_token: Option<String>,
    #[serde(default)]
    pub web_app_version: Option<String>,
    #[serde(default)]
    pub web_metadata_expires_at_unix: u64,
}

impl SpotifySession {
    pub fn has_refresh_credential(&self) -> bool {
        self.sp_dc
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
            || (self
                .refresh_token
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
                && self
                    .oauth_client_id
                    .as_deref()
                    .is_some_and(|value| !value.trim().is_empty()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> SpotifySession {
        SpotifySession {
            access_token: String::new(),
            expires_at_unix: 0,
            refresh_token: None,
            oauth_client_id: None,
            sp_dc: None,
            user_id: None,
            user_name: None,
            web_client_id: None,
            web_client_token: None,
            web_app_version: None,
            web_metadata_expires_at_unix: 0,
        }
    }

    #[test]
    fn whitespace_credentials_do_not_keep_an_expired_session_alive() {
        let mut value = session();
        value.sp_dc = Some("  \t".to_string());
        assert!(!value.has_refresh_credential());

        value.sp_dc = None;
        value.refresh_token = Some("  ".to_string());
        value.oauth_client_id = Some("client-id".to_string());
        assert!(!value.has_refresh_credential());
    }

    #[test]
    fn session_metadata_round_trips_without_plaintext_policy_changes() {
        let mut value = session();
        value.sp_dc = Some("synthetic-cookie".to_string());
        value.web_client_id = Some("synthetic-client".to_string());
        value.web_client_token = Some("synthetic-web-token".to_string());
        value.web_app_version = Some("synthetic-version".to_string());
        value.web_metadata_expires_at_unix = 123;

        let encoded = serde_json::to_vec(&value).expect("serialize");
        let decoded: SpotifySession = serde_json::from_slice(&encoded).expect("deserialize");
        assert_eq!(
            serde_json::to_value(decoded).expect("encode decoded"),
            serde_json::to_value(value).expect("encode original")
        );
    }

    #[test]
    fn legacy_sessions_default_new_web_metadata_fields() {
        let decoded: SpotifySession = serde_json::from_str(
            r#"{"access_token":"token","expires_at_unix":0,"sp_dc":"cookie"}"#,
        )
        .expect("deserialize legacy session");
        assert_eq!(decoded.web_client_id, None);
        assert_eq!(decoded.web_client_token, None);
        assert_eq!(decoded.web_app_version, None);
        assert_eq!(decoded.web_metadata_expires_at_unix, 0);
    }
}
