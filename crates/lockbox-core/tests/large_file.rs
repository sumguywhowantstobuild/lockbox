//! The large-file check (spec 5.5): a file of 4 GiB + 1 byte goes into a vault and comes
//! back out byte for byte, while memory stays flat. It writes about 12 GiB and takes
//! minutes, so it only runs when asked for:
//! `cargo test --release --locked -p lockbox-core --features test-internals --test large_file -- --ignored --nocapture`

use lockbox_core::Vault;
use lockbox_core::blob::{CancelToken, NoJournal, NoProgress, Progress};
use lockbox_core::ids::VaultId;
use lockbox_core::internals::fsio::peak_memory_bytes;
use lockbox_core::internals::header::{CONTAINER_VERSION, VaultHeader, header_mac, write_headers};
use lockbox_core::internals::kdf::{Argon2Params, derive_password_key};
use lockbox_core::internals::recovery::{self, derive_recovery_key};
use lockbox_core::internals::secret::{Key32, random_bytes};
use lockbox_core::internals::slots::{SlotType, wrap_slot};
use lockbox_core::{CoreError, Result};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

const PASSWORD: &str = "correct horse battery";
const LEN: u64 = 4 * 1024 * 1024 * 1024 + 1;
/// The one buffer all reading and writing here goes through.
const BUF_LEN: usize = 1024 * 1024;
const MAX_PEAK_BYTES: u64 = 200 * 1000 * 1000;

/// Byte `pos` of the test file: a multiplicative hash of its position, so every part of
/// the file differs and a chunk in the wrong place changes the SHA-256.
fn pattern_at(pos: u64) -> u8 {
    (pos.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> 56) as u8
}

/// Writes the test file and returns its SHA-256, hashed as it is written.
fn write_source(path: &Path) -> [u8; 32] {
    let mut file = File::create_new(path).unwrap();
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; BUF_LEN];
    let mut pos = 0u64;
    while pos < LEN {
        let n = buf.len().min((LEN - pos) as usize);
        for (i, byte) in buf[..n].iter_mut().enumerate() {
            *byte = pattern_at(pos + i as u64);
        }
        file.write_all(&buf[..n]).unwrap();
        hasher.update(&buf[..n]);
        pos += n as u64;
    }
    file.sync_all().unwrap();
    hasher.finalize().into()
}

/// Streams the file through SHA-256; returns the hash and the byte count.
fn hash_file(path: &Path) -> ([u8; 32], u64) {
    let mut file = File::open(path).unwrap();
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; BUF_LEN];
    let mut total = 0u64;
    loop {
        let n = file.read(&mut buf).unwrap();
        if n == 0 {
            return (hasher.finalize().into(), total);
        }
        hasher.update(&buf[..n]);
        total += n as u64;
    }
}

/// A vault whose password slot uses the cheapest Argon2 settings the reader accepts
/// (64 MiB), built and opened through the public API. `Vault::create` calibrates up to
/// 256 MiB, and that alone would push this process's peak memory past the limit checked
/// below. It writes these same settings (65 536 KiB, 3, 4) on a machine where one run
/// takes 1 s or more, so this is a vault `create` can produce.
fn open_light_vault(dir: &Path) -> Vault {
    fs::create_dir_all(dir.join("items")).unwrap();
    fs::create_dir_all(dir.join("files").join("orphaned")).unwrap();
    let id = VaultId::random();
    let vault_key = Key32::random();
    let params = Argon2Params {
        memory_kib: 65_536,
        iterations: 3,
        parallelism: 4,
    };
    let (password_salt, recovery_salt) = (random_bytes::<16>(), random_bytes::<16>());
    let password_key = derive_password_key(PASSWORD, &password_salt, &params).unwrap();
    let recovery_key = derive_recovery_key(&recovery::generate(), &recovery_salt);
    let mut header = VaultHeader {
        container_version: CONTAINER_VERSION,
        vault_id: id,
        name: "Big".into(),
        slots: vec![
            wrap_slot(
                SlotType::Password,
                &id,
                password_salt,
                Some(params),
                &password_key,
                &vault_key,
            ),
            wrap_slot(
                SlotType::Recovery,
                &id,
                recovery_salt,
                None,
                &recovery_key,
                &vault_key,
            ),
        ],
        migration: None,
        created_at: "2026-10-13T00:00:00Z".into(),
        header_mac: None,
    };
    header.header_mac = Some(header_mac(&header, &vault_key));
    write_headers(dir, &header).unwrap();
    Vault::unlock_with_password(dir, PASSWORD).unwrap().0
}

