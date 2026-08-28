use super::models::SourceTrack;

pub fn parse_raw_input(input: &str) -> Result<(String, Vec<SourceTrack>), String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("empty input".to_string());
    }

    if (trimmed.starts_with('[') && trimmed.ends_with(']'))
        || (trimmed.starts_with('{') && trimmed.ends_with('}'))
    {
        if let Ok(tracks) = parse_json_input(trimmed) {
            if !tracks.is_empty() {
                return Ok(("Imported JSON Playlist".to_string(), tracks));
            }
        }
    }

    // check csv headers
    let first_line = trimmed.lines().next().unwrap_or("");
    if first_line.contains(',')
        && (first_line.to_lowercase().contains("track")
            || first_line.to_lowercase().contains("title"))
    {
        if let Ok(tracks) = parse_csv_input(trimmed) {
            if !tracks.is_empty() {
                return Ok(("Imported CSV Playlist".to_string(), tracks));
            }
        }
    }

    // fallback line parser
    let tracks = parse_text_lines(trimmed);
    if tracks.is_empty() {
        return Err("no tracks found".to_string());
    }

    Ok(("Imported Text Playlist".to_string(), tracks))
}

pub fn parse_csv_input(csv_text: &str) -> Result<Vec<SourceTrack>, String> {
    let mut lines = csv_text.lines();
    let header_line = lines.next().ok_or_else(|| "no csv headers".to_string())?;
    let headers = parse_csv_row(header_line);

    let title_idx = headers.iter().position(|h| {
        let l = h.to_lowercase();
        l == "track name" || l == "title" || l == "song" || l == "name"
    });
    let artist_idx = headers.iter().position(|h| {
        let l = h.to_lowercase();
        l == "artist name(s)" || l == "artist name" || l == "artist" || l == "artists"
    });
    let album_idx = headers.iter().position(|h| {
        let l = h.to_lowercase();
        l == "album name" || l == "album"
    });
    let duration_idx = headers.iter().position(|h| {
        let l = h.to_lowercase();
        l == "track duration (ms)" || l == "duration (ms)" || l == "duration_ms" || l == "duration"
    });

    let Some(t_idx) = title_idx else {
        return Err("no title column".to_string());
    };

    let mut tracks = Vec::new();
    for (idx, line) in lines.enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let cols = parse_csv_row(line);
        if cols.len() <= t_idx {
            continue;
        }

        let title = cols[t_idx].trim().to_string();
        if title.is_empty() {
            continue;
        }

        let artists = if let Some(a_idx) = artist_idx {
            if a_idx < cols.len() {
                cols[a_idx]
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            } else {
                Vec::new()
            }
        } else {
            Vec::new()
        };

        let album = album_idx
            .and_then(|a_idx| cols.get(a_idx))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let duration_ms = duration_idx
            .and_then(|d_idx| cols.get(d_idx))
            .and_then(|s| parse_duration_string(s))
            .unwrap_or(0);

        tracks.push(SourceTrack {
            index: idx,
            id: format!("csv_{idx}"),
            title,
            artists,
            album,
            duration_ms,
            is_explicit: false,
        });
    }

    Ok(tracks)
}

fn parse_csv_row(line: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '"' {
            if in_quotes && chars.peek() == Some(&'"') {
                cur.push('"');
                chars.next();
            } else {
                in_quotes = !in_quotes;
            }
        } else if ch == ',' && !in_quotes {
            result.push(cur.trim().to_string());
            cur.clear();
        } else {
            cur.push(ch);
        }
    }
    result.push(cur.trim().to_string());
    result
}

