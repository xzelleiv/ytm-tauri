use crate::spotify::client;
use crate::spotify::embed::{self, SpotifyLinkType};
use crate::spotify::models::{SpotifyPlaylist, SpotifyTrack};
use crate::transfer::models::{MatchCandidate, SourceTrack, TransferJob};
use crate::transfer::parser;
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::thread;
use tauri::{Manager, WebviewWindow};

const PREFIX: &str = "YTMSPOTIFY:";
const MAX_REQUEST_SIZE: usize = 512 * 1024;

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct SpotifyBridgeRequest {
    pub id: u64,
    pub action: String,
    pub token: Option<String>,
    pub link: Option<String>,
    pub raw_text: Option<String>,
    pub playlist_id: Option<String>,
    pub playlist_title: Option<String>,
    pub playlist_description: Option<String>,
    pub source_tracks: Option<Vec<SourceTrack>>,
    pub job_id: Option<String>,
    pub track_index: Option<usize>,
    pub video_id: Option<String>,
    pub candidates: Option<Vec<MatchCandidate>>,
    pub status: Option<String>,
    pub transferred: Option<usize>,
    pub failed: Option<usize>,
    pub page: Option<usize>,
    pub page_size: Option<usize>,
}

#[derive(Default, Serialize)]
pub struct SpotifyBridgeResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_authenticated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub playlists: Option<Vec<SpotifyPlaylist>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub playlist: Option<SpotifyPlaylist>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tracks: Option<Vec<SpotifyTrack>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_tracks: Option<Vec<SourceTrack>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job: Option<TransferJob>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matches: Option<Vec<crate::transfer::models::TrackMatch>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<usize>,
}

pub fn is_spotify_title_message(title: &str) -> bool {
    title.starts_with(PREFIX)
}

pub fn parse_request(title: &str) -> Option<SpotifyBridgeRequest> {
    if !title.starts_with(PREFIX) {
        return None;
    }
    let json_slice = &title[PREFIX.len()..];
    if json_slice.len() > MAX_REQUEST_SIZE {
        return None;
    }
    serde_json::from_str(json_slice).ok()
}

