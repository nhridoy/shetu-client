// Derived from Apache OpenDAL opendal-service-ftp 0.59.5 (Apache-2.0); changed by Shetu, see CHANGES.md
// Licensed to the Apache Software Foundation (ASF) under one
// or more contributor license agreements.  See the NOTICE file
// distributed with this work for additional information
// regarding copyright ownership.  The ASF licenses this file
// to you under the Apache License, Version 2.0 (the
// "License"); you may not use this file except in compliance
// with the License.  You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied.  See the License for the
// specific language governing permissions and limitations
// under the License.

use std::sync::Arc;
use std::time::Duration;

use asyncband::pool::bounded;
use bytes::Buf;
use suppaftp::FtpError;

use super::listing::exists;
use tokio::io::AsyncWrite;
use tokio::io::AsyncWriteExt;
use tokio::time::timeout;

use super::core::format_ftp_error;
use super::core::FtpCore;
use super::core::Manager;
use opendal::raw::*;
use opendal::*;

pub struct FtpWriter {
    target_path: String,
    tmp_path: Option<String>,
    /// `None` once a drop handed it to the clean-up task.
    ftp_stream: Option<bounded::Object<Manager>>,
    data_stream: Option<Box<dyn AsyncWrite + Sync + Send + Unpin + 'static>>,
    /// Shetu: the upload was started on the server (its temp file may exist).
    started: bool,
    /// Shetu: closed or aborted; nothing left to clean up.
    done: bool,
    /// Shetu: for recovery on a fresh connection when a publish is cut short.
    core: Arc<FtpCore>,
    /// Shetu: publishing began (a cut here leaves the old connection mid-command).
    publishing: bool,
    /// Shetu: where the old target was (or is being) moved aside, until it's deleted.
    backup: Option<String>,
}

/// # Safety
///
/// We only have `&mut self` for FtpWrite.
unsafe impl Sync for FtpWriter {}

/// Shetu: the hidden temp name for an upload, in the target's own folder.
pub fn temp_beside(path: &str, tag: &str) -> String {
    let parent = get_parent(path);
    let parent = if parent == "/" { "" } else { parent };
    let id = uuid::Uuid::new_v4().simple().to_string();
    format!("{parent}.{}.shetu-{tag}{}", get_basename(path), &id[..8])
}

impl FtpWriter {
    pub fn new(
        core: Arc<FtpCore>,
        ftp_stream: bounded::Object<Manager>,
        target_path: String,
        tmp_path: Option<String>,
    ) -> Self {
        FtpWriter {
            target_path,
            tmp_path,
            ftp_stream: Some(ftp_stream),
            data_stream: None,
            started: false,
            done: false,
            core,
            publishing: false,
            backup: None,
        }
    }

    fn conn(&mut self) -> Result<&mut bounded::Object<Manager>> {
        self.ftp_stream
            .as_mut()
            .ok_or_else(|| Error::new(ErrorKind::Unexpected, "ftp writer is closed"))
    }

    /// Starts the transfer: `STOR` to the temp name, or `APPE` to the target for appends.
    async fn open(&mut self) -> Result<()> {
        let tmp = self.tmp_path.clone();
        let target = self.target_path.clone();
        let conn = self.conn()?;
        let stream: Box<dyn AsyncWrite + Sync + Send + Unpin + 'static> = match &tmp {
            Some(tmp) => Box::new(conn.put_with_stream(tmp).await.map_err(format_ftp_error)?),
            None => Box::new(
                conn.append_with_stream(&target)
                    .await
                    .map_err(format_ftp_error)?,
            ),
        };
        self.data_stream = Some(stream);
        self.started = true;
        Ok(())
    }

    /// Puts the finished temp file at the target. If the server won't rename onto an existing
    /// file, the old one is moved aside first and put back if anything fails.
    async fn publish(&mut self, tmp: &str) -> Result<()> {
        self.publishing = true;
        let target = self.target_path.clone();
        let Err(first) = self.conn()?.rename(tmp, &target).await else {
            return Ok(());
        };
        // Recorded before the move, so a cut mid-command can still put the old file back.
        let backup = temp_beside(&target, "old-");
        self.backup = Some(backup.clone());
        let conn = self.conn()?;
        match conn.rename(&target, &backup).await {
            Ok(()) => {}
            // Refused: the old file is still at the target.
            Err(FtpError::UnexpectedResponse(_)) => {
                let _ = conn.rm(tmp).await;
                self.backup = None;
                return Err(format_ftp_error(first));
            }
            // No answer: the move may have happened, so recovery reconciles it.
            Err(e) => return Err(format_ftp_error(e)),
        }
        if let Err(e) = conn.rename(tmp, &target).await {
            if conn.rename(&backup, &target).await.is_ok() {
                let _ = conn.rm(tmp).await;
                self.backup = None;
            }
            // Otherwise the backup stays recorded: abort or drop restore it.
            return Err(format_ftp_error(e));
        }
        let _ = conn.rm(&backup).await;
        self.backup = None;
        Ok(())
    }

    /// Ends a started upload that won't be published and deletes its temp file.
    async fn discard(&mut self) -> Result<()> {
        self.done = true;
        // Its own task owns the work, so cancelling this abort can't drop it halfway.
        match tokio::spawn(self.abandoned()).await {
            Ok(true) => Ok(()),
            _ => Err(Error::new(
                ErrorKind::Unexpected,
                "couldn't finish cleaning up the cut upload; a temporary file may remain",
            )
            .with_context("path", &self.target_path)),
        }
    }

    fn abandoned(&mut self) -> impl std::future::Future<Output = bool> + Send + 'static {
        abandon(
            self.core.clone(),
            self.ftp_stream.take(),
            self.data_stream.take(),
            self.target_path.clone(),
            self.tmp_path.clone().filter(|_| self.started),
            self.backup.take(),
            self.publishing,
        )
    }
}

