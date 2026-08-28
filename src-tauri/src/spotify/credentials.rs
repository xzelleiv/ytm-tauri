use super::models::SpotifySession;
use std::{fs, path::PathBuf};
use windows::Win32::Foundation::LocalFree;
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

pub fn save_session(session: &SpotifySession) -> Result<(), String> {
    let json = serde_json::to_vec(session).map_err(|e| e.to_string())?;
    let encrypted = encrypt_data(&json)?;
    let path = session_file_path()?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    fs::write(path, encrypted).map_err(|e| e.to_string())
}

pub fn load_session() -> Option<SpotifySession> {
    let path = session_file_path().ok()?;
    if !path.exists() {
        return None;
    }

    let encrypted = fs::read(path).ok()?;
    let decrypted = decrypt_data(&encrypted).ok()?;
    let session: SpotifySession = serde_json::from_slice(&decrypted).ok()?;

    // check expiration
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    if session.expires_at_unix > 0
        && session.expires_at_unix < now
        && !session.has_refresh_credential()
    {
        clear_session();
        return None;
    }

    Some(session)
}

pub fn clear_session() {
    if let Ok(path) = session_file_path() {
        let _ = fs::remove_file(path);
    }
}

fn session_file_path() -> Result<PathBuf, String> {
    let mut dir = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("USERPROFILE").map(|p| PathBuf::from(p).join("AppData\\Roaming"))
        })
        .ok_or_else(|| "no appdata dir".to_string())?;

    dir.push("app.ytmusic.desktop");
    dir.push("spotify_session.bin");
    Ok(dir)
}

fn encrypt_data(data: &[u8]) -> Result<Vec<u8>, String> {
    unsafe {
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut out_blob = CRYPT_INTEGER_BLOB::default();

        CryptProtectData(
            &in_blob,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        )
        .map_err(|e| format!("dpapi protect failed {e}"))?;

        let slice = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize);
        let result = slice.to_vec();
        let _ = LocalFree(Some(windows::Win32::Foundation::HLOCAL(
            out_blob.pbData as _,
        )));
        Ok(result)
    }
}

fn decrypt_data(data: &[u8]) -> Result<Vec<u8>, String> {
    unsafe {
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut out_blob = CRYPT_INTEGER_BLOB::default();

        CryptUnprotectData(
            &in_blob,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        )
        .map_err(|e| format!("dpapi unprotect failed {e}"))?;

        let slice = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize);
        let result = slice.to_vec();
        let _ = LocalFree(Some(windows::Win32::Foundation::HLOCAL(
            out_blob.pbData as _,
        )));
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dpapi_roundtrip() {
        let sample = b"test secret token";
        let encrypted = encrypt_data(sample).expect("encrypt");
        assert_ne!(encrypted, sample);
        let decrypted = decrypt_data(&encrypted).expect("decrypt");
        assert_eq!(decrypted, sample);
    }
}