pub fn handle_title(window: &WebviewWindow, title: &str, state: &AppState) {
    eprintln!("[SPOTIFY BRIDGE] handle_title raw len={}", title.len());
    let Some(req) = parse_request(title) else {
        eprintln!(
            "[SPOTIFY BRIDGE] rejected malformed request with length {}",
            title.len()
        );
        return;
    };
    eprintln!(
        "[SPOTIFY BRIDGE] request action='{}' id={}",
        req.action, req.id
    );

    match req.action.as_str() {
        "get_status" => {
            let session = state.spotify.get_session();
            let is_auth = state.spotify.is_authenticated();
            let user_name = session.and_then(|s| s.user_name);
            let resp = SpotifyBridgeResponse {
                ok: true,
                is_authenticated: Some(is_auth),
                user_name,
                ..Default::default()
            };
            send_response(window, req.id, &resp);
        }
        "open_login" => {
            let app = window.app_handle().clone();
            let controller = state.spotify.clone();
            let window_clone = window.clone();
            let req_id = req.id;
            thread::spawn(move || {
                let res = controller.open_login_window(&app);
                let resp = SpotifyBridgeResponse {
                    ok: res.is_ok(),
                    error: res.err(),
                    ..Default::default()
                };
                send_response(&window_clone, req_id, &resp);
            });
        }
        "open_browser_login" => {
            let app = window.app_handle().clone();
            let controller = state.spotify.clone();
            let window_clone = window.clone();
            let req_id = req.id;
            thread::spawn(move || {
                let res = controller.open_browser_login(&app);
                let resp = match res {
                    Ok(mode) => SpotifyBridgeResponse {
                        ok: true,
                        auth_mode: Some(mode.as_str().to_string()),
                        ..Default::default()
                    },
                    Err(error) => SpotifyBridgeResponse {
                        ok: false,
                        error: Some(error),
                        ..Default::default()
                    },
                };
                send_response(&window_clone, req_id, &resp);
            });
        }
        "open_devtools" => {
            window.open_devtools();
            let resp = SpotifyBridgeResponse {
                ok: true,
                ..Default::default()
            };
            send_response(window, req.id, &resp);
        }
        "set_token" => {
            let app = window.app_handle().clone();
            let controller = state.spotify.clone();
            let token_str = req.token.unwrap_or_default();
            let window_clone = window.clone();
            let req_id = req.id;
            thread::spawn(move || {
                let res = controller.handle_captured_token(&app, &token_str);
                let resp = match res {
                    Ok(session) => SpotifyBridgeResponse {
                        ok: true,
                        is_authenticated: Some(true),
                        user_name: session.user_name,
                        ..Default::default()
                    },
                    Err(e) => SpotifyBridgeResponse {
                        ok: false,
                        error: Some(e),
                        ..Default::default()
                    },
                };
                send_response(&window_clone, req_id, &resp);
            });
        }
        "logout" => {
            state.spotify.logout(window.app_handle());
            let resp = SpotifyBridgeResponse {
                ok: true,
                is_authenticated: Some(false),
                ..Default::default()
            };
            send_response(window, req.id, &resp);
        }
        "list_playlists" => {
            let controller = state.spotify.clone();
            let user_id = state.spotify.get_session().and_then(|s| s.user_id);
            let window_clone = window.clone();
            let req_id = req.id;

            thread::spawn(move || {
                let token = match controller.get_token() {
                    Ok(token) => token,
                    Err(error) => {
                        let resp = SpotifyBridgeResponse {
                            ok: false,
                            error: Some(error),
                            is_authenticated: Some(false),
                            ..Default::default()
                        };
                        send_response(&window_clone, req_id, &resp);
                        return;
                    }
                };

                match client::fetch_user_playlists(&token, user_id.as_deref()) {
                    Ok(playlists) => {
                        let resp = SpotifyBridgeResponse {
                            ok: true,
                            is_authenticated: Some(true),
                            playlists: Some(playlists),
                            ..Default::default()
                        };
                        send_response(&window_clone, req_id, &resp);
                    }
                    Err(e) => {
                        let resp = SpotifyBridgeResponse {
                            ok: false,
                            error: Some(e),
                            ..Default::default()
                        };
                        send_response(&window_clone, req_id, &resp);
                    }
                }
            });
        }
        "parse_link" => {
            let link_str = req.link.unwrap_or_default();
            let controller = state.spotify.clone();
            let window_clone = window.clone();
            let req_id = req.id;

            thread::spawn(move || {
                // check liked songs
                if link_str == "liked"
                    || link_str == "liked_songs"
                    || link_str.contains("collection/tracks")
                    || link_str.contains("collection%2Ftracks")
                {
                    let token = match controller.get_token() {
                        Ok(token) => token,
                        Err(_) => {
                            let resp = SpotifyBridgeResponse {
                                ok: false,
                                error: Some(
                                    "Please connect Spotify to access Liked Songs".to_string(),
                                ),
                                ..Default::default()
                            };
                            send_response(&window_clone, req_id, &resp);
                            return;
                        }
                    };

                    match client::fetch_all_liked_songs(&token, |_, _| {}) {
                        Ok(tracks) => {
                            let playlist = SpotifyPlaylist {
                                id: "liked_songs".to_string(),
                                name: "Liked Songs".to_string(),
                                description: Some(format!("{} songs", tracks.len())),
                                track_count: tracks.len(),
                                image_url: None,
                                owner_name: Some("You".to_string()),
                                is_liked_songs: true,
                                is_collaborative: false,
                                is_owner: true,
                                snapshot_id: None,
                            };
                            let resp = SpotifyBridgeResponse {
                                ok: true,
                                is_authenticated: Some(true),
                                playlist: Some(playlist),
                                tracks: Some(tracks),
                                ..Default::default()
                            };
                            send_response(&window_clone, req_id, &resp);
                            return;
                        }
                        Err(e) => {
                            let resp = SpotifyBridgeResponse {
                                ok: false,
                                error: Some(format!("failed fetching liked songs {e}")),
                                ..Default::default()
                            };
                            send_response(&window_clone, req_id, &resp);
                            return;
                        }
                    }
                }

                // parse public link
                let Some(parsed_link) = embed::parse_spotify_link(&link_str) else {
                    let resp = SpotifyBridgeResponse {
                        ok: false,
                        error: Some("invalid spotify link".to_string()),
                        ..Default::default()
                    };
                    send_response(&window_clone, req_id, &resp);
                    return;
                };

                // try user playlist
                if let SpotifyLinkType::Playlist(pid) = &parsed_link {
                    if let Ok(token) = controller.get_token() {
                        if let Ok((playlist, tracks)) =
                            client::fetch_playlist_items(&token, pid, |_, _| {})
                        {
                            let resp = SpotifyBridgeResponse {
                                ok: true,
                                is_authenticated: Some(true),
                                playlist: Some(playlist),
                                tracks: Some(tracks),
                                ..Default::default()
                            };
                            send_response(&window_clone, req_id, &resp);
                            return;
                        }
                    }
                }

                // try embed metadata
                match embed::fetch_embed_metadata(&parsed_link) {
                    Ok((playlist, tracks)) => {
                        let resp = SpotifyBridgeResponse {
                            ok: true,
                            playlist: Some(playlist),
                            tracks: Some(tracks),
                            ..Default::default()
                        };
                        send_response(&window_clone, req_id, &resp);
                    }
                    Err(embed_err) => {
                        let resp = SpotifyBridgeResponse {
                            ok: false,
                            error: Some(embed_err),
                            ..Default::default()
                        };
                        send_response(&window_clone, req_id, &resp);
                    }
                }
            });
        }
        "parse_raw_text" => {
            let text = req.raw_text.unwrap_or_default();
            match parser::parse_raw_input(&text) {
                Ok((title, source_tracks)) => {
                    let resp = SpotifyBridgeResponse {
                        ok: true,
                        playlist: Some(SpotifyPlaylist {
                            id: "raw_import".to_string(),
                            name: title,
                            description: Some(format!("{} tracks", source_tracks.len())),
                            track_count: source_tracks.len(),
                            image_url: None,
                            owner_name: None,
                            is_liked_songs: false,
                            is_collaborative: false,
                            is_owner: true,
                            snapshot_id: None,
                        }),
                        source_tracks: Some(source_tracks),
                        ..Default::default()
                    };
                    send_response(window, req.id, &resp);
                }
                Err(e) => {
                    let resp = SpotifyBridgeResponse {
                        ok: false,
                        error: Some(e),
                        ..Default::default()
                    };
                    send_response(window, req.id, &resp);
                }
            }
        }
        "create_job" => {
            let title = req
                .playlist_title
                .unwrap_or_else(|| "Spotify Playlist".to_string());
            let desc = req.playlist_description;
            let tracks = req.source_tracks.unwrap_or_default();
            let job = state.transfer.create_job(title, desc, tracks);

            let resp = SpotifyBridgeResponse {
                ok: true,
                job: Some(job),
                ..Default::default()
            };
            send_response(window, req.id, &resp);
        }
        "update_track_candidates" => {
            let job_id = req.job_id.unwrap_or_default();
            let idx = req.track_index.unwrap_or(0);
            let candidates = req.candidates.unwrap_or_default();

            let job_opt = state
                .transfer
                .update_track_candidates(&job_id, idx, candidates);
            let resp = SpotifyBridgeResponse {
                ok: job_opt.is_some(),
                error: if job_opt.is_none() {
                    Some("job not found".to_string())
                } else {
                    None
                },
                job: job_opt,
                ..Default::default()
            };
            send_response(window, req.id, &resp);
        }
        "select_candidate" => {
            let job_id = req.job_id.unwrap_or_default();
            let idx = req.track_index.unwrap_or(0);
            let vid = req.video_id.unwrap_or_default();

            let job_opt = state.transfer.select_candidate(&job_id, idx, &vid);
            let resp = SpotifyBridgeResponse {
                ok: job_opt.is_some(),
                error: if job_opt.is_none() {
                    Some("job not found".to_string())
                } else {
                    None
                },
                job: job_opt,
                ..Default::default()
            };
            send_response(window, req.id, &resp);
        }
        "skip_track" => {
            let job_id = req.job_id.unwrap_or_default();
            let idx = req.track_index.unwrap_or(0);

            let job_opt = state.transfer.skip_track(&job_id, idx);
            let resp = SpotifyBridgeResponse {
                ok: job_opt.is_some(),
                error: if job_opt.is_none() {
                    Some("job not found".to_string())
                } else {
                    None
                },
                job: job_opt,
                ..Default::default()
            };
            send_response(window, req.id, &resp);
        }
        "cancel_job" => {
            let job_id = req.job_id.unwrap_or_default();
            state.transfer.cancel_job(&job_id);
            let job_opt = state.transfer.get_job(&job_id);

            let resp = SpotifyBridgeResponse {
                ok: true,
                job: job_opt,
                ..Default::default()
            };
            send_response(window, req.id, &resp);
        }
        "get_job_page" => {
            let job_id = req.job_id.unwrap_or_default();
            let page = req.page.unwrap_or(0);
            let page_size = req.page_size.unwrap_or(50);
            let result = state.transfer.get_job_page(&job_id, page, page_size);

            let (total, matches) = match result {
                Some((tot, list)) => (Some(tot), Some(list)),
                None => (None, None),
            };

            let resp = SpotifyBridgeResponse {
                ok: total.is_some(),
                error: if total.is_none() {
                    Some("job not found".to_string())
                } else {
                    None
                },
                total,
                matches,
                ..Default::default()
            };
            send_response(window, req.id, &resp);
        }
        "get_valid_video_ids" => {
            let job_id = req.job_id.unwrap_or_default();
            let video_ids = state.transfer.get_valid_video_ids(&job_id);

            let resp = SpotifyBridgeResponse {
                ok: video_ids.is_some(),
                error: if video_ids.is_none() {
                    Some("job not found".to_string())
                } else {
                    None
                },
                video_ids,
                ..Default::default()
            };
            send_response(window, req.id, &resp);
        }
        "update_transfer_status" => {
            let job_id = req.job_id.unwrap_or_default();
            let status = req.status.unwrap_or_else(|| "in_progress".to_string());
            let transferred = req.transferred.unwrap_or(0);
            let failed = req.failed.unwrap_or(0);

            let job_opt =
                state
                    .transfer
                    .update_transfer_status(&job_id, &status, transferred, failed);
            let resp = SpotifyBridgeResponse {
                ok: job_opt.is_some(),
                error: None,
                is_authenticated: None,
                user_name: None,
                auth_mode: None,
                playlists: None,
                playlist: None,
                tracks: None,
                source_tracks: None,
                job: job_opt,
                matches: None,
                video_ids: None,
                total: None,
            };
            send_response(window, req.id, &resp);
        }
        _ => {}
    }
}

