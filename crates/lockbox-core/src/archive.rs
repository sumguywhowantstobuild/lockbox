//! Backup archives (spec 6.7): one ZIP64 file whose entries are stored, not compressed.
//! The `zip` crate only writes them. Reading never goes through it: a backup is untrusted
//! input, so [`BackupArchive::open`] is our own parser for exactly the subset written here,
//! and it refuses anything else with the name of the failed check.

use crate::blob::{CancelToken, MAX_FILE_BYTES, SIZE_CHANGED, at_end, blob_len, fill};
use crate::error::{CoreError, Result};
use crate::fsio::{open_shared_read, read_at};
use crate::header::{HEADER_FILE, MAX_HEADER_BYTES};
use crate::ids::{FileId, ItemId};
use crate::item::MAX_ITEM_FILE;
use crate::manifest::{
    BackupManifest, MANIFEST_FILE, MAX_ENTRIES, MAX_MANIFEST_BYTES, parse_manifest,
};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{self, Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryKind {
    Header,
    Manifest,
    Item(ItemId),
    Blob(FileId),
}

/// The kind of an allowed entry name (spec 6.7), or `None` for any other name.
pub fn classify(name: &str) -> Option<EntryKind> {
    match name {
        HEADER_FILE => return Some(EntryKind::Header),
        MANIFEST_FILE => return Some(EntryKind::Manifest),
        _ => {}
    }
    // `from_hex` takes exactly 32 lowercase hex characters, nothing else.
    if let Some(hex) = name
        .strip_prefix("items/")
        .and_then(|r| r.strip_suffix(".item"))
    {
        return ItemId::from_hex(hex).ok().map(EntryKind::Item);
    }
    let hex = name.strip_prefix("files/")?.strip_suffix(".blob")?;
    FileId::from_hex(hex).ok().map(EntryKind::Blob)
}

/// The largest entry of each kind that `open` accepts.
fn size_limit(kind: EntryKind) -> u64 {
    match kind {
        EntryKind::Header => MAX_HEADER_BYTES as u64,
        EntryKind::Manifest => MAX_MANIFEST_BYTES as u64,
        EntryKind::Item(_) => MAX_ITEM_FILE as u64,
        EntryKind::Blob(_) => blob_len(MAX_FILE_BYTES),
    }
}

#[derive(Clone, Debug)]
pub struct ArchiveEntry {
    pub name: String,
    pub kind: EntryKind,
    /// First data byte.
    pub offset: u64,
    pub size: u64,
}

const EOCD_LEN: u64 = 22;
const LOCATOR_LEN: u64 = 20;
const ZIP64_RECORD_LEN: u64 = 56;
const CENTRAL_LEN: usize = 46;
const LOCAL_LEN: usize = 30;
const SIG_EOCD: u32 = 0x0605_4b50;
const SIG_LOCATOR: u32 = 0x0706_4b50;
const SIG_ZIP64_RECORD: u32 = 0x0606_4b50;
const SIG_CENTRAL: u32 = 0x0201_4b50;
const SIG_LOCAL: u32 = 0x0403_4b50;
const ZIP64_EXTRA: u16 = 0x0001;
/// General-purpose flag bit 11: the name is UTF-8. The only flag allowed.
const UTF8_FLAG: u16 = 0x0800;
/// A field holding its maximum defers to the ZIP64 record or extra field.
const SAT32: u32 = u32::MAX;
const SAT16: u16 = u16::MAX;
const MAX_NAME: usize = 64;
const MAX_CD_PER_ENTRY: u64 = 256;
const PIECE: usize = 1 << 20;
/// Test failpoints reached after each piece of the directory or manifest is read.
const DIRECTORY_PIECE: &str = "archive.directory_piece";
const MANIFEST_PIECE: &str = "archive.manifest_piece";

const NOT_ARCHIVE: &str = "backup: not a backup archive";
const END: &str = "backup: end record";
const ZIP64: &str = "backup: zip64 record";
const TOO_MANY: &str = "backup: too many entries";
const DIRECTORY: &str = "backup: central directory";
const NAME: &str = "backup: entry name";
const LINK: &str = "backup: link or folder";
const COMPRESSED: &str = "backup: compressed entry";
const FLAGS: &str = "backup: entry flags";
const LOCAL: &str = "backup: local header";
const EXTRA: &str = "backup: extra field";
const DUPLICATE: &str = "backup: duplicate entry";
const LAYOUT: &str = "backup: layout";
const TOO_LARGE: &str = "backup: entry too large";
const MISMATCH: &str = "backup: manifest mismatch";
const WRITER: CoreError = CoreError::InvalidInput {
    what: "backup: archive writer",
};

fn damaged(what: &'static str) -> CoreError {
    CoreError::Damaged { what }
}

// Callers check that the slice is long enough; these only pick fields out of it.
fn le16(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}

fn le32(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(b[at..at + 4].try_into().expect("4 bytes"))
}

fn le64(b: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(b[at..at + 8].try_into().expect("8 bytes"))
}

/// Fills `buf` from `offset`; running into the end of the file is `Damaged { what }`.
fn read_full(file: &File, buf: &mut [u8], offset: u64, what: &'static str) -> Result<()> {
    let mut done = 0;
    while done < buf.len() {
        let at = offset.checked_add(done as u64).ok_or(damaged(what))?;
        match read_at(file, &mut buf[done..], at) {
            Ok(0) => return Err(damaged(what)),
            Ok(n) => done += n,
            Err(CoreError::Io(e)) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// Fills `buf` from `offset` in pieces of at most 1 MiB, checking `cancel` before each.
/// `step` names the test failpoint reached after each piece.
#[cfg_attr(not(test), allow(unused_variables))]
fn read_pieces(
    file: &File,
    buf: &mut [u8],
    offset: u64,
    what: &'static str,
    step: &'static str,
    cancel: &CancelToken,
) -> Result<()> {
    let mut at = offset;
    for piece in buf.chunks_mut(PIECE) {
        cancel.check()?;
        read_full(file, piece, at, what)?;
        at = at.checked_add(piece.len() as u64).ok_or(damaged(what))?;
        #[cfg(test)]
        crate::fsio::failpoint::check(step)?;
    }
    Ok(())
}

/// The data of the one ZIP64 extra field among `extras`, if any. Any other field, a second
/// ZIP64 field or a truncated one is refused.
fn zip64_extra(mut extras: &[u8]) -> Result<Option<&[u8]>> {
    let mut found = None;
    while !extras.is_empty() {
        if extras.len() < 4 {
            return Err(damaged(EXTRA));
        }
        let (id, len) = (le16(extras, 0), usize::from(le16(extras, 2)));
        if id != ZIP64_EXTRA || found.is_some() || extras.len() - 4 < len {
            return Err(damaged(EXTRA));
        }
        found = Some(&extras[4..4 + len]);
        extras = &extras[4 + len..];
    }
    Ok(found)
}

/// End record, then the ZIP64 locator and record when a field is saturated. Returns the
/// entry count, directory size, directory offset and where the directory must end.
fn read_end(file: &File, len: u64) -> Result<(u64, u64, u64, u64)> {
    let eocd_at = len.checked_sub(EOCD_LEN).ok_or(damaged(NOT_ARCHIVE))?;
    let mut e = [0u8; EOCD_LEN as usize];
    read_full(file, &mut e, eocd_at, END)?;
    // At exactly the end of the file, one disk, no comment.
    if le32(&e, 0) != SIG_EOCD
        || le16(&e, 4) != 0
        || le16(&e, 6) != 0
        || le16(&e, 8) != le16(&e, 10)
        || le16(&e, 20) != 0
    {
        return Err(damaged(END));
    }
    let (count, size, offset) = (le16(&e, 10), le32(&e, 12), le32(&e, 16));
    if count != SAT16 && size != SAT32 && offset != SAT32 {
        return Ok((count.into(), size.into(), offset.into(), eocd_at));
    }
    // The locator sits right before the end record, the ZIP64 record right before it.
    let record_at = eocd_at
        .checked_sub(LOCATOR_LEN + ZIP64_RECORD_LEN)
        .ok_or(damaged(ZIP64))?;
    let mut z = [0u8; (ZIP64_RECORD_LEN + LOCATOR_LEN) as usize];
    read_full(file, &mut z, record_at, ZIP64)?;
    let (r, l) = z.split_at(ZIP64_RECORD_LEN as usize);
    let (count64, size64, offset64) = (le64(r, 32), le64(r, 40), le64(r, 48));
    // A field that is not saturated must agree with its 64-bit twin.
    let agrees = |small: u64, saturated: bool, big: u64| saturated || small == big;
    let ok = le32(l, 0) == SIG_LOCATOR
        && le32(l, 4) == 0
        && le64(l, 8) == record_at
        && le32(l, 16) == 1
        && le32(r, 0) == SIG_ZIP64_RECORD
        && le64(r, 4) == ZIP64_RECORD_LEN - 12
        && le32(r, 16) == 0
        && le32(r, 20) == 0
        && le64(r, 24) == count64
        && agrees(count.into(), count == SAT16, count64)
        && agrees(size.into(), size == SAT32, size64)
        && agrees(offset.into(), offset == SAT32, offset64);
    if !ok {
        return Err(damaged(ZIP64));
    }
    Ok((count64, size64, offset64, record_at))
}

/// One central directory record, checked, with its ZIP64 values resolved.
struct Record {
    name: String,
    kind: EntryKind,
    flags: u16,
    header_offset: u64,
    size: u64,
    data_offset: u64,
    data_end: u64,
}

/// Checks every central record (flags, method, sizes, name, attributes, extras) and
/// resolves its ZIP64 values. The records must fill `cd` exactly.
fn parse_central(mut cd: &[u8], count: u64, cancel: &CancelToken) -> Result<Vec<Record>> {
    let mut records = Vec::new();
    for i in 0..count {
        if i % 1000 == 0 {
            cancel.check()?;
        }
        if cd.len() < CENTRAL_LEN || le32(cd, 0) != SIG_CENTRAL {
            return Err(damaged(DIRECTORY));
        }
        let name_len = usize::from(le16(cd, 28));
        let extra_len = usize::from(le16(cd, 30));
        let comment_len = usize::from(le16(cd, 32));
        let total = CENTRAL_LEN + name_len + extra_len + comment_len;
        // No comment, disk start 0.
        if cd.len() < total || comment_len != 0 || le16(cd, 34) != 0 {
            return Err(damaged(DIRECTORY));
        }
        let (rec, rest) = cd.split_at(total);
        cd = rest;
        let flags = le16(rec, 8);
        if flags & !UTF8_FLAG != 0 {
            return Err(damaged(FLAGS));
        }
        let (compressed, uncompressed, offset) = (le32(rec, 20), le32(rec, 24), le32(rec, 42));
        if le16(rec, 10) != 0 || compressed != uncompressed {
            return Err(damaged(COMPRESSED));
        }
        let name = std::str::from_utf8(&rec[CENTRAL_LEN..CENTRAL_LEN + name_len]).unwrap_or("");
        let Some(kind) = classify(name).filter(|_| name_len <= MAX_NAME) else {
            return Err(damaged(NAME));
        };
        let attributes = le32(rec, 38);
        let unix_type = attributes >> 16 & 0o170_000;
        if attributes & 0x10 != 0 || !matches!(unix_type, 0 | 0o100_000) {
            return Err(damaged(LINK));
        }
        // The ZIP64 field holds exactly the saturated values, in this order.
        let fields = [uncompressed, compressed, offset];
        let wanted = fields.iter().filter(|v| **v == SAT32).count();
        let extras = &rec[CENTRAL_LEN + name_len..total];
        let values = zip64_extra(extras)?.unwrap_or(&[]);
        if values.len() != 8 * wanted {
            return Err(damaged(EXTRA));
        }
        let mut next = values
            .as_chunks::<8>()
            .0
            .iter()
            .map(|v| u64::from_le_bytes(*v));
        let [size, compressed, header_offset] = fields.map(|v| match v {
            SAT32 => next.next().expect("one value per saturated field"),
            v => v.into(),
        });
        if size != compressed {
            return Err(damaged(COMPRESSED));
        }
        records.push(Record {
            name: name.to_owned(),
            kind,
            flags,
            header_offset,
            size,
            data_offset: 0,
            data_end: 0,
        });
    }
    if !cd.is_empty() {
        return Err(damaged(DIRECTORY));
    }
    Ok(records)
}

/// The local header must repeat the central record: flags, method, name and sizes (directly,
/// or both saturated with a ZIP64 field holding both). Sets where the data starts and ends.
/// The header's offset comes from the file, so each part of it must lie before `limit` (the
/// directory start) before it is read.
fn check_local(file: &File, r: &mut Record, limit: u64) -> Result<()> {
    let inside = |start: u64, len: usize| {
        start
            .checked_add(len as u64)
            .is_some_and(|end| end <= limit)
    };
    if !inside(r.header_offset, LOCAL_LEN) {
        return Err(damaged(LOCAL));
    }
    let mut fixed = [0u8; LOCAL_LEN];
    read_full(file, &mut fixed, r.header_offset, LOCAL)?;
    let name_len = r.name.len();
    if le32(&fixed, 0) != SIG_LOCAL
        || le16(&fixed, 6) != r.flags
        || le16(&fixed, 8) != 0
        || usize::from(le16(&fixed, 26)) != name_len
    {
        return Err(damaged(LOCAL));
    }
    let var_len = name_len + usize::from(le16(&fixed, 28));
    // Cannot overflow: the fixed part ends at or before `limit`.
    let var_at = r.header_offset + LOCAL_LEN as u64;
    if !inside(var_at, var_len) {
        return Err(damaged(LOCAL));
    }
    let mut var = vec![0u8; var_len];
    read_full(file, &mut var, var_at, LOCAL)?;
    let zip64 = zip64_extra(&var[name_len..])?;
    let (compressed, uncompressed) = (le32(&fixed, 18), le32(&fixed, 22));
    let direct = zip64.is_none()
        && compressed != SAT32
        && u64::from(compressed) == r.size
        && u64::from(uncompressed) == r.size;
    let via_zip64 = compressed == SAT32
        && uncompressed == SAT32
        && zip64.is_some_and(|z| z.len() == 16 && le64(z, 0) == r.size && le64(z, 8) == r.size);
    if &var[..name_len] != r.name.as_bytes() || !(direct || via_zip64) {
        return Err(damaged(LOCAL));
    }
    r.data_offset = r
        .header_offset
        .checked_add((LOCAL_LEN + var.len()) as u64)
        .ok_or(damaged(LAYOUT))?;
    r.data_end = r.data_offset.checked_add(r.size).ok_or(damaged(LAYOUT))?;
    Ok(())
}

/// A backup file, checked by [`BackupArchive::open`] and held open until dropped (on
/// Windows sharing read access only, so nobody can change it meanwhile).
pub struct BackupArchive {
    file: Arc<File>,
    path: PathBuf,
    manifest: BackupManifest,
    entries: Vec<ArchiveEntry>,
    total_size: u64,
}

impl BackupArchive {
    /// Checks the archive structure and that the manifest lists exactly its entries (spec
    /// 6.7, 6.8 step 1). Contents are not hashed here, and the manifest MAC needs the key.
    pub fn open(path: &Path, cancel: &CancelToken) -> Result<BackupArchive> {
        cancel.check()?;
        let file = open_shared_read(path)?;
        // 1-2. End record, ZIP64 locator and record.
        let (count, cd_size, cd_offset, cd_end) = read_end(&file, file.metadata()?.len())?;
        // 3. Bounds, before anything is allocated from them.
        if count > MAX_ENTRIES as u64 + 2 {
            return Err(damaged(TOO_MANY));
        }
        if cd_size > count * MAX_CD_PER_ENTRY || cd_offset.checked_add(cd_size) != Some(cd_end) {
            return Err(damaged(DIRECTORY));
        }
        // 4. The directory, in pieces, each after a cancel check.
        let mut cd = vec![0u8; usize::try_from(cd_size).map_err(|_| damaged(DIRECTORY))?];
        read_pieces(
            &file,
            &mut cd,
            cd_offset,
            DIRECTORY,
            DIRECTORY_PIECE,
            cancel,
        )?;
        // 5. Each record.
        let mut records = parse_central(&cd, count, cancel)?;
        drop(cd);
        // 6. Duplicates.
        records.sort_unstable_by(|a, b| a.name.cmp(&b.name));
        if records.windows(2).any(|w| w[0].name == w[1].name) {
            return Err(damaged(DUPLICATE));
        }
        // 7. Local headers, all before the directory.
        for (i, r) in records.iter_mut().enumerate() {
            if i % 1000 == 0 {
                cancel.check()?;
            }
            check_local(&file, r, cd_offset)?;
        }
        // 8. Sorted by position, the entries fill everything before the directory exactly.
        records.sort_unstable_by_key(|r| r.header_offset);
        let mut next = 0;
        for r in &records {
            if r.header_offset != next {
                return Err(damaged(LAYOUT));
            }
            next = r.data_end;
        }
        if next != cd_offset {
            return Err(damaged(LAYOUT));
        }
        // 9. Per-kind size limits.
        if records.iter().any(|r| r.size > size_limit(r.kind)) {
            return Err(damaged(TOO_LARGE));
        }
        records.sort_unstable_by(|a, b| a.name.cmp(&b.name));
        let mut entries: Vec<ArchiveEntry> = records
            .into_iter()
            .map(|r| ArchiveEntry {
                name: r.name,
                kind: r.kind,
                offset: r.data_offset,
                size: r.size,
            })
            .collect();
        if !entries.iter().any(|e| e.kind == EntryKind::Header) {
            return Err(damaged("backup: no header"));
        }
        let at = entries.iter().position(|e| e.kind == EntryKind::Manifest);
        let manifest_entry = entries.remove(at.ok_or(damaged("backup: no manifest"))?);
        // 10. The manifest, whose size is already within MAX_MANIFEST_BYTES and whose range
        // lies inside the tiled entries.
        let size = usize::try_from(manifest_entry.size).map_err(|_| damaged(TOO_LARGE))?;
        let mut bytes = vec![0u8; size];
        let at = manifest_entry.offset;
        read_pieces(&file, &mut bytes, at, LAYOUT, MANIFEST_PIECE, cancel)?;
        cancel.check()?;
        let manifest = parse_manifest(&bytes)?;
        // 11. The manifest lists exactly the other entries, each once, with their sizes.
        let mut listed = BTreeMap::new();
        for m in &manifest.entries {
            if listed.insert(m.path.as_str(), m.size).is_some() {
                return Err(damaged(MISMATCH));
            }
        }
        if listed.len() != entries.len()
            || entries
                .iter()
                .any(|e| listed.get(e.name.as_str()) != Some(&e.size))
        {
            return Err(damaged(MISMATCH));
        }
        // Cannot overflow: the entries tile part of the file.
        let total_size = entries.iter().map(|e| e.size).sum();
        Ok(BackupArchive {
            file: Arc::new(file),
            path: std::fs::canonicalize(path)?,
            manifest,
            entries,
            total_size,
        })
    }

    pub fn manifest(&self) -> &BackupManifest {
        &self.manifest
    }

    /// Every entry except the manifest, sorted by name.
    pub fn entries(&self) -> &[ArchiveEntry] {
        &self.entries
    }

    pub fn entry(&self, name: &str) -> Option<&ArchiveEntry> {
        let i = self
            .entries
            .binary_search_by(|e| e.name.as_str().cmp(name))
            .ok()?;
        Some(&self.entries[i])
    }

    /// The sum of the entry sizes, manifest excluded: what a restore writes.
    pub fn total_size(&self) -> u64 {
        self.total_size
    }

    pub fn reader(&self, e: &ArchiveEntry) -> EntryReader {
        entry_reader(&self.file, e)
    }

    /// The whole entry, for the small kinds only (`Header`, `Item`).
    pub fn read_entry(&self, e: &ArchiveEntry) -> Result<Vec<u8>> {
        if !matches!(e.kind, EntryKind::Header | EntryKind::Item(_)) || e.size > size_limit(e.kind)
        {
            return Err(CoreError::InvalidInput {
                what: "backup: entry kind",
            });
        }
        let mut bytes = Vec::new();
        self.reader(e).read_to_end(&mut bytes)?;
        Ok(bytes)
    }

    /// Whether `path` names this archive's file; `false` when `path` does not exist.
    pub fn is_same_file(&self, path: &Path) -> Result<bool> {
        match std::fs::canonicalize(path) {
            Ok(p) => Ok(p == self.path),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e.into()),
        }
    }
}

fn entry_reader(file: &Arc<File>, e: &ArchiveEntry) -> EntryReader {
    EntryReader {
        file: Arc::clone(file),
        pos: e.offset,
        end: e.offset.saturating_add(e.size),
    }
}

/// One entry's bytes, read by position, so several readers never disturb each other.
pub struct EntryReader {
    file: Arc<File>,
    pos: u64,
    end: u64,
}

impl Read for EntryReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let left = usize::try_from(self.end - self.pos).unwrap_or(usize::MAX);
        let want = buf.len().min(left);
        if want == 0 {
            return Ok(0);
        }
        let n = match read_at(&self.file, &mut buf[..want], self.pos) {
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(n) => n,
            Err(CoreError::Io(e)) => return Err(e),
            Err(e) => return Err(io::Error::other(e)),
        };
        self.pos += n as u64;
        Ok(n)
    }
}

fn zip_error(e: zip::result::ZipError) -> CoreError {
    match e {
        zip::result::ZipError::Io(e) => e.into(),
        // Fixed text: the crate's messages can quote entry names.
        _ => WRITER,
    }
}

/// Writes a backup archive through the `zip` crate: stored entries, ZIP64 fields always.
pub struct ArchiveWriter(ZipWriter<File>);

impl ArchiveWriter {
    pub fn new(file: File) -> Self {
        let mut zip = ZipWriter::new(file);
        // An empty extensible sector makes the crate always write the ZIP64 end record.
        // Without it, exactly 65 535 records would get a saturated count but no ZIP64
        // record, which the reader refuses.
        zip.set_raw_zip64_extensible_data_sector(Box::new([]));
        Self(zip)
    }

    fn start(&mut self, name: &str) -> Result<()> {
        classify(name).ok_or(CoreError::InvalidInput { what: NAME })?;
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .large_file(true);
        self.0.start_file(name, options).map_err(zip_error)
    }

    /// Adds `size` bytes from `src` as `name`; returns their SHA-256.
    pub fn add(
        &mut self,
        name: &str,
        src: &mut impl Read,
        size: u64,
        cancel: &CancelToken,
    ) -> Result<[u8; 32]> {
        self.start(name)?;
        copy_hashed(src, size, &mut self.0, cancel)
    }

    /// Adds `name` with what `write` writes and returns the hash `write` returns. When
    /// `write` finds the data damaged, the entry is removed again and `Ok(None)` returned.
    pub fn add_with(
        &mut self,
        name: &str,
        write: impl FnOnce(&mut dyn Write) -> Result<[u8; 32]>,
    ) -> Result<Option<[u8; 32]>> {
        self.start(name)?;
        match write(&mut self.0) {
            Ok(hash) => Ok(Some(hash)),
            Err(CoreError::Damaged { .. }) => {
                self.0.abort_file().map_err(zip_error)?;
                // `abort_file` rewound to the entry's header. Cut the rest off, or `finish`
                // would move the end record past it and leave a gap.
                let mut file = self.0.get_ref().ok_or(WRITER)?;
                let at = file.stream_position()?;
                file.set_len(at)?;
                Ok(None)
            }
            Err(e) => Err(e),
        }
    }

    /// Writes the central directory and end records and hands back the file, which the
    /// caller syncs and drops.
    pub fn finish(self) -> Result<File> {
        self.0.finish().map_err(zip_error)
    }
}

/// Copies exactly `size` bytes from `src` to `dst` and returns their SHA-256. A source that
/// ends early or has more is `InvalidInput { "source size changed" }`.
pub(crate) fn copy_hashed(
    src: &mut impl Read,
    size: u64,
    dst: &mut impl Write,
    cancel: &CancelToken,
) -> Result<[u8; 32]> {
    let mut buf = vec![0u8; usize::try_from(size).map_or(PIECE, |s| s.min(PIECE))];
    let mut hash = Sha256::new();
    let mut left = size;
    while left > 0 {
        cancel.check()?;
        let n = usize::try_from(left).map_or(buf.len(), |l| l.min(buf.len()));
        if fill(src, &mut buf[..n])? != n {
            return Err(SIZE_CHANGED);
        }
        hash.update(&buf[..n]);
        dst.write_all(&buf[..n])?;
        left -= n as u64;
        #[cfg(test)]
        crate::fsio::failpoint::check("copy.after_buffer")?;
    }
    if !at_end(src)? {
        return Err(SIZE_CHANGED);
    }
    Ok(hash.finalize().into())
}

/// Builders for tests here and in `vault/*`: valid backups, byte patches and rebuilt archives.
#[cfg(test)]
pub(crate) mod testkit {
    use super::*;
    use crate::fsio::testutil::TempDir;
    use crate::ids::VaultId;
    use crate::manifest::{
        MANIFEST_FILE, MANIFEST_VERSION, ManifestEntry, manifest_mac, serialize_manifest,
    };
    use crate::secret::Key32;
    use sha2::{Digest, Sha256};
    use std::collections::BTreeMap;

    /// The vault ID of every manifest `build_backup` writes.
    pub(crate) const VAULT: VaultId = VaultId([0x5A; 16]);

    /// A manifest listing `entries` in order, MACed when a key is given.
    pub(crate) fn manifest_for(entries: &[(&str, &[u8])], key: Option<&Key32>) -> BackupManifest {
        let mut m = BackupManifest {
            manifest_version: MANIFEST_VERSION,
            vault_id: VAULT,
            created_at: "2026-10-17T00:00:00Z".to_owned(),
            entries: entries
                .iter()
                .map(|(path, bytes)| ManifestEntry {
                    path: (*path).to_owned(),
                    size: bytes.len() as u64,
                    sha256: Sha256::digest(bytes).into(),
                })
                .collect(),
            mac: None,
        };
        m.mac = key.map(|k| manifest_mac(&m, k));
        m
    }

    /// `prefix`, then `entries` in order through [`ArchiveWriter`], then `manifest` if given.
    pub(crate) fn write_archive(
        prefix: &[u8],
        entries: &[(&str, &[u8])],
        manifest: Option<&[u8]>,
    ) -> Vec<u8> {
        let dir = TempDir::new();
        let path = dir.path().join("a.lockbox-backup");
        let mut file = File::create(&path).unwrap();
        file.write_all(prefix).unwrap();
        let mut w = ArchiveWriter::new(file);
        let cancel = CancelToken::new();
        let manifest = manifest.map(|m| (MANIFEST_FILE, m));
        for (name, bytes) in entries.iter().copied().chain(manifest) {
            w.add(name, &mut &bytes[..], bytes.len() as u64, &cancel)
                .unwrap();
        }
        drop(w.finish().unwrap());
        std::fs::read(&path).unwrap()
    }

    /// A valid archive of `entries` plus a manifest listing them, MACed when a key is given.
    pub(crate) fn build_backup(entries: &[(&str, &[u8])], key: Option<&Key32>) -> Vec<u8> {
        let manifest = serialize_manifest(&manifest_for(entries, key));
        write_archive(&[], entries, Some(&manifest))
    }

    pub(crate) fn patch(bytes: &mut [u8], at: usize, with: &[u8]) {
        bytes[at..at + with.len()].copy_from_slice(with);
    }

    fn le(bytes: &[u8], at: usize, len: usize) -> usize {
        let value = bytes[at..at + len]
            .iter()
            .rev()
            .fold(0u64, |v, b| v << 8 | u64::from(*b));
        usize::try_from(value).unwrap()
    }

    /// Where `name`'s central directory record starts (archives from [`write_archive`]).
    pub(crate) fn central_offset(bytes: &[u8], name: &str) -> usize {
        let zip64_record = bytes.len() - 22 - 20 - 56;
        let mut at = le(bytes, zip64_record + 48, 8);
        while at < zip64_record {
            let name_len = le(bytes, at + 28, 2);
            if &bytes[at + 46..at + 46 + name_len] == name.as_bytes() {
                return at;
            }
            at += 46 + name_len + le(bytes, at + 30, 2) + le(bytes, at + 32, 2);
        }
        panic!("no such entry");
    }

    /// Where `name`'s local header starts. Its data starts `30 + name length + 20` bytes
    /// later (the ZIP64 extra field every entry carries).
    pub(crate) fn entry_offset(bytes: &[u8], name: &str) -> usize {
        le(bytes, central_offset(bytes, name) + 42, 4)
    }

    /// Moves `name`'s end by `delta` bytes in its central and local ZIP64 fields (both hold both
    /// sizes), so its range no longer tiles the file.
    pub(crate) fn resize_entry(b: &mut [u8], name: &str, delta: i64) {
        let (c, l) = (central_offset(b, name), entry_offset(b, name));
        let field = |at: usize, b: &[u8]| u64::from_le_bytes(b[at..at + 8].try_into().unwrap());
        let at = c + 46 + name.len() + 4;
        let size = field(at, b)
            .checked_add_signed(delta)
            .unwrap()
            .to_le_bytes();
        for at in [
            at,
            at + 8,
            l + 30 + name.len() + 4,
            l + 30 + name.len() + 12,
        ] {
            patch(b, at, &size);
        }
    }

    pub(crate) enum ManifestMode<'a> {
        /// The original manifest, unchanged.
        Keep,
        /// Every size and SHA-256 recomputed; re-MACed with `key`, or the old MAC kept with
        /// `None` (a forger without the key).
        Rehash { key: Option<&'a Key32> },
    }

    /// Rebuilds the archive at `path` after `edit` changes, adds or removes entry bytes
    /// (keyed by entry name, manifest excluded).
    pub(crate) fn rewrite_backup(
        path: &Path,
        edit: impl FnOnce(&mut BTreeMap<String, Vec<u8>>),
        mode: ManifestMode,
    ) {
        let (mut map, old) = {
            let archive = BackupArchive::open(path, &CancelToken::new()).unwrap();
            let map: BTreeMap<String, Vec<u8>> = archive
                .entries()
                .iter()
                .map(|e| {
                    let mut bytes = Vec::new();
                    archive.reader(e).read_to_end(&mut bytes).unwrap();
                    (e.name.clone(), bytes)
                })
                .collect();
            (map, archive.manifest().clone())
        };
        edit(&mut map);
        let manifest = match mode {
            ManifestMode::Keep => old,
            ManifestMode::Rehash { key } => {
                // Old order first, then new names, so only the edited values change.
                let mut paths: Vec<&str> = old.entries.iter().map(|e| e.path.as_str()).collect();
                paths.retain(|p| map.contains_key(*p));
                paths.extend(
                    map.keys()
                        .map(String::as_str)
                        .filter(|p| old.entry(p).is_none()),
                );
                let listed: Vec<(&str, &[u8])> = paths.iter().map(|p| (*p, &map[*p][..])).collect();
                let mut m = manifest_for(&listed, None);
                (m.vault_id, m.created_at) = (old.vault_id, old.created_at);
                m.mac = match key {
                    Some(k) => Some(manifest_mac(&m, k)),
                    None => old.mac,
                };
                m
            }
        };
        let entries: Vec<(&str, &[u8])> = map.iter().map(|(n, b)| (n.as_str(), &b[..])).collect();
        let bytes = write_archive(&[], &entries, Some(&serialize_manifest(&manifest)));
        std::fs::write(path, bytes).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::testkit::*;
    use super::*;
    use crate::error::CoreError;
    use crate::fsio::failpoint;
    use crate::fsio::testutil::TempDir;
    use crate::item::MAX_ITEM_FILE;
    use crate::manifest::{MANIFEST_FILE, MAX_ENTRIES, serialize_manifest};
    use sha2::{Digest, Sha256};
    use std::io::Cursor;

    const MIB: usize = 1 << 20;

    fn item(n: u8) -> String {
        format!("items/{}.item", ItemId([n; 16]).to_hex())
    }

    fn blob(n: u8) -> String {
        format!("files/{}.blob", FileId([n; 16]).to_hex())
    }

    fn sha(bytes: &[u8]) -> [u8; 32] {
        Sha256::digest(bytes).into()
    }

    /// The header, two items and a blob: big enough that the directory-size case can keep
    /// its offsets consistent.
    fn payload() -> Vec<(String, Vec<u8>)> {
        vec![
            ("vault.json".into(), br#"{"h":1}"#.to_vec()),
            (item(1), vec![1; 300]),
            (item(2), vec![2; 200]),
            (blob(3), (0..3000).map(|i| (i % 251) as u8).collect()),
        ]
    }

    fn refs(p: &[(String, Vec<u8>)]) -> Vec<(&str, &[u8])> {
        p.iter().map(|(n, b)| (n.as_str(), &b[..])).collect()
    }

    fn base() -> Vec<u8> {
        build_backup(&refs(&payload()), None)
    }

    fn open_bytes(bytes: &[u8]) -> Result<()> {
        let dir = TempDir::new();
        let path = dir.path().join("b.lockbox-backup");
        std::fs::write(&path, bytes).unwrap();
        BackupArchive::open(&path, &CancelToken::new()).map(drop)
    }

    #[track_caller]
    fn refused(bytes: &[u8]) -> &'static str {
        match open_bytes(bytes) {
            Err(CoreError::Damaged { what }) => what,
            other => panic!("expected Damaged, got {other:?}"),
        }
    }

    fn patched(at: impl FnOnce(&[u8]) -> usize, with: &[u8]) -> Vec<u8> {
        let mut b = base();
        let at = at(&b);
        patch(&mut b, at, with);
        b
    }

    /// Sets an entry's size in its central and local ZIP64 fields (both hold both sizes).
    fn resized(name: &str, delta: i64) -> Vec<u8> {
        let mut b = base();
        resize_entry(&mut b, name, delta);
        b
    }

    #[test]
    fn classify_allowlist() {
        let hex = "0123456789abcdef".repeat(2);
        let id = ItemId::from_hex(&hex).unwrap();
        assert_eq!(classify("vault.json"), Some(EntryKind::Header));
        assert_eq!(classify("backup-manifest.json"), Some(EntryKind::Manifest));
        assert_eq!(
            classify(&format!("items/{hex}.item")),
            Some(EntryKind::Item(id))
        );
        assert_eq!(
            classify(&format!("files/{hex}.blob")),
            Some(EntryKind::Blob(FileId(id.0)))
        );
        for bad in [
            format!("items/{}.item", hex.to_uppercase()),
            format!("items/{}.item", &hex[1..]),
            format!("items/{hex}0.item"),
            "items/x.item".into(),
            "./vault.json".into(),
            "/vault.json".into(),
            "C:/vault.json".into(),
            format!("items\\{hex}.item"),
            "items/../vault.json".into(),
            format!("files/orphaned/{hex}.blob"),
            format!("files/{hex}.item"),
            "vault.json.bak".into(),
            String::new(),
        ] {
            assert_eq!(classify(&bad), None, "{bad}");
        }
    }

    #[test]
    fn round_trip() {
        let dir = TempDir::new();
        let path = dir.path().join("r.lockbox-backup");
        let p = payload();
        let cancel = CancelToken::new();
        let mut w = ArchiveWriter::new(File::create(&path).unwrap());
        let mut hashes = Vec::new();
        for (name, bytes) in &p[..3] {
            hashes.push(
                w.add(name, &mut &bytes[..], bytes.len() as u64, &cancel)
                    .unwrap(),
            );
        }
        let (blob_name, blob_bytes) = &p[3];
        let hash = w
            .add_with(blob_name, |dst| {
                copy_hashed(&mut &blob_bytes[..], 3000, &mut &mut *dst, &cancel)
            })
            .unwrap();
        hashes.push(hash.unwrap());
        let manifest = serialize_manifest(&manifest_for(&refs(&p), None));
        w.add(
            MANIFEST_FILE,
            &mut &manifest[..],
            manifest.len() as u64,
            &cancel,
        )
        .unwrap();
        w.finish().unwrap().sync_all().unwrap();

        let archive = BackupArchive::open(&path, &cancel).unwrap();
        let mut sorted = p.clone();
        sorted.sort();
        let names: Vec<&str> = archive.entries().iter().map(|e| e.name.as_str()).collect();
        assert_eq!(
            names,
            sorted.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>()
        );
        for (name, bytes) in &sorted {
            let e = archive.entry(name).unwrap();
            assert_eq!(
                (e.kind, e.size),
                (classify(name).unwrap(), bytes.len() as u64)
            );
            let mut read = Vec::new();
            archive.reader(e).read_to_end(&mut read).unwrap();
            assert_eq!(&read, bytes);
            if matches!(e.kind, EntryKind::Header | EntryKind::Item(_)) {
                assert_eq!(&archive.read_entry(e).unwrap(), bytes);
            } else {
                assert!(archive.read_entry(e).is_err(), "blobs are not read whole");
            }
        }
        for ((_, bytes), hash) in p.iter().zip(&hashes) {
            assert_eq!(*hash, sha(bytes));
        }
        assert_eq!(archive.total_size(), 7 + 300 + 200 + 3000);
        assert_eq!(archive.manifest().entries.len(), 4);
        assert!(archive.entry(MANIFEST_FILE).is_none());
        assert!(archive.entry(&item(9)).is_none());
    }

    #[test]
    fn every_check_refuses() {
        assert_eq!(open_bytes(&base()).map_err(|e| e.to_string()), Ok(()));
        let item1 = item(1);
        let central = |b: &[u8]| central_offset(b, &item(1));
        let local = |b: &[u8]| entry_offset(b, &item(1));
        let p = payload();
        let len = base().len();
        let (eocd, zip64) = (len - 22, len - 98);
        let cases: Vec<(&str, Vec<u8>, &str)> = vec![
            ("empty", vec![], "backup: not a backup archive"),
            (
                "21 bytes",
                base()[len - 21..].to_vec(),
                "backup: not a backup archive",
            ),
            (
                "trailing comment",
                {
                    let mut b = patched(|_| eocd + 20, &4u16.to_le_bytes());
                    b.extend(b"note");
                    b
                },
                "backup: end record",
            ),
            (
                "byte after end",
                {
                    let mut b = base();
                    b.push(0);
                    b
                },
                "backup: end record",
            ),
            (
                "too many entries",
                {
                    let mut b = patched(|_| eocd + 8, &[0xFF; 4]);
                    let n = (MAX_ENTRIES as u64 + 3).to_le_bytes();
                    patch(&mut b, zip64 + 24, &n);
                    patch(&mut b, zip64 + 32, &n);
                    b
                },
                "backup: too many entries",
            ),
            // Read before the count check, this directory size could not be allocated.
            (
                "absurd count and size",
                {
                    let mut b = patched(|_| eocd + 8, &[0xFF; 4]);
                    patch(&mut b, zip64 + 24, &(1u64 << 40).to_le_bytes());
                    patch(&mut b, zip64 + 32, &(1u64 << 40).to_le_bytes());
                    patch(&mut b, zip64 + 40, &(1u64 << 50).to_le_bytes());
                    b
                },
                "backup: too many entries",
            ),
            (
                "count at the limit",
                {
                    let mut b = patched(|_| eocd + 8, &[0xFF; 4]);
                    let n = (MAX_ENTRIES as u64 + 2).to_le_bytes();
                    patch(&mut b, zip64 + 24, &n);
                    patch(&mut b, zip64 + 32, &n);
                    b
                },
                "backup: central directory",
            ),
            (
                // `directory_cap_refuses_before_reading` proves no piece is read first.
                "directory over count x 256",
                {
                    // Offsets kept consistent, so only the size bound can refuse it.
                    let size: u64 = 5 * 256 + 1;
                    let offset = zip64 as u64 - size;
                    let mut b = patched(|_| zip64 + 40, &size.to_le_bytes());
                    patch(&mut b, zip64 + 48, &offset.to_le_bytes());
                    patch(
                        &mut b,
                        eocd + 16,
                        &u32::try_from(offset).unwrap().to_le_bytes(),
                    );
                    b
                },
                "backup: central directory",
            ),
            (
                "uppercase name",
                patched(
                    |b| central(b) + 46,
                    format!("items/{}.item", "AB".repeat(16)).as_bytes(),
                ),
                "backup: entry name",
            ),
            (
                "backslash",
                patched(|b| central(b) + 46, item1.replace('/', "\\").as_bytes()),
                "backup: entry name",
            ),
            (
                "traversal",
                patched(
                    |b| central(b) + 46,
                    format!("items/../{}", "a".repeat(34)).as_bytes(),
                ),
                "backup: entry name",
            ),
            (
                "absolute",
                patched(
                    |b| central(b) + 46,
                    format!("/{}", "a".repeat(42)).as_bytes(),
                ),
                "backup: entry name",
            ),
            (
                "drive",
                patched(
                    |b| central(b) + 46,
                    format!("C:/{}", "a".repeat(40)).as_bytes(),
                ),
                "backup: entry name",
            ),
            (
                "directory-style",
                patched(|b| central(b) + 46, format!("{}/", &item1[..42]).as_bytes()),
                "backup: entry name",
            ),
            (
                "unix link",
                patched(|b| central(b) + 38, &(0o120_777u32 << 16).to_le_bytes()),
                "backup: link or folder",
            ),
            (
                "unix folder",
                patched(|b| central(b) + 38, &(0o040_755u32 << 16).to_le_bytes()),
                "backup: link or folder",
            ),
            (
                "dos folder",
                patched(
                    |b| central(b) + 38,
                    &(0o100_644u32 << 16 | 0x10).to_le_bytes(),
                ),
                "backup: link or folder",
            ),
            (
                "method 8",
                patched(|b| central(b) + 10, &8u16.to_le_bytes()),
                "backup: compressed entry",
            ),
            (
                "flag bit 0",
                patched(|b| central(b) + 8, &1u16.to_le_bytes()),
                "backup: entry flags",
            ),
            (
                "flag bit 3",
                patched(|b| central(b) + 8, &8u16.to_le_bytes()),
                "backup: entry flags",
            ),
            (
                "local name",
                patched(|b| local(b) + 30 + 6, b"f"),
                "backup: local header",
            ),
            (
                "local sizes",
                patched(|b| local(b) + 30 + 43 + 4, &301u64.to_le_bytes()),
                "backup: local header",
            ),
            (
                "extra field",
                patched(|b| central(b) + 46 + 43, &0x000Au16.to_le_bytes()),
                "backup: extra field",
            ),
            (
                "duplicate",
                {
                    let mut b = base();
                    let at = central_offset(&b, &item(2)) + 46;
                    patch(&mut b, at, item1.as_bytes());
                    b
                },
                "backup: duplicate entry",
            ),
            (
                "prepended",
                write_archive(
                    b"MZ\x90\x00",
                    &refs(&p),
                    Some(&serialize_manifest(&manifest_for(&refs(&p), None))),
                ),
                "backup: layout",
            ),
            ("gap", resized(&item1, -1), "backup: layout"),
            ("overlap", resized(&item1, 1), "backup: layout"),
            (
                "into directory",
                resized(MANIFEST_FILE, 1),
                "backup: layout",
            ),
            (
                "item too large",
                build_backup(
                    &[("vault.json", b"{}"), (&item1, &vec![0; MAX_ITEM_FILE + 1])],
                    None,
                ),
                "backup: entry too large",
            ),
            (
                "no header",
                build_backup(&refs(&p)[1..], None),
                "backup: no header",
            ),
            (
                "no manifest",
                write_archive(&[], &refs(&p), None),
                "backup: no manifest",
            ),
        ];
        for (case, bytes, what) in cases {
            assert_eq!(refused(&bytes), what, "{case}");
        }

        let mismatch = |edit: fn(&mut crate::manifest::BackupManifest)| {
            let mut m = manifest_for(&refs(&p), None);
            edit(&mut m);
            refused(&write_archive(
                &[],
                &refs(&p),
                Some(&serialize_manifest(&m)),
            ))
        };
        assert_eq!(
            mismatch(|m| drop(m.entries.pop())),
            "backup: manifest mismatch"
        );
        assert_eq!(
            mismatch(|m| m
                .entries
                .push(manifest_for(&[(&blob(9), b"x")], None).entries[0].clone())),
            "backup: manifest mismatch"
        );
        assert_eq!(
            mismatch(|m| m.entries[1].size += 1),
            "backup: manifest mismatch"
        );
        assert_eq!(
            mismatch(|m| m.entries.push(m.entries[0].clone())),
            "backup: manifest mismatch"
        );

        // Bit 11 (UTF-8 names) is the one flag allowed, when both headers carry it.
        let mut b = patched(|b| central(b) + 8, &0x0800u16.to_le_bytes());
        let at = local(&b) + 6;
        patch(&mut b, at, &0x0800u16.to_le_bytes());
        open_bytes(&b).unwrap();
    }

    /// Review Focus 2: what another tool makes of a backup (deflated, with a folder entry)
    /// is refused, never parsed loosely.
    #[test]
    fn repacked_archive_refused() {
        use zip::write::SimpleFileOptions;
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let deflated =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zip.add_directory("items/", SimpleFileOptions::default())
            .unwrap();
        for (name, bytes) in payload() {
            zip.start_file(name, deflated).unwrap();
            zip.write_all(&bytes).unwrap();
        }
        let manifest = serialize_manifest(&manifest_for(&refs(&payload()), None));
        zip.start_file(MANIFEST_FILE, deflated).unwrap();
        zip.write_all(&manifest).unwrap();
        let bytes = zip.finish().unwrap().into_inner();
        assert!(matches!(open_bytes(&bytes), Err(CoreError::Damaged { .. })));
    }

    #[test]
    fn zip64_fields_round_trip() {
        let b = base();
        let len = b.len();
        // The end record defers to the ZIP64 record, which sits right before the locator.
        assert_eq!(&b[len - 22 + 12..len - 22 + 16], &[0xFF; 4]);
        assert_eq!(&b[len - 98..len - 94], &[0x50, 0x4B, 0x06, 0x06]);
        let dir = TempDir::new();
        let path = dir.path().join("z.lockbox-backup");
        std::fs::write(&path, &b).unwrap();
        let archive = BackupArchive::open(&path, &CancelToken::new()).unwrap();
        for (name, bytes) in payload() {
            let local = entry_offset(&b, &name);
            // Local sizes defer to the ZIP64 extra field, which holds both.
            assert_eq!(&b[local + 18..local + 26], &[0xFF; 8], "{name}");
            assert_eq!(&b[local + 28..local + 30], &20u16.to_le_bytes(), "{name}");
            let e = archive.entry(&name).unwrap();
            assert_eq!(e.offset, (local + 30 + name.len() + 20) as u64, "{name}");
            assert_eq!(e.size, bytes.len() as u64, "{name}");
            let start = usize::try_from(e.offset).unwrap();
            assert_eq!(&b[start..start + bytes.len()], &bytes[..], "{name}");
        }
    }

    #[test]
    fn aborted_entry_leaves_no_tail() {
        let dir = TempDir::new();
        let path = dir.path().join("a.lockbox-backup");
        let cancel = CancelToken::new();
        let p = payload();
        let mut w = ArchiveWriter::new(File::create(&path).unwrap());
        let (header, item1) = (&p[0], &p[1]);
        w.add(&header.0, &mut &header.1[..], 7, &cancel).unwrap();
        let aborted = w
            .add_with(&blob(3), |dst| {
                dst.write_all(&vec![7; 3 * MIB])?;
                Err(CoreError::Damaged { what: "file" })
            })
            .unwrap();
        assert_eq!(aborted, None);
        w.add(&item1.0, &mut &item1.1[..], 300, &cancel).unwrap();
        let manifest = serialize_manifest(&manifest_for(&refs(&p[..2]), None));
        w.add(
            MANIFEST_FILE,
            &mut &manifest[..],
            manifest.len() as u64,
            &cancel,
        )
        .unwrap();
        w.finish().unwrap().sync_all().unwrap();

        let archive = BackupArchive::open(&path, &cancel).unwrap();
        assert!(archive.entry(&blob(3)).is_none());
        assert_eq!(archive.entries().len(), 2);
        // The strict reader puts the end record at exactly the end of the file; also
        // check the length directly.
        let bytes = std::fs::read(&path).unwrap();
        assert!(bytes.len() < MIB);
        assert_eq!(
            &bytes[bytes.len() - 22..bytes.len() - 18],
            &[0x50, 0x4B, 0x05, 0x06]
        );

        // Other errors pass through.
        let mut w = ArchiveWriter::new(File::create(dir.path().join("b")).unwrap());
        let result = w.add_with(&blob(4), |_| Err(CoreError::Cancelled));
        assert!(matches!(result, Err(CoreError::Cancelled)));
    }

    #[test]
    fn writer_short_source_fails() {
        let dir = TempDir::new();
        let mut w = ArchiveWriter::new(File::create(dir.path().join("s")).unwrap());
        let cancel = CancelToken::new();
        let short = w.add(&item(1), &mut &[1u8; 10][..], 20, &cancel);
        assert!(matches!(short, Err(CoreError::InvalidInput { .. })));
        let long = w.add(&item(2), &mut &[1u8; 30][..], 20, &cancel);
        assert!(matches!(long, Err(CoreError::InvalidInput { .. })));
        let bad_name = w.add("../x", &mut &[1u8; 1][..], 1, &cancel);
        assert!(matches!(bad_name, Err(CoreError::InvalidInput { .. })));
    }

    /// Hands out zeros up to `left`, counting what it gave.
    struct Counting {
        left: usize,
        given: usize,
    }

    impl Read for Counting {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let n = buf.len().min(self.left);
            buf[..n].fill(0);
            self.left -= n;
            self.given += n;
            Ok(n)
        }
    }

    #[test]
    fn copy_hashed_cancel_is_prompt() {
        let token = CancelToken::new();
        failpoint::arm_cancel("copy.after_buffer", token.clone());
        let mut src = Counting {
            left: 5 * MIB,
            given: 0,
        };
        let result = copy_hashed(&mut src, 5 * MIB as u64, &mut std::io::sink(), &token);
        failpoint::disarm_all();
        assert!(matches!(result, Err(CoreError::Cancelled)));
        assert_eq!(src.given, MIB);

        let mut src = Counting { left: 5, given: 0 };
        let hash = copy_hashed(&mut src, 5, &mut std::io::sink(), &CancelToken::new());
        assert_eq!(hash.unwrap(), sha(&[0; 5]));
    }

    #[cfg(windows)]
    #[test]
    fn archive_held_against_writers() {
        let dir = TempDir::new();
        let path = dir.path().join("h.lockbox-backup");
        std::fs::write(&path, base()).unwrap();
        let archive = BackupArchive::open(&path, &CancelToken::new()).unwrap();
        assert!(std::fs::OpenOptions::new().write(true).open(&path).is_err());
        assert!(std::fs::rename(&path, dir.path().join("moved")).is_err());
        drop(archive);
        std::fs::OpenOptions::new().write(true).open(&path).unwrap();
    }

    #[test]
    fn is_same_file_compares_canonical_paths() {
        let dir = TempDir::new();
        let path = dir.path().join("s.lockbox-backup");
        std::fs::write(&path, base()).unwrap();
        std::fs::write(dir.path().join("other"), b"x").unwrap();
        let archive = BackupArchive::open(&path, &CancelToken::new()).unwrap();
        assert!(archive.is_same_file(&path).unwrap());
        let roundabout = dir.path().join("sub").join("..").join("s.lockbox-backup");
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        assert!(archive.is_same_file(&roundabout).unwrap());
        assert!(!archive.is_same_file(&dir.path().join("other")).unwrap());
        assert!(!archive.is_same_file(&dir.path().join("missing")).unwrap());
    }

    /// Counts how often the failpoint `step` is reached on this thread.
    fn count_steps(step: &'static str) -> std::rc::Rc<std::cell::Cell<usize>> {
        let seen = std::rc::Rc::new(std::cell::Cell::new(0));
        let counter = seen.clone();
        failpoint::observe(step, Box::new(move || counter.set(counter.get() + 1)));
        seen
    }

    /// Review finding 6: the size cap refuses before any of the directory is read. The
    /// fixture keeps every offset consistent; only the cap stands in its way.
    #[test]
    fn directory_cap_refuses_before_reading() {
        let mut b = base();
        let (eocd, zip64) = (b.len() - 22, b.len() - 98);
        let size: u64 = 5 * 256 + 1;
        let offset = zip64 as u64 - size;
        patch(&mut b, zip64 + 40, &size.to_le_bytes());
        patch(&mut b, zip64 + 48, &offset.to_le_bytes());
        patch(
            &mut b,
            eocd + 16,
            &u32::try_from(offset).unwrap().to_le_bytes(),
        );
        let pieces = count_steps(DIRECTORY_PIECE);
        let refused_with = refused(&b);
        failpoint::disarm_all();
        assert_eq!(refused_with, "backup: central directory");
        assert_eq!(pieces.get(), 0, "the directory was read");
        // The same observer does fire for a valid archive.
        let pieces = count_steps(DIRECTORY_PIECE);
        open_bytes(&base()).unwrap();
        failpoint::disarm_all();
        assert_eq!(pieces.get(), 1);
    }

    /// Review finding 3: the manifest is read in 1 MiB pieces with a cancel check before
    /// each, and once more before parsing.
    #[test]
    fn manifest_read_is_cancellable() {
        let p = payload();
        // Large enough for three pieces; never parsed, as the cancel comes first.
        let manifest = vec![b' '; 2 * MIB + 10];
        let bytes = write_archive(&[], &refs(&p), Some(&manifest));
        let token = CancelToken::new();
        let pieces = count_steps(MANIFEST_PIECE);
        failpoint::arm_cancel(MANIFEST_PIECE, token.clone());
        let dir = TempDir::new();
        let path = dir.path().join("m.lockbox-backup");
        std::fs::write(&path, &bytes).unwrap();
        let result = BackupArchive::open(&path, &token);
        failpoint::disarm_all();
        assert!(matches!(result, Err(CoreError::Cancelled)));
        assert_eq!(pieces.get(), 1, "stopped after the first piece");

        // A cancel during the last (here the only) piece is still caught before parsing.
        let small = build_backup(&refs(&p), None);
        std::fs::write(&path, &small).unwrap();
        let token = CancelToken::new();
        failpoint::arm_cancel(MANIFEST_PIECE, token.clone());
        let result = BackupArchive::open(&path, &token);
        failpoint::disarm_all();
        assert!(matches!(result, Err(CoreError::Cancelled)));
    }

    /// `base()` with `name`'s central header offset moved into its ZIP64 field as `offset`
    /// (the record grows by 8 bytes; the directory size and locator follow).
    fn with_zip64_offset(name: &str, offset: u64) -> Vec<u8> {
        let mut b = base();
        let c = central_offset(&b, name);
        let extra = c + 46 + name.len();
        patch(&mut b, c + 42, &u32::MAX.to_le_bytes());
        patch(&mut b, c + 30, &28u16.to_le_bytes()); // extra field length 20 -> 28
        patch(&mut b, extra + 2, &24u16.to_le_bytes()); // ZIP64 data 16 -> 24
        let tail = b.split_off(extra + 20);
        b.extend(offset.to_le_bytes());
        b.extend(tail);
        let (locator, zip64) = (b.len() - 22 - 20, b.len() - 98);
        let field = |b: &[u8], at: usize| u64::from_le_bytes(b[at..at + 8].try_into().unwrap());
        let cd_size = field(&b, zip64 + 40) + 8;
        patch(&mut b, zip64 + 40, &cd_size.to_le_bytes());
        patch(&mut b, locator + 8, &(zip64 as u64).to_le_bytes());
        b
    }

    /// Review finding 4: a local header offset from the file is range-checked before any
    /// read, so an extreme one is a named refusal, never an I/O error.
    #[test]
    fn extreme_local_offsets_refused() {
        let item1 = item(1);
        let real = entry_offset(&base(), &item1) as u64;
        open_bytes(&with_zip64_offset(&item1, real)).unwrap();
        let len = with_zip64_offset(&item1, real).len() as u64;
        for offset in [u64::MAX, u64::MAX - 29, len - 10, len] {
            assert_eq!(
                refused(&with_zip64_offset(&item1, offset)),
                "backup: local header",
                "{offset}"
            );
        }
        // The fixed part fits but the name runs into the directory.
        let mut b = base();
        let at = entry_offset(&b, MANIFEST_FILE) + 28;
        patch(&mut b, at, &u16::MAX.to_le_bytes());
        assert_eq!(refused(&b), "backup: local header");
    }

    #[test]
    fn open_cancel() {
        let dir = TempDir::new();
        let path = dir.path().join("c.lockbox-backup");
        std::fs::write(&path, base()).unwrap();
        let cancel = CancelToken::new();
        cancel.cancel();
        assert!(matches!(
            BackupArchive::open(&path, &cancel),
            Err(CoreError::Cancelled)
        ));
    }

    #[test]
    fn rewrite_backup_modes() {
        let dir = TempDir::new();
        let path = dir.path().join("w.lockbox-backup");
        let key = crate::secret::Key32::from_bytes([9; 32]);
        std::fs::write(&path, build_backup(&refs(&payload()), Some(&key))).unwrap();
        let edit = |m: &mut std::collections::BTreeMap<String, Vec<u8>>| {
            m.get_mut(&item(1)).unwrap()[0] ^= 1;
        };
        rewrite_backup(&path, edit, ManifestMode::Rehash { key: Some(&key) });
        let a = BackupArchive::open(&path, &CancelToken::new()).unwrap();
        assert!(crate::manifest::verify_manifest_mac(a.manifest(), &key));
        let mut changed = vec![1; 300];
        changed[0] = 0;
        assert_eq!(a.manifest().entry(&item(1)).unwrap().sha256, sha(&changed));
        let old_mac = a.manifest().mac;
        assert!(old_mac.is_some());
        drop(a);
        // A forger without the key: new hashes, the exact old MAC, which no longer verifies.
        rewrite_backup(&path, edit, ManifestMode::Rehash { key: None });
        let a = BackupArchive::open(&path, &CancelToken::new()).unwrap();
        assert_eq!(a.manifest().mac, old_mac);
        assert_eq!(a.manifest().entry(&item(1)).unwrap().sha256, sha(&[1; 300]));
        assert!(!crate::manifest::verify_manifest_mac(a.manifest(), &key));
        drop(a);
        let add = |m: &mut std::collections::BTreeMap<String, Vec<u8>>| {
            m.insert(blob(8), vec![8]);
        };
        rewrite_backup(&path, add, ManifestMode::Keep);
        assert!(matches!(
            BackupArchive::open(&path, &CancelToken::new()),
            Err(CoreError::Damaged {
                what: "backup: manifest mismatch"
            })
        ));
    }
}
