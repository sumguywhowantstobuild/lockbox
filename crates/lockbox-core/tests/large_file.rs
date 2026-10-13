//! The large-file check (spec 5.5): a file of 4 GiB + 1 byte goes into a vault and comes
//! back out byte for byte, while memory stays flat. It writes about 12 GiB and takes
//! minutes, so it only runs when asked for:
//! `cargo test --release --locked -p lockbox-core --test large_file -- --ignored --nocapture`

use lockbox_core::Vault;
use lockbox_core::blob::{CancelToken, NoJournal};
use lockbox_core::fsio::peak_memory_bytes;
use lockbox_core::header::{CONTAINER_VERSION, VaultHeader, header_mac, write_headers};
use lockbox_core::ids::VaultId;
use lockbox_core::kdf::{Argon2Params, derive_password_key};
use lockbox_core::recovery::{RecoverySecret, derive_recovery_key};
use lockbox_core::secret::{Key32, random_bytes};
use lockbox_core::slots::{SlotType, wrap_slot};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::Path;
use std::time::Instant;

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
/// below.
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
    let recovery_key = derive_recovery_key(&RecoverySecret::generate(), &recovery_salt);
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
    let item = vault.new_file_item(None, &source, &cancel).unwrap();
    println!("imported: {:?}", started.elapsed());
    let file = vault.get_item(&item).unwrap().attachments[0].file_id;

    let export = temp.path().join("export.bin");
    vault
        .export_file(&item, &file, &export, &NoJournal, &cancel)
        .unwrap();
    println!("exported: {:?}", started.elapsed());
    let (export_hash, export_len) = hash_file(&export);

    let peak = peak_memory_bytes();
    println!("total {:?}; peak memory {peak:?} bytes", started.elapsed());
    assert_eq!(export_len, LEN);
    assert_eq!(
        export_hash, source_hash,
        "the exported file differs from the source"
    );
    println!("SHA-256 equal: {}", hex(&export_hash));
    match peak {
        Some(bytes) => assert!(bytes < MAX_PEAK_BYTES, "peak memory was {bytes} bytes"),
        None => println!("peak memory is not measured on this platform; that check is skipped"),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
