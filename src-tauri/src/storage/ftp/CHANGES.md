# Changes from upstream

Copied from Apache OpenDAL `opendal-service-ftp` 0.59.5 (Apache-2.0, see `LICENSE-APACHE`).
Every change Shetu made to these files is listed here.

- `opendal_core::` paths read `opendal::` (the facade re-exports the same API); the scheme
  registration function and the crate docs include were dropped.
