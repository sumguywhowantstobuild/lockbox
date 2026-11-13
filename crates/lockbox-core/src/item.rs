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

/// The most earlier passwords a login keeps: the sixth change drops the oldest.
pub const MAX_PREVIOUS_PASSWORDS: usize = 5;

/// A password a login had before it was changed, and when it was replaced (RFC 3339, UTC, as every date here). Only the
/// engine writes these: `update_item` moves the old password here on a real change. Wiped like the password in use, never
/// indexed for search, and never in `Debug`. Its JSON is `PreviousWire`'s.
#[derive(Clone)]
pub struct PreviousPassword {
    pub password: Zeroizing<String>,
    pub replaced_at: String,
}

// Nothing of it: not the password, and the date says when a password changed, which is enough to leave out of a log.
impl fmt::Debug for PreviousPassword {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PreviousPassword").finish_non_exhaustive()
    }
}

/// What an item is. Its JSON is `KindWire`'s.
#[derive(Clone)]
pub enum ItemKind {
    Login {
        username: String,
        password: Zeroizing<String>,
        urls: Vec<String>,
        /// Newest first, at most [`MAX_PREVIOUS_PASSWORDS`]. Left out of the JSON when empty, so a login without any
        /// writes the bytes it always did, and an older file without the field opens with none.
        previous_passwords: Vec<PreviousPassword>,
    },
    /// A named secret value (an API key, a token): the item's title is its name, a variable name (see
    /// [`check_key_name`]). The value is never indexed for search.
    Key {
        value: Zeroizing<String>,
    },
    Note,
    File,
    Collection,
}

impl ItemKind {
    fn name(&self) -> &'static str {
        match self {
            Self::Login { .. } => "login",
            Self::Key { .. } => "key",
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

/// Whether `name` can be a key's name: a variable name, since a `.env` file is where keys go out. Only the ASCII letters,
/// digits and `_`, not starting with a digit, and not empty; anything else is `InvalidInput { "key name" }`, which says
/// nothing of the name itself. The page's own limit on a title's length applies as it does to every title.
pub fn check_key_name(name: &str) -> Result<()> {
    let mut chars = name.chars();
    let starts = chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_');
    if starts && chars.all(|c| c.is_ascii_alphanumeric() || c == '_') {
        Ok(())
    } else {
        Err(CoreError::InvalidInput { what: "key name" })
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
    /// The folder this item was trashed together with, when it went to the trash because that folder was deleted. An ID,
    /// not a secret, and never indexed. Set only by `delete_collection` and cleared by any restore, so restoring the
    /// folder brings back the items that name it and no others.
    pub trashed_with: Option<ItemId>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    trashed_with: Option<ItemId>,
    purging: bool,
    retired_blobs: Vec<FileId>,
}

/// An `ItemKind`'s JSON. Externally tagged, so a login or a key reads straight into its wiped fields:
/// `"note"` / `"file"` / `"collection"`, `{"login": {"username": .., "password": .., "urls": [..]}}` (with a
/// `"previous_passwords"` list after `urls` only when it has some) or `{"key": {"value": ..}}`. (An internally tagged enum would buffer every field, password included, in serde's
/// unwiped private `Content` type first.) A kind added here changes no byte of what the others write.
#[derive(Serialize, Deserialize)]
#[serde(remote = "ItemKind", rename_all = "lowercase", deny_unknown_fields)]
enum KindWire {
    Login {
        username: String,
        password: Zeroizing<String>,
        urls: Vec<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty", with = "previous_list")]
        previous_passwords: Vec<PreviousPassword>,
    },
    Key {
        value: Zeroizing<String>,
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

/// A `PreviousPassword`'s JSON.
#[derive(Serialize, Deserialize)]
#[serde(remote = "PreviousPassword", deny_unknown_fields)]
struct PreviousWire {
    password: Zeroizing<String>,
    replaced_at: String,
}

/// Serialises a `PreviousPassword` through [`PreviousWire`].
struct PreviousOut<'a>(&'a PreviousPassword);

impl Serialize for PreviousOut<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        PreviousWire::serialize(self.0, s)
    }
}

/// Reads a `PreviousPassword` through [`PreviousWire`], straight into its wiped field.
struct PreviousIn(PreviousPassword);

impl<'de> Deserialize<'de> for PreviousIn {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        PreviousWire::deserialize(d).map(PreviousIn)
    }
}

/// `previous_passwords` as a JSON array of [`PreviousWire`], built element by element like serde's own `Vec` (no second
/// vector, so no extra copy of a password).
mod previous_list {
    use super::{PreviousIn, PreviousOut, PreviousPassword};
    use serde::de::{SeqAccess, Visitor};
    use serde::{Deserializer, Serializer};
    use std::fmt;

