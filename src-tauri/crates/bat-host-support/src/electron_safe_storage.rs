use aes::Aes128;
use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use cbc::{Decryptor as CbcDecryptor, Encryptor as CbcEncryptor};
use pbkdf2::pbkdf2_hmac;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::Sha1;
use std::fs;
use std::path::Path;

type Aes128CbcDec = CbcDecryptor<Aes128>;
type Aes128CbcEnc = CbcEncryptor<Aes128>;

const MAC_SALT: &[u8] = b"saltysalt";
const MAC_ITERATIONS: u32 = 1003;
const MAC_IV: [u8; 16] = [0x20; 16];
const ELECTRON_PREFIX: &[u8] = b"v10";
const DEFAULT_MAC_APP_NAME: &str = "BetterAgentTerminal";

#[derive(Debug, PartialEq, Eq)]
pub enum SecretJsonRead<T> {
    Missing,
    Read(T),
    EncryptedUnreadable,
}

#[derive(Debug, Deserialize)]
struct SecretEnvelope {
    enc: Option<bool>,
    data: Option<String>,
}

pub fn read_secret_json<T: DeserializeOwned>(
    app_data_dir: &Path,
    path: &Path,
) -> SecretJsonRead<T> {
    let Ok(raw) = fs::read_to_string(path) else {
        return SecretJsonRead::Missing;
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return SecretJsonRead::Missing;
    };
    let envelope = serde_json::from_value::<SecretEnvelope>(value.clone()).ok();
    if envelope.as_ref().and_then(|env| env.enc) == Some(true) {
        let Some(data) = envelope.and_then(|env| env.data) else {
            return SecretJsonRead::EncryptedUnreadable;
        };
        let Some(plaintext) = decrypt_electron_safe_storage_data(app_data_dir, &data) else {
            return SecretJsonRead::EncryptedUnreadable;
        };
        return serde_json::from_slice::<T>(&plaintext)
            .map(SecretJsonRead::Read)
            .unwrap_or(SecretJsonRead::Missing);
    }
    if envelope.as_ref().and_then(|env| env.enc) == Some(false) {
        if let Some(data) = envelope.and_then(|env| env.data) {
            return serde_json::from_str::<T>(&data)
                .map(SecretJsonRead::Read)
                .unwrap_or(SecretJsonRead::Missing);
        }
    }
    serde_json::from_value::<T>(value)
        .map(SecretJsonRead::Read)
        .unwrap_or(SecretJsonRead::Missing)
}

pub fn write_secret_json<T: Serialize>(
    app_data_dir: &Path,
    path: &Path,
    data: &T,
) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let plaintext = serde_json::to_string(data).unwrap_or_else(|_| "{}".into());
    let payload = if let Some(encrypted) =
        encrypt_electron_safe_storage_data(app_data_dir, plaintext.as_bytes())
    {
        json!({ "enc": true, "data": encrypted })
    } else {
        json!({ "enc": false, "data": plaintext })
    };
    write_owner_only(
        path,
        serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".into()),
    )
}

pub fn read_secret_string(app_data_dir: &Path, path: &Path) -> SecretJsonRead<String> {
    match read_secret_json::<Value>(app_data_dir, path) {
        SecretJsonRead::Missing => SecretJsonRead::Missing,
        SecretJsonRead::EncryptedUnreadable => SecretJsonRead::EncryptedUnreadable,
        SecretJsonRead::Read(Value::String(value)) => SecretJsonRead::Read(value),
        SecretJsonRead::Read(Value::Object(map)) => map
            .get("value")
            .and_then(Value::as_str)
            .map(|value| SecretJsonRead::Read(value.to_string()))
            .unwrap_or(SecretJsonRead::Missing),
        SecretJsonRead::Read(_) => SecretJsonRead::Missing,
    }
}

pub fn write_secret_string(app_data_dir: &Path, path: &Path, value: &str) -> std::io::Result<()> {
    write_secret_json(app_data_dir, path, &json!({ "value": value }))
}

