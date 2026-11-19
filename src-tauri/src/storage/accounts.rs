//! S3 storage accounts. Secrets stay in Rust: the form sees a view without the secret key.

use crate::db::{self, LocalDb, SyncRow, Table};
use crate::CryptoState;
use opendal::Operator;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

const RECORD: &str = "storage_accounts";
const TEXT_FIELDS: [&str; 7] = [
    "provider",
    "endpoint",
    "region",
    "bucket",
    "r2AccountId",
    "accessKeyId",
    "secretAccessKey",
];
const PROVIDERS: [&str; 6] = ["aws", "r2", "b2", "wasabi", "spaces", "custom"];

/// A saved account, decrypted. Only Rust ever holds this.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StorageAccountData {
    pub provider: String,
    pub endpoint: Option<String>,
    pub region: String,
    pub bucket: String,
    pub path_style: bool,
    pub r2_account_id: Option<String>,
    pub access_key_id: String,
    pub secret_access_key: String,
}

/// What the account form may see: everything but the secret key.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageAccountView {
    pub provider: String,
    pub endpoint: Option<String>,
    pub region: String,
    pub bucket: String,
    pub path_style: bool,
    pub r2_account_id: Option<String>,
    pub access_key_id: String,
    pub has_secret: bool,
}

/// Ciphertext of a storage account row (personal `aad` or team `record_type`).
pub fn is_storage_ciphertext(header: &Value) -> bool {
    use base64::Engine;
    let aad = base64::engine::general_purpose::STANDARD_NO_PAD.encode(RECORD);
    header["record_type"] == RECORD
        || header["aad"].as_str().map(|a| a.trim_end_matches('=')) == Some(aad.as_str())
}

