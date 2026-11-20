//! S3-compatible buckets: saved accounts, bucket operations and pane sessions.

pub mod accounts;
pub mod ops;
pub mod sessions;
pub mod tls;
pub mod webdav;

/// A storage side: its OpenDAL operator, and for WebDAV what a streaming upload needs.
#[derive(Clone, Debug)]
pub struct Remote {
    pub op: opendal::Operator,
    pub dav: Option<std::sync::Arc<webdav::DavTarget>>,
}
