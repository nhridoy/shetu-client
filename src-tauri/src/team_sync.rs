use crate::db::{self, LocalDb};
use crate::http::{HttpClient, HttpErrorKind};
use crate::{crypto::KeySession, team_keys};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const OPERATION_LIMIT: usize = 50;
const MAX_PAGES: usize = 100;
const ROTATION_PAGE_SIZE: usize = 100;

#[derive(Default)]
pub struct TeamSyncLocks(
    tokio::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>>,
);

impl TeamSyncLocks {
    pub async fn for_account(&self, account_id: &str) -> std::sync::Arc<tokio::sync::Mutex<()>> {
        let mut map = self.0.lock().await;
        map.entry(account_id.to_owned())
            .or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSyncSummary {
    pub acknowledged: usize,
    pub rejected: usize,
    pub pages: usize,
    pub rotated_vault_ids: Vec<String>,
}

#[derive(Serialize)]
struct TeamSyncRequest {
    cursor: Option<String>,
    known_vault_epochs: Vec<KnownEpoch>,
    operations: Vec<Operation>,
}
#[derive(Clone, Serialize)]
struct KnownEpoch {
    vault_id: String,
    key_epoch: u32,
}
#[derive(Serialize)]
struct Operation {
    operation_id: String,
    #[serde(rename = "type")]
    operation_type: String,
    payload: Value,
}

#[derive(Deserialize)]
struct EnvelopeResponse {
    data: TeamSyncResponse,
}
#[derive(Deserialize)]
struct TeamSyncResponse {
    #[serde(default)]
    results: Vec<OperationResult>,
    #[serde(default)]
    snapshot: TeamSnapshot,
    #[serde(default)]
    envelopes: Vec<KeyEnvelopeWire>,
    next_cursor: Option<String>,
    #[serde(default)]
    has_more: bool,
}
#[derive(Default, Deserialize)]
pub(crate) struct TeamSnapshot {
    #[serde(default)]
    pub(crate) teams: Vec<TeamWire>,
    #[serde(default)]
    pub(crate) members: Vec<MemberWire>,
    #[serde(default)]
    pub(crate) invites: Vec<InviteWire>,
    #[serde(default)]
    pub(crate) vaults: Vec<VaultWire>,
    #[serde(default)]
    pub(crate) revoked_team_ids: Vec<String>,
    #[serde(default)]
    pub(crate) deleted_vault_ids: Vec<String>,
}
#[derive(Deserialize)]
pub(crate) struct TeamWire {
    pub(crate) id: String,
    pub(crate) owner_id: String,
    pub(crate) name: String,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}
#[derive(Deserialize)]
pub(crate) struct MemberWire {
    pub(crate) id: String,
    pub(crate) team_id: String,
    pub(crate) user_id: String,
    pub(crate) email: String,
    pub(crate) full_name: String,
    pub(crate) role: String,
    pub(crate) created_at: String,
    #[serde(default)]
    pub(crate) public_key: String,
    #[serde(default)]
    pub(crate) fingerprint: String,
}
#[derive(Deserialize)]
pub(crate) struct InviteWire {
    pub(crate) id: String,
    pub(crate) team_id: String,
    pub(crate) recipient_email: String,
    pub(crate) role: String,
    pub(crate) state: String,
    pub(crate) created_at: String,
    #[serde(default)]
    pub(crate) expires_at: String,
}
#[derive(Deserialize)]
pub(crate) struct VaultWire {
    pub(crate) id: String,
    pub(crate) team_id: String,
    pub(crate) owner_id: String,
    pub(crate) name: String,
    pub(crate) key_epoch: u32,
    pub(crate) revision: u32,
    pub(crate) rotation_state: String,
}
#[derive(Deserialize)]
pub(crate) struct KeyEnvelopeWire {
    pub(crate) vault_id: String,
    pub(crate) team_id: String,
    pub(crate) epoch: u32,
    pub(crate) recipient_user_id: String,
    pub(crate) recipient_fingerprint: String,
    pub(crate) version: u8,
    pub(crate) ephemeral_public_key: String,
    pub(crate) nonce: String,
    pub(crate) ciphertext: String,
}
#[derive(Clone, Deserialize)]
struct OperationResult {
    operation_id: String,
    status: String,
    error_code: Option<String>,
    error_message: Option<String>,
}

pub async fn run_team_sync(
    account_id: &str,
    db: &LocalDb,
    session: &std::sync::Mutex<KeySession>,
    http: &HttpClient,
) -> Result<TeamSyncSummary, HttpErrorKind> {
    if uuid::Uuid::parse_str(account_id).is_err() {
        return Err(local_error("invalid team sync account ID"));
    }
    const EPOCH_LIMIT: usize = 100;
    let epochs = known_vault_epochs(db, account_id).map_err(local_error)?;
    let mut chunks: Vec<Vec<KnownEpoch>> = epochs
        .chunks(EPOCH_LIMIT)
        .map(|chunk| chunk.to_vec())
        .collect();
    if chunks.is_empty() {
        chunks.push(Vec::new());
    }
    let saved_cursor = db::team_sync_cursor(db, account_id).map_err(local_error)?;
    let mut summary = TeamSyncSummary {
        acknowledged: 0,
        rejected: 0,
        pages: 0,
        rotated_vault_ids: Vec::new(),
    };
    let mut operation_results = Vec::new();
    let mut rotation_results: Vec<(String, Option<String>)> = Vec::new();
    let queued_operations = if saved_cursor.is_none() {
        db::pending_team_operations(db, account_id, OPERATION_LIMIT).map_err(local_error)?
    } else {
        Vec::new()
    };
    let rotations = queued_operations
        .iter()
        .filter(|item| item.operation_type == "vault.rotate")
        .cloned()
        .collect::<Vec<_>>();
    for (chunk_index, epochs) in chunks.drain(..).enumerate() {
        let mut cursor = if chunk_index == 0 {
            saved_cursor.clone()
        } else {
            None
        };
        let mut operations = if chunk_index == 0 && cursor.is_none() {
            queued_operations
                .clone()
                .into_iter()
                .filter(|item| item.operation_type != "vault.rotate")
                .map(|item| Operation {
                    operation_id: item.operation_id,
                    operation_type: item.operation_type,
                    payload: serde_json::from_str(&item.payload).unwrap_or(Value::Null),
                })
                .collect()
        } else {
            Vec::new()
        };
        let mut completed_chunk = false;
        for _ in 0..MAX_PAGES {
            let body = serde_json::to_value(TeamSyncRequest {
                cursor: cursor.clone(),
                known_vault_epochs: epochs.clone(),
                operations: std::mem::take(&mut operations),
            })
            .map_err(|_| local_error("could not encode team sync request"))?;
            let response = http
                .request("POST", "/api/v1/teams/sync", Some(body), true)
                .await?;
            let parsed: EnvelopeResponse = serde_json::from_str(&response.body)
                .map_err(|_| local_error("invalid team sync response"))?;
            let next_cursor = if parsed.data.has_more {
                let next = parsed
                    .data
                    .next_cursor
                    .as_deref()
                    .ok_or_else(|| local_error("team sync cursor missing"))?;
                if cursor.as_deref() == Some(next) {
                    return Err(local_error("team sync cursor did not advance"));
                }
                Some(next.to_owned())
            } else {
                None
            };
            {
                let session = session.lock().map_err(|e| local_error(e.to_string()))?;
                db::apply_team_sync_page(
                    db,
                    account_id,
                    &parsed.data.snapshot,
                    &parsed.data.envelopes,
                    &session,
                    next_cursor.as_deref(),
                    chunk_index == 0,
                )
                .map_err(local_error)?;
            }
            operation_results.extend(parsed.data.results.iter().cloned());
            summary.acknowledged += parsed
                .data
                .results
                .iter()
                .filter(|item| item.status == "accepted")
                .count();
            summary.rejected += parsed
                .data
                .results
                .iter()
                .filter(|item| item.status == "rejected")
                .count();
            summary.pages += 1;
            if !parsed.data.has_more {
                completed_chunk = true;
                break;
            }
            cursor = next_cursor;
        }
        if !completed_chunk {
            return Err(local_error(
                "team sync page limit reached; retry to continue",
            ));
        }
    }
    for result in operation_results {
        let error = if result.status == "rejected" {
            Some(format!(
                "{}: {}",
                result.error_code.as_deref().unwrap_or("REJECTED"),
                result
                    .error_message
                    .as_deref()
                    .unwrap_or("server rejected the change")
            ))
        } else {
            None
        };
        db::acknowledge_team_operation(db, account_id, &result.operation_id, error.as_deref())
            .map_err(local_error)?;
    }
    for rotation in rotations {
        match process_queued_rotation(account_id, db, session, http, &rotation).await {
            Ok(()) => {
                let value: Value = serde_json::from_str(&rotation.payload)
                    .map_err(|_| local_error("invalid queued rotation payload"))?;
                if let Some(vault_id) = value.get("vault_id").and_then(Value::as_str) {
                    summary.rotated_vault_ids.push(vault_id.to_owned());
                }
                rotation_results.push((rotation.operation_id, None));
                summary.acknowledged += 1;
            }
            Err(HttpErrorKind::Http(status, message)) if (400..500).contains(&status) => {
                rotation_results.push((
                    rotation.operation_id,
                    Some(format!("rotation-server-error-{status}: {message}")),
                ));
                summary.rejected += 1;
            }
            Err(error) => return Err(error),
        }
    }
    for (operation_id, error) in rotation_results {
        db::acknowledge_team_operation(db, account_id, &operation_id, error.as_deref())
            .map_err(local_error)?;
    }
    Ok(summary)
}

#[derive(Deserialize)]
struct RotationSnapshotEnvelope {
    data: RotationSnapshotWire,
}
#[derive(Deserialize)]
struct RotationSnapshotWire {
    vault_id: String,
    team_id: String,
    epoch: u32,
    revision: u32,
    #[serde(default)]
    rows: Vec<team_keys::RotationRow>,
    #[serde(default)]
    next: String,
    #[serde(default)]
    has_more: bool,
}

async fn process_queued_rotation(
    account_id: &str,
    db: &LocalDb,
    session: &std::sync::Mutex<KeySession>,
    http: &HttpClient,
    operation: &db::TeamOutboxOperation,
) -> Result<(), HttpErrorKind> {
    let mut payload: Value = serde_json::from_str(&operation.payload)
        .map_err(|_| local_error("invalid queued rotation payload"))?;
    let team_id = payload
        .get("team_id")
        .and_then(Value::as_str)
        .ok_or_else(|| local_error("rotation has no team ID"))?
        .to_owned();
    let vault_id = payload
        .get("vault_id")
        .and_then(Value::as_str)
        .ok_or_else(|| local_error("rotation has no vault ID"))?
        .to_owned();

    if payload.get("prepared").is_none() {
        let vaults = db::list_team_vaults(db, account_id, &team_id).map_err(local_error)?;
        let vault = vaults
            .iter()
            .find(|vault| vault.id == vault_id)
            .ok_or_else(|| rotation_http_error(404, "team vault is not available locally"))?;
        if !matches!(
            vault.rotation_state.as_str(),
            "rotation_required" | "rotation_pending"
        ) {
            return Err(rotation_http_error(
                409,
                "shared vault no longer requires rotation",
            ));
        }
        let mut rows = Vec::new();
        let mut after = String::new();
        let mut snapshot_complete = false;
        for _ in 0..MAX_PAGES {
            let path = format!(
                "/api/v1/vaults/{}/rotation/snapshot?after={}",
                vault_id, after
            );
            let response = http.request("GET", &path, None, true).await?;
            let page: RotationSnapshotEnvelope = serde_json::from_str(&response.body)
                .map_err(|_| local_error("invalid rotation snapshot response"))?;
            if page.data.vault_id != vault_id
                || page.data.team_id != team_id
                || page.data.epoch != vault.key_epoch
                || page.data.revision != vault.revision
            {
                return Err(rotation_http_error(
                    409,
                    "shared vault changed; refresh and retry rotation",
                ));
            }
            rows.extend(page.data.rows);
            if !page.data.has_more {
                snapshot_complete = true;
                break;
            }
            if page.data.next.is_empty() || page.data.next == after {
                return Err(rotation_http_error(
                    409,
                    "rotation snapshot cursor did not advance",
                ));
            }
            after = page.data.next;
        }
        if !snapshot_complete {
            return Err(local_error(
                "rotation snapshot page limit reached; retry to continue",
            ));
        }
        let members = db::list_team_members(db, account_id, &team_id).map_err(local_error)?;
        let recipients = members
            .into_iter()
            .map(|member| team_keys::RecipientKey {
                user_id: member.user_id,
                public_key: member.public_key,
                fingerprint: member.fingerprint,
            })
            .collect();
        let mut prepared = {
            let session = session.lock().map_err(|e| local_error(e.to_string()))?;
            team_keys::prepare_rotation(
                db,
                &session,
                &team_id,
                &vault_id,
                vault.key_epoch,
                vault.revision,
                rows,
                recipients,
            )
            .map_err(local_error)?
        };
        prepared.operation_id = operation.operation_id.clone();
        payload["prepared"] = serde_json::to_value(prepared)
            .map_err(|_| local_error("could not persist prepared rotation"))?;
        let encoded = serde_json::to_string(&payload)
            .map_err(|_| local_error("could not persist prepared rotation"))?;
        db::update_team_operation_payload(db, account_id, &operation.operation_id, &encoded)
            .map_err(local_error)?;
    }

    let prepared: team_keys::PreparedRotation = serde_json::from_value(
        payload
            .get("prepared")
            .cloned()
            .ok_or_else(|| local_error("prepared rotation is missing"))?,
    )
    .map_err(|_| local_error("prepared rotation is invalid"))?;
    let envelopes = prepared
        .envelopes
        .iter()
        .map(|envelope| {
            json!({
                "vault_id": envelope.context.vault_id,
                "team_id": envelope.context.team_id,
                "epoch": envelope.context.epoch,
                "recipient_user_id": envelope.context.recipient_user_id,
                "recipient_fingerprint": envelope.context.recipient_fingerprint,
                "version": envelope.version,
                "ephemeral_public_key": envelope.ephemeral_public_key,
                "nonce": envelope.nonce,
                "ciphertext": envelope.ciphertext,
            })
        })
        .collect::<Vec<_>>();
    let mut stage_error = None;
    for offset in (0..prepared.rows.len().max(1)).step_by(ROTATION_PAGE_SIZE) {
        let body = json!({
            "operation_id": prepared.operation_id,
            "expected_epoch": prepared.expected_epoch,
            "expected_revision": prepared.expected_revision,
            "rows": prepared.rows.iter().skip(offset).take(ROTATION_PAGE_SIZE).collect::<Vec<_>>(),
            "envelopes": envelopes,
        });
        if let Err(error) = http
            .request(
                "POST",
                &format!("/api/v1/vaults/{vault_id}/rotation/stage"),
                Some(body),
                true,
            )
            .await
        {
            stage_error = Some(error);
            break;
        }
    }
    let own_envelope = prepared
        .envelopes
        .iter()
        .find(|envelope| envelope.context.recipient_user_id == account_id)
        .ok_or_else(|| local_error("rotation did not include this device's key grant"))?;
    {
        let session = session.lock().map_err(|e| local_error(e.to_string()))?;
        team_keys::import_team_grant(db, &session, account_id, own_envelope)
            .map_err(local_error)?;
    }
    let commit = http
        .request(
            "POST",
            &format!("/api/v1/vaults/{vault_id}/rotation/commit"),
            Some(json!({ "operation_id": prepared.operation_id })),
            true,
        )
        .await;
    match commit {
        Ok(_) => {
            let current = db::list_team_vaults(db, account_id, &team_id)
                .map_err(local_error)?
                .into_iter()
                .find(|vault| vault.id == vault_id)
                .ok_or_else(|| local_error("rotated team vault is missing locally"))?;
            let new_epoch = prepared
                .expected_epoch
                .checked_add(1)
                .ok_or_else(|| local_error("team key epoch overflow"))?;
            db::import_team_vault_metadata(
                db,
                &vault_id,
                &team_id,
                &current.owner_id,
                &current.name,
                new_epoch,
                "ready",
            )
            .map_err(local_error)?;
            db::update_team_vault_revision(
                db,
                &vault_id,
                prepared.expected_revision.saturating_add(1),
            )
            .map_err(local_error)?;
            Ok(())
        }
        Err(commit_error) => Err(stage_error.unwrap_or(commit_error)),
    }
}

fn known_vault_epochs(db: &LocalDb, account_id: &str) -> Result<Vec<KnownEpoch>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT tv.vault_id,tv.epoch FROM team_vaults tv JOIN team_records tr ON tr.id=tv.team_id JOIN team_vault_keys tk ON tk.vault_id=tv.vault_id AND tk.epoch=tv.epoch WHERE tr.account_id=?1 AND tv.rotation_state <> 'revoked' ORDER BY tv.vault_id").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([account_id], |row| {
            Ok(KnownEpoch {
                vault_id: row.get(0)?,
                key_epoch: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

fn local_error(message: impl Into<String>) -> HttpErrorKind {
    HttpErrorKind::Http(0, message.into())
}

fn rotation_http_error(status: u16, message: impl Into<String>) -> HttpErrorKind {
    HttpErrorKind::Http(status, message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_server_team_sync_snapshot_contract() {
        let response: EnvelopeResponse = serde_json::from_value(json!({ "data": { "results": [], "snapshot": {"teams": [], "members": [], "invites": [], "vaults": [], "revoked_team_ids": []}, "envelopes": [], "next_cursor": null, "has_more": false } })).unwrap();
        assert!(!response.data.has_more);
    }
}
