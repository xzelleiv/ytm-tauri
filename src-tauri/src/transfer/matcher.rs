use super::models::{MatchCandidate, MatchConfidence, SourceTrack};
use std::collections::{HashMap, HashSet};

pub fn score_candidate(source: &SourceTrack, candidate: &mut MatchCandidate, rank: usize) {
    let title_score = title_similarity(&source.title, &candidate.title);
    let artist_score = artist_similarity(&source.artists, &candidate.artists);
    let duration_score = duration_similarity(source.duration_ms, candidate.duration_seconds);

    let album_score = match (&source.album, &candidate.album) {
        (Some(sa), Some(ca)) => title_similarity(sa, ca),
        _ => 0.5,
    };

    let type_score = if candidate.is_official { 1.0 } else { 0.4 };
    let rank_score = match rank {
        0 => 1.0,
        1 => 0.8,
        2 => 0.6,
        _ => 0.3,
    };

    let penalty = variant_penalty(&source.title, &candidate.title);

    let weighted = (title_score * 0.38)
        + (artist_score * 0.27)
        + (duration_score * 0.17)
        + (album_score * 0.08)
        + (type_score * 0.05)
        + (rank_score * 0.05);

    let final_score = (weighted - penalty).clamp(0.0, 1.0);
    candidate.score = final_score;
    candidate.confidence = if final_score >= 0.88 {
        MatchConfidence::High
    } else if final_score >= 0.74 {
        MatchConfidence::Review
    } else {
        MatchConfidence::Low
    };
}

#[allow(dead_code)]
pub fn clean_search_query(title: &str, artists: &[String]) -> String {
    let lower_title = title.to_lowercase();
    let stripped_title = lower_title
        .replace("- 2022 remaster", "")
        .replace("- 2021 remaster", "")
        .replace("- 2020 remaster", "")
        .replace("- 2019 remaster", "")
        .replace("- 2018 remaster", "")
        .replace("- 2011 remaster", "")
        .replace("- remaster", "")
        .replace("- remastered", "")
        .replace("(remastered)", "")
        .replace("[remastered]", "");

    let norm_title = normalize_string(&stripped_title);
    let norm_artist = if let Some(first) = artists.first() {
        normalize_string(first)
    } else {
        String::new()
    };

    if norm_artist.is_empty() || norm_title.contains(&norm_artist) {
        norm_title
    } else {
        format!("{norm_artist} {norm_title}")
    }
}

pub fn normalize_string(input: &str) -> String {
    let lower = input.to_lowercase();
    let mut cleaned = String::with_capacity(lower.len());

    // remove video descriptors
    let text = lower
        .replace("(official audio)", "")
        .replace("(official video)", "")
        .replace("[official audio]", "")
        .replace("[official video]", "")
        .replace("(visualizer)", "")
        .replace("[visualizer]", "")
        .replace("(audio)", "")
        .replace("[audio]", "");

    for ch in text.chars() {
        if ch.is_alphanumeric() || ch.is_whitespace() {
            cleaned.push(ch);
        } else {
            cleaned.push(' ');
        }
    }

    cleaned.split_whitespace().collect::<Vec<&str>>().join(" ")
}

pub fn dice_coefficient(a: &str, b: &str) -> f64 {
    if a.is_empty() && b.is_empty() {
        return 1.0;
    }
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    if a == b {
        return 1.0;
    }

    let bigrams_a = get_bigrams(a);
    let bigrams_b = get_bigrams(b);

    if bigrams_a.is_empty() || bigrams_b.is_empty() {
        return if a == b { 1.0 } else { 0.0 };
    }

    let mut matches = 0;
    let mut b_map = HashMap::new();
    for bg in &bigrams_b {
        *b_map.entry(bg).or_insert(0) += 1;
    }

    for bg in &bigrams_a {
        if let Some(count) = b_map.get_mut(bg) {
            if *count > 0 {
                matches += 1;
                *count -= 1;
            }
        }
    }

    (2.0 * matches as f64) / (bigrams_a.len() + bigrams_b.len()) as f64
}

fn get_bigrams(s: &str) -> Vec<(char, char)> {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() < 2 {
        return Vec::new();
    }
    chars.windows(2).map(|w| (w[0], w[1])).collect()
}

pub fn title_similarity(source_title: &str, target_title: &str) -> f64 {
    let s_norm = normalize_string(source_title);
    let t_norm = normalize_string(target_title);

    if s_norm == t_norm {
        return 1.0;
    }

    let dice = dice_coefficient(&s_norm, &t_norm);

    if s_norm.starts_with(&t_norm) || t_norm.starts_with(&s_norm) {
        return dice.max(0.85);
    }

    dice
}

