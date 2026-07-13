use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const URL_BOOTSTRAP_TTL: Duration = Duration::from_secs(60);
const CODE_BOOTSTRAP_TTL: Duration = Duration::from_secs(5 * 60);
const CODE_MAX_ATTEMPTS: u8 = 5;
const ADMIN_SESSION_TTL_SECS: u64 = 12 * 60 * 60;
const ADMIN_COOKIE: &str = "markon_admin";

#[derive(Debug)]
struct PendingBootstrap {
    redirect: String,
    expires_at: Instant,
}

#[derive(Debug)]
struct PendingCode {
    digest: [u8; 32],
    redirect: String,
    expires_at: Instant,
    failures: u8,
}

#[derive(Debug, Default)]
struct BootstrapState {
    url_tokens: HashMap<[u8; 32], PendingBootstrap>,
    code: Option<PendingCode>,
}

/// In-memory, process-scoped issuer for browser administrator sessions.
///
/// URL nonces and manual pairing codes are capabilities in their own right:
/// neither client IP nor proxy metadata participates in authorization. Values
/// are stored only as SHA-256 digests, expire quickly, and are consumed once.
#[derive(Debug, Default)]
pub struct AdminBootstrapStore {
    inner: Mutex<BootstrapState>,
}

impl AdminBootstrapStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Issue a 256-bit one-time nonce suitable for a URL fragment.
    pub fn issue_url(&self, redirect: &str) -> String {
        let token = random_hex::<32>();
        let pending = PendingBootstrap {
            redirect: safe_redirect(redirect),
            expires_at: Instant::now() + URL_BOOTSTRAP_TTL,
        };
        let mut state = self.inner.lock().unwrap();
        cleanup(&mut state);
        state.url_tokens.insert(digest(&token), pending);
        token
    }

    /// Consume a URL nonce atomically. A second exchange always fails.
    pub fn consume_url(&self, token: &str) -> Option<String> {
        if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let mut state = self.inner.lock().unwrap();
        cleanup(&mut state);
        let pending = state.url_tokens.remove(&digest(token))?;
        (pending.expires_at > Instant::now()).then_some(pending.redirect)
    }

    /// Issue the single active manual pairing code. A new code invalidates the
    /// previous one, keeping the brute-force state small and deterministic.
    pub fn issue_code(&self, redirect: &str) -> String {
        let code = random_pairing_code();
        let normalized = normalize_code(&code);
        let mut state = self.inner.lock().unwrap();
        cleanup(&mut state);
        state.code = Some(PendingCode {
            digest: digest(&normalized),
            redirect: safe_redirect(redirect),
            expires_at: Instant::now() + CODE_BOOTSTRAP_TTL,
            failures: 0,
        });
        code
    }

    /// Consume the manual code. Five wrong attempts invalidate it immediately.
    pub fn consume_code(&self, code: &str) -> Option<String> {
        let normalized = normalize_code(code);
        let candidate = digest(&normalized);
        let mut state = self.inner.lock().unwrap();
        cleanup(&mut state);
        let pending = state.code.as_mut()?;
        if !constant_time_eq(&pending.digest, &candidate) {
            pending.failures = pending.failures.saturating_add(1);
            if pending.failures >= CODE_MAX_ATTEMPTS {
                state.code = None;
            }
            return None;
        }
        state.code.take().map(|entry| entry.redirect)
    }
}

fn cleanup(state: &mut BootstrapState) {
    let now = Instant::now();
    state
        .url_tokens
        .retain(|_, pending| pending.expires_at > now);
    if state
        .code
        .as_ref()
        .is_some_and(|pending| pending.expires_at <= now)
    {
        state.code = None;
    }
}

fn safe_redirect(value: &str) -> String {
    if value.starts_with('/') && !value.starts_with("//") {
        value.to_string()
    } else {
        "/".to_string()
    }
}

fn random_hex<const N: usize>() -> String {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).expect("operating-system randomness unavailable");
    hex(&bytes)
}

fn random_pairing_code() -> String {
    const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let mut bytes = [0u8; 10];
    getrandom::fill(&mut bytes).expect("operating-system randomness unavailable");
    let raw: String = bytes
        .iter()
        .map(|byte| ALPHABET[(byte & 31) as usize] as char)
        .collect();
    format!("{}-{}", &raw[..5], &raw[5..])
}

