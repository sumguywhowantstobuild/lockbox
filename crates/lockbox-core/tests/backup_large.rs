//! The large-archive check (spec 5.5, 6.7, 6.8): a vault holding one file of 4 GiB + 1 byte
//! is backed up, the backup is verified and restored into another folder, and the file is
//! exported from the restored vault, byte for byte, while memory stays flat. It writes about
//! 8 GiB at its peak and takes minutes, so it only runs when asked for:
//! `cargo test --release --locked -p lockbox-core --features test-internals --test backup_large --
//! --ignored --nocapture`

use lockbox_core::blob::{CancelToken, NoJournal};
use lockbox_core::ids::VaultId;
use lockbox_core::internals::fsio::peak_memory_bytes;
use lockbox_core::internals::header::{CONTAINER_VERSION, VaultHeader, header_mac, write_headers};
use lockbox_core::internals::kdf::{Argon2Params, derive_password_key};
use lockbox_core::internals::recovery::derive_recovery_key;
use lockbox_core::internals::secret::{Key32, random_bytes};
use lockbox_core::internals::slots::{SlotType, wrap_slot};
use lockbox_core::recovery::RecoverySecret;
use lockbox_core::{Credential, PreparedRestore, Vault, verify_backup};
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

/// Prints how long a stage took and the process's peak memory so far.
fn stage(name: &str, started: Instant, previous: &mut Instant) {
    let now = Instant::now();
    println!(
        "{name}: {:?} (total {:?}); peak memory so far {:?} bytes",
        now.duration_since(*previous),
        now.duration_since(started),
        peak_memory_bytes(),
    );
    *previous = now;
}

#[test]
#[ignore = "writes about 8 GiB at its peak and takes minutes; run it on purpose"]
fn backup_restore_over_4_gib() {
    // Two folders, so the restore lands as a new folder beside neither the vault nor the
    // backup, and no `.before-restore` copy doubles the disk use.
    let temp = tempfile::tempdir().unwrap();
    let (vaults, restored) = (temp.path().join("vaults"), temp.path().join("restored"));
    let (out, journal) = (temp.path().join("out"), temp.path().join("journal.json"));
    for dir in [&vaults, &restored, &out] {
        fs::create_dir(dir).unwrap();
    }
    let started = Instant::now();
    let mut previous = started;
    let cancel = CancelToken::new();

    // The vault holds the file; the source file goes as soon as it is imported (its hash stays).
    let source = temp.path().join("source.bin");
    let source_hash = write_source(&source);
    stage("source written and hashed", started, &mut previous);
    let mut vault = open_light_vault(&vaults.join("vault"));
    let item = vault.new_file_item(None, &source, &cancel).unwrap();
    let file = vault.get_item(&item).unwrap().attachments[0].file_id;
    fs::remove_file(&source).unwrap();
    stage("imported", started, &mut previous);

    let backup = out.join("big.lockbox-backup");
    let report = vault.backup(&backup, &NoJournal, &cancel).unwrap();
    assert_eq!((report.items, report.files), (1, 1));
    assert_eq!(
        (report.skipped_damaged_items, report.skipped_damaged_files),
        (0, 0)
    );
    stage("backed up", started, &mut previous);

    let summary = verify_backup(&backup, Credential::Password(PASSWORD), &cancel).unwrap();
    assert_eq!(
        (summary.items, summary.files, summary.missing_files),
        (1, 1, 0)
    );
    stage("backup verified", started, &mut previous);

    // The vault goes once its backup has verified: the restore below is the only copy left, so
    // it has to bring everything back.
    drop(vault);
    fs::remove_dir_all(vaults.join("vault")).unwrap();
    let mut prepared = PreparedRestore::prepare(
        &backup,
        &restored,
        Credential::Password(PASSWORD),
        &journal,
        &cancel,
    )
    .unwrap();
    assert!(
        prepared.existing().is_none(),
        "the restore must land as a new folder"
    );
    stage(
        "restore prepared (extracted and checked)",
        started,
        &mut previous,
    );
    let outcome = prepared.commit(&cancel).unwrap();
    assert!(outcome.before_restore.is_none());
    drop(prepared);
    fs::remove_file(&backup).unwrap();
    stage("restore committed", started, &mut previous);

    let vault = Vault::unlock_with_password(&outcome.dir, PASSWORD)
        .unwrap()
        .0;
    let export = temp.path().join("export.bin");
    vault
        .export_file(&item, &file, &export, &NoJournal, &cancel)
        .unwrap();
    stage("exported from the restored vault", started, &mut previous);
    let (export_hash, export_len) = hash_file(&export);
    stage("export hashed", started, &mut previous);

    let peak = peak_memory_bytes();
    assert_eq!(
        peak.is_some(),
        cfg!(windows),
        "the memory reading must work exactly where it is supported"
    );
    assert_eq!(export_len, LEN);
    assert_eq!(
        export_hash, source_hash,
        "the exported file differs from the source"
    );
    println!("SHA-256 equal: {}", hex(&export_hash));
    match peak {
        // The unlock's 64 MiB Argon2 run and the 1 MiB buffers set the floor; the streaming of
        // 4 GiB through backup, verify, restore and export must stay under the limit with them.
        Some(peak) => {
            println!("total {:?}; peak memory {peak} bytes", started.elapsed());
            assert!(peak < MAX_PEAK_BYTES, "peak memory was {peak} bytes");
        }
        None => println!("peak memory is not measured on this platform; that check is skipped"),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
