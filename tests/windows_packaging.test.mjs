import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const tauriConfig = JSON.parse(
  readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
);
const packageLock = JSON.parse(
  readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
);

test("default release build goes through signed Windows build guard", () => {
  assert.match(packageJson.scripts.build, /build-windows\.ps1/);
  assert.match(packageJson.scripts["build:unsigned"], /build-windows\.ps1 -AllowUnsigned/);
  assert.equal(packageJson.scripts["build:tauri"], "tauri build");

  const buildScript = readFileSync(
    new URL("../scripts/build-windows.ps1", import.meta.url),
    "utf8",
  );
  assert.match(buildScript, /\$env:TAURI_SIGNING_PRIVATE_KEY = \$resolvedUpdaterKey\.Path/);
  assert.match(buildScript, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD/);

  const verifyScript = readFileSync(
    new URL("../scripts/verify-windows-bundle.ps1", import.meta.url),
    "utf8",
  );
  assert.match(verifyScript, /Updater signature is missing/);
  assert.match(verifyScript, /signature from tauri secret key/);
});

test("application versions stay aligned", () => {
  const cargoToml = readFileSync(
    new URL("../src-tauri/Cargo.toml", import.meta.url),
    "utf8",
  );
  assert.equal(packageJson.version, "0.2.4");
  assert.equal(packageLock.version, "0.2.4");
  assert.equal(packageLock.packages[""].version, "0.2.4");
  assert.equal(tauriConfig.version, "0.2.4");
  assert.match(cargoToml, /^version = "0\.2\.4"$/m);
});

test("signed in-app updater is configured and owned by Rust", () => {
  const updater = tauriConfig.plugins.updater;
  assert.equal(tauriConfig.bundle.createUpdaterArtifacts, true);
  assert.deepEqual(updater.endpoints, [
    "https://github.com/xzelleiv/ytm-tauri/releases/latest/download/latest.json",
  ]);
  assert.equal(updater.windows.installMode, "passive");
  assert.match(
    Buffer.from(updater.pubkey, "base64").toString("utf8"),
    /minisign public key/,
  );

  const updateSource = readFileSync(
    new URL("../src-tauri/src/updates.rs", import.meta.url),
    "utf8",
  );
  assert.match(updateSource, /tauri_plugin_updater::UpdaterExt/);
  assert.match(updateSource, /download_and_install/);
  assert.doesNotMatch(updateSource, /platform::open_url/);
  assert.doesNotMatch(updateSource, /api\.github\.com/);

  const releaseWorkflow = readFileSync(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  assert.match(releaseWorkflow, /TAURI_SIGNING_PRIVATE_KEY/);
  assert.match(releaseWorkflow, /uploadUpdaterJson: true/);
  assert.match(releaseWorkflow, /updaterJsonPreferNsis: true/);
});

test("first install embeds the WebView2 bootstrapper", () => {
  assert.equal(
    tauriConfig.bundle.windows.webviewInstallMode.type,
    "embedBootstrapper",
  );
});

test("Windows installers register the media-session application identity", () => {
  const windows = tauriConfig.bundle.windows;
  assert.deepEqual(windows.wix.fragmentPaths, ["wix/app-identity.wxs"]);
  assert.deepEqual(windows.wix.componentGroupRefs, [
    "AppUserModelIdentityComponents",
  ]);
  assert.equal(windows.nsis.installerHooks, "nsis/installer-hooks.nsh");

  const wixIdentity = readFileSync(
    new URL("../src-tauri/wix/app-identity.wxs", import.meta.url),
    "utf8",
  );
  const nsisHooks = readFileSync(
    new URL("../src-tauri/nsis/installer-hooks.nsh", import.meta.url),
    "utf8",
  );

  for (const source of [wixIdentity, nsisHooks]) {
    assert.match(source, /app\.ytmusic\.desktop/);
    assert.match(source, /DisplayName/);
    assert.match(source, /IconUri/);
    assert.match(source, /YouTube Music/);
  }

  const mainSource = readFileSync(
    new URL("../src-tauri/src/main.rs", import.meta.url),
    "utf8",
  );
  const platformSource = readFileSync(
    new URL("../src-tauri/src/platform.rs", import.meta.url),
    "utf8",
  );
  const libSource = readFileSync(
    new URL("../src-tauri/src/lib.rs", import.meta.url),
    "utf8",
  );
  assert.match(mainSource, /SetCurrentProcessExplicitAppUserModelID/);
  assert.match(platformSource, /SHGetPropertyStoreForWindow/);
  assert.match(platformSource, /APP_USER_MODEL_ID.*app\.ytmusic\.desktop/);
  assert.match(libSource, /set_window_app_identity\(&window\)/);
});

test("MSI license source remains plain text for Tauri's RTF conversion", () => {
  assert.doesNotMatch(tauriConfig.bundle.licenseFile, /\.rtf$/i);

  const licenseSource = readFileSync(
    new URL(`../src-tauri/${tauriConfig.bundle.licenseFile}`, import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(licenseSource, /^\{\\rtf1\\ansi/);
  assert.match(licenseSource, /^MIT License/);
});
