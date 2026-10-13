//! Search at scale through the public API. Slow (it writes 5 000 sealed files and runs real
//! Argon2 twice), so it is ignored by default:
//! `cargo test --release --locked -p lockbox-core --test search -- --ignored --nocapture`

use lockbox_core::Vault;
use lockbox_core::header::{HEADER_FILE, parse_header};
use lockbox_core::ids::ItemId;
use lockbox_core::item::ItemKind;
use lockbox_core::kdf::derive_password_key;
use lockbox_core::slots::SlotType;
use std::fs;
use std::time::{Duration, Instant};
use zeroize::Zeroizing;

const PW: &str = "correct horse battery";
const ITEMS: usize = 5_000;

#[test]
#[ignore = "slow: run with --release -- --ignored"]
fn five_thousand_items_fast() {
    let parent = tempfile::tempdir().unwrap();
    let mut vault = Vault::create(parent.path(), "Big", PW).unwrap().vault;
    let dir = vault.dir().to_path_buf();

    let folders: Vec<ItemId> = (0..50)
        .map(|n| {
            vault
                .new_item(ItemKind::Collection, &format!("Folder {n}"), None)
                .unwrap()
        })
        .collect();
    let mut target = None;
    for n in 0..ITEMS {
        let kind = ItemKind::Login {
            username: format!("user{n}@example.com"),
            password: Zeroizing::new(format!("pw-{n}")),
            urls: vec![format!("https://site{n}.example.org/login")],
        };
        let folder = (n % 3 == 0).then(|| folders[n % folders.len()]);
        let id = vault
            .new_item(kind, &format!("Account number {n}"), folder)
            .unwrap();
        if n == 4_321 {
            target = Some(id);
        }
    }
    drop(vault);

    // The vault's own Argon2 cost, measured alone so it can be taken off the unlock time.
    let header = parse_header(&fs::read(dir.join(HEADER_FILE)).unwrap()).unwrap();
    let slot = header
        .slots
        .iter()
        .find(|s| s.slot_type == SlotType::Password)
        .unwrap();
    let start = Instant::now();
    derive_password_key(PW, &slot.salt, &slot.kdf.unwrap()).unwrap();
    let argon2 = start.elapsed();

    let start = Instant::now();
    let (vault, _) = Vault::unlock_with_password(&dir, PW).unwrap();
    let unlock = start.elapsed();
    let without_argon2 = unlock.saturating_sub(argon2);

    let start = Instant::now();
    let hits = vault.search("number 4321", 20);
    let query = start.elapsed();

    println!(
        "unlock {unlock:?}, argon2 {argon2:?}, unlock minus argon2 {without_argon2:?}, one query {query:?}"
    );
    assert_eq!(hits.first(), target.as_ref());
    assert!(
        without_argon2 < Duration::from_secs(3),
        "{without_argon2:?}"
    );
    assert!(query < Duration::from_millis(50), "{query:?}");
}
