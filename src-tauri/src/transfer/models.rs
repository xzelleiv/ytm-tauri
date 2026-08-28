use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SourceTrack {
    pub index: usize,
    pub id: String,
    pub title: String,
    pub artists: Vec<String>,
    pub album: Option<String>,
    pub duration_ms: u64,
    pub is_explicit: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum MatchConfidence {
    High,
    Review,
    Low,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MatchCandidate {
    pub video_id: String,
    pub title: String,
    pub artists: Vec<String>,
    pub album: Option<String>,
    pub duration_seconds: u64,
    pub is_explicit: bool,
    pub is_official: bool,
    pub score: f64,
    pub confidence: MatchConfidence,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum MatchStatus {
    Matched,
    NeedsReview,
    Unmatched,
    Skipped,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TrackMatch {
    pub source: SourceTrack,
    pub selected_candidate: Option<MatchCandidate>,
    pub candidates: Vec<MatchCandidate>,
    pub status: MatchStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferProgress {
    pub total: usize,
    pub current: usize,
    pub matched: usize,
    pub needs_review: usize,
    pub unmatched: usize,
    pub transferred: usize,
    pub failed: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferJob {
    pub id: String,
    pub playlist_title: String,
    pub playlist_description: Option<String>,
    pub tracks: Vec<TrackMatch>,
    pub status: String,
    pub progress: TransferProgress,
}
