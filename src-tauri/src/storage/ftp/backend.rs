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

use std::fmt::Debug;
use std::sync::Arc;

use http::Uri;
use log::debug;
use suppaftp::tokio_rustls::rustls::ClientConfig;
use suppaftp::types::Response;
use suppaftp::FtpError;
use suppaftp::Status;

use super::config::FtpConfig;
use super::core::format_ftp_error;
use super::core::FtpCore;
use super::core::Manager;
use super::deleter::FtpDeleter;
use super::reader::*;
use super::FTP_SCHEME;
use opendal::raw::*;
use opendal::*;

/// FTP and FTPS services support.
#[derive(Debug, Default)]
pub struct FtpBuilder {
    pub(super) config: FtpConfig,
    /// Shetu: the TLS setup FTPS uses (required for `ftps://`).
    pub(super) tls: Option<Arc<ClientConfig>>,
    /// Shetu: operators with the same key share one capped connection pool.
    pub(super) pool_key: Option<String>,
}

impl FtpBuilder {
    /// Shetu: the TLS client config for FTPS (its verifier decides which certificates pass).
    pub fn tls(mut self, config: Arc<ClientConfig>) -> Self {
        self.tls = Some(config);
        self
    }

    /// Shetu: share the connection pool with every operator built with the same key.
    pub fn pool_key(mut self, key: String) -> Self {
        self.pool_key = Some(key);
        self
    }

    /// set endpoint for ftp backend.
    pub fn endpoint(mut self, endpoint: &str) -> Self {
        self.config.endpoint = if endpoint.is_empty() {
            None
        } else {
            Some(endpoint.to_string())
        };

        self
    }

    /// set root path for ftp backend.
    pub fn root(mut self, root: &str) -> Self {
        self.config.root = if root.is_empty() {
            None
        } else {
            Some(root.to_string())
        };

        self
    }

    /// set user for ftp backend.
    pub fn user(mut self, user: &str) -> Self {
        self.config.user = if user.is_empty() {
            None
        } else {
            Some(user.to_string())
        };

        self
    }

    /// set password for ftp backend.
    pub fn password(mut self, password: &str) -> Self {
        self.config.password = if password.is_empty() {
            None
        } else {
            Some(password.to_string())
        };

        self
    }
}

impl Builder for FtpBuilder {
    type Config = FtpConfig;

    fn build(self) -> Result<impl Service> {
        debug!("ftp backend build started: {:?}", self);
        let endpoint = match &self.config.endpoint {
            None => return Err(Error::new(ErrorKind::ConfigInvalid, "endpoint is empty")),
            Some(v) => v,
        };

        let endpoint_uri = match endpoint.parse::<Uri>() {
            Err(e) => {
                return Err(Error::new(ErrorKind::ConfigInvalid, "endpoint is invalid")
                    .with_context("endpoint", endpoint)
                    .set_source(e));
            }
            Ok(uri) => uri,
        };

        let host = endpoint_uri.host().unwrap_or("127.0.0.1");
        let port = endpoint_uri.port_u16().unwrap_or(21);

        let endpoint = format!("{host}:{port}");

        let enable_secure = match endpoint_uri.scheme_str() {
            Some("ftp") => false,
            // if the user forgot to add a scheme prefix
            // treat it as using secured scheme
            Some("ftps") | None => true,

            Some(s) => {
                return Err(Error::new(
                    ErrorKind::ConfigInvalid,
                    "endpoint is unsupported or invalid",
                )
                .with_context("endpoint", s));
            }
        };

        if enable_secure && self.tls.is_none() {
            return Err(Error::new(
                ErrorKind::ConfigInvalid,
                "FTPS needs a TLS config",
            ));
        }

        // Shetu: an empty root means "where the login lands" (no CWD at all); a relative one
        // starts from there too, so it's sent as typed.
        let typed = self.config.root.as_deref().filter(|r| !r.is_empty());
        let cwd = typed.map(|r| match r.trim_end_matches('/') {
            "" => "/".to_string(),
            r => r.to_string(),
        });
        let root = typed.map(normalize_root).unwrap_or_else(|| "/".to_string());

        let user = match &self.config.user {
            None => "".to_string(),
            Some(v) => v.clone(),
        };

        let password = match &self.config.password {
            None => "".to_string(),
            Some(v) => v.clone(),
        };

        let info = ServiceInfo::new(FTP_SCHEME, &root, "");
        let capability = Capability {
            stat: true,

            read: true,

            write: true,
            write_can_multi: true,
            write_can_append: true,

            delete: true,
            create_dir: true,

            list: true,

            // Shetu: RNFR/RNTO, for files and folders.
            rename: true,

            shared: true,

            ..Default::default()
        };

        let manager = Manager {
            endpoint: endpoint.clone(),
            host: host.to_string(),
            root: cwd,
            user: user.clone(),
            password: password.clone(),
            enable_secure,
            tls: self.tls.clone(),
        };

        let core = Arc::new(FtpCore::new(
            info,
            capability,
            manager.clone(),
            self.pool_key.as_deref(),
        ));
        Ok(FtpBackend { core })
    }
}

#[derive(Clone)]
pub struct FtpBackend {
    pub(crate) core: Arc<FtpCore>,
}

impl Debug for FtpBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FtpBackend").finish()
    }
}

impl Service for FtpBackend {
    type Reader = oio::StreamReader<FtpReader>;
    type Writer = FtpLazyWriter;
    type Lister = FtpLazyLister;
    type Deleter = oio::OneShotDeleter<FtpDeleter>;
    type Copier = ();
    type Composer = ();

    fn info(&self) -> ServiceInfo {
        self.core.info()
    }

    fn capability(&self) -> Capability {
        self.core.capability()
    }

