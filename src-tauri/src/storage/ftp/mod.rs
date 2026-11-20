// Derived from Apache OpenDAL opendal-service-ftp 0.59.5 (Apache-2.0); changed by Shetu, see CHANGES.md
//! FTP and FTPS storage, used through an OpenDAL `Operator` like the S3 and WebDAV panes.

/// URI scheme the service reports.
pub const FTP_SCHEME: &str = "ftp";

mod backend;
mod config;
mod core;
mod deleter;
mod lister;
mod reader;
mod writer;

#[cfg(test)]
pub(crate) mod fake;

pub use backend::FtpBuilder as Ftp;
pub use config::FtpConfig;

#[cfg(test)]
mod tests {
    use super::fake::{FakeFtp, FakeOpts, Node};
    use super::Ftp;
    use opendal::Operator;

    pub(crate) fn plain(fake: &FakeFtp) -> Operator {
        Operator::new(
            Ftp::default()
                .endpoint(&format!("ftp://127.0.0.1:{}", fake.port))
                .user("me")
                .password("pw"),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn upstream_service_lists_a_fake_server() {
        let fake = FakeFtp::start(FakeOpts::default()).await;
        fake.put("/a.txt", Node::File(b"abc".to_vec()));
        fake.put("/docs", Node::Dir);
        let mut seen: Vec<(String, u64)> = plain(&fake)
            .list("/")
            .await
            .unwrap()
            .into_iter()
            .filter(|e| e.path() != "/")
            .map(|e| (e.path().to_string(), e.metadata().content_length()))
            .collect();
        seen.sort();
        assert_eq!(seen, vec![("a.txt".into(), 3), ("docs/".into(), 0)]);
    }
}