fn non_empty(v: &Option<String>) -> Option<&str> {
    v.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// The S3 endpoint for a provider preset, or the custom one.
pub fn endpoint_for(d: &StorageAccountData) -> Result<String, String> {
    let region = || {
        Some(d.region.trim())
            .filter(|r| !r.is_empty())
            .ok_or_else(|| "Region is required".to_string())
    };
    Ok(match d.provider.as_str() {
        "aws" => format!("https://s3.{}.amazonaws.com", region()?),
        "r2" => format!(
            "https://{}.r2.cloudflarestorage.com",
            non_empty(&d.r2_account_id).ok_or("Cloudflare account ID is required")?
        ),
        "b2" => format!("https://s3.{}.backblazeb2.com", region()?),
        "wasabi" => format!("https://s3.{}.wasabisys.com", region()?),
        "spaces" => format!("https://{}.digitaloceanspaces.com", region()?),
        "custom" => non_empty(&d.endpoint)
            .ok_or("Endpoint is required")?
            .to_string(),
        other => return Err(format!("Unknown provider: {other}")),
    })
}

/// An operator for the account's bucket. Credentials come only from the account: no
/// environment, config files or instance metadata.
pub fn operator_for(d: &StorageAccountData) -> Result<Operator, String> {
    let region = match d.provider.as_str() {
        "r2" => "auto",
        _ if d.region.trim().is_empty() => "us-east-1",
        _ => d.region.trim(),
    };
    let mut builder = opendal::services::S3::default()
        .bucket(&d.bucket)
        .endpoint(&endpoint_for(d)?)
        .region(region)
        .access_key_id(&d.access_key_id)
        .secret_access_key(&d.secret_access_key)
        .disable_config_load()
        .disable_ec2_metadata();
    let virtual_host = match d.provider.as_str() {
        "aws" | "wasabi" | "spaces" => true,
        "custom" => !d.path_style,
        _ => false,
    };
    if virtual_host {
        builder = builder.enable_virtual_host_style();
    }
    Ok(Operator::new(builder)
        .map_err(|e| format!("Couldn't set up the bucket: {e}"))?
        .layer(opendal::layers::RetryLayer::new())
        .layer(opendal::layers::TimeoutLayer::new()))
}

fn live_payload(
    db: &LocalDb,
    crypto: &CryptoState,
    id: &str,
) -> Option<(SyncRow, Map<String, Value>)> {
    let row = db::get_sync_row(db, Table::StorageAccounts, id)
        .ok()
        .flatten()
        .filter(|r| r.deleted_at.is_none())?;
    let session = crypto.session.lock().ok()?;
    let plain =
        crate::team_keys::decrypt_row_secret(db, &session, &row.data, RECORD, &row.vault_id)
            .ok()?;
    let payload = serde_json::from_str::<Value>(&plain)
        .ok()?
        .as_object()?
        .clone();
    Some((row, payload))
}

fn parse(payload: &Map<String, Value>) -> Result<StorageAccountData, String> {
    serde_json::from_value(Value::Object(payload.clone())).map_err(|e| e.to_string())
}

/// The decrypted account, for Rust-side use (sessions, transfers).
pub fn load_account(
    db: &LocalDb,
    crypto: &CryptoState,
    id: &str,
) -> Result<StorageAccountData, String> {
    let (_, payload) =
        live_payload(db, crypto, id).ok_or_else(|| "storage account not found".to_string())?;
    parse(&payload)
}

pub fn view(db: &LocalDb, crypto: &CryptoState, id: &str) -> Option<StorageAccountView> {
    let d = load_account(db, crypto, id).ok()?;
    Some(StorageAccountView {
        has_secret: !d.secret_access_key.is_empty(),
        provider: d.provider,
        endpoint: d.endpoint,
        region: d.region,
        bucket: d.bucket,
        path_style: d.path_style,
        r2_account_id: d.r2_account_id,
        access_key_id: d.access_key_id,
    })
}

/// Applies a form patch: text fields keep on absent or `""`, clear on `null`, set on text;
/// `pathStyle` sets on a boolean.
fn apply_patch(payload: &mut Map<String, Value>, patch: &Value) {
    for key in TEXT_FIELDS {
        match patch.get(key) {
            Some(Value::Null) => {
                payload.remove(key);
            }
            Some(Value::String(v)) if !v.is_empty() => {
                payload.insert(key.into(), Value::String(v.clone()));
            }
            _ => {}
        }
    }
    if let Some(Value::Bool(b)) = patch.get("pathStyle") {
        payload.insert("pathStyle".into(), Value::Bool(*b));
    }
}

fn validate(d: &StorageAccountData) -> Result<(), String> {
    if !PROVIDERS.contains(&d.provider.as_str()) {
        return Err(format!("Unknown provider: {}", d.provider));
    }
    if d.bucket.trim().is_empty() {
        return Err("Bucket is required".into());
    }
    if d.access_key_id.trim().is_empty() {
        return Err("Access key is required".into());
    }
    if d.secret_access_key.is_empty() {
        return Err("Secret key is required".into());
    }
    endpoint_for(d).map(|_| ())
}

/// The stored account (if any) with the form's patch applied, for saving or testing.
fn merged(
    db: &LocalDb,
    crypto: &CryptoState,
    id: Option<&str>,
    patch: &Value,
) -> Result<(Option<SyncRow>, Map<String, Value>), String> {
    let (row, mut payload) = match id {
        Some(id) => {
            let (row, payload) = live_payload(db, crypto, id).ok_or("storage account not found")?;
            (Some(row), payload)
        }
        None => (None, Map::new()),
    };
    apply_patch(&mut payload, patch);
    Ok((row, payload))
}

/// Create (`id` None) or merge-update.
pub fn save(
    db: &LocalDb,
    crypto: &CryptoState,
    id: Option<&str>,
    vault_id: &str,
    name: &str,
    patch: &Value,
    device_id: &str,
) -> Result<SyncRow, String> {
    let (row, payload) = merged(db, crypto, id, patch)?;
    validate(&parse(&payload)?)?;
    let mut row = row.unwrap_or_else(|| SyncRow {
        id: uuid::Uuid::new_v4().to_string(),
        vault_id: vault_id.to_string(),
        ..Default::default()
    });
    row.name = Some(name.to_string());
    let session = crypto.session.lock().map_err(|e| e.to_string())?;
    row.data = crate::team_keys::encrypt_row_secret(
        db,
        &session,
        &Value::Object(payload).to_string(),
        RECORD,
        &row.vault_id,
    )?;
    drop(session);
    match id {
        // A sync deletion or edit since the read wins over this save.
        Some(_) => {
            let expected = row.operation_id.clone();
            db::local_mutate_if(db, Table::StorageAccounts, &row, device_id, &expected)
        }
        None => db::local_mutate(db, Table::StorageAccounts, &row, device_id),
    }
}

#[tauri::command]
pub fn storage_account_view(
    id: String,
    db: tauri::State<'_, LocalDb>,
    crypto: tauri::State<'_, CryptoState>,
) -> Option<StorageAccountView> {
    view(&db, &crypto, &id)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn storage_account_save(
    id: Option<String>,
    vault_id: String,
    name: String,
    patch: Value,
    device_id: String,
    db: tauri::State<'_, LocalDb>,
    crypto: tauri::State<'_, CryptoState>,
) -> Result<SyncRow, String> {
    save(
        &db,
        &crypto,
        id.as_deref(),
        &vault_id,
        &name,
        &patch,
        &device_id,
    )
}

/// "Test connection": the stored account with the form's changes, listing one entry.
#[tauri::command]
pub async fn storage_test(
    id: Option<String>,
    patch: Value,
    db: tauri::State<'_, LocalDb>,
    crypto: tauri::State<'_, CryptoState>,
) -> Result<String, String> {
    let (_, payload) = merged(&db, &crypto, id.as_deref(), &patch)?;
    let d = parse(&payload)?;
    validate(&d)?;
    let op = operator_for(&d)?;
    op.list_with("/")
        .limit(1)
        .await
        .map_err(|e| format!("Couldn't reach the bucket: {e}"))?;
    Ok(format!("Connected to {}", d.bucket))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{crypto, db, CryptoState};
    use serde_json::json;
    use std::sync::Mutex;

    const DEVICE: &str = "6f1c1b2e-6b7a-4c1e-9a65-1f2a3b4c5d6e";

    fn fixture() -> (db::LocalDb, CryptoState) {
        let mut keys = crypto::KeySession::new();
        crypto::generate_account_material(&mut keys).unwrap();
        (
            db::open(":memory:").unwrap(),
            CryptoState {
                session: Mutex::new(keys),
            },
        )
    }

    fn data(provider: &str) -> StorageAccountData {
        StorageAccountData {
            provider: provider.into(),
            region: "eu-central-1".into(),
            bucket: "backups".into(),
            r2_account_id: Some("abc123".into()),
            endpoint: Some("http://127.0.0.1:9000".into()),
            access_key_id: "AKIA".into(),
            secret_access_key: "s3cr3t".into(),
            ..Default::default()
        }
    }

    fn new_account() -> Value {
        json!({"provider": "aws", "region": "us-east-1", "bucket": "backups",
               "accessKeyId": "AKIA", "secretAccessKey": "s1"})
    }

    #[test]
    fn endpoint_for_presets() {
        let ep = |p: &str| endpoint_for(&data(p));
        assert_eq!(ep("aws").unwrap(), "https://s3.eu-central-1.amazonaws.com");
        assert_eq!(ep("r2").unwrap(), "https://abc123.r2.cloudflarestorage.com");
        assert_eq!(ep("b2").unwrap(), "https://s3.eu-central-1.backblazeb2.com");
        assert_eq!(
            ep("wasabi").unwrap(),
            "https://s3.eu-central-1.wasabisys.com"
        );
        assert_eq!(
            ep("spaces").unwrap(),
            "https://eu-central-1.digitaloceanspaces.com"
        );
        assert_eq!(ep("custom").unwrap(), "http://127.0.0.1:9000");
        let mut custom = data("custom");
        custom.endpoint = Some("  ".into());
        assert!(endpoint_for(&custom).is_err());
        let mut r2 = data("r2");
        r2.r2_account_id = None;
        assert!(endpoint_for(&r2).is_err());
        assert!(endpoint_for(&data("ftp")).is_err());
    }

    #[test]
    fn operator_for_builds_every_preset() {
        for p in ["aws", "r2", "b2", "wasabi", "spaces", "custom"] {
            let op = operator_for(&data(p)).unwrap_or_else(|e| panic!("{p}: {e}"));
            assert_eq!(op.info().name(), "backups", "{p}");
        }
    }

    #[test]
    fn save_then_view_hides_the_secret() {
        let (db, crypto) = fixture();
        let row = save(&db, &crypto, None, "v1", "Backups", &new_account(), DEVICE).unwrap();
        assert!(!row.data.contains("s1"));
        let v = view(&db, &crypto, &row.id).unwrap();
        assert!(v.has_secret);
        assert_eq!((v.provider.as_str(), v.bucket.as_str()), ("aws", "backups"));
        let text = serde_json::to_string(&v).unwrap();
        assert!(
            !text.contains("\"s1\"") && !text.contains("secretAccessKey"),
            "{text}"
        );
    }

    #[test]
    fn empty_secret_keeps_the_stored_one() {
        let (db, crypto) = fixture();
        let row = save(&db, &crypto, None, "v1", "Backups", &new_account(), DEVICE).unwrap();
        save(
            &db,
            &crypto,
            Some(&row.id),
            "v1",
            "Backups",
            &json!({"secretAccessKey": "", "bucket": "photos"}),
            DEVICE,
        )
        .unwrap();
        let d = load_account(&db, &crypto, &row.id).unwrap();
        assert_eq!(
            (d.secret_access_key.as_str(), d.bucket.as_str()),
            ("s1", "photos")
        );
    }

    #[test]
    fn save_requires_bucket_keys_and_a_valid_provider() {
        let (db, crypto) = fixture();
        let without = |k: &str| {
            let mut p = new_account();
            p.as_object_mut().unwrap().remove(k);
            save(&db, &crypto, None, "v1", "x", &p, DEVICE)
        };
        assert!(without("bucket").is_err());
        assert!(without("accessKeyId").is_err());
        assert!(without("secretAccessKey").is_err());
        let mut bad = new_account();
        bad["provider"] = json!("ftp");
        assert!(save(&db, &crypto, None, "v1", "x", &bad, DEVICE).is_err());
    }

    #[test]
    fn load_account_missing_is_plain() {
        let (db, crypto) = fixture();
        assert_eq!(
            load_account(&db, &crypto, "nope").unwrap_err(),
            "storage account not found"
        );
    }

    #[test]
    fn storage_ciphertext_is_recognised() {
        assert!(is_storage_ciphertext(
            &json!({"record_type": "storage_accounts"})
        ));
        assert!(!is_storage_ciphertext(&json!({"record_type": "hosts"})));
    }
}