pub fn parse_json_input(json_text: &str) -> Result<Vec<SourceTrack>, String> {
    let val: serde_json::Value = serde_json::from_str(json_text).map_err(|e| e.to_string())?;

    let array = match val {
        serde_json::Value::Array(arr) => arr,
        serde_json::Value::Object(obj) => {
            if let Some(serde_json::Value::Array(arr)) = obj.get("tracks").or(obj.get("items")) {
                arr.clone()
            } else {
                return Err("no json array".to_string());
            }
        }
        _ => return Err("invalid json format".to_string()),
    };

    let mut tracks = Vec::new();
    for (idx, item) in array.into_iter().enumerate() {
        let title = item
            .get("title")
            .or(item.get("name"))
            .or(item.get("track_name"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();

        if title.is_empty() {
            continue;
        }

        let mut artists = Vec::new();
        if let Some(artist_val) = item
            .get("artist")
            .or(item.get("artists"))
            .or(item.get("artist_name"))
        {
            match artist_val {
                serde_json::Value::String(s) => {
                    for a in s.split(',') {
                        let a_trim = a.trim();
                        if !a_trim.is_empty() {
                            artists.push(a_trim.to_string());
                        }
                    }
                }
                serde_json::Value::Array(arr) => {
                    for a in arr {
                        if let Some(s) = a.as_str().or(a.get("name").and_then(|n| n.as_str())) {
                            artists.push(s.trim().to_string());
                        }
                    }
                }
                _ => {}
            }
        }

        let album = item
            .get("album")
            .or(item.get("album_name"))
            .and_then(|v| v.as_str().or(v.get("name").and_then(|n| n.as_str())))
            .map(|s| s.trim().to_string());

        let duration_ms = item
            .get("duration_ms")
            .or(item.get("duration"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);

        tracks.push(SourceTrack {
            index: idx,
            id: format!("json_{idx}"),
            title,
            artists,
            album,
            duration_ms,
            is_explicit: false,
        });
    }

    Ok(tracks)
}

pub fn parse_text_lines(text: &str) -> Vec<SourceTrack> {
    let mut tracks = Vec::new();
    for (idx, raw_line) in text.lines().enumerate() {
        let mut line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        // strip leading numbering
        if let Some(pos) = line.find('.') {
            if pos < 5 && line[..pos].chars().all(|c| c.is_ascii_digit()) {
                line = line[pos + 1..].trim();
            }
        }

        let mut duration_ms = 0;
        if let Some(open_paren) = line.rfind('(') {
            if let Some(close_paren) = line.rfind(')') {
                if close_paren > open_paren {
                    let dur_str = &line[open_paren + 1..close_paren];
                    if let Some(dur) = parse_duration_string(dur_str) {
                        duration_ms = dur;
                        line = line[..open_paren].trim();
                    }
                }
            }
        }

        let (artist, title) = if let Some(dash_pos) = line.find(" - ") {
            let a = line[..dash_pos].trim();
            let t = line[dash_pos + 3..].trim();
            (Some(a), t)
        } else if let Some(by_pos) = line.to_lowercase().find(" by ") {
            let t = line[..by_pos].trim();
            let a = line[by_pos + 4..].trim();
            (Some(a), t)
        } else {
            (None, line)
        };

        if title.is_empty() {
            continue;
        }

        let artists = artist
            .map(|a| {
                a.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default();

        tracks.push(SourceTrack {
            index: idx,
            id: format!("text_{idx}"),
            title: title.to_string(),
            artists,
            album: None,
            duration_ms,
            is_explicit: false,
        });
    }

    tracks
}

fn parse_duration_string(s: &str) -> Option<u64> {
    let s = s.trim();
    if let Ok(ms) = s.parse::<u64>() {
        return Some(ms);
    }

    if s.contains(':') {
        let parts: Vec<&str> = s.split(':').collect();
        if parts.len() == 2 {
            let mins = parts[0].parse::<u64>().ok()?;
            let secs = parts[1].parse::<u64>().ok()?;
            return Some((mins * 60 + secs) * 1000);
        } else if parts.len() == 3 {
            let hours = parts[0].parse::<u64>().ok()?;
            let mins = parts[1].parse::<u64>().ok()?;
            let secs = parts[2].parse::<u64>().ok()?;
            return Some((hours * 3600 + mins * 60 + secs) * 1000);
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_exportify_csv() {
        let csv = "Track Name,Artist Name(s),Album Name,Track Duration (ms)\nSolomon,\"Munimuni, Clara Benin\",Kulayan Natin,378000\nSuper Trouper,ABBA,Super Trouper,252000";
        let tracks = parse_csv_input(csv).expect("parse csv");
        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0].title, "Solomon");
        assert_eq!(tracks[0].artists, vec!["Munimuni", "Clara Benin"]);
        assert_eq!(tracks[0].duration_ms, 378000);
    }

    #[test]
    fn parse_plain_text_lines() {
        let text = "1. Munimuni - Solomon (6:18)\nABBA - Super Trouper (4:12)";
        let tracks = parse_text_lines(text);
        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0].title, "Solomon");
        assert_eq!(tracks[0].artists, vec!["Munimuni"]);
        assert_eq!(tracks[0].duration_ms, 378000);
    }
}
