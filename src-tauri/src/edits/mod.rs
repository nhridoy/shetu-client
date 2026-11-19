//! Edit a remote file in your own app: a temp copy is watched, and every save is uploaded back
//! through the transfer queue (asking first if the server copy changed).

pub mod files;
pub mod manager;
pub mod state;
pub mod watch;
