use super::models::{SpotifyPlaylist, SpotifyTrack};
use regex::Regex;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpotifyLinkType {
    Playlist(String),
    Album(String),
    Track(String),
    Artist(String),
}

pub fn parse_spotify_link(input: &str) -> Option<SpotifyLinkType> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }

    if trimmed == "liked" || trimmed == "liked_songs" || trimmed == "collection" {
        return Some(SpotifyLinkType::Playlist("liked".to_string()));
    }

    if let Some(uri) = trimmed.strip_prefix("spotify:") {
        let parts: Vec<&str> = uri.split(':').collect();
        if parts.len() >= 2 {
            let id = clean_spotify_id(parts[parts.len() - 1]);
            if !id.is_empty() {
                match parts[0] {
                    "playlist" | "user" => return Some(SpotifyLinkType::Playlist(id)),
                    "album" => return Some(SpotifyLinkType::Album(id)),
                    "track" => return Some(SpotifyLinkType::Track(id)),
                    "artist" => return Some(SpotifyLinkType::Artist(id)),
                    _ => {}
                }
            }
        }
    }

    if let Ok(url) = url::Url::parse(trimmed) {
        if let Some(host) = url.host_str() {
            if host == "open.spotify.com" || host.ends_with(".spotify.com") {
                let segments: Vec<&str> = url
                    .path_segments()
                    .map(|s| s.filter(|p| !p.is_empty()).collect())
                    .unwrap_or_default();

                if segments.len() >= 2 && segments[0] == "collection" && segments[1] == "tracks" {
                    return Some(SpotifyLinkType::Playlist("liked".to_string()));
                }

                let mut type_idx = 0;
                if segments.first() == Some(&"embed") {
                    type_idx = 1;
                }

                if segments.len() > type_idx + 1 {
                    let kind = segments[type_idx];
                    let id = clean_spotify_id(segments[type_idx + 1]);
                    if !id.is_empty() {
                        match kind {
                            "playlist" => return Some(SpotifyLinkType::Playlist(id)),
                            "album" => return Some(SpotifyLinkType::Album(id)),
                            "track" => return Some(SpotifyLinkType::Track(id)),
                            "artist" => return Some(SpotifyLinkType::Artist(id)),
                            _ => {}
                        }
                    }
                }
            }
        }
    }

    // check raw id
    let cleaned = clean_spotify_id(trimmed);
    if cleaned.len() == 22 && cleaned.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Some(SpotifyLinkType::Playlist(cleaned));
    }

    None
}

fn clean_spotify_id(id: &str) -> String {
    id.split('?').next().unwrap_or("").trim().to_string()
}