pub fn artist_similarity(source_artists: &[String], target_artists: &[String]) -> f64 {
    if source_artists.is_empty() && target_artists.is_empty() {
        return 1.0;
    }
    if source_artists.is_empty() || target_artists.is_empty() {
        return 0.0;
    }

    let s_primary = normalize_string(&source_artists[0]);
    let t_primary = normalize_string(&target_artists[0]);
    let primary_sim = dice_coefficient(&s_primary, &t_primary);

    let s_set: HashSet<String> = source_artists.iter().map(|a| normalize_string(a)).collect();
    let t_set: HashSet<String> = target_artists.iter().map(|a| normalize_string(a)).collect();

    let intersection = s_set.intersection(&t_set).count();
    let union = s_set.union(&t_set).count();
    let jaccard = if union == 0 {
        0.0
    } else {
        intersection as f64 / union as f64
    };

    (primary_sim * 0.7 + jaccard * 0.3).clamp(0.0, 1.0)
}

pub fn duration_similarity(source_ms: u64, target_secs: u64) -> f64 {
    if source_ms == 0 || target_secs == 0 {
        return 0.5;
    }

    let source_secs = (source_ms as f64 / 1000.0).round() as u64;
    let diff = source_secs.abs_diff(target_secs);

    if diff <= 2 {
        1.0
    } else if diff <= 5 {
        0.95
    } else if diff <= 10 {
        0.80
    } else if diff <= 20 {
        0.50
    } else {
        0.0
    }
}

const VARIANT_TAGS: &[&str] = &[
    "remix",
    "acoustic",
    "live",
    "sped up",
    "slowed",
    "instrumental",
    "remaster",
    "remastered",
    "demo",
    "cover",
    "nightcore",
    "radio edit",
    "club mix",
    "extended",
];

pub fn extract_variant_tags(title: &str) -> HashSet<&'static str> {
    let lower = title.to_lowercase();
    let mut tags = HashSet::new();
    for &tag in VARIANT_TAGS {
        if lower.contains(tag) {
            tags.insert(tag);
        }
    }
    tags
}

pub fn variant_penalty(source_title: &str, target_title: &str) -> f64 {
    let s_tags = extract_variant_tags(source_title);
    let t_tags = extract_variant_tags(target_title);

    let diff_count = s_tags.symmetric_difference(&t_tags).count();
    diff_count as f64 * 0.12
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn perfect_match_scores_high() {
        let source = SourceTrack {
            index: 0,
            id: "1".into(),
            title: "Solomon".into(),
            artists: vec!["Munimuni".into(), "Clara Benin".into()],
            album: Some("Kulayan Natin".into()),
            duration_ms: 378000,
            is_explicit: false,
        };

        let mut candidate = MatchCandidate {
            video_id: "vid1".into(),
            title: "Solomon (Official Audio)".into(),
            artists: vec!["Munimuni".into(), "Clara Benin".into()],
            album: Some("Kulayan Natin".into()),
            duration_seconds: 378,
            is_explicit: false,
            is_official: true,
            score: 0.0,
            confidence: MatchConfidence::None,
        };

        score_candidate(&source, &mut candidate, 0);
        assert!(candidate.score >= 0.88);
        assert_eq!(candidate.confidence, MatchConfidence::High);
    }

    #[test]
    fn remix_mismatch_incurs_penalty() {
        let source = SourceTrack {
            index: 0,
            id: "2".into(),
            title: "Girls Need Love".into(),
            artists: vec!["Summer Walker".into()],
            album: None,
            duration_ms: 150000,
            is_explicit: false,
        };

        let mut candidate = MatchCandidate {
            video_id: "vid2".into(),
            title: "Girls Need Love (with Drake) - Remix".into(),
            artists: vec!["Summer Walker".into(), "Drake".into()],
            album: None,
            duration_seconds: 222,
            is_explicit: true,
            is_official: true,
            score: 0.0,
            confidence: MatchConfidence::None,
        };

        score_candidate(&source, &mut candidate, 0);
        assert!(candidate.score < 0.88);
    }

    #[test]
    fn cleans_search_queries() {
        let artists = vec!["Munimuni".into(), "Clara Benin".into()];
        assert_eq!(
            clean_search_query("Solomon - 2022 Remaster", &artists),
            "munimuni solomon"
        );
    }
}