pub fn decrypt_electron_safe_storage_data(app_data_dir: &Path, data: &str) -> Option<Vec<u8>> {
    let encrypted = B64.decode(data).ok()?;
    decrypt_electron_safe_storage_blob(app_data_dir, &encrypted)
}

pub fn decrypt_electron_safe_storage_blob(
    app_data_dir: &Path,
    encrypted: &[u8],
) -> Option<Vec<u8>> {
    decrypt_electron_windows_blob(app_data_dir, encrypted)
        .or_else(|| decrypt_electron_macos_blob(app_data_dir, encrypted))
}

pub fn encrypt_electron_safe_storage_data(app_data_dir: &Path, plaintext: &[u8]) -> Option<String> {
    encrypt_electron_windows_blob(app_data_dir, plaintext)
        .or_else(|| encrypt_electron_macos_blob(app_data_dir, plaintext))
        .map(|bytes| B64.encode(bytes))
}

fn write_owner_only(path: &Path, content: String) -> std::io::Result<()> {
    fs::write(path, content)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn read_local_state_os_crypt_key(app_data_dir: &Path) -> Option<Vec<u8>> {
    let local_state = fs::read_to_string(app_data_dir.join("Local State")).ok()?;
    let value = serde_json::from_str::<Value>(&local_state).ok()?;
    value
        .get("os_crypt")?
        .get("encrypted_key")?
        .as_str()
        .and_then(decrypt_electron_os_crypt_key)
}

fn decrypt_electron_windows_blob(app_data_dir: &Path, encrypted: &[u8]) -> Option<Vec<u8>> {
    let key = read_local_state_os_crypt_key(app_data_dir)?;
    decrypt_electron_v10_aes_gcm_blob(&key, encrypted)
}

fn encrypt_electron_windows_blob(app_data_dir: &Path, plaintext: &[u8]) -> Option<Vec<u8>> {
    let key = read_or_create_local_state_os_crypt_key(app_data_dir)?;
    encrypt_electron_v10_aes_gcm_blob(&key, plaintext)
}

fn read_or_create_local_state_os_crypt_key(app_data_dir: &Path) -> Option<Vec<u8>> {
    read_local_state_os_crypt_key(app_data_dir)
        .or_else(|| create_local_state_os_crypt_key(app_data_dir))
}

#[cfg(windows)]
fn create_local_state_os_crypt_key(app_data_dir: &Path) -> Option<Vec<u8>> {
    let key = rand::random::<[u8; 32]>().to_vec();
    let protected = protect_with_current_user_dpapi(&key)?;
    let mut prefixed = b"DPAPI".to_vec();
    prefixed.extend_from_slice(&protected);
    let encrypted_key = B64.encode(prefixed);

    fs::create_dir_all(app_data_dir).ok()?;
    let path = app_data_dir.join("Local State");
    let mut value = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(|| json!({}));
    if !value.is_object() {
        value = json!({});
    }
    let root = value.as_object_mut()?;
    let os_crypt = root
        .entry("os_crypt")
        .or_insert_with(|| json!({}))
        .as_object_mut()?;
    os_crypt.insert("encrypted_key".into(), Value::String(encrypted_key));
    write_owner_only(
        &path,
        serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".into()),
    )
    .ok()?;
    Some(key)
}

#[cfg(not(windows))]
fn create_local_state_os_crypt_key(_app_data_dir: &Path) -> Option<Vec<u8>> {
    None
}

fn decrypt_electron_os_crypt_key(encrypted_key: &str) -> Option<Vec<u8>> {
    let raw = B64.decode(encrypted_key).ok()?;
    let prefixed = raw.strip_prefix(b"DPAPI")?;
    decrypt_with_current_user_dpapi(prefixed)
}

fn decrypt_electron_v10_aes_gcm_blob(key: &[u8], encrypted: &[u8]) -> Option<Vec<u8>> {
    let payload = encrypted.strip_prefix(ELECTRON_PREFIX)?;
    if payload.len() < 12 + 16 {
        return None;
    }
    let (nonce, ciphertext_and_tag) = payload.split_at(12);
    let cipher = Aes256Gcm::new_from_slice(key).ok()?;
    cipher
        .decrypt(Nonce::from_slice(nonce), ciphertext_and_tag)
        .ok()
}

fn encrypt_electron_v10_aes_gcm_blob(key: &[u8], plaintext: &[u8]) -> Option<Vec<u8>> {
    let nonce = rand::random::<[u8; 12]>();
    let cipher = Aes256Gcm::new_from_slice(key).ok()?;
    let mut out = ELECTRON_PREFIX.to_vec();
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&cipher.encrypt(Nonce::from_slice(&nonce), plaintext).ok()?);
    Some(out)
}

