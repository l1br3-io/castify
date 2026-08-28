//! In-memory rate limiting for the share unlock endpoint
//! (docs/specs/sharing, task 004).
//!
//! Brute-force protection for the password gate: after [`MAX_FAILURES`]
//! consecutive wrong passwords for one share, [`UnlockRateLimiter::check`]
//! denies every further attempt — *without* running argon2 — until the
//! [`COOL_OFF`] window elapses. A successful unlock wipes the slate.
//!
//! Design constraints (spec § task 004):
//!   * **In memory only, never persisted** — a restart clears the lockout.
//!     That is deliberate: persisting failure counts would turn recipient
//!     IP rotation into a denial-of-service diary against the owner.
//!   * **Per-token** — one share under attack never locks out another.
//!     Entries are keyed by share id (1:1 with the token; the handler has
//!     the row loaded by the time it consults the limiter, and ids are
//!     what logs are allowed to carry).
//!   * **Bounded** — entries exist only for live password-protected shares
//!     that are being actively attacked: unknown tokens 404 before the
//!     limiter, and successes/elapsed cool-offs remove their entry.
//!   * **Wall-clock-free** — `Instant` (monotonic) is injected so unit
//!     tests can time-travel.
//!
//! The mutex is `std::sync::Mutex` held only for map reads/writes — never
//! across argon2 or await points — so it does not block the async runtime.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

/// Consecutive wrong passwords per share before the cool-off engages.
/// Five absorbs a family member fumbling a password without punishing
/// them, while still capping an online brute-forcer at ~5 argon2
/// verifications per 15-minute window per token — roughly 480 guesses/day,
/// far below any realistic crack rate against a strong share password.
pub const MAX_FAILURES: u32 = 5;

/// How long a locked-out share token stays locked. 15 minutes balances
/// "human typos don't hurt" (the window clears quickly after success or
/// expiry) against "automated guessing stays expensive". Doubles as the
/// entry's lifetime: an elapsed cool-off removes the entry entirely.
pub const COOL_OFF: Duration = Duration::from_secs(15 * 60);

/// Point-in-time verdict for one unlock attempt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RateVerdict {
    /// The attempt may proceed to argon2 verification.
    Allowed,
    /// The cool-off is active: reject without hashing, even if the
    /// password is correct (an offline attacker with the right password
    /// learns nothing about which attempt succeeded).
    LockedOut,
}

#[derive(Debug, Default)]
struct FailureRecord {
    consecutive: u32,
    /// `Some(until)` while the cool-off is active; entries whose window
    /// has elapsed are removed on the next [`UnlockRateLimiter::check`].
    locked_until: Option<Instant>,
}

/// Per-share failure counters, held by [`crate::state::AppState`].
#[derive(Debug, Default)]
pub struct UnlockRateLimiter {
    inner: Mutex<HashMap<String, FailureRecord>>,
}

impl UnlockRateLimiter {
    pub fn new() -> Self {
        Self::default()
    }

    /// May this attempt proceed to verification? Also performs the lazy
    /// cleanup: an elapsed cool-off removes the entry, so the next batch
    /// of failures starts from zero. Entries that are merely *counting*
    /// (failures below the threshold, no lockout yet) are left alone.
    pub fn check(&self, share_id: &str, now: Instant) -> RateVerdict {
        // Decision computed under one borrow, acted on under another —
        // `get_mut` + `remove` in the same match arm would double-borrow.
        #[derive(PartialEq)]
        enum Decision {
            Allow,
            Deny,
            ClearElapsedAndAllow,
        }
        let decision = match self.lock().get(share_id) {
            None => Decision::Allow,
            Some(entry) => match entry.locked_until {
                Some(until) if until > now => Decision::Deny,
                Some(_) => Decision::ClearElapsedAndAllow,
                None => Decision::Allow,
            },
        };
        let mut map = self.lock();
        match decision {
            Decision::Deny => RateVerdict::LockedOut,
            Decision::ClearElapsedAndAllow => {
                map.remove(share_id);
                RateVerdict::Allowed
            }
            Decision::Allow => RateVerdict::Allowed,
        }
    }

