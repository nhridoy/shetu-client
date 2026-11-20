// Derived from Apache OpenDAL opendal-service-ftp 0.59.5 (Apache-2.0); changed by Shetu, see CHANGES.md
//! FTP and FTPS storage, used through an OpenDAL `Operator` like the S3 and WebDAV panes.

/// URI scheme the service reports.
pub const FTP_SCHEME: &str = "ftp";

/// Shown when an FTPS account's server refuses `AUTH TLS` (never retried as plain FTP).
pub const AUTH_TLS_REFUSED: &str =
    "This server doesn't support FTPS; choose FTP (unencrypted) if you trust the network.";

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

    #[tokio::test]
    async fn a_relative_root_starts_from_the_login_folder() {
        let fake = FakeFtp::start(FakeOpts {
            home: "/home/me".into(),
            ..FakeOpts::default()
        })
        .await;
        for dir in ["/home", "/home/me", "/home/me/public_html"] {
            fake.put(dir, Node::Dir);
        }
        fake.put("/home/me/public_html/a.txt", Node::File(b"abc".to_vec()));
        let op = with(&fake, "public_html", "relative-root");
        assert_eq!(entries(&op, "/").await, vec![("a.txt".into(), 3)]);
    }

    #[tokio::test]
    async fn a_pause_while_replacing_keeps_a_file_at_the_target() {
        let fake = FakeFtp::start(FakeOpts {
            refuse_rnto_over_existing: true,
            rnto_delay: Some(std::time::Duration::from_millis(150)),
            ..FakeOpts::default()
        })
        .await;
        fake.put("/site", Node::Dir);
        fake.put("/site/index.html", Node::File(b"old".to_vec()));
        let op = plain(&fake);
        let mut w = op.writer("site/index.html").await.unwrap();
        w.write(b"new".to_vec()).await.unwrap();
        // Cut the close after the old file was moved aside, before the new one is in.
        let cut = tokio::time::timeout(std::time::Duration::from_millis(250), w.close()).await;
        assert!(cut.is_err(), "the close should still be running");
        let _ = w.abort().await;
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        assert!(
            matches!(fake.get("/site/index.html"), Some(Node::File(_))),
            "{:?}",
            fake.names()
        );
        assert!(leftovers(&fake).is_empty(), "{:?}", fake.names());
    }

    #[tokio::test]
    async fn a_wrong_password_is_not_retried() {
        let fake = FakeFtp::start(FakeOpts::default()).await;
        let op = Operator::new(
            Ftp::default()
                .endpoint(&format!("ftp://127.0.0.1:{}", fake.port))
                .user("me")
                .password("nope"),
        )
        .unwrap();
        let err = op.list("/").await.unwrap_err();
        assert_eq!(err.kind(), opendal::ErrorKind::PermissionDenied, "{err}");
        assert!(matches!(
            crate::transfers::io::opendal_err("list", err),
            crate::transfers::model::JobError::Operation(_)
        ));
    }

    #[tokio::test]
    async fn refusing_to_delete_a_full_folder_is_an_error() {
        let fake = FakeFtp::start(FakeOpts::default()).await;
        fake.put("/full", Node::Dir);
        fake.put("/full/x", Node::File(b"x".to_vec()));
        assert!(plain(&fake).delete("full/").await.is_err());
        assert!(fake.get("/full").is_some());
    }

    #[tokio::test]
    async fn deleting_a_missing_file_is_fine() {
        let fake = FakeFtp::start(FakeOpts::default()).await;
        plain(&fake).delete("nope.txt").await.unwrap();
    }

    #[tokio::test]
    async fn mlsd_names_keep_semicolons() {
        let fake = FakeFtp::start(FakeOpts::default()).await;
        fake.put("/report;final.txt", Node::File(b"r".to_vec()));
        fake.put("/final.txt", Node::File(b"ff".to_vec()));
        assert_eq!(
            entries(&plain(&fake), "/").await,
            vec![("final.txt".into(), 2), ("report;final.txt".into(), 1)]
        );
    }

    #[tokio::test]
    async fn a_symlink_probe_that_loses_the_connection_is_an_error() {
        let fake = FakeFtp::start(FakeOpts {
            drop_on_size: true,
            ..FakeOpts::default()
        })
        .await;
        fake.put("/a.txt", Node::File(b"abc".to_vec()));
        fake.put("/latest", Node::Link("/a.txt".into()));
        assert!(plain(&fake).list("/").await.is_err());
    }

    #[tokio::test]
    async fn a_download_the_server_aborts_is_an_error() {
        let fake = FakeFtp::start(FakeOpts {
            retr_abort_after: Some(2),
            ..FakeOpts::default()
        })
        .await;
        fake.put("/a.bin", Node::File(b"abcdef".to_vec()));
        assert!(plain(&fake).read("a.bin").await.is_err());
    }

    /// Starts a replace of `/site/index.html` ("old") and cuts its close mid-publish.
    async fn cut_replace(opts: FakeOpts) -> (FakeFtp, opendal::Writer) {
        let fake = FakeFtp::start(FakeOpts {
            refuse_rnto_over_existing: true,
            rnto_delay: Some(std::time::Duration::from_millis(150)),
            ..opts
        })
        .await;
        fake.put("/site", Node::Dir);
        fake.put("/site/index.html", Node::File(b"old".to_vec()));
        let mut w = plain(&fake).writer("site/index.html").await.unwrap();
        w.write(b"new".to_vec()).await.unwrap();
        let cut = tokio::time::timeout(std::time::Duration::from_millis(250), w.close()).await;
        assert!(cut.is_err(), "the close should still be running");
        assert!(
            fake.names().iter().any(|n| n.contains(".shetu-old-")),
            "the cut must come after the old file was moved aside: {:?}",
            fake.names()
        );
        (fake, w)
    }

    fn target_kept(fake: &FakeFtp) {
        assert!(
            matches!(fake.get("/site/index.html"), Some(Node::File(_))),
            "{:?}",
            fake.names()
        );
        assert!(leftovers(fake).is_empty(), "{:?}", fake.names());
    }

    #[tokio::test]
    async fn a_failed_rollback_is_recovered_by_abort() {
        let fake = FakeFtp::start(FakeOpts {
            refuse_rnto_over_existing: true,
            fail_rnto: Some((
                "/site/index.html".into(),
                std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(3)),
            )),
            ..FakeOpts::default()
        })
        .await;
        fake.put("/site", Node::Dir);
        fake.put("/site/index.html", Node::File(b"old".to_vec()));
        let mut w = plain(&fake).writer("site/index.html").await.unwrap();
        w.write(b"new".to_vec()).await.unwrap();
        assert!(w.close().await.is_err());
        let _ = w.abort().await;
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        assert_eq!(
            fake.get("/site/index.html"),
            Some(Node::File(b"old".to_vec()))
        );
        assert!(leftovers(&fake).is_empty(), "{:?}", fake.names());
    }

    #[tokio::test]
    async fn a_cancelled_abort_still_recovers() {
        let (fake, mut w) = cut_replace(FakeOpts::default()).await;
        let cut = tokio::time::timeout(std::time::Duration::from_millis(1), w.abort()).await;
        assert!(cut.is_err(), "the abort should have been cut short");
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        target_kept(&fake);
    }

    #[tokio::test]
    async fn recovery_waits_out_a_server_that_is_briefly_down() {
        let (fake, mut w) = cut_replace(FakeOpts::default()).await;
        fake.down.store(true, std::sync::atomic::Ordering::SeqCst);
        let down = fake.down.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
            down.store(false, std::sync::atomic::Ordering::SeqCst);
        });
        let _ = w.abort().await;
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        target_kept(&fake);
    }

    #[tokio::test]
    async fn a_silent_server_doesnt_hold_connections_after_cancels() {
        let fake = FakeFtp::start(FakeOpts {
            silent_after_stor: true,
            ..FakeOpts::default()
        })
        .await;
        let op = plain(&fake);
        for i in 0..5 {
            let mut w = op.writer(&format!("f{i}.bin")).await.unwrap();
            w.write(vec![1u8; 1024]).await.unwrap();
            let aborted = tokio::time::timeout(std::time::Duration::from_secs(5), w.abort()).await;
            assert!(aborted.is_ok(), "abort {i} hung");
        }
        let listed = tokio::time::timeout(std::time::Duration::from_secs(5), op.list("/")).await;
        assert!(matches!(listed, Ok(Ok(_))), "{listed:?}");
        // The server stored each upload; clean-up still deletes them on fresh connections.
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        assert!(fake.names().is_empty(), "{:?}", fake.names());
    }

    #[tokio::test]
    async fn deleting_a_missing_file_is_fine_without_size() {
        let fake = FakeFtp::start(FakeOpts {
            no_size: true,
            ..FakeOpts::default()
        })
        .await;
        plain(&fake).delete("nope.txt").await.unwrap();
    }

    #[tokio::test]
    async fn recovery_finds_the_backup_without_size() {
        let (fake, mut w) = cut_replace(FakeOpts {
            no_size: true,
            ..FakeOpts::default()
        })
        .await;
        let _ = w.abort().await;
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        target_kept(&fake);
    }

    #[tokio::test]
    async fn a_lost_move_reply_keeps_the_backup_for_recovery() {
        let fake = FakeFtp::start(FakeOpts {
            refuse_rnto_over_existing: true,
            vanish_after_rnto: Some(".shetu-old-".into()),
            ..FakeOpts::default()
        })
        .await;
        fake.put("/site", Node::Dir);
        fake.put("/site/index.html", Node::File(b"old".to_vec()));
        let mut w = plain(&fake).writer("site/index.html").await.unwrap();
        w.write(b"new".to_vec()).await.unwrap();
        assert!(w.close().await.is_err());
        let _ = w.abort().await;
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        assert_eq!(
            fake.get("/site/index.html"),
            Some(Node::File(b"old".to_vec()))
        );
        assert!(leftovers(&fake).is_empty(), "{:?}", fake.names());
    }
}
