//! Items: the saved entries (logins, notes, file records, collections), each sealed into
//! its own encrypted file (spec 5.4).
//!
//! File layout: `"LBXI"` | item_version (u16 LE) | nonce (24) | ciphertext. The plaintext is
//! the item's JSON, then `0x80`, then zeros up to a multiple of 512 bytes, so a file's size
//! reveals only a size bucket. The AD binds the version, vault and item id, so a file cannot
//! be moved to another slot or vault unnoticed.
//!
//! Known limit: `serde_json` copies a JSON string that contains escape sequences (`\"`, `\\`, `\n`,
//! tabs and other control characters) through scratch buffers it does not wipe. Plain strings
//! (non-English letters are not escaped, so they count as plain) are copied straight into the
//! wiped fields.

use crate::ad::{encode_ad, v16};
use crate::aead;
use crate::error::{CoreError, Result};
use crate::ids::{FileId, ItemId, VaultId};
use crate::limits::{MAX_JSON_DEPTH, check_json};
use crate::secret::{Key32, random_bytes};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::{fmt, io};
use zeroize::Zeroizing;

/// The item file format version written today.
pub const ITEM_VERSION: u16 = 1;
/// Longest item JSON accepted or produced, in bytes.
pub const MAX_ITEM_JSON: usize = 1_048_576;
/// Largest item file accepted: the maximum JSON plus room for padding, tag and header.
pub const MAX_ITEM_FILE: usize = MAX_ITEM_JSON + 1024;

const MAGIC: &[u8; 4] = b"LBXI";
const HEADER_LEN: usize = 4 + 2 + 24;
const TAG_LEN: usize = 16;
const BUCKET: usize = 512;
const DAMAGED: CoreError = CoreError::Damaged { what: "item" };

/// What an item is. Its JSON is `KindWire`'s.
#[derive(Clone)]
pub enum ItemKind {
    Login {
        username: String,
        password: Zeroizing<String>,
        urls: Vec<String>,
    },
    Note,
    File,
    Collection,
}

impl ItemKind {
    fn name(&self) -> &'static str {
        match self {
            Self::Login { .. } => "login",
            Self::Note => "note",
            Self::File => "file",
            Self::Collection => "collection",
        }
    }
}

// Shows the kind name only: a login's username, password and URLs stay out of logs.
impl fmt::Debug for ItemKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

/// Where an attached file's encrypted blob is and how to open it. The key is secret, and it and
/// the other fields that open the blob stay inside the engine. Its JSON is `FileRefWire`'s.
pub struct FileRef {
    pub file_id: FileId,
    pub(crate) blob_version: u16,
    pub(crate) chunk_size: u32,
    pub(crate) file_key: Key32,
    pub(crate) nonce_prefix: [u8; 19],
    pub length: u64,
    pub chunk_count: u64,
    pub name: String,
    pub media_type: String,
}

// `Key32` is deliberately not `Clone`; the copy is written straight into a wiped buffer.
impl Clone for FileRef {
    fn clone(&self) -> Self {
        let file_key = Key32::fill_with(|key| {
            key.copy_from_slice(self.file_key.as_bytes());
            Ok(())
        })
        .expect("copying a key cannot fail");
        Self {
            file_id: self.file_id,
            blob_version: self.blob_version,
            chunk_size: self.chunk_size,
            file_key,
            nonce_prefix: self.nonce_prefix,
            length: self.length,
            chunk_count: self.chunk_count,
            name: self.name.clone(),
            media_type: self.media_type.clone(),
        }
    }
}

// Id and size only: not the key, and not the file name.
impl fmt::Debug for FileRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FileRef")
            .field("file_id", &self.file_id)
            .field("length", &self.length)
            .finish_non_exhaustive()
    }
}

/// A file key as standard padded base64, encoded and decoded inside wiped buffers.
mod file_key_b64 {
    use crate::secret::Key32;
    use base64::{Engine, engine::general_purpose::STANDARD};
    use serde::{Deserialize, Deserializer, Serializer};
    use zeroize::Zeroizing;

    const BAD: &str = "invalid file key";