fn decrypt_electron_macos_blob(app_data_dir: &Path, encrypted: &[u8]) -> Option<Vec<u8>> {
    for password in macos_safe_storage_password_candidates(app_data_dir) {
        if let Some(plaintext) = decrypt_electron_v10_aes_cbc_blob(&password, encrypted) {
            return Some(plaintext);
        }
    }
    None
}

fn encrypt_electron_macos_blob(app_data_dir: &Path, plaintext: &[u8]) -> Option<Vec<u8>> {
    let password = macos_safe_storage_password_candidates(app_data_dir)
        .into_iter()
        .next()
        .or_else(|| macos_create_default_safe_storage_password())?;
    encrypt_electron_v10_aes_cbc_blob(&password, plaintext)
}

fn decrypt_electron_v10_aes_cbc_blob(password: &str, encrypted: &[u8]) -> Option<Vec<u8>> {
    let ciphertext = encrypted.strip_prefix(ELECTRON_PREFIX)?;
    let key = macos_derive_aes_key(password);
    let mut buf = ciphertext.to_vec();
    Aes128CbcDec::new_from_slices(&key, &MAC_IV)
        .ok()?
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .ok()
        .map(|plaintext| plaintext.to_vec())
}

fn encrypt_electron_v10_aes_cbc_blob(password: &str, plaintext: &[u8]) -> Option<Vec<u8>> {
    let key = macos_derive_aes_key(password);
    let mut buf = plaintext.to_vec();
    let block = 16;
    let padding = block - (buf.len() % block);
    buf.resize(buf.len() + padding, 0);
    let ciphertext = Aes128CbcEnc::new_from_slices(&key, &MAC_IV)
        .ok()?
        .encrypt_padded_mut::<Pkcs7>(&mut buf, plaintext.len())
        .ok()?;
    let mut out = ELECTRON_PREFIX.to_vec();
    out.extend_from_slice(ciphertext);
    Some(out)
}

fn macos_derive_aes_key(password: &str) -> [u8; 16] {
    let mut key = [0u8; 16];
    pbkdf2_hmac::<Sha1>(password.as_bytes(), MAC_SALT, MAC_ITERATIONS, &mut key);
    key
}

fn macos_safe_storage_password_candidates(app_data_dir: &Path) -> Vec<String> {
    macos_safe_storage_keychain_names(app_data_dir)
        .into_iter()
        .filter_map(|(service, account)| macos_keychain_password(&service, &account))
        .collect()
}

fn macos_safe_storage_keychain_names(app_data_dir: &Path) -> Vec<(String, String)> {
    let mut app_names = vec![DEFAULT_MAC_APP_NAME.to_string()];
    if let Some(name) = app_data_dir.file_name().and_then(|name| name.to_str()) {
        app_names.push(name.to_string());
    }
    app_names.push("Electron".to_string());
    app_names.sort();
    app_names.dedup();

    let mut names = Vec::new();
    for app_name in app_names {
        let service = format!("{app_name} Safe Storage");
        names.push((service.clone(), format!("{app_name} Key")));
        names.push((service, app_name));
    }
    names
}

