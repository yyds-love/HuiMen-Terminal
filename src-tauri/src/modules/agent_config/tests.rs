use super::*;
use std::sync::{Arc, Barrier};
use tempfile::tempdir;

fn entries(dir: &Path) -> Vec<std::ffi::OsString> {
    let mut names = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();
    names.sort();
    names
}

fn request(tool: &str) -> AgentProviderConfigRequest {
    serde_json::from_value(serde_json::json!({
        "tool": tool,
        "providerId": "official",
        "model": "test-model"
    }))
    .unwrap()
}

#[test]
fn first_save_creates_parent_and_preserves_exact_utf8() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("nested/settings.json");
    write_text_atomic(&path, "配置\nsecond line\n").unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "配置\nsecond line\n");
    assert_eq!(
        entries(path.parent().unwrap()),
        vec![path.file_name().unwrap().to_os_string()]
    );
}

#[test]
fn overwrite_has_no_stale_suffix_or_temporary_files() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("config.toml");
    fs::write(&path, "long original configuration").unwrap();
    write_text_atomic(&path, "short\n").unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "short\n");
    assert_eq!(
        entries(dir.path()),
        vec![path.file_name().unwrap().to_os_string()]
    );
}

#[test]
fn save_does_not_touch_a_preexisting_pid_temporary_path() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let old_tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    fs::write(&old_tmp, "belongs to another operation").unwrap();
    write_text_atomic(&path, "replacement").unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "replacement");
    assert_eq!(
        fs::read_to_string(&old_tmp).unwrap(),
        "belongs to another operation"
    );
}

#[test]
fn failed_save_to_a_directory_does_not_leave_credential_temps() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("settings.json");
    fs::create_dir(&path).unwrap();
    fs::write(path.join("sentinel"), "keep").unwrap();
    assert!(write_text_atomic(&path, "synthetic secret").is_err());
    assert_eq!(fs::read_to_string(path.join("sentinel")).unwrap(), "keep");
    assert_eq!(
        entries(dir.path()),
        vec![path.file_name().unwrap().to_os_string()]
    );
}

#[test]
fn concurrent_claude_applies_keep_complete_settings() {
    let dir = tempdir().unwrap();
    let path = claude_settings_path(dir.path());
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, r#"{"theme":"dark","env":{"LOCAL_FLAG":"keep"}}"#).unwrap();
    let start = Arc::new(Barrier::new(8));
    let threads = (0..8)
        .map(|index| {
            let home = dir.path().to_path_buf();
            let start = start.clone();
            std::thread::spawn(move || {
                let mut input = request("claude");
                input.provider_id = "custom".to_string();
                input.base_url = Some("https://provider.invalid/v1".to_string());
                input.model = Some(format!("model-{index}"));
                input.api_key = Some(format!("synthetic-{index}"));
                start.wait();
                // Exercise the production entry point, which serializes the
                // entire read/modify/write operation on all platforms.
                apply_claude_provider_config(&home, input)
            })
        })
        .collect::<Vec<_>>();
    for thread in threads {
        thread.join().unwrap().unwrap();
    }
    let saved = read_json_or_empty_object(&path).unwrap();
    let model = saved["env"]["ANTHROPIC_MODEL"].as_str().unwrap();
    let index = model
        .strip_prefix("model-")
        .unwrap()
        .parse::<usize>()
        .unwrap();
    assert!(index < 8);
    assert_eq!(
        saved["env"]["ANTHROPIC_AUTH_TOKEN"],
        format!("synthetic-{index}")
    );
    assert_eq!(saved["theme"], "dark");
    assert_eq!(saved["env"]["LOCAL_FLAG"], "keep");
    assert_eq!(
        entries(path.parent().unwrap()),
        vec![path.file_name().unwrap().to_os_string()]
    );
}

#[test]
fn claude_apply_preserves_unmanaged_settings_and_env() {
    let dir = tempdir().unwrap();
    let path = claude_settings_path(dir.path());
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        r#"{"theme":"dark","env":{"LOCAL_FLAG":"keep","ANTHROPIC_AUTH_TOKEN":"synthetic-old"}}"#,
    )
    .unwrap();
    let mut input = request("claude");
    input.provider_id = "deepseek".to_string();
    input.api_key = Some("synthetic-new".to_string());
    apply_claude_provider_config(dir.path(), input).unwrap();
    let saved = read_json_or_empty_object(&path).unwrap();
    assert_eq!(saved["theme"], "dark");
    assert_eq!(saved["env"]["LOCAL_FLAG"], "keep");
    assert_eq!(saved["env"]["ANTHROPIC_AUTH_TOKEN"], "synthetic-new");
    assert_eq!(saved["env"]["ANTHROPIC_MODEL"], "test-model");
}

