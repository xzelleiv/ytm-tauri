# Third-Party Notices

This project uses open-source dependencies and is licensed under the MIT License.

This project is unofficial and is not affiliated with, endorsed by, or sponsored
by YouTube, Google, Discord, Microsoft, or Tauri.

## Direct Runtime Dependencies

SPDX `OR` expressions offer a license choice. This distribution uses the MIT
option for every direct dependency offered under `MIT OR Apache-2.0`.

| Component | Version | Distribution license | Purpose |
| --- | --- | --- | --- |
| Tauri | 2.11.5 | MIT (selected) | Desktop app framework |
| Tauri global-shortcut plugin | 2.3.2 | MIT (selected) | Global playback shortcuts |
| Tauri notification plugin | 2.4.0 | MIT (selected) | Native Windows notifications |
| Tauri single-instance plugin | 2.4.4 | MIT (selected) | Reuses the existing app window |
| Tauri updater plugin | 2.11.0 | MIT (selected) | In-app application updater |
| Tauri window-state plugin | 2.4.1 | MIT (selected) | Persists window size and position |
| discord-rich-presence | 1.1.0 | MIT | Discord Rich Presence IPC |
| reqwest | 0.13.4 | MIT (selected) | GitHub release checks |
| semver | 1.0.28 | MIT (selected) | Release version comparison |
| serde | 1.0.228 | MIT (selected) | Data serialization |
| serde_json | 1.0.150 | MIT (selected) | JSON parsing |
| webview2-com | 0.38.2 | MIT | Windows WebView2 COM bindings |
| windows | 0.61.3 | MIT (selected) | Windows API bindings |
| winreg | 0.56.0 | MIT | Windows startup registration |

## Build Tooling

| Component | Version | Distribution license | Purpose |
| --- | --- | --- | --- |
| @tauri-apps/cli | 2.11.4 | MIT (selected) | Tauri build and bundle CLI |
| tauri-build | 2.6.3 | MIT (selected) | Tauri build script support |

## Platform Components

| Component | Provider | Notes |
| --- | --- | --- |
| Microsoft Edge WebView2 Runtime | Microsoft | Required runtime used by Tauri on Windows |
| Discord desktop client | Discord | Required only for Rich Presence display |
| YouTube Music web service | Google/YouTube | Loaded as a remote web page; no affiliation claimed |

## Transitive Dependencies

The Windows release build also includes transitive Rust dependencies recorded in
`src-tauri/Cargo.lock`. The Windows-target dependency graph can be inspected with:

```powershell
cargo metadata --format-version 1 --filter-platform x86_64-pc-windows-msvc
```

Most transitive dependencies are licensed under permissive licenses such as MIT,
Apache-2.0, BSD-3-Clause, Zlib, Unlicense, Unicode-3.0, CC0-1.0, or MPL-2.0.
