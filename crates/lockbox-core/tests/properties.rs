//! Property tests (spec 5.4, 5.5): what goes in comes back out, and any malformed input is
//! an error, never a panic, with fixed error text that never repeats the input.
//!
//! Bad input comes in two kinds. Random bytes stop at the first check. A valid file with a
//! few bytes changed (the `*_survives_corruption` tests) gets past it into the deeper ones.

use lockbox_core::blob::{
    BLOB_VERSION, CHUNK_SIZE, CancelToken, blob_len, chunk_count, decrypt_stream, encrypt_stream,
};
use lockbox_core::header::{HEADER_FILE, parse_header};
use lockbox_core::ids::{FileId, ItemId, VaultId};
use lockbox_core::item::{FileRef, Item, ItemKind, open_item, seal_item};
use lockbox_core::recovery::RecoverySecret;
use lockbox_core::secret::{Key32, random_bytes};
use lockbox_core::{CoreError, Vault};
use proptest::collection::vec;
use proptest::option;
use proptest::prelude::*;
use proptest::sample::{Index, select};
use std::sync::LazyLock;
use zeroize::Zeroizing;

const CASES: u32 = 256;
const MAX_BLOB: usize = 3 * 1024 * 1024;
const VAULT_ID: VaultId = VaultId([0x11; 16]);
const ITEM_ID: ItemId = ItemId([0xAA; 16]);

fn key() -> Key32 {
    Key32::from_bytes([0x22; 32])
}

/// Items have no `PartialEq` (keys must not be compared casually); JSON covers every field.
fn json(item: &Item) -> serde_json::Value {
    serde_json::to_value(item).unwrap()
}

/// Any Unicode text, control characters included, of up to `max` characters.
fn text(max: usize) -> impl Strategy<Value = String> {
    vec(any::<char>(), 0..=max).prop_map(|chars| chars.into_iter().collect())
}

/// Random bytes of a length drawn from `len`, filled straight from the test's random
/// generator. A `vec(any::<u8>())` of megabytes is built element by element and takes about
/// a second per case in a debug build. The bytes do not shrink, which costs nothing here:
/// what makes a blob fail is its length, and that still shrinks.
fn random_bytes_of(len: impl Strategy<Value = usize>) -> impl Strategy<Value = Vec<u8>> {
    len.prop_perturb(|len, mut rng| {
        let mut bytes = vec![0u8; len];
        rng.fill_bytes(&mut bytes);
        bytes
    })
}

fn kind() -> impl Strategy<Value = ItemKind> {
    prop_oneof![
        (text(200), text(200), vec(text(200), 0..4)).prop_map(|(username, password, urls)| {
            ItemKind::Login {
                username,
                password: Zeroizing::new(password),
                urls,
            }
        }),
        Just(ItemKind::Note),
        Just(ItemKind::File),
        Just(ItemKind::Collection),
    ]
}

fn file_ref() -> impl Strategy<Value = FileRef> {
    (
        (
            any::<[u8; 16]>(),
            any::<u16>(),
            any::<u32>(),
            any::<[u8; 32]>(),
            any::<[u8; 19]>(),
        ),
        (any::<u64>(), any::<u64>(), text(100), text(50)),
    )
        .prop_map(
            |((id, blob_version, chunk_size, file_key, nonce_prefix), rest)| {
                let (length, chunk_count, name, media_type) = rest;
                FileRef {
                    file_id: FileId(id),
                    blob_version,
                    chunk_size,
                    file_key: Key32::from_bytes(file_key),
                    nonce_prefix,
                    length,
                    chunk_count,
                    name,
                    media_type,
                }
            },
        )
}

/// Any item that fits the 1 MiB limit: even if every character of the 100 000-character
/// note is a control character (6 bytes once escaped), the JSON stays near 610 000 bytes.
fn item() -> impl Strategy<Value = Item> {
    (
        (any::<[u8; 16]>(), kind(), text(200), text(100_000)),
        (
            option::of(any::<[u8; 16]>()),
            vec(file_ref(), 0..3),
            any::<u64>(),
            text(40),
            text(40),
        ),
        (
            option::of(text(40)),
            any::<bool>(),
            vec(any::<[u8; 16]>(), 0..4),
        ),
    )
        .prop_map(|(head, middle, tail)| {
            let (id, kind, title, notes) = head;
            let (collection, attachments, revision, created_at, modified_at) = middle;
            let (trashed_at, purging, retired) = tail;
            Item {
                id: ItemId(id),
                kind,
                title,
                notes: Zeroizing::new(notes),
                collection: collection.map(ItemId),
                attachments,
                revision,
                created_at,
                modified_at,
                trashed_at,
                purging,
                retired_blobs: retired.into_iter().map(FileId).collect(),
            }
        })
}