pub fn fetch_embed_metadata(
    link: &SpotifyLinkType,
) -> Result<(SpotifyPlaylist, Vec<SpotifyTrack>), String> {
    let (kind, id) = match link {
        SpotifyLinkType::Playlist(id) => ("playlist", id.as_str()),
        SpotifyLinkType::Album(id) => ("album", id.as_str()),
        SpotifyLinkType::Track(id) => ("track", id.as_str()),
        SpotifyLinkType::Artist(id) => ("artist", id.as_str()),
    };

    let embed_url = format!("https://open.spotify.com/embed/{kind}/{id}");
    eprintln!("[SPOTIFY EMBED] fetching {embed_url}");
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(&embed_url)
        .header(
            reqwest::header::USER_AGENT,
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        )
        .header(
            reqwest::header::ACCEPT,
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .send()
        .map_err(|e| {
            eprintln!("[SPOTIFY EMBED ERROR] request failed: {e}");
            format!("request failed {e}")
        })?;

    eprintln!("[SPOTIFY EMBED] response status: {}", response.status());
    if !response.status().is_success() {
        return Err(format!("http status {}", response.status()));
    }

    let html = response.text().map_err(|e| e.to_string())?;
    let res = parse_embed_html(&html, kind, id);
    if let Ok((ref pl, ref tr)) = res {
        eprintln!(
            "[SPOTIFY EMBED SUCCESS] parsed '{}' with {} tracks",
            pl.name,
            tr.len()
        );
    } else if let Err(ref err) = res {
        eprintln!("[SPOTIFY EMBED PARSE ERROR] {err}");
    }
    res
}

pub fn parse_embed_html(
    html: &str,
    kind: &str,
    id: &str,
) -> Result<(SpotifyPlaylist, Vec<SpotifyTrack>), String> {
    let regex = Regex::new(r#"(?s)<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)</script>"#)
        .map_err(|e| e.to_string())?;

    let captures = regex
        .captures(html)
        .ok_or_else(|| "no embed data".to_string())?;
    let json_text = captures
        .get(1)
        .map(|m| m.as_str())
        .ok_or_else(|| "empty embed data".to_string())?;

    let val: serde_json::Value =
        serde_json::from_str(json_text).map_err(|e| format!("invalid json {e}"))?;

    let entity = val
        .pointer("/props/pageProps/state/data/entity")
        .or_else(|| val.pointer("/props/pageProps/data/entity"))
        .ok_or_else(|| "missing entity in embed data".to_string())?;

    let name = entity
        .get("title")
        .or_else(|| entity.get("name"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    let name = if name.is_empty() {
        format!("{kind} {id}")
    } else {
        name
    };

    let description = entity
        .get("subtitle")
        .or_else(|| entity.get("description"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let image_url = entity
        .pointer("/visualIdentity/image")
        .and_then(|v| v.as_array())
        .and_then(|arr| {
            arr.iter()
                .max_by_key(|img| img.get("maxWidth").and_then(|w| w.as_u64()).unwrap_or(0))
        })
        .and_then(|img| img.get("url"))
        .and_then(|u| u.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            entity
                .get("coverArt")
                .and_then(|ca| ca.get("sources"))
                .and_then(|s| s.as_array())
                .and_then(|arr| arr.first())
                .and_then(|src| src.get("url"))
                .and_then(|u| u.as_str())
                .map(|s| s.to_string())
        });

    let raw_tracks = entity
        .get("trackList")
        .or_else(|| entity.get("tracks"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let raw_tracks = if raw_tracks.is_empty()
        && (kind == "track" || entity.get("type").and_then(|v| v.as_str()) == Some("track"))
    {
        vec![entity.clone()]
    } else {
        raw_tracks
    };

    let mut tracks = Vec::with_capacity(raw_tracks.len());
    for (idx, raw_track) in raw_tracks.into_iter().enumerate() {
        let title = raw_track
            .get("title")
            .or_else(|| raw_track.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .trim()
            .to_string();

        if title.is_empty() {
            continue;
        }

        let artists: Vec<String> =
            if let Some(subtitle) = raw_track.get("subtitle").and_then(|v| v.as_str()) {
                subtitle
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            } else if let Some(artists_arr) = raw_track.get("artists").and_then(|v| v.as_array()) {
                artists_arr
                    .iter()
                    .filter_map(|a| a.get("name").and_then(|n| n.as_str()))
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            } else {
                Vec::new()
            };

        let uri = raw_track
            .get("uri")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();

        let track_id = if let Some(stripped) = uri.strip_prefix("spotify:track:") {
            stripped.to_string()
        } else {
            format!("track_{idx}")
        };

        let duration_ms = raw_track
            .get("duration")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);

        let is_explicit = raw_track
            .get("isExplicit")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let preview_url = raw_track
            .pointer("/audioPreview/url")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        tracks.push(SpotifyTrack {
            id: track_id,
            title,
            artists,
            album: if kind == "album" {
                Some(name.clone())
            } else {
                None
            },
            duration_ms,
            is_explicit,
            preview_url,
            uri: if uri.is_empty() {
                format!("spotify:track:track_{idx}")
            } else {
                uri
            },
        });
    }

    let playlist = SpotifyPlaylist {
        id: id.to_string(),
        name,
        description,
        track_count: tracks.len(),
        image_url,
        owner_name: None,
        is_liked_songs: false,
        is_collaborative: false,
        is_owner: true,
        snapshot_id: None,
    };

    Ok((playlist, tracks))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_links_correctly() {
        assert_eq!(
            parse_spotify_link("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc"),
            Some(SpotifyLinkType::Playlist(
                "37i9dQZF1DXcBWIGoYBM5M".to_string()
            ))
        );
        assert_eq!(
            parse_spotify_link("https://open.spotify.com/embed/album/4m2880jivSbbyEGAKfITCa"),
            Some(SpotifyLinkType::Album("4m2880jivSbbyEGAKfITCa".to_string()))
        );
        assert_eq!(
            parse_spotify_link("spotify:track:4cOdK2wGLETKBW3PvgPWqT"),
            Some(SpotifyLinkType::Track("4cOdK2wGLETKBW3PvgPWqT".to_string()))
        );
        assert_eq!(
            parse_spotify_link("https://open.spotify.com/artist/0gxyHStUsqpMadRV0Di1Qt"),
            Some(SpotifyLinkType::Artist(
                "0gxyHStUsqpMadRV0Di1Qt".to_string()
            ))
        );
        assert_eq!(parse_spotify_link("https://youtube.com/watch?v=123"), None);
    }

    #[test]
    fn parse_single_track_embed_html() {
        let html = r#"<!DOCTYPE html><html><body><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"state":{"data":{"entity":{"type":"track","name":"Never Gonna Give You Up","uri":"spotify:track:4cOdK2wGLETKBW3PvgPWqT","id":"4cOdK2wGLETKBW3PvgPWqT","title":"Never Gonna Give You Up","artists":[{"name":"Rick Astley","uri":"spotify:artist:0gxyHStUsqpMadRV0Di1Qt"}],"duration":213573,"isExplicit":false}}}}}}</script></body></html>"#;
        let res = parse_embed_html(html, "track", "4cOdK2wGLETKBW3PvgPWqT");
        assert!(res.is_ok());
        let (playlist, tracks) = res.unwrap();
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].title, "Never Gonna Give You Up");
        assert_eq!(tracks[0].artists, vec!["Rick Astley".to_string()]);
        assert_eq!(playlist.name, "Never Gonna Give You Up");
    }
}
