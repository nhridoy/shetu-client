//! RFC 6238 TOTP codes for identities: base32 secrets or `otpauth://totp/` URIs.

use hmac::{Hmac, Mac};

pub const INVALID: &str = "Not a valid TOTP secret";

#[derive(Clone, Copy)]
pub enum Algorithm {
    Sha1,
    Sha256,
    Sha512,
}

/// No Debug on purpose: the secret must never reach logs.
#[derive(Clone)]
pub struct TotpParams {
    pub secret: Vec<u8>,
    pub algorithm: Algorithm,
    pub digits: u32,
    pub period: u64,
}

fn decode_base32(input: &str) -> Option<Vec<u8>> {
    let cleaned: String = input
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-' && *c != '=')
        .map(|c| c.to_ascii_uppercase())
        .collect();
    let bytes = data_encoding::BASE32_NOPAD
        .decode(cleaned.as_bytes())
        .ok()?;
    (!bytes.is_empty()).then_some(bytes)
}

/// `%XX` escapes in a URI value; None for a malformed escape or non-UTF-8 result.
fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// A base32 secret, or an `otpauth://totp/...` URI with its algorithm, digits and period.
pub fn parse(input: &str) -> Result<TotpParams, String> {
    let input = input.trim();
    let invalid = || INVALID.to_string();
    let mut params = TotpParams {
        secret: Vec::new(),
        algorithm: Algorithm::Sha1,
        digits: 6,
        period: 30,
    };
    let lower = input.to_ascii_lowercase();
    if !lower.starts_with("otpauth://") {
        params.secret = decode_base32(input).ok_or_else(invalid)?;
        return Ok(params);
    }
    if !lower.starts_with("otpauth://totp/") {
        return Err(invalid());
    }
    let query = input.split_once('?').map(|(_, q)| q).unwrap_or_default();
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        match key.to_ascii_lowercase().as_str() {
            "secret" => {
                params.secret = percent_decode(value)
                    .and_then(|v| decode_base32(&v))
                    .ok_or_else(invalid)?
            }
            "algorithm" => {
                params.algorithm = match value.to_ascii_uppercase().as_str() {
                    "SHA1" => Algorithm::Sha1,
                    "SHA256" => Algorithm::Sha256,
                    "SHA512" => Algorithm::Sha512,
                    _ => return Err(invalid()),
                }
            }
            "digits" => {
                params.digits = value
                    .parse()
                    .ok()
                    .filter(|d| (6..=8).contains(d))
                    .ok_or_else(invalid)?
            }
            "period" => {
                params.period = value.parse().ok().filter(|p| *p > 0).ok_or_else(invalid)?
            }
            _ => {}
        }
    }
    if params.secret.is_empty() {
        return Err(invalid());
    }
    Ok(params)
}

/// The code for `unix_secs`.
pub fn code(p: &TotpParams, unix_secs: u64) -> String {
    let counter = (unix_secs / p.period).to_be_bytes();
    macro_rules! digest {
        ($hash:ty) => {{
            let mut mac =
                Hmac::<$hash>::new_from_slice(&p.secret).expect("HMAC takes any key length");
            mac.update(&counter);
            mac.finalize().into_bytes().to_vec()
        }};
    }
    let hash = match p.algorithm {
        Algorithm::Sha1 => digest!(sha1::Sha1),
        Algorithm::Sha256 => digest!(sha2::Sha256),
        Algorithm::Sha512 => digest!(sha2::Sha512),
    };
    let offset = (hash[hash.len() - 1] & 0x0f) as usize;
    let binary = u32::from_be_bytes([
        hash[offset] & 0x7f,
        hash[offset + 1],
        hash[offset + 2],
        hash[offset + 3],
    ]);
    format!(
        "{:0width$}",
        binary % 10u32.pow(p.digits),
        width = p.digits as usize
    )
}

pub fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

/// A keyboard-interactive prompt that asks for a one-time code.
pub fn is_code_prompt(prompt: &str) -> bool {
    static CODE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(
            r"(?i)\b(verification|one[- ]?time|otp|token|authenticator|2fa|two[- ]factor|code|passcode)\b",
        )
        .unwrap()
    });
    // Users and hosts named in the prompt ("Password for deploy@code.example:") aren't the factor asked for.
    static LOGIN: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"[\w-]+(?:[@.][\w-]+)+").unwrap());
    CODE.is_match(&LOGIN.replace_all(prompt, " "))
}

#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub code: String,
    pub seconds_left: u64,
}

fn preview_at(p: &TotpParams, unix_secs: u64) -> Preview {
    Preview {
        code: code(p, unix_secs),
        seconds_left: p.period - unix_secs % p.period,
    }
}

