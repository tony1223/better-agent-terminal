// image:read-as-data-url — load a local image and return a data: URL.
//
// Mirrors the Electron handler: refuses sensitive paths via path_guard,
// caps reads at 10 MiB, and infers the MIME type from the file extension
// (defaulting to image/png to match the Electron behaviour).
//
// We deliberately keep the same byte cap and same error wording so error
// surfaces feel identical to the renderer.

use crate::path_guard::is_sensitive_path;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
#[cfg(feature = "desktop")]
use tauri_plugin_dialog::DialogExt;

const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Debug, Serialize)]
pub struct CommandError {
    message: String,
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CommandError {}

pub fn mime_for_extension(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "image/png",
    }
}

fn extension_for_mime(mime: &str) -> &'static str {
    match mime.to_ascii_lowercase().as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "png",
    }
}

fn sanitize_default_name(default_name: Option<String>, ext: &str) -> String {
    let mut safe = default_name
        .unwrap_or_else(|| format!("generated-image.{ext}"))
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            '\0'..='\u{1F}' => '-',
            _ => c,
        })
        .collect::<String>();
    while safe.ends_with('.') {
        safe.pop();
    }
    let has_extension = safe
        .rsplit_once('.')
        .map(|(_, suffix)| !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or(false);
    if has_extension {
        safe
    } else {
        format!("{safe}.{ext}")
    }
}

fn decode_image_data_url(data_url: &str) -> Result<(String, Vec<u8>), CommandError> {
    let Some(rest) = data_url.strip_prefix("data:") else {
        return Err(CommandError {
            message: "Invalid image data URL".into(),
        });
    };
    let Some((mime, encoded)) = rest.split_once(";base64,") else {
        return Err(CommandError {
            message: "Invalid image data URL".into(),
        });
    };
    let Some(mime_subtype) = mime.strip_prefix("image/") else {
        return Err(CommandError {
            message: "Invalid image data URL".into(),
        });
    };
    if mime_subtype.is_empty()
        || !mime_subtype
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '+' | '-'))
        || encoded.is_empty()
        || !encoded
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=' | '\r' | '\n'))
    {
        return Err(CommandError {
            message: "Invalid image data URL".into(),
        });
    }
    let normalized = encoded.replace(['\r', '\n'], "");
    let bytes = B64.decode(normalized).map_err(|_| CommandError {
        message: "Invalid image data URL".into(),
    })?;
    Ok((mime.to_ascii_lowercase(), bytes))
}