    pub fn serialize<S: Serializer>(key: &Key32, s: S) -> Result<S::Ok, S::Error> {
        let mut text = Zeroizing::new([0u8; 44]); // 32 bytes -> 44 base64 characters
        STANDARD
            .encode_slice(key.as_bytes(), &mut *text)
            .map_err(|_| serde::ser::Error::custom(BAD))?;
        s.serialize_str(std::str::from_utf8(&*text).map_err(|_| serde::ser::Error::custom(BAD))?)
    }

    /// Rejects bad base64 and any length other than 32 bytes, with fixed error text.
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Key32, D::Error> {
        let err = || serde::de::Error::custom(BAD);
        let text = Zeroizing::<String>::deserialize(d)?;
        let mut bytes = Zeroizing::new([0u8; 33]); // the decoder's estimate for 44 characters
        let len = STANDARD
            .decode_slice(text.as_bytes(), &mut *bytes)
            .map_err(|_| err())?;
        if len != 32 {
            return Err(err());
        }
        Key32::fill_with(|key| {
            key.copy_from_slice(&bytes[..32]);
            Ok(())
        })
        .map_err(|_| err())
    }
}

/// One saved entry. `Debug` shows only the id, kind name and revision. Its JSON is `ItemWire`'s.
#[derive(Clone)]
pub struct Item {
    pub id: ItemId,
    pub kind: ItemKind,
    pub title: String,
    pub notes: Zeroizing<String>,
    pub collection: Option<ItemId>,
    pub attachments: Vec<FileRef>,
    pub revision: u64,
    pub created_at: String,
    pub modified_at: String,
    pub trashed_at: Option<String>,
    pub purging: bool,
    pub retired_blobs: Vec<FileId>,
}

impl fmt::Debug for Item {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Item")
            .field("id", &self.id)
            .field("kind", &self.kind)
            .field("revision", &self.revision)
            .finish_non_exhaustive()
    }
}

// The JSON of an item file. `Item`, `ItemKind` and `FileRef` have no serde of their own, so no
// code outside the engine can serialise one (a password or file key on its way to the screen).
// These crate-private mirrors (serde's remote derive) read and write the real types directly, with
// no copy in between; their names, order and attributes are the item format
// (`plaintext_golden_bytes`, `file_ref_json_is_pinned`).

/// An `Item`'s JSON.
#[derive(Serialize, Deserialize)]
#[serde(remote = "Item", deny_unknown_fields)]
struct ItemWire {
    id: ItemId,
    #[serde(with = "KindWire")]
    kind: ItemKind,
    title: String,
    notes: Zeroizing<String>,
    collection: Option<ItemId>,
    #[serde(with = "file_refs")]
    attachments: Vec<FileRef>,
    revision: u64,
    created_at: String,
    modified_at: String,
    trashed_at: Option<String>,
    purging: bool,
    retired_blobs: Vec<FileId>,
}

/// An `ItemKind`'s JSON. Externally tagged, so a login reads straight into its wiped fields:
/// `"note"` / `"file"` / `"collection"`, or `{"login": {"username": .., "password": .., "urls": [..]}}`.
/// (An internally tagged enum would buffer every field, password included, in serde's
/// unwiped private `Content` type first.)
#[derive(Serialize, Deserialize)]
#[serde(remote = "ItemKind", rename_all = "lowercase", deny_unknown_fields)]
enum KindWire {
    Login {
        username: String,
        password: Zeroizing<String>,
        urls: Vec<String>,
    },
    Note,
    File,
    Collection,
}

/// A `FileRef`'s JSON.
#[derive(Serialize, Deserialize)]
#[serde(remote = "FileRef", deny_unknown_fields)]
struct FileRefWire {
    file_id: FileId,
    blob_version: u16,
    chunk_size: u32,
    #[serde(with = "file_key_b64")]
    file_key: Key32,
    #[serde(with = "crate::serde_b64")]
    nonce_prefix: [u8; 19],
    length: u64,
    chunk_count: u64,
    name: String,
    media_type: String,
}

/// Serialises an `Item` through [`ItemWire`].
struct ItemOut<'a>(&'a Item);

impl Serialize for ItemOut<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        ItemWire::serialize(self.0, s)
    }
}

