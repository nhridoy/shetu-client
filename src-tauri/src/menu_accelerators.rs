//! Lets the frontend change the macOS menu bar's accelerators to the user's shortcut
//! bindings. Compiled everywhere; without a menu (Linux/Windows) the command does nothing.

use std::collections::HashMap;

use tauri::menu::MenuItem;
use tauri::{AppHandle, Manager, Wry};

/// The menu bar's custom items, registered by `menu::install` on macOS.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct MenuItems(pub Vec<(&'static str, MenuItem<Wry>)>);

/// Menu items whose accelerators follow user bindings. Must match MENU_ACTION_IDS in
/// src/lib/window/menuActions.ts.
pub const MENU_ITEM_IDS: [&str; 4] = ["settings", "new-tab", "quick-connect", "close-tab"];

/// Keeps only known item ids, in MENU_ITEM_IDS order.
pub fn accelerator_updates(
    input: &HashMap<String, Option<String>>,
) -> Vec<(&'static str, Option<String>)> {
    MENU_ITEM_IDS
        .iter()
        .filter_map(|id| input.get(*id).map(|accel| (*id, accel.clone())))
        .collect()
}

/// Sets each listed item's accelerator; `None` removes it. Unknown ids are ignored.
#[tauri::command]
pub fn set_menu_accelerators(
    app: AppHandle,
    accelerators: HashMap<String, Option<String>>,
) -> Result<(), String> {
    let Some(items) = app.try_state::<MenuItems>() else {
        return Ok(());
    };
    for (id, accel) in accelerator_updates(&accelerators) {
        if let Some((_, item)) = items.0.iter().find(|(item_id, _)| *item_id == id) {
            item.set_accelerator(accel.as_deref())
                .map_err(|e| format!("{id}: {e}"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accelerator_updates_keep_only_known_items() {
        let input = HashMap::from([
            ("new-tab".to_string(), Some("Cmd+T".to_string())),
            ("settings".to_string(), None),
            ("bogus".to_string(), Some("X".to_string())),
        ]);
        assert_eq!(
            accelerator_updates(&input),
            vec![("settings", None), ("new-tab", Some("Cmd+T".to_string()))]
        );
    }
}
