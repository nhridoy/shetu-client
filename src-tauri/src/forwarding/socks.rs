use std::net::{Ipv4Addr, Ipv6Addr};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SocksError {
    Malformed,
    UnsupportedVersion,
    UnsupportedAuth,
    UnsupportedCommand,
    UnsupportedAddress,
    ConnectFailed,
}

impl SocksError {
    pub fn reply_code(self) -> u8 {
        match self {
            Self::UnsupportedCommand => 0x07,
            Self::UnsupportedAddress => 0x08,
            Self::ConnectFailed => 0x05,
            _ => 0x01,
        }
    }
}

pub fn parse_connect(request: &[u8]) -> Result<(String, u16), SocksError> {
    if request.len() < 4 {
        return Err(SocksError::Malformed);
    }
    if request[0] != 5 {
        return Err(SocksError::UnsupportedVersion);
    }
    if request[1] != 1 {
        return Err(SocksError::UnsupportedCommand);
    }
    if request[2] != 0 {
        return Err(SocksError::Malformed);
    }
    let (host, end) = match request[3] {
        1 if request.len() >= 10 => (
            Ipv4Addr::new(request[4], request[5], request[6], request[7]).to_string(),
            8,
        ),
        4 if request.len() >= 22 => {
            let bytes: [u8; 16] = request[4..20]
                .try_into()
                .map_err(|_| SocksError::Malformed)?;
            (Ipv6Addr::from(bytes).to_string(), 20)
        }
        3 if request.len() >= 5 => {
            let len = request[4] as usize;
            if len == 0 || request.len() < 5 + len + 2 {
                return Err(SocksError::Malformed);
            }
            (
                std::str::from_utf8(&request[5..5 + len])
                    .map_err(|_| SocksError::Malformed)?
                    .to_string(),
                5 + len,
            )
        }
        1 | 3 | 4 => return Err(SocksError::Malformed),
        _ => return Err(SocksError::UnsupportedAddress),
    };
    if request.len() != end + 2 {
        return Err(SocksError::Malformed);
    }
    let port = u16::from_be_bytes([request[end], request[end + 1]]);
    if port == 0 {
        return Err(SocksError::Malformed);
    }
    Ok((host, port))
}

pub async fn read_connect(stream: &mut TcpStream) -> Result<(String, u16), SocksError> {
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut header = [0u8; 2];
        stream
            .read_exact(&mut header)
            .await
            .map_err(|_| SocksError::Malformed)?;
        if header[0] != 5 {
            return Err(SocksError::UnsupportedVersion);
        }
        if header[1] == 0 {
            return Err(SocksError::UnsupportedAuth);
        }
        let mut methods = vec![0u8; header[1] as usize];
        stream
            .read_exact(&mut methods)
            .await
            .map_err(|_| SocksError::Malformed)?;
        let supported = methods.contains(&0);
        stream
            .write_all(&[5, if supported { 0 } else { 0xff }])
            .await
            .map_err(|_| SocksError::Malformed)?;
        if !supported {
            return Err(SocksError::UnsupportedAuth);
        }
        let mut request = vec![0u8; 4];
        stream
            .read_exact(&mut request)
            .await
            .map_err(|_| SocksError::Malformed)?;
        let address_len = match request[3] {
            1 => 4,
            4 => 16,
            3 => {
                let mut len = [0];
                stream
                    .read_exact(&mut len)
                    .await
                    .map_err(|_| SocksError::Malformed)?;
                request.push(len[0]);
                len[0] as usize
            }
            _ => 0,
        };
        if address_len > 0 {
            let start = request.len();
            request.resize(start + address_len + 2, 0);
            stream
                .read_exact(&mut request[start..])
                .await
                .map_err(|_| SocksError::Malformed)?;
        }
        parse_connect(&request)
    })
    .await
    .map_err(|_| SocksError::Malformed)?
}

pub async fn reply(stream: &mut TcpStream, code: u8) -> std::io::Result<()> {
    stream.write_all(&[5, code, 0, 1, 0, 0, 0, 0, 0, 0]).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_all_address_types_and_rejects_unsupported_commands() {
        assert_eq!(
            parse_connect(&[5, 1, 0, 1, 127, 0, 0, 1, 0, 80]),
            Ok(("127.0.0.1".into(), 80))
        );
        assert_eq!(
            parse_connect(&[
                5, 1, 0, 3, 9, b'l', b'o', b'c', b'a', b'l', b'h', b'o', b's', b't', 0, 80
            ]),
            Ok(("localhost".into(), 80))
        );
        let mut v6 = vec![5, 1, 0, 4];
        v6.extend(Ipv6Addr::LOCALHOST.octets());
        v6.extend([0, 80]);
        assert_eq!(parse_connect(&v6), Ok(("::1".into(), 80)));
        assert_eq!(
            parse_connect(&[5, 2, 0, 1, 127, 0, 0, 1, 0, 80]),
            Err(SocksError::UnsupportedCommand)
        );
        assert_eq!(
            parse_connect(&[5, 3, 0, 1, 127, 0, 0, 1, 0, 80]),
            Err(SocksError::UnsupportedCommand)
        );
    }

    #[tokio::test]
    async fn reads_split_handshake_and_rejects_missing_auth() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(addr).await.unwrap();
            stream.write_all(&[5]).await.unwrap();
            stream.write_all(&[1, 0]).await.unwrap();
            let mut method = [0; 2];
            stream.read_exact(&mut method).await.unwrap();
            assert_eq!(method, [5, 0]);
            stream
                .write_all(&[5, 1, 0, 3, 1, b'x', 0, 80])
                .await
                .unwrap();
        });
        let (mut incoming, _) = listener.accept().await.unwrap();
        assert_eq!(read_connect(&mut incoming).await, Ok(("x".into(), 80)));
        client.await.unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(addr).await.unwrap();
            stream.write_all(&[5, 1, 2]).await.unwrap();
            let mut reply = [0; 2];
            stream.read_exact(&mut reply).await.unwrap();
            assert_eq!(reply, [5, 0xff]);
        });
        let (mut incoming, _) = listener.accept().await.unwrap();
        assert_eq!(
            read_connect(&mut incoming).await,
            Err(SocksError::UnsupportedAuth)
        );
        client.await.unwrap();
    }
}