    pub fn serialize<S: Serializer>(list: &[PreviousPassword], s: S) -> Result<S::Ok, S::Error> {
        s.collect_seq(list.iter().map(PreviousOut))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<PreviousPassword>, D::Error> {
        struct List;

        impl<'de> Visitor<'de> for List {
            type Value = Vec<PreviousPassword>;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a sequence")
            }

            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> Result<Vec<PreviousPassword>, A::Error> {
                let mut list = Vec::new();
                while let Some(PreviousIn(old)) = seq.next_element()? {
                    list.push(old);
                }
                Ok(list)
            }
        }

        d.deserialize_seq(List)
    }
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
            trashed_with: None,
            purging: false,
            retired_blobs: vec![],
        }
    }

    fn login() -> Item {
        base(ItemKind::Login {
            username: "ariel".into(),
            password: Zeroizing::new("hunter2".into()),
            urls: vec!["https://example.com".into()],
            previous_passwords: vec![],
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
        let edits: [(&str, Edit); 10] = [
            ("title", |i| i.title.push('x')),
            ("notes", |i| i.notes.push('x')),
            ("collection", |i| i.collection = Some(ItemId([1; 16]))),
            ("revision", |i| i.revision += 1),
            ("modified_at", |i| i.modified_at.push('x')),
            ("trashed_at", |i| i.trashed_at = Some("t".into())),
            ("trashed_with", |i| i.trashed_with = Some(ItemId([2; 16]))),
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
        with_extras.trashed_with = Some(ItemId([0xBB; 16]));
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

        // A login with earlier passwords: the same bytes up to `urls`, then the list, newest first. Pinned here from the
        // first version of the field, as the key's bytes are.
        let expected_json = format!(
            concat!(
                r#"{{"id":"{}","kind":{{"login":{{"username":"ariel","password":"hunter2","urls":["https://example.com"],"#,
                r#""previous_passwords":[{{"password":"demo-old-one","replaced_at":"2026-10-09T00:00:02Z"}},"#,
                r#"{{"password":"demo-old-two","replaced_at":"2026-10-09T00:00:03Z"}}]}}}},"#,
                r#""title":"Example","notes":"n","collection":null,"attachments":[],"revision":3,"#,
                r#""created_at":"2026-10-09T00:00:00Z","modified_at":"2026-10-09T00:00:01Z","#,
                r#""trashed_at":null,"purging":false,"retired_blobs":[]}}"#
            ),
            "aa".repeat(16)
        );
        let mut expected = expected_json.into_bytes();
        expected.push(0x80);
        expected.resize(512, 0);
        let plain = padded_plaintext(&login_with_earlier()).unwrap();
        assert_eq!(plain.as_slice(), expected.as_slice());
        // It reads back as written, through the file too.
        let (v, k) = vault();
        let item = login_with_earlier();
        let back = open_item(&seal_item(&item, &v, &k).unwrap(), &item.id, &v, &k).unwrap();
        assert_eq!(
            padded_plaintext(&back).unwrap().as_slice(),
            expected.as_slice()
        );
        assert!(same_item(&item, &back));
        // The list is part of the item: another list is another item.
        let mut fewer = login_with_earlier();
        if let ItemKind::Login {
            previous_passwords, ..
        } = &mut fewer.kind
        {
            previous_passwords.pop();
        }
        assert!(!same_item(&item, &fewer));

        // An item trashed with its folder: `trashed_with` comes right after `trashed_at`, as the folder's ID in hex. Pinned
        // from the first version of the field; with none it is left out, which the blocks above prove.
        let mut with_folder = login();
        with_folder.collection = Some(ItemId([0xBB; 16]));
        with_folder.trashed_at = Some("2026-10-10T00:00:00Z".into());
        with_folder.trashed_with = Some(ItemId([0xBB; 16]));
        let expected_json = format!(
            concat!(
                r#"{{"id":"{}","kind":{{"login":{{"username":"ariel","password":"hunter2","urls":["https://example.com"]}}}},"#,
                r#""title":"Example","notes":"n","collection":"{}","attachments":[],"revision":3,"#,
                r#""created_at":"2026-10-09T00:00:00Z","modified_at":"2026-10-09T00:00:01Z","#,
                r#""trashed_at":"2026-10-10T00:00:00Z","trashed_with":"{}","purging":false,"retired_blobs":[]}}"#
            ),
            "aa".repeat(16),
            "bb".repeat(16),
            "bb".repeat(16)
        );
        let mut expected = expected_json.into_bytes();
        expected.push(0x80);
        expected.resize(512, 0);
        let plain = padded_plaintext(&with_folder).unwrap();
        assert_eq!(plain.as_slice(), expected.as_slice());
        let back = open_item(
            &seal_item(&with_folder, &v, &k).unwrap(),
            &with_folder.id,
            &v,
            &k,
        )
        .unwrap();
        assert_eq!(back.trashed_with, Some(ItemId([0xBB; 16])));
        assert!(same_item(&with_folder, &back));
        // And the same item without the field is a different item, and has no such word in its bytes.
        let mut without = with_folder.clone();
        without.trashed_with = None;
        assert!(!same_item(&with_folder, &without));
        let bytes = padded_plaintext(&without).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("trashed_with"));
    }

    /// `trashed_with` is a folder's ID and nothing else: any other shape is a damaged item, and `null` is the same as
    /// no field.
    #[test]
    fn trashed_with_must_be_an_id() {
        let (v, k) = vault();
        let id = ItemId([0xAA; 16]);
        let mut item = base(ItemKind::Note);
        item.trashed_at = Some("2026-10-10T00:00:00Z".into());
        item.trashed_with = Some(ItemId([0xBB; 16]));
        let good = serde_json::to_string(&ItemOut(&item)).unwrap();
        let field = format!(r#""trashed_with":"{}""#, "bb".repeat(16));
        assert!(good.contains(&field), "{good}");
        for (replacement, opens) in [
            (r#""trashed_with":null"#.to_owned(), true),
            (field.clone(), true),
            (r#""trashed_with":"zz""#.to_owned(), false),
            (r#""trashed_with":7"#.to_owned(), false),
            (r#""trashed_with":["bb"]"#.to_owned(), false),
            (r#""trashed_with":"""#.to_owned(), false),
        ] {
            let json = good.replace(&field, &replacement);
            let mut plain = json.into_bytes();
            plain.push(0x80);
            plain.resize(plain.len().div_ceil(512) * 512, 0);
            let sealed = seal_raw(&plain, &id, &v, &k);
            assert_eq!(
                open_item(&sealed, &id, &v, &k).is_ok(),
                opens,
                "{replacement}"
            );
        }
    }

    /// An earlier password, made up for these tests.
    fn earlier(password: &str, replaced_at: &str) -> PreviousPassword {
        PreviousPassword {
            password: Zeroizing::new(password.into()),
            replaced_at: replaced_at.into(),
        }
    }

    fn login_with_earlier() -> Item {
        base(ItemKind::Login {
            username: "ariel".into(),
            password: Zeroizing::new("hunter2".into()),
            urls: vec!["https://example.com".into()],
            previous_passwords: vec![
                earlier("demo-old-one", "2026-10-09T00:00:02Z"),
                earlier("demo-old-two", "2026-10-09T00:00:03Z"),
            ],
        })
    }

    /// An item file written before earlier passwords existed (`fixtures/old-items.txt`) opens with none, and written
    /// again it is the very bytes it was: the field is left out of the JSON when the list is empty. The field's own
    /// shape is strict.
    #[test]
    fn old_item_with_no_field_opens() {
        let (v, k) = vault();
        let id = ItemId([0xAA; 16]);
        let bytes = old_file("LOGIN");
        let login = open_item(&bytes, &id, &v, &k).unwrap();
        match &login.kind {
            ItemKind::Login {
                previous_passwords, ..
            } => assert!(previous_passwords.is_empty()),
            other => panic!("kind changed to {other:?}"),
        }
        // The plaintext the old code sealed, opened by hand, is what is written today.
        let nonce: [u8; 24] = bytes[6..HEADER_LEN].try_into().unwrap();
        let mut old_plain = Vec::from(&bytes[HEADER_LEN..]);
        aead::decrypt_in_place(&k, &nonce, &item_ad(&v, &id), &mut old_plain).unwrap();
        assert_eq!(
            padded_plaintext(&login).unwrap().as_slice(),
            old_plain.as_slice()
        );
        assert!(!String::from_utf8_lossy(&old_plain).contains("previous_passwords"));

        // With or without the field, an old shape and an empty list are the same login.
        for kind in [
            r#"{"login":{"username":"","password":"","urls":[]}}"#,
            r#"{"login":{"username":"","password":"","urls":[],"previous_passwords":[]}}"#,
            r#"{"login":{"username":"","password":"","urls":[],"previous_passwords":[{"password":"x","replaced_at":"t"}]}}"#,
        ] {
            assert!(kind_from(kind).is_ok(), "{kind}");
        }
        for kind in [
            // An entry has its two fields and no other.
            r#"{"login":{"username":"","password":"","urls":[],"previous_passwords":[{"password":"x"}]}}"#,
            r#"{"login":{"username":"","password":"","urls":[],"previous_passwords":[{"replaced_at":"t"}]}}"#,
            r#"{"login":{"username":"","password":"","urls":[],"previous_passwords":[{"password":"x","replaced_at":"t","extra":1}]}}"#,
            r#"{"login":{"username":"","password":"","urls":[],"previous_passwords":["x"]}}"#,
            r#"{"login":{"username":"","password":"","urls":[],"previous_passwords":null}}"#,
            // And only a login has the list.
            r#"{"key":{"value":"x","previous_passwords":[]}}"#,
        ] {
            assert!(kind_from(kind).is_err(), "{kind}");
        }
    }

    /// `Debug` shows nothing of an earlier password, alone or inside an item.
    #[test]
    fn previous_passwords_debug_shows_nothing() {
        let item = login_with_earlier();
        let alone = format!("{:?}", earlier("demo-old-one", "2026-10-09T00:00:02Z"));
        for out in [
            alone,
            format!("{item:?}"),
            format!("{item:#?}"),
            format!("{:?}", item.kind),
            format!("{:#?}", item.kind),
        ] {
            assert!(!out.contains("demo-old"), "a password leaked in {out}");
            assert!(!out.contains("hunter2"), "a password leaked in {out}");
        }
    }

    /// A key's value, made up for these tests.
    const KEY_VALUE: &str = "demo-zzz-qqq-one";

    fn key() -> Item {
        let mut item = base(ItemKind::Key {
            value: Zeroizing::new(KEY_VALUE.into()),
        });
        item.title = "OPENAI_API_KEY".into();
        item
    }

    /// A key reads back as it was written, through the file as well as through JSON, and its JSON is
    /// `{"key":{"value":..}}`: an externally tagged kind like a login, so the value reads straight into its wiped field.
    #[test]
    fn key_round_trips() {
        let (v, k) = vault();
        let item = key();
        assert_eq!(
            json(&item)["kind"],
            serde_json::json!({ "key": { "value": KEY_VALUE } })
        );
        let sealed = seal_item(&item, &v, &k).unwrap();
        let back = open_item(&sealed, &item.id, &v, &k).unwrap();
        assert_eq!(json(&back), json(&item));
        match &back.kind {
            ItemKind::Key { value } => assert_eq!(value.as_str(), KEY_VALUE),
            other => panic!("kind changed to {other:?}"),
        }
        assert_eq!(back.title, "OPENAI_API_KEY");
        // A different value is a different item.
        let mut other = key();
        other.kind = ItemKind::Key {
            value: Zeroizing::new("demo-zzz-qqq-two".into()),
        };
        assert!(same_item(&item, &item.clone()) && !same_item(&item, &other));
        // A value with quotes, backslashes, newlines and non-English text is kept exactly.
        let mut odd = key();
        let text = "line one\n\"two\" \\ ключ 鍵\t";
        odd.kind = ItemKind::Key {
            value: Zeroizing::new(text.into()),
        };
        let back = open_item(&seal_item(&odd, &v, &k).unwrap(), &odd.id, &v, &k).unwrap();
        assert!(matches!(&back.kind, ItemKind::Key { value } if value.as_str() == text));
        // The strict shapes: no other field, none missing, and not the old internally tagged shape.
        for kind in [
            r#"{"key":{"value":"x","extra":1}}"#,
            r#"{"key":{}}"#,
            r#""key""#,
            r#"{"key":"x"}"#,
            r#"{"Key":{"value":"x"}}"#,
        ] {
            assert!(kind_from(kind).is_err(), "{kind}");
        }
        assert!(kind_from(r#"{"key":{"value":""}}"#).is_ok());
    }

    #[test]
    fn key_debug_shows_no_value() {
        let item = key();
        for out in [
            format!("{item:?}"),
            format!("{item:#?}"),
            format!("{:?}", item.kind),
            format!("{:#?}", item.kind),
        ] {
            assert!(!out.contains(KEY_VALUE), "the value leaked in {out}");
            assert!(
                !out.contains("demo-zzz"),
                "part of the value leaked in {out}"
            );
            assert!(!out.contains("OPENAI_API_KEY"), "the name leaked in {out}");
            assert!(out.contains("key"), "{out}");
        }
        assert_eq!(format!("{:?}", item.kind), "key");
    }

    /// A key joins the others in the bytes it writes (pinned here from the first version of it), and the bytes the
    /// other kinds write are the ones `plaintext_golden_bytes` and `plaintext_golden_bytes_of_the_other_kinds` pin.
    #[test]
    fn key_golden_bytes() {
        let expected_json = format!(
            concat!(
                r#"{{"id":"{}","kind":{{"key":{{"value":"demo-zzz-qqq-one"}}}},"#,
                r#""title":"OPENAI_API_KEY","notes":"n","collection":null,"attachments":[],"revision":3,"#,
                r#""created_at":"2026-10-09T00:00:00Z","modified_at":"2026-10-09T00:00:01Z","#,
                r#""trashed_at":null,"purging":false,"retired_blobs":[]}}"#
            ),
            "aa".repeat(16)
        );
        let mut expected = expected_json.into_bytes();
        expected.push(0x80);
        expected.resize(512, 0);
        assert_eq!(
            padded_plaintext(&key()).unwrap().as_slice(),
            expected.as_slice()
        );
    }

    /// The item files of the four old kinds (`fixtures/old-items.txt`), sealed by the code before keys existed with the
    /// test vault's key, a fixed nonce and the ID `aa..aa`: they open as they did, and write back the same bytes once
    /// the JSON is the same (the format of the old kinds did not move).
    fn old_file(name: &str) -> Vec<u8> {
        let text = include_str!("fixtures/old-items.txt");
        let mut hex = String::new();
        let mut inside = false;
        for line in text.lines() {
            if line.chars().all(|c| c.is_ascii_uppercase()) {
                inside = line == name;
            } else if inside {
                hex.push_str(line);
            }
        }
        assert!(!hex.is_empty(), "no fixture named {name}");
        (0..hex.len())
            .step_by(2)
            .map(|at| u8::from_str_radix(&hex[at..at + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn old_format_items_still_open() {
        let (v, k) = vault();
        let id = ItemId([0xAA; 16]);

        let login = open_item(&old_file("LOGIN"), &id, &v, &k).unwrap();
        match &login.kind {
            ItemKind::Login {
                username,
                password,
                urls,
                previous_passwords,
            } => {
                assert!(previous_passwords.is_empty());
                assert_eq!(username, "ariel");
                assert_eq!(password.as_str(), "hunter2");
                assert_eq!(urls, &["https://example.com"]);
            }
            other => panic!("kind changed to {other:?}"),
        }
        assert_eq!(login.collection, Some(ItemId([0xBB; 16])));
        assert_eq!(login.attachments.len(), 1);
        assert_eq!(login.attachments[0].name, "tax.pdf");
        assert_eq!(login.attachments[0].file_key.as_bytes(), &[0x42; 32]);
        assert_eq!((login.title.as_str(), login.revision), ("Example", 3));

        for (name, check) in [
            (
                "NOTE",
                (|k: &ItemKind| matches!(k, ItemKind::Note)) as fn(&ItemKind) -> bool,
            ),
            ("FILE", |k| matches!(k, ItemKind::File)),
            ("COLLECTION", |k| matches!(k, ItemKind::Collection)),
        ] {
            let item = open_item(&old_file(name), &id, &v, &k).unwrap();
            assert!(check(&item.kind), "{name}: {:?}", item.kind);
            assert_eq!((item.title.as_str(), item.notes.as_str()), ("Example", "n"));
            assert!(item.attachments.is_empty() && item.collection.is_none());
        }

        // The same item written again today has the bytes the old code wrote in its plaintext.
        let again = open_item(&old_file("NOTE"), &id, &v, &k).unwrap();
        let old_plain = {
            let mut plain = serde_json::to_vec(&ItemOut(&base(ItemKind::Note))).unwrap();
            plain.push(0x80);
            plain.resize(512, 0);
            plain
        };
        assert_eq!(padded_plaintext(&again).unwrap().as_slice(), old_plain);
    }

    /// Every item file written before `trashed_with` existed (`fixtures/old-items.txt`) opens with none, and written again
    /// is the very bytes the old code sealed: nothing about the field shows when it is none.
    #[test]
    fn old_items_with_no_field_still_open() {
        let (v, k) = vault();
        let id = ItemId([0xAA; 16]);
        for name in ["LOGIN", "NOTE", "FILE", "COLLECTION"] {
            let bytes = old_file(name);
            let item = open_item(&bytes, &id, &v, &k).unwrap();
            assert!(item.trashed_with.is_none(), "{name}");
            let nonce: [u8; 24] = bytes[6..HEADER_LEN].try_into().unwrap();
            let mut old_plain = Vec::from(&bytes[HEADER_LEN..]);
            aead::decrypt_in_place(&k, &nonce, &item_ad(&v, &id), &mut old_plain).unwrap();
            assert_eq!(
                padded_plaintext(&item).unwrap().as_slice(),
                old_plain.as_slice(),
                "{name}"
            );
            assert!(!String::from_utf8_lossy(&old_plain).contains("trashed_with"));
        }
    }

    /// The name of a key is a variable name, since `.env` out is the point: ASCII letters, digits and `_`, not starting
    /// with a digit, not empty. Everything else is refused with the one fixed `what`, and nothing is said of the name.
    #[test]
    fn key_name_rules() {
        let long = "A".repeat(1024);
        for good in [
            "A",
            "a",
            "_",
            "__",
            "OPENAI_API_KEY",
            "openai_api_key",
            "key1",
            "_1",
            "A_b_2",
            "TELEGRAM_BOT_TOKEN",
            long.as_str(),
        ] {
            assert!(check_key_name(good).is_ok(), "{good}");
        }
        for bad in [
            "",
            " ",
            "1",
            "1KEY",
            "9_",
            "A-B",
            "A B",
            "A.B",
            "A=B",
            "A$",
            "$A",
            " A",
            "A ",
            "A\n",
            "A\r\n",
            "A\t",
            "A\0",
            "\u{7f}",
            "é",
            "Clé",
            "日本",
            "ＡＢＣ",      // full-width letters
            "A\u{200b}",   // a zero-width space
            "A\u{0301}",   // a combining accent
            "٣",           // an Arabic-Indic digit
            "KEY\u{ff3f}", // a full-width underscore
            "A/B",
            "A\\B",
            "A:B",
            "A,B",
            "\"A\"",
        ] {
            assert!(
                matches!(
                    check_key_name(bad),
                    Err(CoreError::InvalidInput { what: "key name" })
                ),
                "{bad:?}"
            );
        }
        // Every ASCII character one by one: only letters, digits and `_` pass, and a digit only after the first place.
        for byte in 0u8..=127 {
            let c = char::from(byte);
            let alone = check_key_name(&c.to_string()).is_ok();
            assert_eq!(alone, c.is_ascii_alphabetic() || c == '_', "{c:?} alone");
            let after = check_key_name(&format!("A{c}")).is_ok();
            assert_eq!(
                after,
                c.is_ascii_alphanumeric() || c == '_',
                "{c:?} after a letter"
            );
        }
        // The refusal says nothing of the name.
        let said = format!("{:?}", check_key_name("secret value 1").unwrap_err());
        assert!(!said.contains("secret"), "{said}");
    }

    /// The check keeps everything but a name out, whatever it is given: many odd texts never pass unless they are made
    /// of the allowed characters alone, and the slowest one is measured (no pattern engine to hang).
    #[test]
    fn key_name_check_only_ever_passes_names() {
        use std::time::{Duration, Instant};

        const PIECES: &[&str] = &[
            "A", "z", "_", "0", "9", "-", ".", " ", "\n", "\0", "=", "é", "日", "\u{200b}",
            "\u{0301}", "$", "/", "\\", "AB_", "KEY", "1", "٣",
        ];
        let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        let (mut accepted, mut slowest) = (0, Duration::ZERO);
        for _ in 0..30_000 {
            let pieces = 1 + (next() % 12) as usize;
            let name: String = (0..pieces)
                .map(|_| PIECES[(next() % PIECES.len() as u64) as usize])
                .collect();
            let started = Instant::now();
            let passed = check_key_name(&name).is_ok();
            slowest = slowest.max(started.elapsed());
            let only_allowed = name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                && !name.is_empty()
                && !name.starts_with(|c: char| c.is_ascii_digit());
            assert_eq!(passed, only_allowed, "{name:?}");
            accepted += usize::from(passed);
        }
        assert!(
            accepted > 500,
            "only {accepted} passed: the mass is not varied enough"
        );
        assert!(
            slowest < Duration::from_millis(100),
            "the slowest took {slowest:?}"
        );
    }

    /// The bytes a note, a file and a folder write are pinned too, taken from the code before keys existed: adding a kind
    /// must not change what the others write.
    #[test]
    fn plaintext_golden_bytes_of_the_other_kinds() {
        for (kind, expected_kind) in [
            (ItemKind::Note, r#""note""#),
            (ItemKind::File, r#""file""#),
            (ItemKind::Collection, r#""collection""#),
        ] {
            let expected_json = format!(
                concat!(
                    r#"{{"id":"{}","kind":{},"#,
                    r#""title":"Example","notes":"n","collection":null,"attachments":[],"revision":3,"#,
                    r#""created_at":"2026-10-09T00:00:00Z","modified_at":"2026-10-09T00:00:01Z","#,
                    r#""trashed_at":null,"purging":false,"retired_blobs":[]}}"#
                ),
                "aa".repeat(16),
                expected_kind
            );
            let mut expected = expected_json.into_bytes();
            expected.push(0x80);
            expected.resize(512, 0);
            let plain = padded_plaintext(&base(kind)).unwrap();
            assert_eq!(plain.as_slice(), expected.as_slice(), "{expected_kind}");
        }
    }

    #[test]
    fn plaintext_golden_bytes_with_attachment() {
        let mut item = login();
        item.attachments = vec![file_ref()];
        let expected_json = format!(
            concat!(
                r#"{{"id":"{}","kind":{{"login":{{"username":"ariel","password":"hunter2","urls":["https://example.com"]}}}},"#,
                r#""title":"Example","notes":"n","collection":null,"#,
                r#""attachments":[{{"file_id":"{}","blob_version":1,"chunk_size":1048576,"#,
                r#""file_key":"QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=","#,
                r#""nonce_prefix":"BwcHBwcHBwcHBwcHBwcHBwcHBw==","#,
                r#""length":5000000,"chunk_count":5,"#,
                r#""name":"tax.pdf","media_type":"application/pdf"}}],"#,
                r#""revision":3,"created_at":"2026-10-09T00:00:00Z","modified_at":"2026-10-09T00:00:01Z","#,
                r#""trashed_at":null,"purging":false,"retired_blobs":[]}}"#
            ),
            "aa".repeat(16),
            "33".repeat(16)
        );
        let mut expected = expected_json.into_bytes();
        expected.push(0x80);
        expected.resize(1024, 0);
        let plain = padded_plaintext(&item).unwrap();
        assert_eq!(plain.as_slice(), expected.as_slice());

        let (v, k) = vault();
        let back = open_item(&seal_item(&item, &v, &k).unwrap(), &item.id, &v, &k).unwrap();
        assert_eq!(
            padded_plaintext(&back).unwrap().as_slice(),
            expected.as_slice()
        );
        assert_eq!(json(&back), json(&item));
    }
}