fn normalize_code(code: &str) -> String {
    code.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(char::to_uppercase)
        .collect()
}

fn digest(value: &str) -> [u8; 32] {
    Sha256::digest(value.as_bytes()).into()
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(crate) fn auth_tag(secret: &str, domain: &[u8], payload: &str) -> String {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC accepts keys of any length");
    mac.update(domain);
    mac.update(payload.as_bytes());
    hex(&mac.finalize().into_bytes())
}

pub(crate) fn make_admin_cookie(secret: &str, now: u64, secure: bool) -> String {
    let payload = format!(
        "{}|{}",
        now.saturating_add(ADMIN_SESSION_TTL_SECS),
        random_hex::<16>()
    );
    let payload_hex = hex(payload.as_bytes());
    let tag = auth_tag(secret, b"markon-admin-session\0", &payload_hex);
    let secure_attr = if secure { "; Secure" } else { "" };
    format!(
        "{ADMIN_COOKIE}={payload_hex}.{tag}; Path=/; Max-Age={ADMIN_SESSION_TTL_SECS}; HttpOnly; SameSite=Strict{secure_attr}"
    )
}

pub(crate) fn admin_cookie_valid(secret: &str, cookie_header: Option<&str>, now: u64) -> bool {
    let Some(token) = cookie_value(cookie_header, ADMIN_COOKIE) else {
        return false;
    };
    let Some((payload_hex, tag)) = token.split_once('.') else {
        return false;
    };
    if payload_hex.len() % 2 != 0
        || !constant_time_eq(
            auth_tag(secret, b"markon-admin-session\0", payload_hex).as_bytes(),
            tag.as_bytes(),
        )
    {
        return false;
    }
    let Ok(payload_bytes) = (0..payload_hex.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&payload_hex[index..index + 2], 16))
        .collect::<Result<Vec<_>, _>>()
    else {
        return false;
    };
    let Ok(payload) = String::from_utf8(payload_bytes) else {
        return false;
    };
    let Some((exp, session_id)) = payload.split_once('|') else {
        return false;
    };
    !session_id.is_empty() && exp.parse::<u64>().is_ok_and(|exp| exp > now)
}

fn cookie_value<'a>(cookie_header: Option<&'a str>, name: &str) -> Option<&'a str> {
    cookie_header?
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_nonce_is_single_use_and_redirect_is_relative() {
        let store = AdminBootstrapStore::new();
        let nonce = store.issue_url("/abcd1234/");
        assert_eq!(nonce.len(), 64);
        assert_eq!(store.consume_url(&nonce).as_deref(), Some("/abcd1234/"));
        assert_eq!(store.consume_url(&nonce), None);

        let nonce = store.issue_url("https://evil.example/");
        assert_eq!(store.consume_url(&nonce).as_deref(), Some("/"));
    }

    #[test]
    fn pairing_code_is_single_use_and_attempt_limited() {
        let store = AdminBootstrapStore::new();
        let code = store.issue_code("/target");
        assert_eq!(code.len(), 11);
        assert_eq!(
            store.consume_code(&code.to_lowercase()).as_deref(),
            Some("/target")
        );
        assert_eq!(store.consume_code(&code), None);

        let valid = store.issue_code("/");
        for _ in 0..CODE_MAX_ATTEMPTS {
            assert_eq!(store.consume_code("WRONG-WRONG"), None);
        }
        assert_eq!(store.consume_code(&valid), None);
    }

    #[test]
    fn admin_cookie_is_hmac_signed_and_expires() {
        let cookie = make_admin_cookie("secret", 100, false);
        assert!(cookie.contains("HttpOnly; SameSite=Strict"));
        assert!(!cookie.contains("; Secure"));
        assert!(admin_cookie_valid("secret", Some(&cookie), 101));
        assert!(!admin_cookie_valid("other", Some(&cookie), 101));
        assert!(!admin_cookie_valid(
            "secret",
            Some(&cookie),
            100 + ADMIN_SESSION_TTL_SECS
        ));

        let secure = make_admin_cookie("secret", 100, true);
        assert!(secure.contains("; Secure"));
    }
}