    async fn create_dir(
        &self,
        _ctx: &OperationContext,
        path: &str,
        _: OpCreateDir,
    ) -> Result<RpCreateDir> {
        let mut ftp_stream = self.core.ftp_connect(Operation::CreateDir).await?;

        let paths: Vec<&str> = path.split_inclusive('/').collect();

        let mut curr_path = String::new();

        for path in paths {
            curr_path.push_str(path);
            match ftp_stream.mkdir(&curr_path).await {
                // Do nothing if status is FileUnavailable or OK(()) is return.
                Err(FtpError::UnexpectedResponse(Response {
                    status: Status::FileUnavailable,
                    ..
                }))
                | Ok(()) => (),
                Err(e) => {
                    return Err(format_ftp_error(e));
                }
            }
        }

        Ok(RpCreateDir::default())
    }

    async fn stat(&self, _ctx: &OperationContext, path: &str, _: OpStat) -> Result<RpStat> {
        let file = self.ftp_stat(path).await?;
        let mut meta = if file.dir {
            MetadataBuilder::dir()
        } else {
            MetadataBuilder::file(file.size)
        };
        meta.last_modified(Timestamp::try_from(file.modified)?);

        Ok(RpStat::new(meta.build()))
    }
    fn read(&self, _ctx: &OperationContext, path: &str, args: OpRead) -> Result<Self::Reader> {
        let output: oio::StreamReader<FtpReader> = {
            Ok(oio::StreamReader::new(FtpReader::new(
                self.clone(),
                path,
                args,
            )))
        }?;

        Ok(output)
    }

    fn write(&self, _ctx: &OperationContext, path: &str, op: OpWrite) -> Result<Self::Writer> {
        Ok(FtpLazyWriter::new(self.core.clone(), path, op))
    }

    fn delete(&self, _ctx: &OperationContext) -> Result<Self::Deleter> {
        let output: oio::OneShotDeleter<FtpDeleter> =
            { Ok(oio::OneShotDeleter::new(FtpDeleter::new(self.core.clone()))) }?;

        Ok(output)
    }

    fn list(&self, _ctx: &OperationContext, path: &str, _: OpList) -> Result<Self::Lister> {
        Ok(FtpLazyLister::new(self.core.clone(), path))
    }

    fn copy(
        &self,
        _ctx: &OperationContext,
        _from: &str,
        _to: &str,
        _args: OpCopy,
    ) -> Result<Self::Copier> {
        Err(Error::new(
            ErrorKind::Unsupported,
            "operation is not supported",
        ))
    }

    async fn rename(
        &self,
        _ctx: &OperationContext,
        from: &str,
        to: &str,
        _args: OpRename,
    ) -> Result<RpRename> {
        let mut conn = self.core.ftp_connect(Operation::Rename).await?;
        conn.rename(from, to).await.map_err(format_ftp_error)?;
        Ok(RpRename::default())
    }

    async fn presign(
        &self,
        _ctx: &OperationContext,
        _path: &str,
        _args: OpPresign,
    ) -> Result<RpPresign> {
        Err(Error::new(
            ErrorKind::Unsupported,
            "operation is not supported",
        ))
    }
}

impl FtpBackend {
    /// Shetu: stats through the same listing as `list` (dot-files, symlinks, MLSD times).
    pub async fn ftp_stat(&self, path: &str) -> Result<super::listing::Entry> {
        let (parent, basename) = (get_parent(path), get_basename(path));
        let name = basename.trim_end_matches('/');
        super::listing::list_dir(&self.core, parent)
            .await?
            .into_iter()
            .find(|f| f.name == name)
            .ok_or_else(|| Error::new(ErrorKind::NotFound, "file is not found during list"))
    }
}

#[cfg(test)]
mod build_test {
    use super::super::config::FtpConfig;
    use super::FtpBuilder;
    use opendal::*;

    #[test]
    fn test_build() {
        // Shetu: ftps needs a TLS config, so it doesn't build without one.
        let b = FtpBuilder::default()
            .endpoint("ftps://ftp_server.local")
            .build();
        assert!(b.is_err());

        // ftp scheme
        let b = FtpBuilder::default()
            .endpoint("ftp://ftp_server.local:1234")
            .build();
        assert!(b.is_ok());

        // no scheme means ftps, which needs a TLS config
        let b = FtpBuilder::default()
            .endpoint("ftp_server.local:8765")
            .build();
        assert!(b.is_err());

        // invalid scheme
        let b = FtpBuilder::default()
            .endpoint("invalidscheme://ftp_server.local:8765")
            .build();
        assert!(b.is_err());
        let e = b.unwrap_err();
        assert_eq!(e.kind(), ErrorKind::ConfigInvalid);
    }

    #[test]
    fn from_uri_sets_endpoint_and_root() {
        let uri = OperatorUri::new(
            "ftp://example.com/public/data",
            Vec::<(String, String)>::new(),
        )
        .unwrap();

        let cfg = FtpConfig::from_uri(&uri).unwrap();
        assert_eq!(cfg.endpoint.as_deref(), Some("ftp://example.com"));
        assert_eq!(cfg.root.as_deref(), Some("public/data"));
    }

    #[test]
    fn from_uri_applies_credentials_from_query() {
        let uri = OperatorUri::new(
            "ftp://example.com/data",
            vec![
                ("user".to_string(), "alice".to_string()),
                ("password".to_string(), "secret".to_string()),
            ],
        )
        .unwrap();

        let cfg = FtpConfig::from_uri(&uri).unwrap();
        assert_eq!(cfg.endpoint.as_deref(), Some("ftp://example.com"));
        assert_eq!(cfg.user.as_deref(), Some("alice"));
        assert_eq!(cfg.password.as_deref(), Some("secret"));
    }
}
