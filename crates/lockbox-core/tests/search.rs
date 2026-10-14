//! Search at scale through the public API. Slow (it writes 5 000 sealed files and runs real
//! Argon2 once), so it is ignored by default:
//! `cargo test --release --locked -p lockbox-core --test search -- --ignored --nocapture`

use lockbox_core::Vault;
use lockbox_core::ids::ItemId;
use lockbox_core::item::ItemKind;
use std::time::{Duration, Instant};
use zeroize::Zeroizing;

const PW: &str = "correct horse battery";
const ITEMS: usize = 5_000;

#[test]
#[ignore = "slow: run with --release -- --ignored"]
fn five_thousand_items_fast() {
    let parent = tempfile::tempdir().unwrap();
    let created = Vault::create(parent.path(), "Big", PW).unwrap();
    let (mut vault, recovery) = (created.vault, created.recovery);
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

    // The recovery unlock runs no Argon2, so this times loading and indexing alone.
    let start = Instant::now();
    let (vault, _) = Vault::unlock_with_recovery(&dir, &recovery).unwrap();
    let unlock = start.elapsed();

    let start = Instant::now();
    let hits = vault.search("number 4321", 20);
    let query = start.elapsed();

    println!("unlock (no Argon2) {unlock:?}, one query {query:?}");
    assert_eq!(hits.first(), target.as_ref());
    assert!(unlock < Duration::from_secs(3), "{unlock:?}");
    assert!(query < Duration::from_millis(50), "{query:?}");
}
