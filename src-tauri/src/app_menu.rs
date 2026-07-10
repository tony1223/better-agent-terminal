use crate::commands::{app as app_cmd, debug as debug_cmd};
use tauri::{
    menu::{AboutMetadata, Menu, MenuBuilder, MenuEvent, MenuItem, SubmenuBuilder},
    AppHandle, Wry,
};

const APP_LABEL: &str = "BetterAgentTerminal";
const MENU_NEW_WINDOW: &str = "app.new-window";
const MENU_NEXT_WINDOW: &str = "app.next-window";
const MENU_OPEN_LOGS: &str = "app.open-logs";

#[cfg(target_os = "macos")]
const NEXT_WINDOW_ACCELERATOR: &str = "CmdOrCtrl+Backquote";

#[cfg(not(target_os = "macos"))]
const NEXT_WINDOW_ACCELERATOR: &str = "CmdOrCtrl+Tab";

pub(crate) fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let about_metadata = AboutMetadata {
        name: Some(APP_LABEL.to_string()),
        version: Some(app.package_info().version.to_string()),
        authors: Some(vec!["TonyQ CO., LTD.".to_string()]),
        comments: Some("Better Agent Terminal".to_string()),
        ..Default::default()
    };

    let new_window = MenuItem::with_id(
        app,
        MENU_NEW_WINDOW,
        "New Window",
        true,
        Some("CmdOrCtrl+N"),
    )?;
    let next_window = MenuItem::with_id(
        app,
        MENU_NEXT_WINDOW,
        "Next Window",
        true,
        Some(NEXT_WINDOW_ACCELERATOR),
    )?;
    let open_logs = MenuItem::with_id(app, MENU_OPEN_LOGS, "Open Logs Folder", true, None::<&str>)?;

    #[cfg(target_os = "macos")]
    let app_menu = SubmenuBuilder::new(app, APP_LABEL)
        .about(Some(about_metadata.clone()))
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    #[cfg(target_os = "macos")]
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new_window)
        .separator()
        .close_window_with_text("Close Window")
        .build()?;

    #[cfg(not(target_os = "macos"))]
    let file_menu = SubmenuBuilder::new(app, "&File")
        .item(&new_window)
        .separator()
        .close_window_with_text("Close Window")
        .separator()
        .quit()
        .build()?;

    #[cfg(target_os = "macos")]
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    #[cfg(not(target_os = "macos"))]
    let edit_menu = SubmenuBuilder::new(app, "&Edit")
        .cut()
        .copy()
        .paste()
        .separator()
        .select_all()
        .build()?;

    #[cfg(target_os = "macos")]
    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize_with_text("Zoom")
        .fullscreen()
        .separator()
        .item(&next_window)
        .bring_all_to_front()
        .build()?;

    #[cfg(not(target_os = "macos"))]
    let window_menu = SubmenuBuilder::new(app, "&Window")
        .minimize()
        .maximize()
        .item(&next_window)
        .separator()
        .close_window_with_text("Close Window")
        .build()?;

    #[cfg(target_os = "macos")]
    let help_menu = SubmenuBuilder::new(app, "Help").item(&open_logs).build()?;

    #[cfg(not(target_os = "macos"))]
    let help_menu = SubmenuBuilder::new(app, "&Help")
        .item(&open_logs)
        .separator()
        .about_with_text("About BetterAgentTerminal", Some(about_metadata))
        .build()?;

    #[cfg(target_os = "macos")]
    {
        MenuBuilder::new(app)
            .item(&app_menu)
            .item(&file_menu)
            .item(&edit_menu)
            .item(&window_menu)
            .item(&help_menu)
            .build()
    }

    #[cfg(not(target_os = "macos"))]
    {
        MenuBuilder::new(app)
            .item(&file_menu)
            .item(&edit_menu)
            .item(&window_menu)
            .item(&help_menu)
            .build()
    }
}

pub(crate) fn handle_event(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        MENU_NEW_WINDOW => {
            let _ = app_cmd::app_new_window_for_active(app);
        }
        MENU_NEXT_WINDOW => {
            let _ = app_cmd::app_focus_next_window_from_active(app);
        }
        MENU_OPEN_LOGS => {
            let app = app.clone();
            crate::async_rt::spawn(async move {
                if let Err(error) = debug_cmd::debug_open_logs_folder(app.clone()).await {
                    app_cmd::log_tauri(
                        &crate::host_context::HostContext::from_app(app.clone()),
                        &format!("[menu] open-logs-failed error={error}"),
                    );
                }
            });
        }
        _ => {}
    }
}
