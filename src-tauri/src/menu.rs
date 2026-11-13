//! macOS menu bar. Custom items emit `menu-action` with their id; the
//! frontend (src/lib/window/menuActions.ts) runs the matching app action.

use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{App, AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

const MENU_ACTION_EVENT: &str = "menu-action";
/// Must match MENU_ACTION_IDS in src/lib/window/menuActions.ts.
const APP_ACTIONS: [&str; 4] = crate::menu_accelerators::MENU_ITEM_IDS;
const HELP_GITHUB: &str = "help-github";
const REPO_URL: &str = "https://github.com/nhridoy/shetu";

pub fn install(app: &App) -> tauri::Result<()> {
    let item = |id: &'static str, text: &str, accel: &str| {
        MenuItemBuilder::with_id(id, text)
            .accelerator(accel)
            .build(app)
    };

    // Kept so the frontend can move their accelerators (menu_accelerators.rs).
    let settings = item("settings", "Settings…", "Cmd+,")?;
    let new_tab = item("new-tab", "New Tab", "Cmd+T")?;
    let quick_connect = item("quick-connect", "Quick Connect…", "Cmd+K")?;
    let close_tab = item("close-tab", "Close Tab", "Cmd+W")?;

    let shetu = SubmenuBuilder::new(app, "Shetu")
        .about_with_text("About Shetu", None)
        .separator()
        .item(&settings)
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
        .item(&new_tab)
        .item(&quick_connect)
        .separator()
        .item(&close_tab)
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
    app.manage(crate::menu_accelerators::MenuItems(vec![
        ("settings", settings),
        ("new-tab", new_tab),
        ("quick-connect", quick_connect),
        ("close-tab", close_tab),
    ]));
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
