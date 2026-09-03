use super::matcher::score_candidate;
use super::models::{
    MatchCandidate, MatchConfidence, MatchStatus, SourceTrack, TrackMatch, TransferJob,
    TransferProgress,
};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

const MAX_RETAINED_JOBS: usize = 16;
const MAX_PAGE_SIZE: usize = 200;
static JOB_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Default)]
pub struct TransferController {
    jobs: Arc<Mutex<HashMap<String, TransferJob>>>,
    cancellations: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl TransferController {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn create_job(
        &self,
        playlist_title: String,
        playlist_description: Option<String>,
        source_tracks: Vec<SourceTrack>,
    ) -> TransferJob {
        let job_id = format!(
            "job_{}_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
            JOB_COUNTER.fetch_add(1, Ordering::Relaxed),
        );
        let total = source_tracks.len();

        let tracks = source_tracks
            .into_iter()
            .map(|source| TrackMatch {
                source,
                selected_candidate: None,
                candidates: Vec::new(),
                status: MatchStatus::Unmatched,
            })
            .collect();

        let job = TransferJob {
            id: job_id.clone(),
            playlist_title,
            playlist_description,
            tracks,
            status: "created".to_string(),
            progress: TransferProgress {
                total,
                current: 0,
                matched: 0,
                needs_review: 0,
                unmatched: total,
                transferred: 0,
                failed: 0,
            },
        };

        let evicted = {
            let mut jobs = self
                .jobs
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let evicted = if jobs.len() >= MAX_RETAINED_JOBS {
                jobs.keys().min().cloned()
            } else {
                None
            };
            if let Some(id) = &evicted {
                jobs.remove(id);
            }
            jobs.insert(job_id.clone(), job.clone());
            evicted
        };
        let mut cancellations = self
            .cancellations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(id) = evicted {
            cancellations.remove(&id);
        }
        cancellations.insert(job_id, Arc::new(AtomicBool::new(false)));

        job
    }

    pub fn get_job(&self, job_id: &str) -> Option<TransferJob> {
        self.jobs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(job_id)
            .cloned()
    }

    pub fn get_job_page(
        &self,
        job_id: &str,
        page: usize,
        page_size: usize,
    ) -> Option<(usize, Vec<TrackMatch>)> {
        let guard = self
            .jobs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let job = guard.get(job_id)?;
        let total = job.tracks.len();
        let page_size = page_size.clamp(1, MAX_PAGE_SIZE);
        let start = page.checked_mul(page_size).unwrap_or(total).min(total);
        let end = start.saturating_add(page_size).min(total);
        let slice = job.tracks[start..end].to_vec();
        Some((total, slice))
    }

    pub fn get_valid_video_ids(&self, job_id: &str) -> Option<Vec<String>> {
        let guard = self
            .jobs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let job = guard.get(job_id)?;
        let ids = job
            .tracks
            .iter()
            .filter(|t| t.status != MatchStatus::Skipped)
            .filter_map(|t| t.selected_candidate.as_ref().map(|c| c.video_id.clone()))
            .collect();
        Some(ids)
    }

    #[allow(dead_code)]
    pub fn is_cancelled(&self, job_id: &str) -> bool {
        self.cancellations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(job_id)
            .map(|c| c.load(Ordering::Relaxed))
            .unwrap_or(false)
    }

    pub fn cancel_job(&self, job_id: &str) {
        if let Some(flag) = self
            .cancellations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(job_id)
        {
            flag.store(true, Ordering::Relaxed);
        }
        if let Some(job) = self
            .jobs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get_mut(job_id)
        {
            job.status = "cancelled".to_string();
        }
    }

    pub fn update_track_candidates(
        &self,
        job_id: &str,
        track_index: usize,
        mut candidates: Vec<MatchCandidate>,
    ) -> Option<TransferJob> {
        let mut guard = self
            .jobs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let job = guard.get_mut(job_id)?;

        if self.is_cancelled(job_id) {
            return Some(job.clone());
        }

        if track_index >= job.tracks.len() {
            return None;
        }

        let source = job.tracks[track_index].source.clone();

        // score candidates
        for (rank, cand) in candidates.iter_mut().enumerate() {
            score_candidate(&source, cand, rank);
        }

        // sort by score
        candidates.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        let (status, selected) = if let Some(best) = candidates.first() {
            if best.confidence == MatchConfidence::High {
                (MatchStatus::Matched, Some(best.clone()))
            } else {
                (MatchStatus::NeedsReview, Some(best.clone()))
            }
        } else {
            (MatchStatus::Unmatched, None)
        };

        job.tracks[track_index].candidates = candidates;
        job.tracks[track_index].selected_candidate = selected;
        job.tracks[track_index].status = status;

        self.recalculate_progress(job);
        Some(job.clone())
    }

    pub fn select_candidate(
        &self,
        job_id: &str,
        track_index: usize,
        video_id: &str,
    ) -> Option<TransferJob> {
        let mut guard = self
            .jobs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let job = guard.get_mut(job_id)?;

        if self.is_cancelled(job_id) {
            return Some(job.clone());
        }

        let track = job.tracks.get_mut(track_index)?;
        let selected = track
            .candidates
            .iter()
            .find(|candidate| candidate.video_id == video_id)
            .cloned()?;
        track.selected_candidate = Some(selected);
        track.status = MatchStatus::Matched;

        self.recalculate_progress(job);
        Some(job.clone())
    }

    pub fn skip_track(&self, job_id: &str, track_index: usize) -> Option<TransferJob> {
        let mut guard = self
            .jobs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let job = guard.get_mut(job_id)?;

        if self.is_cancelled(job_id) {
            return Some(job.clone());
        }

        let track = job.tracks.get_mut(track_index)?;
        track.status = MatchStatus::Skipped;

        self.recalculate_progress(job);
        Some(job.clone())
    }

    pub fn update_transfer_status(
        &self,
        job_id: &str,
        status: &str,
        transferred: usize,
        failed: usize,
    ) -> Option<TransferJob> {
        let mut guard = self
            .jobs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let job = guard.get_mut(job_id)?;
        if self.is_cancelled(job_id) {
            return Some(job.clone());
        }
        if !matches!(
            status,
            "created" | "matching" | "review" | "in_progress" | "completed" | "failed"
        ) {
            return None;
        }
        job.status = status.to_string();
        job.progress.transferred = transferred.min(job.progress.total);
        job.progress.failed = failed.min(job.progress.total);
        Some(job.clone())
    }

    fn recalculate_progress(&self, job: &mut TransferJob) {
        let mut matched = 0;
        let mut needs_review = 0;
        let mut unmatched = 0;
        let mut processed = 0;

        for t in &job.tracks {
            match t.status {
                MatchStatus::Matched => {
                    matched += 1;
                    processed += 1;
                }
                MatchStatus::NeedsReview => {
                    needs_review += 1;
                    processed += 1;
                }
                MatchStatus::Unmatched => {
                    unmatched += 1;
                }
                MatchStatus::Skipped => {
                    processed += 1;
                }
            }
        }

        job.progress.current = processed;
        job.progress.matched = matched;
        job.progress.needs_review = needs_review;
        job.progress.unmatched = unmatched;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(index: usize) -> SourceTrack {
        SourceTrack {
            index,
            id: format!("source-{index}"),
            title: format!("Track {index}"),
            artists: vec!["Artist".to_string()],
            album: None,
            duration_ms: 180_000,
            is_explicit: false,
        }
    }

    #[test]
    fn rapidly_created_jobs_have_unique_ids() {
        let controller = TransferController::new();
        let first = controller.create_job("One".to_string(), None, vec![source(0)]);
        let second = controller.create_job("Two".to_string(), None, vec![source(1)]);

        assert_ne!(first.id, second.id);
    }

    #[test]
    fn paging_bounds_cannot_overflow() {
        let controller = TransferController::new();
        let job = controller.create_job("Playlist".to_string(), None, vec![source(0), source(1)]);

        let (total, page) = controller
            .get_job_page(&job.id, usize::MAX, usize::MAX)
            .expect("job page");
        assert_eq!(total, 2);
        assert!(page.is_empty());
    }

    #[test]
    fn cancelled_jobs_reject_late_status_updates() {
        let controller = TransferController::new();
        let job = controller.create_job("Playlist".to_string(), None, vec![source(0)]);
        controller.cancel_job(&job.id);

        let updated = controller
            .update_transfer_status(&job.id, "completed", 1, 0)
            .expect("job");
        assert_eq!(updated.status, "cancelled");
    }
}
