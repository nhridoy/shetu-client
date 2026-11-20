// Derived from Apache OpenDAL opendal-service-ftp 0.59.5 (Apache-2.0); changed by Shetu, see CHANGES.md
//! FTP and FTPS storage, used through an OpenDAL `Operator` like the S3 and WebDAV panes.

/// URI scheme the service reports.
pub const FTP_SCHEME: &str = "ftp";

/// Most connections one account opens at once: shared hosts often allow only a few per
/// address, and this leaves one free for browsing while the queue runs its 3 transfers.
pub const MAX_CONNECTIONS: usize = 4;

mod backend;
mod config;
mod core;
mod deleter;
mod lister;
mod listing;
mod reader;
mod writer;

#[cfg(test)]
pub(crate) mod fake;

pub use backend::FtpBuilder as Ftp;
pub use config::FtpConfig;
pub use core::forget_pools;

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

    fn with(fake: &FakeFtp, root: &str, key: &str) -> Operator {
        Operator::new(
            Ftp::default()
                .endpoint(&format!("ftp://127.0.0.1:{}", fake.port))
                .root(root)
                .user("me")
                .password("pw")
                .pool_key(key.to_string()),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn missing_root_is_an_error_not_created() {
        let fake = FakeFtp::start(FakeOpts::default()).await;
        let err = with(&fake, "/gone", "missing-root")
            .list("/")
            .await
            .unwrap_err();
        assert!(
            err.to_string().contains("doesn't exist on the server"),
            "{err}"
        );
        assert!(!fake.commands().iter().any(|c| c.starts_with("MKD")));
        assert!(fake.get("/gone").is_none());
    }

    #[tokio::test]
    async fn empty_root_stays_where_login_lands() {
        let fake = FakeFtp::start(FakeOpts::default()).await;
        fake.put("/a.txt", Node::File(b"abc".to_vec()));
        with(&fake, "", "empty-root").list("/").await.unwrap();
        let cmds = fake.commands();
        let listed = cmds
            .iter()
            .position(|c| c.starts_with("LIST") || c.starts_with("MLSD"))
            .unwrap();
        assert!(
            !cmds[..listed].iter().any(|c| c.starts_with("CWD")),
            "{cmds:?}"
        );
    }

    #[tokio::test]
    async fn pool_never_exceeds_the_cap() {
        let fake = FakeFtp::start(FakeOpts::default()).await;
        fake.put("/big.bin", Node::File(vec![7u8; 1 << 20]));
        let (a, b) = (with(&fake, "", "capped"), with(&fake, "", "capped"));
        let reads = (0..6).map(|i| {
            let op = if i % 2 == 0 { a.clone() } else { b.clone() };
            async move { op.read("big.bin").await.map(|buf| buf.len()) }
        });
        for got in futures::future::join_all(reads).await {
            assert_eq!(got.unwrap(), 1 << 20);
        }
        let peak = fake.peak.load(std::sync::atomic::Ordering::SeqCst);
        assert!(peak <= super::MAX_CONNECTIONS, "peak {peak}");
    }

    #[tokio::test]
    async fn ftps_uses_the_given_tls_config() {
        let (tls, der) = super::fake::self_signed_tls();
        let fake = FakeFtp::start(FakeOpts {
            tls: Some(tls),
            ..FakeOpts::default()
        })
        .await;
        fake.put("/a.txt", Node::File(b"abc".to_vec()));
        let op = |pin: Option<&str>, key: &str| {
            Operator::new(
                Ftp::default()
                    .endpoint(&format!("ftps://127.0.0.1:{}", fake.port))
                    .user("me")
                    .password("pw")
                    .tls(std::sync::Arc::new(
                        crate::storage::tls::client_config(pin).unwrap(),
                    ))
                    .pool_key(key.to_string()),
            )
            .unwrap()
        };
        let pin = crate::storage::tls::sha256_hex(&der);
        assert_eq!(op(Some(&pin), "pinned").list("/").await.unwrap().len(), 1);
        assert!(op(None, "unpinned").list("/").await.is_err());
    }

    async fn entries(op: &Operator, dir: &str) -> Vec<(String, u64)> {
        let mut seen: Vec<(String, u64)> = op
            .list(dir)
            .await
            .unwrap()
            .into_iter()
            .filter(|e| e.path() != dir)
            .map(|e| (e.path().to_string(), e.metadata().content_length()))
            .collect();
        seen.sort();
        seen
    }

    #[tokio::test]
    async fn dot_files_are_listed() {
        for mlsd in [true, false] {
            let fake = FakeFtp::start(FakeOpts {
                mlsd,
                ..FakeOpts::default()
            })
            .await;
            fake.put("/.htaccess", Node::File(b"deny".to_vec()));
            fake.put("/a.txt", Node::File(b"abc".to_vec()));
            assert_eq!(
                entries(&plain(&fake), "/").await,
                vec![(".htaccess".into(), 4), ("a.txt".into(), 3)],
                "mlsd {mlsd}"
            );
        }
    }

    #[tokio::test]
    async fn list_falls_back_to_plain_list() {
        let fake = FakeFtp::start(FakeOpts {
            mlsd: false,
            list_a: false,
            ..FakeOpts::default()
        })
        .await;
        fake.put("/a.txt", Node::File(b"abc".to_vec()));
        assert_eq!(entries(&plain(&fake), "/").await, vec![("a.txt".into(), 3)]);
    }

    #[tokio::test]
    async fn symlinks_resolve_to_file_or_folder() {
        for mlsd in [true, false] {
            let fake = FakeFtp::start(FakeOpts {
                mlsd,
                ..FakeOpts::default()
            })
            .await;
            fake.put("/a.txt", Node::File(b"abc".to_vec()));
            fake.put("/public_html", Node::Dir);
            fake.put("/www", Node::Link("/public_html".into()));
            fake.put("/latest", Node::Link("/a.txt".into()));
            let got = entries(&plain(&fake), "/").await;
            assert!(got.contains(&("www/".into(), 0)), "mlsd {mlsd}: {got:?}");
            assert!(got.contains(&("latest".into(), 3)), "mlsd {mlsd}: {got:?}");
        }
    }

    #[tokio::test]
    async fn mlsd_times_are_exact() {
        let fake = FakeFtp::start(FakeOpts::default()).await;
        fake.put("/a.txt", Node::File(b"abc".to_vec()));
        let meta = plain(&fake).stat("a.txt").await.unwrap();
        assert_eq!(
            meta.last_modified().unwrap().to_string(),
            "2024-01-02T03:04:05Z"
        );
    }

    fn leftovers(fake: &FakeFtp) -> Vec<String> {
        fake.names()
            .into_iter()
            .filter(|n| n.contains(".shetu-"))
            .collect()
    }

    #[tokio::test]
    async fn upload_goes_beside_the_target() {
        let fake = FakeFtp::start(FakeOpts::default()).await;
        fake.put("/site", Node::Dir);
        plain(&fake)
            .write("site/index.html", b"<h1>hi</h1>".to_vec())
            .await
            .unwrap();
        let cmds = fake.commands();
        let stor = cmds
            .iter()
            .position(|c| c.starts_with("STOR site/.index.html.shetu-"))
            .unwrap_or_else(|| panic!("{cmds:?}"));
        assert!(
            cmds[stor..].iter().any(|c| c == "RNTO site/index.html"),
            "{cmds:?}"
        );
        assert_eq!(
            fake.get("/site/index.html"),
            Some(Node::File(b"<h1>hi</h1>".to_vec()))
        );
        assert!(leftovers(&fake).is_empty(), "{:?}", fake.names());
    }

    #[tokio::test]
    async fn replace_deletes_then_renames() {
        let fake = FakeFtp::start(FakeOpts {
            refuse_rnto_over_existing: true,
            ..FakeOpts::default()
        })
        .await;
        fake.put("/site", Node::Dir);
        fake.put("/site/index.html", Node::File(b"old".to_vec()));
        plain(&fake)
            .write("site/index.html", b"new".to_vec())
            .await
            .unwrap();
        assert_eq!(
            fake.get("/site/index.html"),
            Some(Node::File(b"new".to_vec()))
        );
        assert!(leftovers(&fake).is_empty(), "{:?}", fake.names());
    }

    #[tokio::test]
    async fn an_empty_upload_creates_the_file() {
        let fake = FakeFtp::start(FakeOpts::default()).await;
        let op = plain(&fake);
        let mut w = op.writer("empty.txt").await.unwrap();
        w.close().await.unwrap();
        assert_eq!(fake.get("/empty.txt"), Some(Node::File(Vec::new())));
    }

    #[tokio::test]
    async fn an_aborted_upload_leaves_nothing() {
        let fake = FakeFtp::start(FakeOpts::default()).await;
        let op = plain(&fake);
        let mut w = op.writer("cut.bin").await.unwrap();
        w.write(vec![1u8; 65536]).await.unwrap();
        w.abort().await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert!(leftovers(&fake).is_empty(), "{:?}", fake.names());
        assert!(fake.get("/cut.bin").is_none());
    }

    #[tokio::test]
    async fn a_dropped_upload_leaves_nothing() {
        let fake = FakeFtp::start(FakeOpts::default()).await;
        let op = plain(&fake);
        let mut w = op.writer("cut.bin").await.unwrap();
        w.write(vec![1u8; 65536]).await.unwrap();
        drop(w);
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        assert!(fake.names().is_empty(), "{:?}", fake.names());
    }
}
