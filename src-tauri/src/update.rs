fn classify_update_installation(debug: bool, linux: bool, appimage: bool) -> &'static str {
    if debug {
        "development"
    } else if !linux {
        "native"
    } else if appimage {
        "appimage"
    } else {
        "package"
    }
}

#[tauri::command]
pub fn update_installation_kind() -> &'static str {
    classify_update_installation(
        cfg!(debug_assertions),
        cfg!(target_os = "linux"),
        std::env::var_os("APPIMAGE").is_some_and(|value| !value.is_empty()),
    )
}

#[cfg(test)]
mod tests {
    use super::classify_update_installation;

    #[test]
    fn distinguishes_debug_appimage_package_and_native_installs() {
        assert_eq!(classify_update_installation(true, true, true), "development");
        assert_eq!(classify_update_installation(false, true, true), "appimage");
        assert_eq!(classify_update_installation(false, true, false), "package");
        assert_eq!(classify_update_installation(false, false, false), "native");
    }
}