/// A record for a freshly made blob of `length` bytes.
fn file_ref_for(length: u64) -> FileRef {
    FileRef {
        file_id: FileId::random(),
        blob_version: BLOB_VERSION,
        chunk_size: CHUNK_SIZE,
        file_key: Key32::random(),
        nonce_prefix: random_bytes(),
        length,
        chunk_count: chunk_count(length),
        name: "file".into(),
        media_type: "application/octet-stream".into(),
    }
}

fn seal_blob(data: &[u8], fref: &FileRef) -> Vec<u8> {
    let mut sealed = Vec::new();
    encrypt_stream(
        &mut &*data,
        data.len() as u64,
        &mut sealed,
        &VAULT_ID,
        fref,
        &CancelToken::new(),
    )
    .unwrap();
    sealed
}

/// Opens `sealed`, which the caller declares to be `declared_len` bytes long.
fn open_blob(sealed: &[u8], declared_len: u64, fref: &FileRef) -> lockbox_core::Result<Vec<u8>> {
    let mut out = Vec::new();
    decrypt_stream(
        &mut &*sealed,
        declared_len,
        &mut out,
        &VAULT_ID,
        fref,
        &CancelToken::new(),
    )?;
    Ok(out)
}

/// `valid` with up to three bytes replaced (mostly by printable ASCII, so JSON stays JSON and
/// reaches the later checks), sometimes cut short, sometimes with extra bytes appended.
fn mangled(valid: &'static [u8]) -> impl Strategy<Value = Vec<u8>> {
    let replacement = prop_oneof![3 => 0x20u8..0x7f, 1 => any::<u8>()];
    (
        vec((any::<Index>(), replacement), 0..4),
        option::weighted(0.2, any::<Index>()),
        prop_oneof![4 => Just(Vec::new()), 1 => vec(any::<u8>(), 1..8)],
    )
        .prop_map(move |(edits, cut, tail)| {
            let mut bytes = valid.to_vec();
            for (at, byte) in edits {
                bytes[at.index(valid.len())] = byte;
            }
            if let Some(at) = cut {
                bytes.truncate(at.index(valid.len() + 1));
            }
            bytes.extend(tail);
            bytes
        })
}

static VALID_ITEM: LazyLock<Vec<u8>> = LazyLock::new(|| {
    let item = Item {
        id: ITEM_ID,
        kind: ItemKind::Login {
            username: "ariel".into(),
            password: Zeroizing::new("hunter2".into()),
            urls: vec!["https://example.com".into()],
        },
        title: "Example".into(),
        notes: Zeroizing::new("a note".into()),
        collection: None,
        attachments: vec![],
        revision: 1,
        created_at: "2026-10-13T00:00:00Z".into(),
        modified_at: "2026-10-13T00:00:00Z".into(),
        trashed_at: None,
        purging: false,
        retired_blobs: vec![],
    };
    seal_item(&item, &VAULT_ID, &key()).unwrap()
});

/// A small blob (one chunk) and its record. Multi-chunk damage is covered in `blob.rs`.
static VALID_BLOB: LazyLock<(FileRef, Vec<u8>)> = LazyLock::new(|| {
    let fref = file_ref_for(3000);
    let sealed = seal_blob(&[7; 3000], &fref);
    (fref, sealed)
});

/// A real `vault.json`, so changes to it reach the slot and settings checks.
static VALID_HEADER: LazyLock<Vec<u8>> = LazyLock::new(|| {
    let parent = tempfile::tempdir().unwrap();
    let created = Vault::create(parent.path(), "Family", "correct horse battery").unwrap();
    std::fs::read(created.vault.dir().join(HEADER_FILE)).unwrap()
});

static VALID_RECOVERY: LazyLock<String> =
    LazyLock::new(|| RecoverySecret::generate().to_display().to_string());

/// Error text is fixed (rule R5): neither `Display` nor `Debug` of the error may contain the
/// input, as text or as any 8 bytes of it. Inputs under 8 bytes are skipped; they could match
/// the fixed words by chance.
fn assert_text_is_fixed(error: &CoreError, input: &[u8]) -> Result<(), TestCaseError> {
    if input.len() < 8 {
        return Ok(());
    }
    for (kind, message) in [
        ("Display", error.to_string()),
        ("Debug", format!("{error:?}")),
    ] {
        prop_assert!(
            !message.contains(&*String::from_utf8_lossy(input)),
            "{kind} text {message:?} contains the input"
        );
        for window in message.as_bytes().windows(8) {
            prop_assert!(
                !input.windows(8).any(|part| part == window),
                "{kind} text {message:?} repeats 8 bytes of the input"
            );
        }
    }
    Ok(())
}

