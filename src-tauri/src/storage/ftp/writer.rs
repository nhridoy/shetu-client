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

use asyncband::pool::bounded;
use bytes::Buf;
use tokio::io::AsyncWrite;
use tokio::io::AsyncWriteExt;

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
        if conn.rename(&target, &backup).await.is_err() {
            let _ = conn.rm(tmp).await;
            self.backup = None;
            return Err(format_ftp_error(first));
        }
        if let Err(e) = conn.rename(tmp, &target).await {
            let _ = conn.rename(&backup, &target).await;
            let _ = conn.rm(tmp).await;
            self.backup = None;
            return Err(format_ftp_error(e));
        }
        let _ = conn.rm(&backup).await;
        self.backup = None;
        Ok(())
    }

    /// Ends a started upload that won't be published and deletes its temp file.
    async fn discard(&mut self) {
        self.done = true;
        self.abandoned().await;
    }

    fn abandoned(&mut self) -> impl std::future::Future<Output = ()> + Send + 'static {
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

/// Cleans up an upload that won't finish. A cut publish may have left its connection
/// mid-command, so it recovers on a fresh one: the old file goes back if the target is gone.
async fn abandon(
    core: Arc<FtpCore>,
    conn: Option<bounded::Object<Manager>>,
    data: Option<Box<dyn AsyncWrite + Sync + Send + Unpin + 'static>>,
    target: String,
    tmp: Option<String>,
    backup: Option<String>,
    publishing: bool,
) {
    if !publishing {
        if let Some(mut conn) = conn {
            cleanup(&mut conn, data, tmp).await;
        }
        return;
    }
    drop((conn, data));
    let Ok(mut conn) = core.ftp_connect(Operation::Write).await else {
        return;
    };
    if let Some(backup) = backup {
        if conn.size(&backup).await.is_ok() {
            if conn.size(&target).await.is_ok() {
                let _ = conn.rm(&backup).await;
            } else {
                let _ = conn.rename(&backup, &target).await;
            }
        }
    }
    if let Some(tmp) = tmp {
        let _ = conn.rm(&tmp).await;
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
            if let Err(e) = self.publish(&tmp).await {
                self.done = true;
                return Err(e);
            }
        }
        self.done = true;
        Ok(MetadataBuilder::unknown().build())
    }

    async fn abort(&mut self) -> Result<()> {
        self.discard().await;
        Ok(())
    }
}