fn macos_create_default_safe_storage_password() -> Option<String> {
    let service = format!("{DEFAULT_MAC_APP_NAME} Safe Storage");
    let account = format!("{DEFAULT_MAC_APP_NAME} Key");
    let password = B64.encode(rand::random::<[u8; 16]>());
    if macos_add_keychain_password(&service, &account, &password) {
        Some(password)
    } else {
        None
    }
}

#[cfg(target_os = "macos")]
fn macos_keychain_password(service: &str, account: &str) -> Option<String> {
    let output = std::process::Command::new("security")
        .args(["find-generic-password", "-w", "-s", service, "-a", account])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout)
        .ok()
        .map(|value| value.trim_end_matches(['\r', '\n']).to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(not(target_os = "macos"))]
fn macos_keychain_password(_service: &str, _account: &str) -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
fn macos_add_keychain_password(service: &str, account: &str, password: &str) -> bool {
    std::process::Command::new("security")
        .args([
            "add-generic-password",
            "-U",
            "-s",
            service,
            "-a",
            account,
            "-w",
            password,
        ])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
fn macos_add_keychain_password(_service: &str, _account: &str, _password: &str) -> bool {
    false
}

#[cfg(windows)]
fn decrypt_with_current_user_dpapi(data: &[u8]) -> Option<Vec<u8>> {
    use std::ptr;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};

    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len().try_into().ok()?,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            ptr::null_mut(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            0,
            &mut output,
        )
    };
    if ok == 0 || output.pbData.is_null() {
        return None;
    }
    let decrypted =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe {
        let _ = LocalFree(output.pbData.cast());
    }
    Some(decrypted)
}

#[cfg(not(windows))]
fn decrypt_with_current_user_dpapi(_data: &[u8]) -> Option<Vec<u8>> {
    None
}

#[cfg(windows)]
fn protect_with_current_user_dpapi(data: &[u8]) -> Option<Vec<u8>> {
    use std::ptr;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};

    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len().try_into().ok()?,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let ok = unsafe {
        CryptProtectData(
            &input,
            ptr::null(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            0,
            &mut output,
        )
    };
    if ok == 0 || output.pbData.is_null() {
        return None;
    }
    let encrypted =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe {
        let _ = LocalFree(output.pbData.cast());
    }
    Some(encrypted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
    struct Token {
        value: String,
    }

    #[test]
    fn macos_v10_aes_cbc_round_trips() {
        let password = "ztTx7aL290IuVyPJIgFfUQ==";
        let plaintext = br#"{"value":"secret"}"#;
        let encrypted = encrypt_electron_v10_aes_cbc_blob(password, plaintext).unwrap();
        assert!(encrypted.starts_with(ELECTRON_PREFIX));
        assert_eq!(
            decrypt_electron_v10_aes_cbc_blob(password, &encrypted).as_deref(),
            Some(plaintext.as_slice())
        );
    }

    #[test]
    fn windows_v10_aes_gcm_round_trips() {
        let key = [7u8; 32];
        let plaintext = br#"{"value":"secret"}"#;
        let encrypted = encrypt_electron_v10_aes_gcm_blob(&key, plaintext).unwrap();
        assert!(encrypted.starts_with(ELECTRON_PREFIX));
        assert_eq!(
            decrypt_electron_v10_aes_gcm_blob(&key, &encrypted).as_deref(),
            Some(plaintext.as_slice())
        );
    }

    #[test]
    fn reads_plaintext_secret_envelope() {
        let dir = std::env::temp_dir().join(format!(
            "bat-secret-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("token.enc.json");
        fs::write(&path, r#"{"enc":false,"data":"{\"value\":\"secret\"}"}"#).unwrap();
        assert_eq!(
            read_secret_json::<Token>(&dir, &path),
            SecretJsonRead::Read(Token {
                value: "secret".into()
            })
        );
        let _ = fs::remove_dir_all(dir);
    }
}
