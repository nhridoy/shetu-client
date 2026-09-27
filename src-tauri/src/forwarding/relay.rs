use russh::{Channel, ChannelMsg};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_util::sync::CancellationToken;

/// Copy both directions independently so a half-close still lets the peer drain.
pub async fn bridge(
    stream: TcpStream,
    channel: Channel<russh::client::Msg>,
    stop: CancellationToken,
) -> Result<(), String> {
    let (mut tcp_read, mut tcp_write) = stream.into_split();
    let (mut ssh_read, ssh_write) = channel.split();
    let to_ssh = async {
        let mut buffer = [0u8; 16 * 1024];
        loop {
            let count = tcp_read
                .read(&mut buffer)
                .await
                .map_err(|e| e.to_string())?;
            if count == 0 {
                ssh_write.eof().await.map_err(|e| e.to_string())?;
                return Ok::<(), String>(());
            }
            ssh_write
                .data_bytes(buffer[..count].to_vec())
                .await
                .map_err(|e| e.to_string())?;
        }
    };
    let to_tcp = async {
        while let Some(message) = ssh_read.wait().await {
            match message {
                ChannelMsg::Data { data } => tcp_write
                    .write_all(&data)
                    .await
                    .map_err(|e| e.to_string())?,
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
        tcp_write.shutdown().await.map_err(|e| e.to_string())
    };
    tokio::select! {
        _ = stop.cancelled() => Ok(()),
        result = async { tokio::try_join!(to_ssh, to_tcp) } => result.map(|_| ()),
    }
}
