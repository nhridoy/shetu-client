//! macOS menu bar. Custom items emit `menu-action` with their id; the
//! frontend (src/lib/window/menuActions.ts) runs the matching app action.

use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{App, AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;

const MENU_ACTION_EVENT: &str = "menu-action";
/// Must match MENU_ACTION_IDS in src/lib/window/menuActions.ts.
const APP_ACTIONS: [&str; 4] = ["settings", "new-tab", "quick-connect", "close-tab"];
const HELP_GITHUB: &str = "help-github";
const REPO_URL: &str = "https://github.com/nhridoy/shetu";

pub fn install(app: &App) -> tauri::Result<()> {
    let item = |id: &str, text: &str, accel: &str| {
        MenuItemBuilder::with_id(id, text)
            .accelerator(accel)
            .build(app)
    };

    let shetu = SubmenuBuilder::new(app, "Shetu")
        .about_with_text("About Shetu", None)
        .separator()
        .item(&item("settings", "Settings…", "Cmd+,")?)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let file = SubmenuBuilder::new(app, "File")
        .item(&item("new-tab", "New Tab", "Cmd+T")?)
        .item(&item("quick-connect", "Quick Connect…", "Cmd+K")?)
        .separator()
        .item(&item("close-tab", "Close Tab", "Cmd+W")?)
        .build()?;

    // Predefined items keep copy/paste working in text fields.
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let view = SubmenuBuilder::new(app, "View").fullscreen().build()?;

    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .bring_all_to_front()
        .build()?;

    let help = SubmenuBuilder::new(app, "Help")
        .item(&MenuItemBuilder::with_id(HELP_GITHUB, "Shetu on GitHub").build(app)?)
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&shetu, &file, &edit, &view, &window, &help])
        .build()?;
    app.set_menu(menu)?;
    app.on_menu_event(|handle: &AppHandle, event| {
        let id = event.id().as_ref();
        if APP_ACTIONS.contains(&id) {
            let _ = handle.emit(MENU_ACTION_EVENT, id);
        } else if id == HELP_GITHUB {
            let _ = handle.opener().open_url(REPO_URL, None::<&str>);
        }
    });
    Ok(())
}