/// Live code for the identity form, from the value being typed (saved secrets never come here).
#[tauri::command]
pub fn totp_preview(value: String) -> Result<Preview, String> {
    Ok(preview_at(&parse(&value)?, unix_now()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(secret: &[u8], algorithm: Algorithm) -> TotpParams {
        TotpParams {
            secret: secret.to_vec(),
            algorithm,
            digits: 8,
            period: 30,
        }
    }

    #[test]
    fn rfc6238_sha1_vectors() {
        let p = params(b"12345678901234567890", Algorithm::Sha1);
        for (t, want) in [
            (59, "94287082"),
            (1111111109, "07081804"),
            (1111111111, "14050471"),
            (1234567890, "89005924"),
            (2000000000, "69279037"),
        ] {
            assert_eq!(code(&p, t), want, "t={t}");
        }
    }

    #[test]
    fn rfc6238_sha256_vectors() {
        let p = params(b"12345678901234567890123456789012", Algorithm::Sha256);
        for (t, want) in [
            (59, "46119246"),
            (1111111109, "68084774"),
            (1111111111, "67062674"),
            (1234567890, "91819424"),
        ] {
            assert_eq!(code(&p, t), want, "t={t}");
        }
    }

    #[test]
    fn rfc6238_sha512_vectors() {
        let p = params(
            b"1234567890123456789012345678901234567890123456789012345678901234",
            Algorithm::Sha512,
        );
        for (t, want) in [
            (59, "90693936"),
            (1111111109, "25091201"),
            (1111111111, "99943326"),
            (1234567890, "93441116"),
        ] {
            assert_eq!(code(&p, t), want, "t={t}");
        }
    }

    #[test]
    fn parse_accepts_lowercase_base32_with_spaces() {
        let p = parse(" gezd gnbv gy3t qojq gezd gnbv gy3t qojq ").unwrap();
        assert_eq!(p.secret, b"12345678901234567890");
        assert_eq!((p.digits, p.period), (6, 30));
        assert!(matches!(p.algorithm, Algorithm::Sha1));
        assert_eq!(code(&p, 59), "287082");
    }

    #[test]
    fn parse_accepts_otpauth_uri_parameters() {
        let p = parse("otpauth://totp/Prod:deploy?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA&algorithm=SHA256&digits=8&period=60&issuer=Prod").unwrap();
        assert_eq!(p.secret, b"12345678901234567890123456789012");
        assert!(matches!(p.algorithm, Algorithm::Sha256));
        assert_eq!((p.digits, p.period), (8, 60));
        // Period 60: t=119 is counter 1, the RFC's t=59 vector.
        assert_eq!(code(&p, 119), "46119246");
    }

    #[test]
    fn parse_percent_decodes_uri_values() {
        let p = parse("otpauth://totp/x?secret=%47EZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ%3D%3D&digits=6")
            .unwrap();
        assert_eq!(p.secret, b"12345678901234567890");
    }

    #[test]
    fn parse_rejects_garbage() {
        for bad in [
            "",
            "not base32!",
            "otpauth://hotp/x?secret=GEZDGNBV&counter=1",
            "otpauth://totp/x?issuer=a",
            "otpauth://totp/x?secret=GEZDGNBV&digits=12",
            "otpauth://totp/x?secret=GEZDGNBV&period=0",
            "otpauth://totp/x?secret=GEZDGNBV&algorithm=MD5",
        ] {
            assert_eq!(parse(bad).err().as_deref(), Some(INVALID), "{bad:?}");
        }
    }

    #[test]
    fn code_prompt_matching() {
        for yes in [
            "Verification code: ",
            "One-time password:",
            "OTP:",
            "Token: ",
            "Authenticator app code",
            "2FA:",
            "Two-factor code:",
            "Password or verification code: ",
            "Passcode or option (1-3): ",
        ] {
            assert!(is_code_prompt(yes), "{yes}");
        }
        for no in [
            "Password: ",
            "password for deploy:",
            "Username:",
            "(deploy@hotpot) Password:",
            "Password for alice@CODEBASE.EXAMPLE:",
            "Password for deploy@code.example:",
            "Password for token.internal:",
        ] {
            assert!(!is_code_prompt(no), "{no}");
        }
    }

    #[test]
    fn preview_reports_seconds_left_in_period() {
        let p = parse("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ").unwrap();
        assert_eq!(
            preview_at(&p, 59),
            Preview {
                code: "287082".into(),
                seconds_left: 1
            }
        );
        assert_eq!(preview_at(&p, 60).seconds_left, 30);
    }
}