/// How long one clean-up step may wait for the server.
const CLEANUP_LIMIT: Duration = if cfg!(test) {
    Duration::from_millis(300)
} else {
    Duration::from_secs(30)
};
/// Tries at recovering a cut publish, waiting `RETRY_BASE` × 2ⁿ between them.
const RECOVERY_TRIES: u32 = 5;
const RETRY_BASE: Duration = if cfg!(test) {
    Duration::from_millis(100)
} else {
    Duration::from_secs(1)
};

/// Cleans up an upload that won't finish. A cut publish may have left its connection
/// mid-command, so it recovers on fresh ones: the old file goes back if the target is gone.
async fn abandon(
    core: Arc<FtpCore>,
    conn: Option<bounded::Object<Manager>>,
    data: Option<Box<dyn AsyncWrite + Sync + Send + Unpin + 'static>>,
    target: String,
    tmp: Option<String>,
    backup: Option<String>,
    publishing: bool,
) -> bool {
    let mut conn = conn;
    if !publishing {
        let Some(mut c) = conn.take() else {
            return true;
        };
        match timeout(CLEANUP_LIMIT, cleanup(&mut c, data, tmp.clone())).await {
            Ok(()) => return true,
            // Still mid-command: never back to the pool. The server may have stored the temp
            // file anyway, so delete it on fresh connections below.
            Err(_) => drop(c.detach()),
        }
    } else {
        if let Some(c) = conn.take() {
            drop(c.detach());
        }
        drop(data);
    }
    for attempt in 0..RECOVERY_TRIES {
        if attempt > 0 {
            tokio::time::sleep(RETRY_BASE * 2u32.pow(attempt - 1)).await;
        }
        let Ok(mut conn) = core.ftp_connect(Operation::Write).await else {
            continue;
        };
        let step = recover(&core, &mut conn, &target, backup.as_deref(), tmp.as_deref());
        match timeout(CLEANUP_LIMIT, step).await {
            Ok(Ok(())) => return true,
            Ok(Err(_)) => {}
            Err(_) => drop(conn.detach()),
        }
    }
    log::warn!("ftp: couldn't finish cleaning up an upload to {target}");
    false
}

/// Puts the old file back if the target is missing (else drops the backup), and deletes the
/// temp file. It acts on the hidden names directly ("no such file" means already done) rather
/// than looking for them, since a plain `LIST` may hide them; the target is then checked. An
/// error means it couldn't be confirmed; the caller tries again.
async fn recover(
    core: &FtpCore,
    conn: &mut bounded::Object<Manager>,
    target: &str,
    backup: Option<&str>,
    tmp: Option<&str>,
) -> Result<()> {
    if let Some(backup) = backup {
        if exists(core, target).await? {
            done_or_missing(conn.rm(backup).await)?;
        } else {
            done_or_missing(conn.rename(backup, target).await)?;
            if !exists(core, target).await? {
                return Err(Error::new(
                    ErrorKind::Unexpected,
                    "couldn't put the old file back",
                ));
            }
        }
    }
    if let Some(tmp) = tmp {
        done_or_missing(conn.rm(tmp).await)?;
    }
    Ok(())
}

/// A command on a name that may already be gone: 550 counts as done.
fn done_or_missing(r: suppaftp::FtpResult<()>) -> Result<()> {
    match r {
        Ok(()) => Ok(()),
        Err(FtpError::UnexpectedResponse(resp))
            if resp.status == suppaftp::Status::FileUnavailable =>
        {
            Ok(())
        }
        Err(e) => Err(format_ftp_error(e)),
    }
}

/// Lets the server finish the cut transfer (so the temp file exists), then deletes it.
async fn cleanup(
    conn: &mut bounded::Object<Manager>,
    data: Option<Box<dyn AsyncWrite + Sync + Send + Unpin + 'static>>,
    tmp: Option<String>,
) {
    if let Some(data) = data {
        let _ = conn.finalize_put_stream(data).await;
    }
    if let Some(tmp) = tmp {
        let _ = conn.rm(&tmp).await;
    }
}

impl Drop for FtpWriter {
    fn drop(&mut self) {
        if self.done || !self.started || self.tmp_path.is_none() {
            return;
        }
        let abandoned = self.abandoned();
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            rt.spawn(abandoned);
        }
    }
}

impl oio::Write for FtpWriter {
    async fn write(&mut self, mut bs: Buffer) -> Result<()> {
        if self.data_stream.is_none() {
            self.open().await?;
        }

        while bs.has_remaining() {
            let n = self
                .data_stream
                .as_mut()
                .unwrap()
                .write(bs.chunk())
                .await
                .map_err(|err| {
                    Error::new(ErrorKind::Unexpected, "copy from ftp stream").set_source(err)
                })?;
            bs.advance(n);
        }

        Ok(())
    }

    async fn close(&mut self) -> Result<Metadata> {
        // Shetu: an upload with no bytes still creates the (empty) file.
        if !self.started {
            self.open().await?;
        }
        if let Some(mut data_stream) = self.data_stream.take() {
            data_stream.flush().await.map_err(|err| {
                Error::new(ErrorKind::Unexpected, "flush data stream failed").set_source(err)
            })?;
            self.conn()?
                .finalize_put_stream(data_stream)
                .await
                .map_err(format_ftp_error)?;
        }
        if let Some(tmp) = self.tmp_path.clone() {
            // A failed publish stays undone, so abort or drop recover what it left.
            self.publish(&tmp).await?;
        }
        self.done = true;
        Ok(MetadataBuilder::unknown().build())
    }

    async fn abort(&mut self) -> Result<()> {
        self.discard().await
    }
}