fn send_response(window: &WebviewWindow, id: u64, response: &SpotifyBridgeResponse) {
    eprintln!("[SPOTIFY BRIDGE] send_response id={id}, ok={}", response.ok);
    let Ok(payload_json) = serde_json::to_string(response) else {
        eprintln!("[SPOTIFY BRIDGE ERROR] failed to serialize response for id={id}");
        return;
    };
    let Ok(escaped) = serde_json::to_string(&payload_json) else {
        return;
    };
    let script = format!(
        "try {{ window.__ytmSpotify?.receive?.({id}, JSON.parse({escaped})); }} catch (e) {{ console.error('bridge receive error:', e); }}"
    );
    let app = window.app_handle().clone();
    let app_for_closure = app.clone();
    let window_label = window.label().to_string();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = app_for_closure.get_webview_window(&window_label) {
            if let Err(e) = w.eval(&script) {
                eprintln!("[SPOTIFY BRIDGE ERROR] eval failed for id={id}: {e}");
            } else {
                eprintln!("[SPOTIFY BRIDGE] eval succeeded for id={id}");
            }
        } else {
            eprintln!("[SPOTIFY BRIDGE ERROR] window {window_label} not found");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_parse_link_request() {
        let title = r#"YTMSPOTIFY:{"id":1,"action":"parse_link","link":"https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M","ts":1787775000000}"#;
        assert!(is_spotify_title_message(title));
        let req = parse_request(title).expect("should parse successfully");
        assert_eq!(req.id, 1);
        assert_eq!(req.action, "parse_link");
        assert_eq!(
            req.link,
            Some("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M".to_string())
        );
    }
}
