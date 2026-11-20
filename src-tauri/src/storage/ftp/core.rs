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

use asyncband::pool::{bounded, ManageObject, ObjectStatus};
use suppaftp::tokio::AsyncRustlsConnector;
use suppaftp::tokio::AsyncRustlsFtpStream;
use suppaftp::tokio::ImplAsyncFtpStream;
use suppaftp::tokio_rustls::rustls::ClientConfig;
use suppaftp::tokio_rustls::TlsConnector;
use suppaftp::types::FileType;
use suppaftp::types::Response;
use suppaftp::FtpError;
use suppaftp::Status;

use opendal::raw::*;
use opendal::*;

type Pools = std::collections::HashMap<String, Arc<bounded::Pool<Manager>>>;

/// Shetu: pools shared by key, so every operator for one account stays under the cap.
static POOLS: std::sync::LazyLock<std::sync::Mutex<Pools>> =
    std::sync::LazyLock::new(Default::default);

fn shared_pool(key: Option<&str>, manager: Manager) -> Arc<bounded::Pool<Manager>> {
    let new =
        |manager| bounded::Pool::new(bounded::PoolConfig::new(super::MAX_CONNECTIONS), manager);
    let Some(key) = key else {
        return new(manager);
    };
    let Ok(mut pools) = POOLS.lock() else {
        return new(manager);
    };
    pools
        .entry(key.to_string())
        .or_insert_with(|| new(manager))
        .clone()
}

/// Shetu: drops every shared pool (sign-out); pooled connections close as they're released.
pub fn forget_pools() {
    if let Ok(mut pools) = POOLS.lock() {
        pools.clear();
    }
}

pub struct FtpCore {
    info: ServiceInfo,
    capability: Capability,
    pool: Arc<bounded::Pool<Manager>>,
    /// Shetu: whether the server lists with MLSD (learned once, from FEAT).
    pub mlsd: std::sync::OnceLock<bool>,
}

impl FtpCore {
    pub fn new(
        info: ServiceInfo,
        capability: Capability,
        manager: Manager,
        pool_key: Option<&str>,
    ) -> Self {
        let pool = shared_pool(pool_key, manager);
        Self {
            info,
            capability,
            pool,
            mlsd: std::sync::OnceLock::new(),
        }
    }

    pub fn info(&self) -> ServiceInfo {
        self.info.clone()
    }

    pub fn capability(&self) -> Capability {
        self.capability
    }

    pub async fn ftp_connect(&self, _: Operation) -> Result<bounded::Object<Manager>> {
        let fut = self.pool.get();

        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(10)) => {
                Err(Error::new(ErrorKind::Unexpected, "connection request: timeout").set_temporary())
            }
            result = fut => match result {
                Ok(conn) => Ok(conn),
                Err(err) => Err(format_ftp_error(err)),
            }
        }
    }
}

#[derive(Clone)]
pub struct Manager {
    pub endpoint: String,
    pub host: String,
    /// Shetu: `None` = stay where the login lands.
    pub root: Option<String>,
    pub user: String,
    pub password: String,
    pub enable_secure: bool,
    /// Shetu: the injected TLS setup (no platform-certificate loading here).
    pub tls: Option<Arc<ClientConfig>>,
}

impl ManageObject for Manager {
    type Object = AsyncRustlsFtpStream;
    type Error = FtpError;

    async fn create(&self) -> Result<Self::Object, Self::Error> {
        let stream = ImplAsyncFtpStream::connect(&self.endpoint).await?;
        // switch to secure mode if ssl/tls is on.
        let mut ftp_stream = if self.enable_secure {
            let cfg = self
                .tls
                .clone()
                .ok_or_else(|| FtpError::SecureError("FTPS needs a TLS config".to_string()))?;
            stream
                .into_secure(
                    AsyncRustlsConnector::from(TlsConnector::from(cfg)),
                    &self.host,
                )
                .await?
        } else {
            stream
        };

        // login if needed
        if !self.user.is_empty() {
            ftp_stream.login(&self.user, &self.password).await?;
        }

        // Shetu: change to the root path, never creating it.
        if let Some(root) = &self.root {
            match ftp_stream.cwd(root).await {
                Err(FtpError::UnexpectedResponse(e)) if e.status == Status::FileUnavailable => {
                    let shown = match root.trim_end_matches('/') {
                        "" => "/",
                        r => r,
                    };
                    return Err(FtpError::UnexpectedResponse(Response::new(
                        Status::FileUnavailable,
                        format!("{shown} doesn't exist on the server").into_bytes(),
                    )));
                }
                Err(e) => return Err(e),
                Ok(_) => (),
            }
        }

        ftp_stream.transfer_type(FileType::Binary).await?;

        Ok(ftp_stream)
    }

    async fn is_recyclable(
        &self,
        o: &mut Self::Object,
        _: &ObjectStatus,
    ) -> Result<(), Self::Error> {
        o.noop().await
    }
}

mod err {
    use suppaftp::FtpError;
    use suppaftp::Status;

    use opendal::Error;
    use opendal::ErrorKind;

    pub(crate) fn format_ftp_error(err: FtpError) -> Error {
        let (kind, retryable) = match err {
            // Allow retry for error
            //
            // `{ status: NotAvailable, body: "421 There are too many connections from your internet address." }`
            FtpError::UnexpectedResponse(ref resp) if resp.status == Status::NotAvailable => {
                (ErrorKind::Unexpected, true)
            }
            FtpError::UnexpectedResponse(ref resp) if resp.status == Status::FileUnavailable => {
                (ErrorKind::NotFound, false)
            }
            // Allow retry bad response.
            FtpError::BadResponse => (ErrorKind::Unexpected, true),
            _ => (ErrorKind::Unexpected, false),
        };

        let mut err = Error::new(kind, "ftp error").set_source(err);

        if retryable {
            err = err.set_temporary();
        }

        err
    }
}

pub(super) use err::*;
