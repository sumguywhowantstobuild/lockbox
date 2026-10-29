//! Choices waiting for the user's yes ([`Pending`]), each behind a one-time [`Token`] the confirming command sends
//! back. What waits can be a typed password or an unlocked vault, so a lock of all vaults drops everything here
//! (`Sessions::lock_all`).

use std::fmt;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use lockbox_core::ids::VaultId;
use serde::de::{self, Deserializer};
use serde::ser::Serializer;
use serde::{Deserialize, Serialize};

use crate::error::{ShellError, ShellResult};
use crate::lock;

/// How long a choice waits for its answer.
const LIFETIME: Duration = Duration::from_secs(5 * 60);

/// A one-time confirmation token: 128 random bits from the OS, as 32 lowercase hex characters (a JSON string, so
/// JavaScript keeps every bit). Parsed back only in that exact form.
pub struct Token(String);

impl Token {
    /// The engine's random ID is exactly this: 16 bytes from the OS random source, written and parsed as 32
    /// lowercase hex characters and nothing else.
    fn random() -> Token {
        Token(VaultId::random().to_hex())
    }

    fn parse(text: String) -> Option<Token> {
        VaultId::from_hex(&text).is_ok().then_some(Token(text))
    }

    /// Compares every byte, whatever the first difference, so the time taken does not tell how much of a guess was
    /// right.
    fn matches(&self, other: &Token) -> bool {
        let (a, b) = (self.0.as_bytes(), other.0.as_bytes());
        a.len() == b.len() && a.iter().zip(b).fold(0, |diff, (x, y)| diff | (x ^ y)) == 0
    }
}

impl Serialize for Token {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for Token {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Token::parse(String::deserialize(deserializer)?).ok_or_else(|| de::Error::custom("token"))
    }
}

/// Never shows the token: it is what confirms the choice.
impl fmt::Debug for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Token(..)")
    }
}

/// What waits in [`Pending`] for the user's answer. Each task adds the variants it needs; a typed password is kept
/// as a `Zeroizing<String>`.
pub enum PendingChoice {
    /// Tests only: a choice that may hold an unlocked vault, to see it dropped.
    #[cfg(test)]
    Test(Option<lockbox_core::Vault>),
}

/// The choices waiting for an answer, each until it is taken, it expires, or every vault locks.
#[derive(Default)]
pub struct Pending {
    parked: Mutex<Vec<Parked>>,
}

struct Parked {
    token: Token,
    until: Instant,
    choice: PendingChoice,
}

impl Pending {
    /// Parks `choice` and returns the token that takes it back.
    pub fn put(&self, choice: PendingChoice) -> Token {
        self.put_at(choice, Instant::now())
    }

    /// Takes the choice parked under `token`, once. `NotFound` for a token taken before, expired, or dropped by a
    /// lock.
    pub fn take(&self, token: &Token) -> ShellResult<PendingChoice> {
        self.take_at(token, Instant::now())
    }

    /// Removes every choice, for the caller to drop.
    pub(crate) fn drain(&self) -> Vec<PendingChoice> {
        lock(&self.parked)
            .drain(..)
            .map(|parked| parked.choice)
            .collect()
    }

    /// Drops nothing: `Sessions::open` parks under the sessions mutex, and an expired choice may be a vault, which
    /// is closed outside it ([`take`](Self::take) clears the expired ones).
    fn put_at(&self, choice: PendingChoice, now: Instant) -> Token {
        let token = Token::random();
        lock(&self.parked).push(Parked {
            token: Token(token.0.clone()),
            until: now + LIFETIME,
            choice,
        });
        token
    }

    fn take_at(&self, token: &Token, now: Instant) -> ShellResult<PendingChoice> {
        let mut parked = lock(&self.parked);
        let (expired, live): (Vec<Parked>, Vec<Parked>) = std::mem::take(&mut *parked)
            .into_iter()
            .partition(|p| p.until <= now);
        *parked = live;
        let found = parked
            .iter()
            .position(|p| p.token.matches(token))
            .map(|at| parked.swap_remove(at));
        // The expired choices close after the lock is released.
        drop(parked);
        drop(expired);
        found.map(|p| p.choice).ok_or(ShellError::NotFound)
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        lock(&self.parked).len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_expires_after_five_minutes() {
        let pending = Pending::default();
        let now = Instant::now();
        let token = pending.put_at(PendingChoice::Test(None), now);
        assert!(
            pending
                .take_at(&token, now + LIFETIME - Duration::from_secs(1))
                .is_ok()
        );

        let token = pending.put_at(PendingChoice::Test(None), now);
        assert!(matches!(
            pending.take_at(&token, now + LIFETIME),
            Err(ShellError::NotFound)
        ));
        assert_eq!(pending.len(), 0, "an expired choice is dropped");
    }
}