/// Reads an `Item` through [`ItemWire`].
struct ItemIn(Item);

impl<'de> Deserialize<'de> for ItemIn {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        ItemWire::deserialize(d).map(ItemIn)
    }
}

/// Serialises a `FileRef` through [`FileRefWire`].
struct FileRefOut<'a>(&'a FileRef);

impl Serialize for FileRefOut<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        FileRefWire::serialize(self.0, s)
    }
}

/// Reads a `FileRef` through [`FileRefWire`].
struct FileRefIn(FileRef);

impl<'de> Deserialize<'de> for FileRefIn {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        FileRefWire::deserialize(d).map(FileRefIn)
    }
}

/// `attachments` as a JSON array of [`FileRefWire`], built element by element like serde's own
/// `Vec` (no second vector, so no extra copy of a file key).
mod file_refs {
    use super::{FileRef, FileRefIn, FileRefOut};
    use serde::de::{SeqAccess, Visitor};
    use serde::{Deserializer, Serializer};
    use std::fmt;

    pub fn serialize<S: Serializer>(refs: &[FileRef], s: S) -> Result<S::Ok, S::Error> {
        s.collect_seq(refs.iter().map(FileRefOut))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<FileRef>, D::Error> {
        struct Refs;

        impl<'de> Visitor<'de> for Refs {
            type Value = Vec<FileRef>;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a sequence")
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Vec<FileRef>, A::Error> {
                // serde's own `Vec` reserves what the format promises, up to 1 MiB.
                let cap = seq.size_hint().unwrap_or(0);
                let mut refs = Vec::with_capacity(cap.min(1024 * 1024 / size_of::<FileRef>()));
                while let Some(FileRefIn(fref)) = seq.next_element()? {
                    refs.push(fref);
                }
                Ok(refs)
            }
        }

        d.deserialize_seq(Refs)
    }
}

/// The authenticated data for an item file (spec 5.1).
fn item_ad(vault_id: &VaultId, item_id: &ItemId) -> Vec<u8> {
    encode_ad(
        "lockbox/item",
        &[&v16(ITEM_VERSION), &vault_id.0, &item_id.0],
    )
}

/// Writes into a vector that must never grow: a reallocation would leave an unwiped copy of
/// the item in freed memory. Fails at the JSON size limit instead.
struct Bounded<'a>(&'a mut Vec<u8>);

impl io::Write for Bounded<'_> {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        if self.0.len() + data.len() > MAX_ITEM_JSON {
            return Err(io::Error::other("item too large"));
        }
        self.0.extend_from_slice(data);
        Ok(data.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// The item's JSON, then `0x80` and zeros up to a multiple of 512, in a wiped vector with
/// room for the largest padded plaintext plus the AEAD tag (so later steps never reallocate).
fn padded_plaintext(item: &Item) -> Result<Zeroizing<Vec<u8>>> {
    let mut buf = Zeroizing::new(Vec::with_capacity(MAX_ITEM_JSON + BUCKET + TAG_LEN));
    serde_json::to_writer(Bounded(&mut buf), &ItemOut(item)).map_err(|e| {
        if e.is_io() {
            CoreError::TooLarge { what: "item" }
        } else {
            CoreError::InvalidInput { what: "item" }
        }
    })?;
    buf.push(0x80);
    let padded_len = buf.len().next_multiple_of(BUCKET);
    buf.resize(padded_len, 0);
    Ok(buf)
}

/// True when `a` and `b` are the same item in every field. `Item` has no `PartialEq` (a file
/// key is not compared with `==`), so this compares what is written to disk: the JSON of all
/// fields (none is skipped), padded the same way.
pub fn same_item(a: &Item, b: &Item) -> bool {
    matches!((padded_plaintext(a), padded_plaintext(b)), (Ok(a), Ok(b)) if a == b)
}

/// Strict inverse of the padding: JSON, one `0x80`, then zeros to the next multiple of 512.
fn unpad(plain: &[u8]) -> Result<&[u8]> {
    match plain.iter().rposition(|&b| b != 0) {
        // Exactly the padding `seal_item` writes: no extra all-zero buckets.
        Some(end) if plain[end] == 0x80 && plain.len() == (end + 1).next_multiple_of(BUCKET) => {
            Ok(&plain[..end])
        }
        _ => Err(DAMAGED),
    }
}

/// Encrypts `item` into the bytes of its item file, with a fresh random nonce.
pub fn seal_item(item: &Item, vault_id: &VaultId, vault_key: &Key32) -> Result<Vec<u8>> {
    let mut buf = padded_plaintext(item)?;
    let capacity = buf.capacity();
    let nonce = random_bytes::<24>();
    aead::encrypt_in_place(vault_key, &nonce, &item_ad(vault_id, &item.id), &mut buf);
    debug_assert_eq!(buf.capacity(), capacity, "sealing must not reallocate");
    let mut out = Vec::with_capacity(HEADER_LEN + buf.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&v16(ITEM_VERSION));
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&buf);
    Ok(out)
}