#[test]
fn codex_apply_preserves_unmanaged_toml_and_auth() {
    let dir = tempdir().unwrap();
    let config = codex_config_path(dir.path());
    let auth = codex_auth_path(dir.path());
    fs::create_dir_all(config.parent().unwrap()).unwrap();
    fs::write(
        &config,
        "model = \"old\"\n[projects.\"/repo\"]\ntrust_level = \"trusted\"\n",
    )
    .unwrap();
    fs::write(
        &auth,
        r#"{"OPENAI_API_KEY":"synthetic-old","unrelated":"keep"}"#,
    )
    .unwrap();
    let mut input = request("codex");
    input.provider_id = "custom".to_string();
    input.base_url = Some("https://provider.invalid/v1".to_string());
    input.api_key = Some("synthetic-new".to_string());
    apply_codex_provider_config(dir.path(), input).unwrap();
    let saved = fs::read_to_string(&config).unwrap();
    assert!(saved.contains("trust_level = \"trusted\""));
    assert!(saved.contains("synthetic-new"));
    let saved_auth = read_json_or_empty_object(&auth).unwrap();
    assert_eq!(saved_auth["unrelated"], "keep");
    assert_eq!(saved_auth["OPENAI_API_KEY"], "synthetic-new");
}

#[test]
fn named_custom_providers_keep_stored_model_and_credentials_for_both_tools() {
    for tool in ["claude", "codex"] {
        let dir = tempdir().unwrap();
        let provider: AgentCustomProvider = serde_json::from_value(serde_json::json!({
            "id": "local",
            "name": "Synthetic provider",
            "baseUrl": "https://provider.invalid/v1",
            "apiKey": "synthetic-stored-key",
            "model": "stored-model"
        }))
        .unwrap();
        write_custom_provider_store(
            dir.path(),
            tool,
            &AgentCustomProviderStore {
                providers: vec![provider],
            },
        )
        .unwrap();
        let mut input = request(tool);
        input.provider_id = "custom:local".to_string();
        input.model = None;
        let result = if tool == "claude" {
            apply_claude_provider_config(dir.path(), input)
        } else {
            apply_codex_provider_config(dir.path(), input)
        }
        .unwrap();
        assert_eq!(result.provider_id, "custom:local");
        if tool == "claude" {
            let saved = read_json_or_empty_object(&claude_settings_path(dir.path())).unwrap();
            assert_eq!(saved["env"]["ANTHROPIC_MODEL"], "stored-model");
            assert_eq!(saved["env"]["ANTHROPIC_AUTH_TOKEN"], "synthetic-stored-key");
        } else {
            let config = fs::read_to_string(codex_config_path(dir.path())).unwrap();
            assert_eq!(
                extract_top_level_toml_string(&config, "model").as_deref(),
                Some("stored-model")
            );
            assert!(config.contains("synthetic-stored-key"));
            let auth = read_json_or_empty_object(&codex_auth_path(dir.path())).unwrap();
            assert_eq!(auth["OPENAI_API_KEY"], "synthetic-stored-key");
        }
    }
}