// Called directly by the remote dispatch (pure args), so it must compile in
// the headless build — apply the tauri::command wrapper only on desktop.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn image_read_as_data_url(path: String) -> Result<String, CommandError> {
    let abs = match std::path::absolute(&path) {
        Ok(p) => p,
        Err(e) => {
            return Err(CommandError {
                message: e.to_string(),
            })
        }
    };
    if is_sensitive_path(&abs.to_string_lossy()) {
        return Err(CommandError {
            message: "Access denied (sensitive path)".into(),
        });
    }
    let metadata = fs::metadata(&abs).map_err(|e| CommandError {
        message: e.to_string(),
    })?;
    if metadata.len() > MAX_IMAGE_BYTES {
        return Err(CommandError {
            message: format!("Image too large ({}KB)", metadata.len() / 1024),
        });
    }
    let bytes = fs::read(&abs).map_err(|e| CommandError {
        message: e.to_string(),
    })?;
    let ext = PathBuf::from(&abs)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_string();
    let mime = mime_for_extension(&ext);
    let encoded = B64.encode(bytes);
    Ok(format!("data:{mime};base64,{encoded}"))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn image_save_data_url(
    app: tauri::AppHandle,
    data_url: String,
    default_name: Option<String>,
) -> Result<Option<String>, CommandError> {
    let (mime, bytes) = decode_image_data_url(&data_url)?;
    let ext = extension_for_mime(&mime);
    let filename = sanitize_default_name(default_name, ext);
    let filter_name = format!("{} Image", ext.to_ascii_uppercase());

    let app_clone = app.clone();
    let result = crate::async_rt::spawn_blocking(move || {
        app_clone
            .dialog()
            .file()
            .set_file_name(filename)
            .add_filter(filter_name, &[ext])
            .add_filter("All Files", &["*"])
            .blocking_save_file()
    })
    .await
    .map_err(|e| CommandError {
        message: e.to_string(),
    })?;

    let Some(file_path) = result else {
        return Ok(None);
    };
    let path = file_path.into_path().map_err(|_| CommandError {
        message: "Invalid save path".into(),
    })?;
    fs::write(&path, bytes).map_err(|e| CommandError {
        message: e.to_string(),
    })?;
    Ok(Some(path.to_string_lossy().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn mime_lookup_handles_common_extensions() {
        assert_eq!(mime_for_extension("png"), "image/png");
        assert_eq!(mime_for_extension("PNG"), "image/png");
        assert_eq!(mime_for_extension("jpg"), "image/jpeg");
        assert_eq!(mime_for_extension("jpeg"), "image/jpeg");
        assert_eq!(mime_for_extension("gif"), "image/gif");
        assert_eq!(mime_for_extension("webp"), "image/webp");
        // Unknown extensions fall back to image/png so the renderer still
        // gets something it can drop into <img src=…>.
        assert_eq!(mime_for_extension("bmp"), "image/png");
        assert_eq!(mime_for_extension(""), "image/png");
    }

    #[test]
    fn small_png_round_trips_to_data_url() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("bat-img-{}.png", std::process::id()));
        // Magic-only PNG header — we only care about the bytes, not the
        // image being valid.
        let bytes: Vec<u8> = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3];
        {
            let mut f = fs::File::create(&path).unwrap();
            f.write_all(&bytes).unwrap();
        }
        let url = crate::async_rt::block_on(image_read_as_data_url(path.to_string_lossy().into()))
            .unwrap();
        assert!(url.starts_with("data:image/png;base64,"));
        // Round-trip check: payload after the prefix should decode back to
        // the source bytes.
        let payload = url.strip_prefix("data:image/png;base64,").unwrap();
        let decoded = B64.decode(payload).unwrap();
        assert_eq!(decoded, bytes);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn data_url_decoder_accepts_image_base64_and_strips_newlines() {
        let (mime, bytes) = decode_image_data_url("data:image/png;base64,aGVs\r\nbG8=").unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(bytes, b"hello");
    }

    #[test]
    fn data_url_decoder_rejects_non_image_or_malformed_payloads() {
        assert_eq!(
            decode_image_data_url("data:text/plain;base64,aGVsbG8=")
                .err()
                .unwrap()
                .message,
            "Invalid image data URL"
        );
        assert!(decode_image_data_url("data:image/png;base64,hello world").is_err());
        assert!(decode_image_data_url("data:image/png,aaaa").is_err());
    }

    #[test]
    fn save_data_url_default_name_matches_electron_sanitization() {
        assert_eq!(
            sanitize_default_name(Some("bad<>:/\\|?*\u{0007}name".into()), "png"),
            "bad---------name.png"
        );
        assert_eq!(
            sanitize_default_name(Some("photo.jpeg".into()), "png"),
            "photo.jpeg"
        );
        assert_eq!(
            sanitize_default_name(Some("generated".into()), "webp"),
            "generated.webp"
        );
        assert_eq!(sanitize_default_name(None, "gif"), "generated-image.gif");
    }

    #[test]
    fn images_above_size_cap_are_refused() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("bat-img-large-{}.png", std::process::id()));
        {
            let mut f = fs::File::create(&path).unwrap();
            // 10 MiB + 1 byte: just past the cap.
            let chunk = vec![0u8; 1024 * 1024];
            for _ in 0..10 {
                f.write_all(&chunk).unwrap();
            }
            f.write_all(&[0u8]).unwrap();
        }
        let err = crate::async_rt::block_on(image_read_as_data_url(path.to_string_lossy().into()))
            .err()
            .unwrap();
        assert!(err.message.starts_with("Image too large"));
        let _ = fs::remove_file(path);
    }
}
