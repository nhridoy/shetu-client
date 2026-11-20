# Changes from upstream

Copied from Apache OpenDAL `opendal-service-ftp` 0.59.5 (Apache-2.0, see `LICENSE-APACHE`).
Every change Shetu made to these files is listed here.

- `opendal_core::` paths read `opendal::` (the facade re-exports the same API); the scheme
  registration function and the crate docs include were dropped.
- The FTPS TLS setup is injected (`FtpBuilder::tls`, Shetu's verifier with a pin); upstream's
  platform-certificate loading (`rustls-native-certs`, with an `expect`) is gone. `ftps://` without
  a TLS config fails to build.
- An empty root means "where the login lands" (no `CWD`); a root that can't be entered is an error
  ("<folder> doesn't exist on the server") and is never created (upstream sent `MKD`).
- Connection pools are capped at `MAX_CONNECTIONS` (4, upstream 64) and shared by `pool_key`
  across operators; `forget_pools` drops them.
- Listing and stat go through `listing.rs` (new): `MLSD` when `FEAT` advertises it (exact times),
  else `LIST -a` (dot-files), else `LIST`; `.`/`..` are skipped; MLSD's `type=OS.unix=slink:` is
  read as a link; each symlink is resolved once with `SIZE` (a size = file, otherwise folder).
