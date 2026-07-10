// clipboard:* — local OS clipboard bridge.
//
// Electron preload exposes:
//   clipboard.writeText(text)  -> Promise<boolean>
//   clipboard.saveImage()      -> Promise<string|null>
//   clipboard.writeImage(file) -> Promise<boolean>

use crate::commands::app::log_tauri;
use serde::Serialize;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::image::Image;
use tauri_plugin_clipboard_manager::ClipboardExt;

#[derive(Debug, Serialize)]
pub struct CommandError {
    message: String,
}

#[tauri::command]
pub fn clipboard_write_text(app: tauri::AppHandle, text: String) -> Result<bool, CommandError> {
    app.clipboard()
        .write_text(text)
        .map(|_| true)
        .map_err(|e| CommandError {
            message: e.to_string(),
        })
}

fn clipboard_temp_png_path() -> std::path::PathBuf {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("bat-clipboard-{millis}.png"))
}

fn write_rgba_png(path: &Path, rgba: &[u8], width: u32, height: u32) -> Result<(), CommandError> {
    let Some(buffer) =
        image::ImageBuffer::<image::Rgba<u8>, _>::from_raw(width, height, rgba.to_vec())
    else {
        return Err(CommandError {
            message: "Invalid clipboard image data".into(),
        });
    };
    buffer
        .save_with_format(path, image::ImageFormat::Png)
        .map_err(|e| CommandError {
            message: e.to_string(),
        })
}

fn load_rgba_image(path: &Path) -> Result<Image<'static>, CommandError> {
    let image = image::open(path).map_err(|e| CommandError {
        message: e.to_string(),
    })?;
    let rgba = image.to_rgba8();
    let (width, height) = rgba.dimensions();
    Ok(Image::new_owned(rgba.into_raw(), width, height))
}

#[tauri::command]
pub async fn clipboard_save_image(app: tauri::AppHandle) -> Result<Option<String>, CommandError> {
    let app_clone = app.clone();
    let app_for_log = app.clone();
    let result: Result<Option<String>, CommandError> = crate::async_rt::spawn_blocking(move || {
        let image = match app_clone.clipboard().read_image() {
            Ok(image) => image,
            Err(err) => {
                log_tauri(
                    &crate::host_context::HostContext::from_app(app_clone.clone()),
                    &format!("[clipboard] save_image: read_image error: {err}"),
                );
                return Ok(None);
            }
        };
        let width = image.width();
        let height = image.height();
        let path = clipboard_temp_png_path();
        log_tauri(
            &crate::host_context::HostContext::from_app(app_clone.clone()),
            &format!(
                "[clipboard] save_image: read_image ok {width}x{height} → {}",
                path.display()
            ),
        );
        write_rgba_png(&path, image.rgba(), width, height)?;
        Ok(Some(path.to_string_lossy().to_string()))
    })
    .await
    .map_err(|e| CommandError {
        message: e.to_string(),
    })?;
    match &result {
        Ok(Some(p)) => log_tauri(
            &crate::host_context::HostContext::from_app(app_for_log.clone()),
            &format!("[clipboard] save_image → {p}"),
        ),
        Ok(None) => log_tauri(
            &crate::host_context::HostContext::from_app(app_for_log.clone()),
            "[clipboard] save_image → None",
        ),
        Err(e) => log_tauri(
            &crate::host_context::HostContext::from_app(app_for_log.clone()),
            &format!("[clipboard] save_image error: {}", e.message),
        ),
    }
    result
}

#[tauri::command]
pub fn clipboard_write_image(
    app: tauri::AppHandle,
    file_path: String,
) -> Result<bool, CommandError> {
    let image = match load_rgba_image(Path::new(&file_path)) {
        Ok(img) => img,
        Err(err) => {
            log_tauri(
                &crate::host_context::HostContext::from_app(app.clone()),
                &format!(
                    "[clipboard] write_image load_rgba_image failed: {} (path={})",
                    err.message, file_path
                ),
            );
            return Ok(false);
        }
    };
    let width = image.width();
    let height = image.height();
    match app.clipboard().write_image(&image) {
        Ok(()) => {
            log_tauri(
                &crate::host_context::HostContext::from_app(app.clone()),
                &format!("[clipboard] write_image ok {width}x{height} path={file_path}"),
            );
            Ok(true)
        }
        Err(err) => {
            log_tauri(
                &crate::host_context::HostContext::from_app(app.clone()),
                &format!("[clipboard] write_image plugin error: {err} (path={file_path})"),
            );
            Ok(false)
        }
    }
}

#[cfg(test)]
mod tests {
    // The plugin owns OS clipboard access, which is impractical to unit test.
    // We keep unit coverage on the file/encoding helpers around that boundary.
    use super::{clipboard_temp_png_path, load_rgba_image, write_rgba_png, CommandError};
    use serde_json::json;
    use std::fs;

    #[test]
    fn command_error_serializes_message() {
        let err = CommandError {
            message: "boom".into(),
        };
        let v = serde_json::to_value(&err).unwrap();
        assert_eq!(v, json!({ "message": "boom" }));
    }

    #[test]
    fn temp_png_path_uses_electron_compatible_prefix() {
        let path = clipboard_temp_png_path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap();
        assert!(name.starts_with("bat-clipboard-"));
        assert!(name.ends_with(".png"));
    }

    #[test]
    fn rgba_png_writer_creates_png_file() {
        let path = std::env::temp_dir().join(format!(
            "bat-clipboard-png-writer-{}.png",
            std::process::id()
        ));
        let _ = fs::remove_file(&path);
        write_rgba_png(&path, &[255, 0, 0, 255], 1, 1).unwrap();
        let bytes = fs::read(&path).unwrap();
        assert_eq!(
            &bytes[..8],
            &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]
        );
        let image = load_rgba_image(&path).unwrap();
        assert_eq!(image.width(), 1);
        assert_eq!(image.height(), 1);
        assert_eq!(image.rgba(), &[255, 0, 0, 255]);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn rgba_png_writer_rejects_mismatched_dimensions() {
        let path = std::env::temp_dir().join(format!(
            "bat-clipboard-png-writer-bad-{}.png",
            std::process::id()
        ));
        let _ = fs::remove_file(&path);
        let err = write_rgba_png(&path, &[255, 0, 0, 255], 2, 1)
            .err()
            .unwrap();
        assert_eq!(err.message, "Invalid clipboard image data");
    }
}