    /// Record a failed verification. Returns `true` when *this* failure
    /// engaged the cool-off — callers may log that (share id only, never
    /// token or password material). Failures during an active lockout are
    /// ignored: those attempts were rejected before hashing, so counting
    /// them would let a locked-out attacker extend their own lockout.
    pub fn record_failure(&self, share_id: &str, now: Instant) -> bool {
        let mut map = self.lock();
        let entry = map.entry(share_id.to_string()).or_default();
        if entry.locked_until.is_some_and(|until| until > now) {
            return false;
        }
        entry.consecutive += 1;
        if entry.consecutive >= MAX_FAILURES {
            entry.locked_until = Some(now + COOL_OFF);
            return true;
        }
        false
    }

    /// A successful unlock wipes the slate: the next mistake is a fresh
    /// count, not a step toward the cool-off.
    pub fn reset(&self, share_id: &str) {
        self.lock().remove(share_id);
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, FailureRecord>> {
        // Poisoning only means a panic happened mid-update; the map is
        // still structurally sound, and overcounting failures is the safe
        // direction — recover rather than 500 every unlock.
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(seconds: u64) -> Instant {
        Instant::now() + Duration::from_secs(seconds)
    }

    #[test]
    fn five_consecutive_failures_engage_the_cool_off() {
        let limiter = UnlockRateLimiter::new();
        for i in 1..MAX_FAILURES {
            assert!(!limiter.record_failure("s1", t(i as u64 * 60)));
            assert_eq!(limiter.check("s1", t(i as u64 * 60)), RateVerdict::Allowed);
        }
        // The fifth failure flips the verdict...
        assert!(limiter.record_failure("s1", t(5 * 60)));
        assert_eq!(limiter.check("s1", t(5 * 60)), RateVerdict::LockedOut);
        // ...and holds through the window.
        assert_eq!(
            limiter.check("s1", t(5 * 60 + 15 * 60 - 1)),
            RateVerdict::LockedOut
        );
    }

    #[test]
    fn cool_off_expires_into_a_fresh_window() {
        let limiter = UnlockRateLimiter::new();
        for _ in 0..MAX_FAILURES {
            limiter.record_failure("s1", t(0));
        }
        let engaged_at = t(0);
        // Exactly at the boundary (now == locked_until) the lock has lapsed.
        assert_eq!(
            limiter.check("s1", engaged_at + COOL_OFF),
            RateVerdict::Allowed
        );
        // Entry was removed: failures start over from zero, so
        // MAX_FAILURES - 1 fresh failures stay allowed.
        for i in 1..MAX_FAILURES {
            limiter.record_failure("s1", engaged_at + COOL_OFF + Duration::from_secs(i as u64));
        }
        assert_eq!(
            limiter.check("s1", engaged_at + COOL_OFF + Duration::from_secs(60)),
            RateVerdict::Allowed
        );
    }

    #[test]
    fn lockout_cannot_be_extended_from_inside_the_window() {
        let limiter = UnlockRateLimiter::new();
        for _ in 0..MAX_FAILURES {
            limiter.record_failure("s1", t(0));
        }
        // Attempt at minute 14 is rejected pre-hash and must NOT push the
        // window out — otherwise a locked-out attacker could keep a share
        // locked forever with cheap unauthenticated attempts.
        assert!(!limiter.record_failure("s1", t(14 * 60)));
        assert_eq!(limiter.check("s1", t(15 * 60)), RateVerdict::Allowed);
    }

    #[test]
    fn counters_are_isolated_per_share() {
        let limiter = UnlockRateLimiter::new();
        for _ in 0..MAX_FAILURES {
            limiter.record_failure("attacked", t(0));
        }
        assert_eq!(limiter.check("attacked", t(1)), RateVerdict::LockedOut);
        assert_eq!(limiter.check("bystander", t(1)), RateVerdict::Allowed);
    }

    #[test]
    fn success_resets_the_count_to_zero() {
        let limiter = UnlockRateLimiter::new();
        for _ in 0..MAX_FAILURES - 1 {
            limiter.record_failure("s1", t(0));
        }
        limiter.reset("s1");
        // Without the reset these would be failures #5..#8 — locked out.
        for _ in 0..MAX_FAILURES - 1 {
            limiter.record_failure("s1", t(30));
        }
        assert_eq!(limiter.check("s1", t(30)), RateVerdict::Allowed);
        // The engaging failure is the fifth of the fresh batch.
        assert!(limiter.record_failure("s1", t(31)));
        assert_eq!(limiter.check("s1", t(31)), RateVerdict::LockedOut);
    }
}