/// Decrypts an item file that must be the item `expected_id` of this vault. Any failure to
/// authenticate or parse is `Damaged`; it is never `WrongPassword`, since the key was
/// already proven when the vault unlocked.
pub fn open_item(
    bytes: &[u8],
    expected_id: &ItemId,
    vault_id: &VaultId,
    vault_key: &Key32,
) -> Result<Item> {
    if bytes.len() > MAX_ITEM_FILE {
        return Err(CoreError::TooLarge { what: "item" });
    }
    let (header, ciphertext) = bytes.split_at_checked(HEADER_LEN).ok_or(DAMAGED)?;
    if &header[..4] != MAGIC {
        return Err(DAMAGED);
    }
    if header[4..6] != v16(ITEM_VERSION) {
        return Err(CoreError::UnsupportedVersion);
    }
    let nonce: [u8; 24] = header[6..].try_into().map_err(|_| DAMAGED)?;

    let mut buf = Zeroizing::new(Vec::with_capacity(ciphertext.len()));
    buf.extend_from_slice(ciphertext);
    aead::decrypt_in_place(vault_key, &nonce, &item_ad(vault_id, expected_id), &mut buf)
        .map_err(|_| DAMAGED)?;

    let json = unpad(&buf)?;
    check_json(json, MAX_ITEM_JSON, MAX_JSON_DEPTH)?;
    // serde_json's own messages can quote the value that failed, so none of them are passed on.
    let ItemIn(item) = serde_json::from_slice(json).map_err(|_| DAMAGED)?;
    // The AD already binds the id; checking it again costs nothing.
    if item.id != *expected_id {
        return Err(DAMAGED);
    }
    Ok(item)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAX_JSON: usize = 1_048_576;

    fn vault() -> (VaultId, Key32) {
        (VaultId([0x11; 16]), Key32::from_bytes([0x22; 32]))
    }

    fn base(kind: ItemKind) -> Item {
        Item {
            id: ItemId([0xAA; 16]),
            kind,
            title: "Example".into(),
            notes: Zeroizing::new("n".into()),
            collection: None,
            attachments: vec![],
            revision: 3,
            created_at: "2026-10-09T00:00:00Z".into(),
            modified_at: "2026-10-09T00:00:01Z".into(),
            trashed_at: None,
            purging: false,
            retired_blobs: vec![],
        }
    }

    fn login() -> Item {
        base(ItemKind::Login {
            username: "ariel".into(),
            password: Zeroizing::new("hunter2".into()),
            urls: vec!["https://example.com".into()],
        })
    }

    fn file_ref() -> FileRef {
        FileRef {
            file_id: FileId([0x33; 16]),
            blob_version: 1,
            chunk_size: 1_048_576,
            file_key: Key32::from_bytes([0x42; 32]),
            nonce_prefix: [7; 19],
            length: 5_000_000,
            chunk_count: 5,
            name: "tax.pdf".into(),
            media_type: "application/pdf".into(),
        }
    }

    /// Items have no `PartialEq` (keys must not be compared casually); JSON covers every field.
    fn json(item: &Item) -> serde_json::Value {
        serde_json::to_value(ItemOut(item)).unwrap()
    }

    #[test]
    fn same_item_sees_every_field() {
        let mut full = login();
        full.attachments = vec![file_ref()];
        assert!(same_item(&full, &full.clone()));

        type Edit = fn(&mut Item);
        let edits: [(&str, Edit); 9] = [
            ("title", |i| i.title.push('x')),
            ("notes", |i| i.notes.push('x')),
            ("collection", |i| i.collection = Some(ItemId([1; 16]))),
            ("revision", |i| i.revision += 1),
            ("modified_at", |i| i.modified_at.push('x')),
            ("trashed_at", |i| i.trashed_at = Some("t".into())),
            ("purging", |i| i.purging = true),
            ("retired", |i| i.retired_blobs.push(FileId([9; 16]))),
            ("file key", |i| {
                i.attachments[0].file_key = Key32::from_bytes([0x43; 32]);
            }),
        ];
        for (what, edit) in edits {
            let mut other = full.clone();
            edit(&mut other);
            assert!(!same_item(&full, &other), "{what}");
        }
        let mut other = full.clone();
        other.attachments[0].file_id = FileId([0x34; 16]);
        assert!(!same_item(&full, &other), "attachment id");
        other = full.clone();
        if let ItemKind::Login { username, .. } = &mut other.kind {
            username.push('x');
        }
        assert!(!same_item(&full, &other), "login username");
    }

    fn json_len(item: &Item) -> usize {
        serde_json::to_vec(&ItemOut(item)).unwrap().len()
    }

    /// A note whose JSON is exactly `n` bytes (plain ASCII notes, so no escaping).
    fn note_with_json_len(n: usize) -> Item {
        let mut item = base(ItemKind::Note);
        item.notes = Zeroizing::new(String::new());
        let extra = n - json_len(&item);
        item.notes = Zeroizing::new("a".repeat(extra));
        assert_eq!(json_len(&item), n);
        item
    }

    fn pad(json: &[u8]) -> Vec<u8> {
        let mut out = json.to_vec();
        out.push(0x80);
        out.resize(out.len().div_ceil(512) * 512, 0);
        out
    }

    /// Seals arbitrary plaintext as an item file, with `ad_id` in the AD (for malformed-file tests).
    fn seal_raw(plain: &[u8], ad_id: &ItemId, vault_id: &VaultId, key: &Key32) -> Vec<u8> {
        let nonce = [5u8; 24];
        let mut buf = plain.to_vec();
        crate::aead::encrypt_in_place(key, &nonce, &item_ad(vault_id, ad_id), &mut buf);
        let mut out = b"LBXI".to_vec();
        out.extend(1u16.to_le_bytes());
        out.extend(nonce);
        out.extend(buf);
        out
    }

    /// Reads an `ItemKind` through `KindWire`, the way `serde_json::from_str` reads a type.
    fn kind_from(text: &str) -> serde_json::Result<ItemKind> {
        let mut de = serde_json::Deserializer::from_str(text);
        let kind = KindWire::deserialize(&mut de)?;
        de.end()?;
        Ok(kind)
    }

    fn open(bytes: &[u8]) -> crate::Result<Item> {
        let (v, k) = vault();
        open_item(bytes, &ItemId([0xAA; 16]), &v, &k)
    }

    #[test]
    fn round_trip_each_kind() {
        let (v, k) = vault();
        let mut with_extras = login();
        with_extras.collection = Some(ItemId([0xBB; 16]));
        with_extras.attachments = vec![file_ref(), file_ref()];
        with_extras.trashed_at = Some("2026-10-10T00:00:00Z".into());
        with_extras.purging = true;
        with_extras.retired_blobs = vec![FileId([0x44; 16])];
        for item in [
            login(),
            with_extras,
            base(ItemKind::Note),
            base(ItemKind::File),
            base(ItemKind::Collection),
        ] {
            let sealed = seal_item(&item, &v, &k).unwrap();
            assert_eq!(&sealed[..4], b"LBXI");
            assert_eq!(&sealed[4..6], &[1, 0]);
            let back = open_item(&sealed, &item.id, &v, &k).unwrap();
            assert_eq!(json(&back), json(&item));
        }
    }

    #[test]
    fn open_gives_back_the_secret_values() {
        let (v, k) = vault();
        let mut item = login();
        item.attachments = vec![file_ref()];
        let back = open_item(&seal_item(&item, &v, &k).unwrap(), &item.id, &v, &k).unwrap();
        assert_eq!(back.attachments[0].file_key.as_bytes(), &[0x42; 32]);
        match back.kind {
            ItemKind::Login { password, .. } => assert_eq!(password.as_str(), "hunter2"),
            _ => panic!("kind changed"),
        }
    }

    #[test]
    fn clone_copies_the_file_key() {
        let mut item = login();
        item.attachments = vec![file_ref()];
        let copy = item.clone();
        assert_eq!(json(&copy), json(&item));
        assert_eq!(copy.attachments[0].file_key.as_bytes(), &[0x42; 32]);
    }

    #[test]
    fn ciphertext_size_is_bucketed() {
        let (v, k) = vault();
        let size = |n| seal_item(&note_with_json_len(n), &v, &k).unwrap().len();
        let small = json_len(&base(ItemKind::Note));
        assert!(small < 400);
        assert_eq!(size(small), size(400));
        assert_eq!(size(400), 4 + 2 + 24 + 512 + 16);
        // 511 bytes of JSON still leaves room for the 0x80 marker; 512 does not.
        assert_eq!(size(511), size(400));
        assert_eq!(size(512), size(400) + 512);
        assert_eq!(size(600), size(400) + 512);
    }

    #[test]
    fn json_over_1_mib_rejected() {
        let (v, k) = vault();
        let at_limit = note_with_json_len(MAX_JSON);
        let sealed = seal_item(&at_limit, &v, &k).unwrap();
        assert!(sealed.len() <= MAX_JSON + 1024);
        let back = open_item(&sealed, &at_limit.id, &v, &k).unwrap();
        assert_eq!(back.notes.len(), at_limit.notes.len());

        let too_big = note_with_json_len(MAX_JSON + 1);
        assert!(matches!(
            seal_item(&too_big, &v, &k),
            Err(CoreError::TooLarge { what: "item" })
        ));
    }

    #[test]
    fn oversized_file_rejected_before_anything_else() {
        let bytes = vec![0u8; MAX_JSON + 1024 + 1];
        assert!(matches!(
            open(&bytes),
            Err(CoreError::TooLarge { what: "item" })
        ));
    }

    #[test]
    fn tamper_any_byte_damaged() {
        let (v, k) = vault();
        let sealed = seal_item(&base(ItemKind::Note), &v, &k).unwrap();
        for i in 0..sealed.len() {
            let mut bad = sealed.clone();
            bad[i] ^= 1;
            match (i, open(&bad)) {
                (4 | 5, Err(CoreError::UnsupportedVersion)) => {}
                (4 | 5, other) => panic!("byte {i}: {other:?}"),
                (_, Err(CoreError::Damaged { .. })) => {}
                (_, other) => panic!("byte {i}: {other:?}"),
            }
        }
    }

    #[test]
    fn truncated_or_extended_is_damaged() {
        let (v, k) = vault();
        let sealed = seal_item(&base(ItemKind::Note), &v, &k).unwrap();
        for len in (0..=46).chain([sealed.len() - 1]) {
            assert!(
                matches!(open(&sealed[..len]), Err(CoreError::Damaged { .. })),
                "len {len}"
            );
        }
        let mut longer = sealed.clone();
        longer.push(0);
        assert!(matches!(open(&longer), Err(CoreError::Damaged { .. })));
    }

    #[test]
    fn moved_item_detected() {
        let (v, k) = vault();
        let sealed = seal_item(&login(), &v, &k).unwrap();
        assert!(matches!(
            open_item(&sealed, &ItemId([0xCC; 16]), &v, &k),
            Err(CoreError::Damaged { what: "item" })
        ));
    }

    #[test]
    fn id_inside_must_match_even_if_the_ad_does() {
        let (v, k) = vault();
        let other = ItemId([0xCC; 16]);
        let json = serde_json::to_vec(&ItemOut(&login())).unwrap(); // says id AA
        let sealed = seal_raw(&pad(&json), &other, &v, &k); // sealed for CC
        assert!(matches!(
            open_item(&sealed, &other, &v, &k),
            Err(CoreError::Damaged { what: "item" })
        ));
    }

    #[test]
    fn other_vault_detected() {
        let (v, k) = vault();
        let sealed = seal_item(&login(), &v, &k).unwrap();
        let id = ItemId([0xAA; 16]);
        assert!(matches!(
            open_item(&sealed, &id, &VaultId([0x12; 16]), &k),
            Err(CoreError::Damaged { what: "item" })
        ));
    }

    #[test]
    fn wrong_key_is_damaged_never_wrong_password() {
        let (v, k) = vault();
        let sealed = seal_item(&login(), &v, &k).unwrap();
        let id = ItemId([0xAA; 16]);
        assert!(matches!(
            open_item(&sealed, &id, &v, &Key32::from_bytes([0x23; 32])),
            Err(CoreError::Damaged { what: "item" })
        ));
    }

    #[test]
    fn bad_padding_damaged() {
        let (v, k) = vault();
        let id = ItemId([0xAA; 16]);
        let json = serde_json::to_vec(&ItemOut(&base(ItemKind::Note))).unwrap();
        let mut no_marker = json.clone();
        no_marker.resize(512, 0);
        let mut not_bucketed = json.clone();
        not_bucketed.push(0x80);
        not_bucketed.resize(511, 0);
        let mut junk_after_marker = pad(&json);
        junk_after_marker[300] = 0x01;
        let mut double_marker = json.clone();
        double_marker.extend([0x80, 0x80]);
        double_marker.resize(512, 0);
        let mut deep = vec![b'['; 33];
        deep.extend(vec![b']'; 33]);
        for (what, plain) in [
            ("no marker", no_marker),
            ("not a multiple of 512", not_bucketed),
            ("junk after marker", junk_after_marker),
            ("double marker", double_marker),
            ("empty", vec![]),
            ("only zeros", vec![0; 512]),
            ("extra zero bucket", {
                let mut p = pad(&json);
                p.resize(p.len() + 512, 0);
                p
            }),
            ("no json", pad(b"")),
            ("trailing garbage", pad(&[json.as_slice(), b"x"].concat())),
            ("too deep", pad(&deep)),
        ] {
            let sealed = seal_raw(&plain, &id, &v, &k);
            assert!(
                matches!(
                    open_item(&sealed, &id, &v, &k),
                    Err(CoreError::Damaged { .. })
                ),
                "{what}"
            );
        }
    }

    #[test]
    fn debug_hides_password_and_notes() {
        let mut item = login();
        item.title = "Private Title".into();
        item.notes = Zeroizing::new("private-notes".into());
        item.attachments = vec![file_ref()];
        for out in [format!("{item:?}"), format!("{item:#?}")] {
            for secret in [
                "hunter2",
                "private-notes",
                "Private Title",
                "ariel",
                "example.com",
                "tax.pdf",
                "QkJC",
            ] {
                assert!(!out.contains(secret), "{secret} leaked in {out}");
            }
            assert!(out.contains("login"));
            assert!(out.contains('3')); // revision
        }
        let kind = format!("{:?}", item.kind);
        assert!(!kind.contains("hunter2") && !kind.contains("ariel"));
    }

    #[test]
    fn file_ref_debug_hides_key_and_name() {
        let out = format!("{:?}", file_ref());
        for secret in ["QkJC", "66", "tax.pdf", "application/pdf", "Key32"] {
            assert!(!out.contains(secret), "{secret} leaked in {out}");
        }
        assert!(out.contains("FileRef"));
    }

    #[test]
    fn kind_json_is_externally_tagged_and_lowercase() {
        for (item, tag) in [
            (base(ItemKind::Note), "note"),
            (base(ItemKind::File), "file"),
            (base(ItemKind::Collection), "collection"),
        ] {
            assert_eq!(json(&item)["kind"], tag);
        }
        let login = json(&login());
        assert_eq!(login["kind"]["login"]["username"], "ariel");
        assert_eq!(login["kind"]["login"]["password"], "hunter2");
    }

    #[test]
    fn unknown_fields_are_rejected_everywhere() {
        let mut item = json(&login());
        item["extra"] = 1.into();
        assert!(serde_json::from_value::<ItemIn>(item).is_err());

        let mut with_file = login();
        with_file.attachments = vec![file_ref()];
        let mut item = json(&with_file);
        item["attachments"][0]["extra"] = 1.into();
        assert!(serde_json::from_value::<ItemIn>(item).is_err());

        for kind in [
            r#"{"login":{"username":"","password":"","urls":[],"extra":1}}"#,
            r#"{"login":{"username":"","password":""}}"#, // missing field
            r#""login""#,                                 // login needs its fields
            r#"{"note":{}}"#,
            r#""Note""#,
            r#""other""#,
            r#"{"kind":"note"}"#, // the old internally tagged shape
        ] {
            assert!(kind_from(kind).is_err(), "{kind}");
        }
        for kind in [
            r#""note""#,
            r#""file""#,
            r#""collection""#,
            r#"{"login":{"username":"","password":"","urls":[]}}"#,
        ] {
            assert!(kind_from(kind).is_ok(), "{kind}");
        }
    }

    #[test]
    fn file_ref_json_is_pinned() {
        let text = serde_json::to_string(&FileRefOut(&file_ref())).unwrap();
        let expected = format!(
            concat!(
                r#"{{"file_id":"{}","blob_version":1,"chunk_size":1048576,"#,
                r#""file_key":"QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=","#,
                r#""nonce_prefix":"BwcHBwcHBwcHBwcHBwcHBwcHBw==","#,
                r#""length":5000000,"chunk_count":5,"#,
                r#""name":"tax.pdf","media_type":"application/pdf"}}"#
            ),
            "33".repeat(16)
        );
        assert_eq!(text, expected);
        let FileRefIn(back) = serde_json::from_str(&text).unwrap();
        assert_eq!(back.file_key.as_bytes(), &[0x42; 32]);
        assert_eq!(back.nonce_prefix, [7; 19]);
    }

    #[test]
    fn bad_file_key_rejected_with_fixed_text() {
        let good = serde_json::to_value(FileRefOut(&file_ref())).unwrap();
        // 4 bytes; not base64; 33 bytes; empty.
        for bad in [
            "QUFBQQ==",
            "SECRET-not-base64!",
            "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJC",
            "",
        ] {
            let mut v = good.clone();
            v["file_key"] = bad.into();
            let err = serde_json::from_value::<FileRefIn>(v)
                .map(|FileRefIn(fref)| fref)
                .unwrap_err()
                .to_string();
            assert!(err.contains("invalid file key"), "{err}");
            assert!(!err.contains("SECRET") && !err.contains("QUFB"), "{err}");
        }
    }

    #[test]
    fn item_ad_golden_bytes() {
        // Built by hand (not via encode_ad) so label, field order and sizes are pinned.
        let field = |out: &mut Vec<u8>, bytes: &[u8]| {
            out.extend((bytes.len() as u32).to_le_bytes());
            out.extend(bytes);
        };
        let mut expected = b"lockbox/item".to_vec();
        field(&mut expected, &[1, 0]); // item_version, u16 LE
        field(&mut expected, &[0x11; 16]); // vault_id
        field(&mut expected, &[0xAA; 16]); // item_id
        assert_eq!(item_ad(&VaultId([0x11; 16]), &ItemId([0xAA; 16])), expected);
    }

    #[test]
    fn plaintext_golden_bytes() {
        let expected_json = format!(
            concat!(
                r#"{{"id":"{}","kind":{{"login":{{"username":"ariel","password":"hunter2","urls":["https://example.com"]}}}},"#,
                r#""title":"Example","notes":"n","collection":null,"attachments":[],"revision":3,"#,
                r#""created_at":"2026-10-09T00:00:00Z","modified_at":"2026-10-09T00:00:01Z","#,
                r#""trashed_at":null,"purging":false,"retired_blobs":[]}}"#
            ),
            "aa".repeat(16)
        );
        let mut expected = expected_json.into_bytes();
        expected.push(0x80);
        expected.resize(512, 0);
        let plain = padded_plaintext(&login()).unwrap();
        assert_eq!(plain.as_slice(), expected.as_slice());
    }
}