#[test]
#[ignore = "writes about 12 GiB and takes minutes; run it on purpose"]
fn large_file_round_trip_4_gib() {
    let temp = tempfile::tempdir().unwrap();
    let started = Instant::now();
    let source = temp.path().join("source.bin");
    let source_hash = write_source(&source);
    println!("source written and hashed: {:?}", started.elapsed());

    let cancel = CancelToken::new();
    let mut vault = open_light_vault(&temp.path().join("vault"));
    // The peak only ever rises: this is the high-water mark so far, which includes the process
    // baseline, the 1 MiB source buffer and the 64 MiB Argon2 run of the unlock.
    let unlock_peak = peak_memory_bytes();
    println!(
        "peak after unlock (includes process baseline and the source buffer): {unlock_peak:?} bytes"
    );
    assert_eq!(
        unlock_peak.is_some(),
        cfg!(windows),
        "the memory reading after unlock must work exactly where it is supported"
    );
    let item = vault
        .new_file_item(None, &source, &cancel, &NoProgress)
        .unwrap();
    println!("imported: {:?}", started.elapsed());
    let file = vault.get_item(&item).unwrap().attachments[0].file_id;

    let export = temp.path().join("export.bin");
    vault
        .export_file(&item, &file, &export, &NoJournal, &cancel, &NoProgress)
        .unwrap();
    println!("exported: {:?}", started.elapsed());
    let (export_hash, export_len) = hash_file(&export);

    let peak = peak_memory_bytes();
    println!("total {:?}; peak memory {peak:?} bytes", started.elapsed());
    assert_eq!(
        peak.is_some(),
        cfg!(windows),
        "the final memory reading must work exactly where it is supported"
    );
    assert_eq!(export_len, LEN);
    assert_eq!(
        export_hash, source_hash,
        "the exported file differs from the source"
    );
    println!("SHA-256 equal: {}", hex(&export_hash));
    match (unlock_peak, peak) {
        (Some(unlock), Some(end)) => {
            assert!(end < MAX_PEAK_BYTES, "peak memory was {end} bytes");
            // The end peak is dominated by the unlock, so the honest claim is that the
            // streaming of 4 GiB in and out never pushed memory above the unlock peak.
            if end == unlock {
                println!("streaming never pushed memory above the unlock peak ({unlock} bytes)");
            } else {
                println!(
                    "peak {end} bytes after streaming, {unlock} bytes after unlock: {} bytes higher",
                    end.saturating_sub(unlock)
                );
            }
        }
        _ => println!("peak memory is not measured on this platform; that check is skipped"),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A listener that counts what it hears and keeps the last bytes done.
#[derive(Default)]
struct Counting {
    calls: AtomicU64,
    done: AtomicU64,
}

impl Progress for Counting {
    fn advance(&self, done: u64, _total: u64) {
        self.calls.fetch_add(1, Ordering::Relaxed);
        self.done.store(done, Ordering::Relaxed);
    }
}

/// Imports `source` into a new vault in `dir` and says how long it took.
fn timed_import(dir: &Path, source: &Path, progress: &dyn Progress) -> (Duration, Vault) {
    let mut vault = open_light_vault(dir);
    let started = Instant::now();
    vault
        .new_file_item(None, source, &CancelToken::new(), progress)
        .unwrap();
    (started.elapsed(), vault)
}

/// Starts `job` on its own thread with a token of its own, waits until `watch` has heard `after`
/// bytes, cancels, and says how long the job took to return after the cancel, and what it returned.
fn cancel_latency<T: Send>(
    watch: &Counting,
    after: u64,
    job: impl FnOnce(&CancelToken) -> Result<T> + Send,
) -> (Duration, Result<T>) {
    let token = CancelToken::new();
    std::thread::scope(|scope| {
        let running = scope.spawn(|| job(&token));
        while watch.done.load(Ordering::Relaxed) < after {
            assert!(!running.is_finished(), "the job ended before the cancel");
            std::thread::sleep(Duration::from_millis(1));
        }
        let cancelled_at = Instant::now();
        token.cancel();
        let result = running.join().unwrap();
        (cancelled_at.elapsed(), result)
    })
}

/// The release measurement of Task 1: what a listener costs a 3 GiB import (counting progress
/// against none, the best of four runs each, the order alternating), and how long a cancel takes to
/// land while importing and while saving a copy. Slow and heavy (about 12 GiB of disk), so it runs on
/// purpose:
/// `cargo test --release --locked -p lockbox-core --features test-internals --test large_file progress_ -- --ignored --nocapture`
#[test]
#[ignore = "writes about 12 GiB and takes minutes; run it on purpose"]
fn progress_cost_and_cancel_latency_3_gib() {
    const SIZE: u64 = 3 * 1024 * 1024 * 1024;
    const HALF_WAY: u64 = SIZE / 2;
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source.bin");
    let mut file = File::create_new(&source).unwrap();
    let mut buf = vec![0u8; BUF_LEN];
    for pos in (0..SIZE).step_by(BUF_LEN) {
        for (i, byte) in buf.iter_mut().enumerate() {
            *byte = pattern_at(pos + i as u64);
        }
        file.write_all(&buf).unwrap();
    }
    file.sync_all().unwrap();
    drop(file);

    // Fair to both: the order alternates each round (none then counting, then counting then none), the
    // disk gets a pause to settle before each run, and each run's folder is gone before the next starts,
    // so neither kind always follows the deletion of 3 GiB or runs beside another vault.
    let run = |label: &str, round: usize, counting: bool| -> Duration {
        std::thread::sleep(Duration::from_secs(5));
        let dir = temp.path().join(format!("{label}-{round}"));
        let listener = Counting::default();
        let progress: &dyn Progress = if counting { &listener } else { &NoProgress };
        let (time, vault) = timed_import(&dir, &source, progress);
        if counting {
            assert_eq!(
                listener.done.load(Ordering::Relaxed),
                SIZE,
                "ends at the total"
            );
        }
        drop(vault);
        fs::remove_dir_all(dir).unwrap();
        println!("round {round}: {label} {time:?}");
        time
    };
    let (mut none, mut counted) = (Vec::new(), Vec::new());
    for round in 0..4 {
        if round % 2 == 0 {
            none.push(run("none", round, false));
            counted.push(run("counting", round, true));
        } else {
            counted.push(run("counting", round, true));
            none.push(run("none", round, false));
        }
    }
    let (best_none, best_counted) = (none.iter().min().unwrap(), counted.iter().min().unwrap());
    let ratio = best_counted.as_secs_f64() / best_none.as_secs_f64();
    println!("IMPORT 3 GiB: none {best_none:?}, counting {best_counted:?}, ratio {ratio:.3}");

    // A vault holding the file, for the Save a copy cancel below (this import is not timed).
    let kept_dir = temp.path().join("kept");
    let (_, kept) = timed_import(&kept_dir, &source, &NoProgress);

    // A cancel while importing: the vault is fresh, the job stops half way.
    let mut vault = open_light_vault(&temp.path().join("cancelled-import"));
    let watch = Counting::default();
    let (latency, result) = cancel_latency(&watch, HALF_WAY, |token| {
        vault.new_file_item(None, &source, token, &watch)
    });
    println!("CANCEL while importing: returned {latency:?} after the cancel");
    assert!(matches!(result, Err(CoreError::Cancelled)), "{result:?}");
    assert!(latency < Duration::from_secs(1), "{latency:?}");

    // A cancel while saving a copy of the file the kept vault holds.
    let vault = kept;
    let item = vault.items().next().unwrap().id;
    let file = vault.get_item(&item).unwrap().attachments[0].file_id;
    let export = temp.path().join("export.bin");
    let watch = Counting::default();
    let (latency, result) = cancel_latency(&watch, HALF_WAY, |token| {
        vault.export_file(&item, &file, &export, &NoJournal, token, &watch)
    });
    println!("CANCEL while saving a copy: returned {latency:?} after the cancel");
    assert!(matches!(result, Err(CoreError::Cancelled)), "{result:?}");
    assert!(latency < Duration::from_secs(1), "{latency:?}");
    assert!(!export.exists(), "no half copy");

    assert!(
        ratio <= 1.05,
        "counting progress cost {ratio:.3} times none"
    );
}
