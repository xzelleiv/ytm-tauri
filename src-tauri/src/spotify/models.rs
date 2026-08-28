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
}

impl SpotifySession {
    pub fn has_refresh_credential(&self) -> bool {
        self.sp_dc.as_deref().is_some_and(|value| !value.is_empty())
            || (self
                .refresh_token
                .as_deref()
                .is_some_and(|value| !value.is_empty())
                && self
                    .oauth_client_id
                    .as_deref()
                    .is_some_and(|value| !value.is_empty()))
    }
}
