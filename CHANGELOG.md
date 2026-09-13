# Changelog

## 0.2.5 - 2026-09-13

### Features

- Added **Playlist Manager** directly to playlist pages: search every song, select across pages, review duplicates and unavailable entries, and copy, move, remove, or reorder songs in bulk.
- Added built-in Spotify sign-in for private playlists and Liked Songs, with encrypted session persistence across app launches and connected-profile lookup.
- Added ListenBrainz token setup alongside Last.fm scrobbling.
- Added a keyboard shortcut reference with **Ctrl+H**.

### UI/UX Improvements

- Added album thumbnails, private destination search, Shift-click range selection, and exact counts for songs already in the destination.
- Added configurable transfer auto-skip thresholds, clearer recording-version warnings, and review controls that preserve the current position.
- Fixed unreadable transfer dropdown options in the dark interface.
- Added in-app updater download progress, verification status, and retry feedback in **Settings → System**.
- Added cinematic, studio, and luminescent synced-lyrics styles.

### Fixes & Reliability

- Batched playlist copying, moving, and removal in groups of up to 25; source entries are removed only after their destination copy is confirmed.
- Preserved unfinished selections after failed playlist operations and rebuilt their review plans for retry.
- Improved Spotify pagination, matching fallback searches, and matching concurrency; authenticated imports no longer silently fall back to truncated previews.
- Corrected playlist creation fields and surfaced actionable transfer errors without automatically replaying uncertain writes.
- Hardened lyric timing, media-element rebinding, duration matching, and LRCLib fallback behavior.
- Fixed scrobbling setup and serialized encrypted credential updates for independent providers.
- Improved playback-speed, autoplay, disliked-song, and SponsorBlock behavior after player changes.
- Avoided repeated startup update prompts for versions already offered, while keeping manual checks available.

### Credits

- xzelleiv
- Henix (original creator)
- Pear Desktop

> Windows may show an "Unknown publisher" notice because this community release is not code-signed. In-app updater packages are separately signature-verified.

## 0.1.8 - 2026-07-26

### Fixes

- Fixed Google sign-in looping and opening Chrome when the regional `accounts.google.com.sg` handoff was rejected; the login flow now stays inside the WebView.

## 0.1.7 - 2026-07-24

### Fixes

- Restored ad blocking with host-scoped WebView2 filters that do not intercept media streams.
- Preserved Share, inactivity, and other YouTube Music dialogs while skipping detected player ads.
- Reapplied ad blocking after sign-out navigation without changing Google account pages.
- Kept Google sign-in completion inside the desktop app instead of opening Chrome.
- Embedded the WebView2 bootstrapper for more reliable first-time Windows installs.
- Added MSI license/bootstrapper verification and blocked accidental unsigned release builds.

## 0.1.6 - 2026-07-20

### Fixes

- Fixed Google sign-in navigation being opened in an external browser instead of WebView.
- Fixed HTML5 audio/video media playback stalling at 0:00 when ad-block is enabled.
- Fixed WebView2 media autoplay policy requiring manual user gesture.

## 0.1.5 - 2026-07-12

### QoL

- Added persistent Discord RPC, ad-block, close-to-tray, startup, start-minimized, and zoom settings.
- Added a system tray with show/hide, previous, play/pause, next, Discord RPC, and quit controls.
- Added reload, zoom, cache clear, session reset, RPC status, and ad-block status actions.
- Added automatic and manual GitHub release checks.
- Open external HTTPS links in the default browser.
- Added left-hand global playback shortcuts: `Ctrl+Alt+A` previous, `Ctrl+Alt+S` play/pause, and `Ctrl+Alt+D` next.
- Avoided GitHub API rate limits in update checks.

## 0.1.4 - 2026-07-04

### Fixes

- Clear Discord Rich Presence when YouTube Music has no valid track, shows an ad, leaves the music host, or the app closes.

### Documentation

- Refined README positioning for the desktop app.