#[test]
fn codex_auth_failure_does_not_change_config() {
    let dir = tempdir().unwrap();
    let config = codex_config_path(dir.path());
    let auth = codex_auth_path(dir.path());
    fs::create_dir_all(config.parent().unwrap()).unwrap();
    fs::write(&config, "model = \"original\"\n").unwrap();
    fs::write(&auth, "{}\n").unwrap();
    let original_permissions = fs::metadata(&auth).unwrap().permissions();
    let mut read_only = original_permissions.clone();
    read_only.set_readonly(true);
    fs::set_permissions(&auth, read_only).unwrap();
    let mut input = request("codex");
    input.auth_config = Some(r#"{"OPENAI_API_KEY":"synthetic"}"#.to_string());
    let result = apply_codex_provider_config(dir.path(), input);
    fs::set_permissions(&auth, original_permissions).unwrap();
    assert!(result.is_err());
    assert_eq!(
        fs::read_to_string(&config).unwrap(),
        "model = \"original\"\n"
    );
    assert_eq!(fs::read_to_string(&auth).unwrap(), "{}\n");
    assert_eq!(
        entries(config.parent().unwrap()),
        vec![
            auth.file_name().unwrap().to_os_string(),
            config.file_name().unwrap().to_os_string()
        ]
    );
}

#[test]
fn invalid_auth_json_does_not_modify_either_file() {
    let dir = tempdir().unwrap();
    let config = codex_config_path(dir.path());
    let auth = codex_auth_path(dir.path());
    fs::create_dir_all(config.parent().unwrap()).unwrap();
    fs::write(&config, "model = \"original\"\n").unwrap();
    fs::write(&auth, "{}\n").unwrap();
    let mut input = request("codex");
    input.auth_config = Some("not json".to_string());
    assert!(apply_codex_provider_config(dir.path(), input).is_err());
    assert_eq!(
        fs::read_to_string(config).unwrap(),
        "model = \"original\"\n"
    );
    assert_eq!(fs::read_to_string(auth).unwrap(), "{}\n");
}

#[test]
fn unreadable_codex_source_is_not_replaced_with_empty_configuration() {
    let dir = tempdir().unwrap();
    let config = codex_config_path(dir.path());
    fs::create_dir_all(config.parent().unwrap()).unwrap();
    let invalid_utf8 = [0xff, 0xfe, 0xfd];
    fs::write(&config, invalid_utf8).unwrap();
    assert!(apply_codex_provider_config(dir.path(), request("codex")).is_err());
    assert_eq!(fs::read(config).unwrap(), invalid_utf8);
}

#[test]
fn concurrent_codex_applies_keep_model_and_authentication_together() {
    let dir = tempdir().unwrap();
    let config = codex_config_path(dir.path());
    let auth = codex_auth_path(dir.path());
    let start = Arc::new(Barrier::new(6));
    let threads = (0..6)
        .map(|index| {
            let home = dir.path().to_path_buf();
            let start = start.clone();
            std::thread::spawn(move || {
                let mut input = request("codex");
                input.provider_id = "custom".to_string();
                input.base_url = Some("https://provider.invalid/v1".to_string());
                input.model = Some(format!("model-{index}"));
                input.api_key = Some(format!("synthetic-{index}"));
                start.wait();
                apply_codex_provider_config(&home, input)
            })
        })
        .collect::<Vec<_>>();
    for thread in threads {
        thread.join().unwrap().unwrap();
    }
    let saved = fs::read_to_string(&config).unwrap();
    let model = extract_top_level_toml_string(&saved, "model").unwrap();
    let index = model.strip_prefix("model-").unwrap();
    let key = format!("synthetic-{index}");
    assert!(saved.contains(&key));
    assert_eq!(
        read_json_or_empty_object(&auth).unwrap()["OPENAI_API_KEY"],
        key
    );
    assert_eq!(
        entries(config.parent().unwrap()),
        vec![
            auth.file_name().unwrap().to_os_string(),
            config.file_name().unwrap().to_os_string()
        ]
    );
}

#[cfg(windows)]
#[test]
fn windows_locked_target_keeps_old_content_and_cleans_temps() {
    use std::os::windows::fs::OpenOptionsExt;
    let dir = tempdir().unwrap();
    let path = dir.path().join("auth.json");
    fs::write(&path, "original").unwrap();
    let locked = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(&path)
        .unwrap();
    assert!(write_text_atomic(&path, "replacement").is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "original");
    assert_eq!(
        entries(dir.path()),
        vec![path.file_name().unwrap().to_os_string()]
    );
    drop(locked);
}

#[cfg(unix)]
#[test]
fn unix_config_files_are_user_only() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempdir().unwrap();
    let path = dir.path().join("auth.json");
    write_text_atomic(&path, "synthetic").unwrap();
    assert_eq!(
        fs::metadata(path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[cfg(windows)]
#[test]
fn windows_auth_lock_failure_rolls_back_codex_config() {
    use std::os::windows::fs::OpenOptionsExt;
    let dir = tempdir().unwrap();
    let config = codex_config_path(dir.path());
    let auth = codex_auth_path(dir.path());
    fs::create_dir_all(config.parent().unwrap()).unwrap();
    fs::write(&config, "model = \"original\"\n").unwrap();
    fs::write(&auth, "{}\n").unwrap();
    let locked = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(&auth)
        .unwrap();
    let mut input = request("codex");
    input.auth_config = Some(r#"{"OPENAI_API_KEY":"synthetic"}"#.to_string());
    let error = apply_codex_provider_config(dir.path(), input).unwrap_err();
    assert!(error.starts_with(&format!("Failed to replace {}:", auth.display())));
    assert!(error.contains("rolled back"));
    assert_eq!(
        fs::read_to_string(&config).unwrap(),
        "model = \"original\"\n"
    );
    assert_eq!(fs::read_to_string(&auth).unwrap(), "{}\n");
    assert_eq!(
        entries(config.parent().unwrap()),
        vec![
            auth.file_name().unwrap().to_os_string(),
            config.file_name().unwrap().to_os_string()
        ]
    );
    drop(locked);
}