/// The input must be refused, with fixed text.
fn assert_refused<T>(result: lockbox_core::Result<T>, input: &[u8]) -> Result<(), TestCaseError> {
    match result {
        Ok(_) => Err(TestCaseError::fail("malformed input was accepted")),
        Err(error) => assert_text_is_fixed(&error, input),
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(CASES))]

    #[test]
    fn item_round_trip_any_content(item in item()) {
        let sealed = seal_item(&item, &VAULT_ID, &key()).unwrap();
        let opened = open_item(&sealed, &item.id, &VAULT_ID, &key()).unwrap();
        prop_assert_eq!(json(&opened), json(&item));
    }

    /// Half the cases sit on a chunk edge (1 MiB less 1, exactly, and plus 1), where
    /// off-by-one mistakes live; a uniform length would almost never land there.
    #[test]
    fn blob_round_trip_any_bytes_up_to_3_mib(
        data in random_bytes_of(prop_oneof![
            0..=MAX_BLOB,
            select(vec![
                0, 1, 1_048_575, 1_048_576, 1_048_577, 2_097_151, 2_097_152, 2_097_153,
                3_145_727, 3_145_728,
            ]),
        ])
    ) {
        let fref = file_ref_for(data.len() as u64);
        let sealed = seal_blob(&data, &fref);
        prop_assert_eq!(sealed.len() as u64, blob_len(data.len() as u64));
        prop_assert_eq!(open_blob(&sealed, sealed.len() as u64, &fref).unwrap(), data);
    }

    #[test]
    fn parse_header_never_panics(bytes in vec(any::<u8>(), 0..=2048)) {
        assert_refused(parse_header(&bytes), &bytes)?;
    }

    #[test]
    fn open_item_never_panics(
        bytes in prop_oneof![
            vec(any::<u8>(), 0..=2048),
            // A well-formed start (magic, version 1), so the decryption itself is reached.
            vec(any::<u8>(), 0..=2048).prop_map(|rest| [b"LBXI\x01\x00".as_slice(), &rest].concat()),
        ]
    ) {
        assert_refused(open_item(&bytes, &ITEM_ID, &VAULT_ID, &key()), &bytes)?;
    }

    #[test]
    fn decrypt_stream_never_panics(bytes in vec(any::<u8>(), 0..=2048)) {
        // A record whose size matches the input (a blob is its data plus 16 bytes), so the
        // size check passes and the chunk is what gets rejected.
        let fref = file_ref_for((bytes.len() as u64).saturating_sub(16));
        assert_refused(open_blob(&bytes, bytes.len() as u64, &fref), &bytes)?;
    }

    #[test]
    fn recovery_parse_never_panics(input in text(200)) {
        assert_refused(RecoverySecret::parse(&input), input.as_bytes())?;
    }

    #[test]
    fn parse_header_survives_corruption(bytes in mangled(&VALID_HEADER[..])) {
        // A change that keeps the header valid (a letter of the name) is fine either way.
        if let Err(error) = parse_header(&bytes) {
            assert_text_is_fixed(&error, &bytes)?;
        }
    }

    #[test]
    fn open_item_survives_corruption(bytes in mangled(&VALID_ITEM[..])) {
        let result = open_item(&bytes, &ITEM_ID, &VAULT_ID, &key());
        if bytes == *VALID_ITEM {
            prop_assert!(result.is_ok());
        } else {
            assert_refused(result, &bytes)?;
        }
    }

    #[test]
    fn decrypt_stream_survives_corruption(bytes in mangled(&VALID_BLOB.1[..])) {
        // The size the record promises, not the size of what arrived: a blob that is cut or
        // extended passes the size check and fails in the read loop, where the real bytes
        // run out or are left over.
        let declared = blob_len(VALID_BLOB.0.length);
        let result = open_blob(&bytes, declared, &VALID_BLOB.0);
        if bytes == VALID_BLOB.1 {
            prop_assert!(result.is_ok());
        } else {
            assert_refused(result, &bytes)?;
        }
    }

    #[test]
    fn recovery_parse_survives_corruption(bytes in mangled(VALID_RECOVERY.as_bytes())) {
        // A typo can still leave a key that reads (another letter that means the same, or a
        // one-in-16 checksum match), so only the error text is checked.
        let input = String::from_utf8_lossy(&bytes);
        if let Err(error) = RecoverySecret::parse(&input) {
            assert_text_is_fixed(&error, input.as_bytes())?;
        }
    }
}
