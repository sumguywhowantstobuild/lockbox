//! Encrypted file blobs (spec 5.5): a file is cut into 1 MiB chunks and sealed with the
//! STREAM construction (`aead-stream`, big-endian 32-bit counter) over XChaCha20-Poly1305.
//! Each chunk's nonce is the 19-byte random prefix, the chunk counter (big-endian u32) and a
//! last-chunk flag byte. The chunk AD binds version, vault, file, total length and chunk count.
//!
//! Streaming only: no vault, no paths. Plaintext lives in one fixed-size wiped buffer.

use crate::ad::{encode_ad, v16};
use crate::error::{CoreError, Result};
use crate::ids::{FileId, VaultId};
use crate::item::FileRef;
use crate::secret::{Key32, random_bytes};
use aead_stream::{DecryptorBE32, EncryptorBE32, Nonce, StreamBE32};
use chacha20poly1305::XChaCha20Poly1305;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use zeroize::Zeroizing;

/// The blob format version written today.
pub const BLOB_VERSION: u16 = 1;
/// Plaintext bytes per chunk in blob version 1 (the last chunk may be smaller).
pub const CHUNK_SIZE: u32 = 1_048_576;
/// Largest file accepted: 256 GiB, i.e. 262 144 chunks, far below the 2^32 counter limit.
pub const MAX_FILE_BYTES: u64 = 274_877_906_944;

/// Asks a long operation to stop. Clones share one flag.
#[derive(Clone, Debug, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::Relaxed);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }

    /// `Err(Cancelled)` once cancelled.
    pub(crate) fn check(&self) -> Result<()> {
        if self.is_cancelled() {
            return Err(CoreError::Cancelled);
        }
        Ok(())
    }
}

/// Where temporary plaintext files are written down before they exist, so a crash cannot
/// leave one behind unnoticed (spec 7.2). Plan 3 provides the real journal.
pub trait OutputJournal {
    fn record(&self, temp: &Path);
    fn clear(&self, temp: &Path);
}

/// A journal that remembers nothing.
pub struct NoJournal;

impl OutputJournal for NoJournal {
    fn record(&self, _temp: &Path) {}
    fn clear(&self, _temp: &Path) {}
}

const CHUNK: u64 = CHUNK_SIZE as u64;
const TAG_LEN: u64 = 16;
pub(crate) const SIZE_CHANGED: CoreError = CoreError::InvalidInput {
    what: "source size changed",
};
const DAMAGED: CoreError = CoreError::Damaged { what: "file" };

type Cipher = XChaCha20Poly1305;

/// Number of chunks for `length` plaintext bytes: at least one, even for an empty file.
pub fn chunk_count(length: u64) -> u64 {
    length.div_ceil(CHUNK).max(1)
}

/// Exact size of the stored blob: the plaintext plus a 16-byte tag per chunk. Saturates at
/// `u64::MAX` for lengths no file can have, so callers' size checks simply fail.
pub fn blob_len(length: u64) -> u64 {
    length.saturating_add(TAG_LEN * chunk_count(length))
}

/// `TooLarge` when `length` is over [`MAX_FILE_BYTES`].
pub(crate) fn check_length(length: u64) -> Result<()> {
    if length > MAX_FILE_BYTES {
        return Err(CoreError::TooLarge { what: "file" });
    }
    Ok(())
}

#[cfg(test)]
thread_local! {
    static FORCED_FILE_ID: std::cell::Cell<Option<FileId>> = const { std::cell::Cell::new(None) };
}

fn next_file_id() -> FileId {
    #[cfg(test)]
    if let Some(id) = FORCED_FILE_ID.with(|id| id.take()) {
        return id;
    }
    FileId::random()
}

/// Makes the next `new_file_ref` on this thread use `id`, to force a name collision.
#[cfg(test)]
pub(crate) fn force_next_file_id(id: FileId) {
    FORCED_FILE_ID.with(|cell| cell.set(Some(id)));
}

/// A fresh file record for a file of `length` bytes: new ID, key and nonce prefix.
pub(crate) fn new_file_ref(length: u64, name: String, media_type: String) -> FileRef {
    FileRef {
        file_id: next_file_id(),
        blob_version: BLOB_VERSION,
        chunk_size: CHUNK_SIZE,
        file_key: Key32::random(),
        nonce_prefix: random_bytes(),
        length,
        chunk_count: chunk_count(length),
        name,
        media_type,
    }
}

/// The authenticated data of every chunk of this file (spec 5.1, 5.5).
fn chunk_ad(vault_id: &VaultId, fref: &FileRef) -> Vec<u8> {
    encode_ad(
        "lockbox/chunk",
        &[
            &v16(fref.blob_version),
            &vault_id.0,
            &fref.file_id.0,
            &fref.length.to_le_bytes(),
            &fref.chunk_count.to_le_bytes(),
        ],
    )
}

/// The record must describe a blob this code can read. Read from an item, so a mismatch
/// means the item is damaged (or from a newer version).
fn check_record(fref: &FileRef) -> Result<()> {
    if fref.blob_version != BLOB_VERSION {
        return Err(CoreError::UnsupportedVersion);
    }
    if fref.chunk_size != CHUNK_SIZE
        || fref.length > MAX_FILE_BYTES
        || fref.chunk_count != chunk_count(fref.length)
    {
        return Err(DAMAGED);
    }
    Ok(())
}

/// Plaintext bytes in chunk `index` (all full except possibly the last).
fn plain_len(fref: &FileRef, index: u64) -> usize {
    let rest = fref.length - index * CHUNK;
    usize::try_from(rest.min(CHUNK)).expect("a chunk fits in memory")
}

/// Reads until `buf` is full or the source ends; returns how many bytes arrived.
pub(crate) fn fill(src: &mut impl Read, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match src.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(filled)
}

/// Whether the source has nothing more to give.
pub(crate) fn at_end(src: &mut impl Read) -> std::io::Result<bool> {
    // Wiped: a source that grew hands over one real plaintext byte here.
    let mut probe = Zeroizing::new([0u8; 1]);
    Ok(fill(src, &mut *probe)? == 0)
}

/// One wiped buffer for every chunk. Its capacity covers the largest chunk plus tag, so
/// sealing in place never reallocates (a reallocation would leave an unwiped copy).
fn chunk_buffer() -> Zeroizing<Vec<u8>> {
    Zeroizing::new(Vec::with_capacity(CHUNK_SIZE as usize + TAG_LEN as usize))
}

fn stream_nonce(fref: &FileRef) -> &Nonce<Cipher, StreamBE32<Cipher>> {
    (&fref.nonce_prefix).into()
}

/// Seals `declared_len` bytes read from `src` into `dst`. Fewer or more bytes than
/// declared is `InvalidInput { "source size changed" }`.
pub fn encrypt_stream(
    src: &mut impl Read,
    declared_len: u64,
    dst: &mut impl Write,
    vault_id: &VaultId,
    fref: &FileRef,
    cancel: &CancelToken,
) -> Result<()> {
    check_length(declared_len)?;
    check_record(fref)?;
    if fref.length != declared_len {
        return Err(CoreError::InvalidInput {
            what: "file record",
        });
    }
    let ad = chunk_ad(vault_id, fref);
    let mut stream =
        EncryptorBE32::<Cipher>::new(fref.file_key.as_bytes().into(), stream_nonce(fref));
    let mut buf = chunk_buffer();
    let seal_failed = |_| CoreError::InvalidInput { what: "chunk" };
    let mut read_chunk = |index: u64, buf: &mut Vec<u8>| -> Result<()> {
        cancel.check()?;
        buf.resize(plain_len(fref, index), 0);
        if fill(src, buf)? != buf.len() {
            return Err(SIZE_CHANGED);
        }
        Ok(())
    };
    let last = fref.chunk_count - 1;
    for index in 0..last {
        read_chunk(index, &mut buf)?;
        stream
            .encrypt_next_in_place(&ad, &mut *buf)
            .map_err(seal_failed)?;
        dst.write_all(&buf)?;
    }
    read_chunk(last, &mut buf)?;
    // One more read must find the end, or the file grew while it was being read.
    if !at_end(src)? {
        return Err(SIZE_CHANGED);
    }
    // Consumes the stream: nothing can be sealed after the last chunk.
    stream
        .encrypt_last_in_place(&ad, &mut *buf)
        .map_err(seal_failed)?;
    dst.write_all(&buf)?;
    Ok(())
}

/// Opens a blob of `blob_len` bytes read from `src` into `dst`. The size is checked before
/// any output, then each chunk is authenticated before its plaintext is written. A caller
/// must treat `dst` as unverified until this returns `Ok`.
pub fn decrypt_stream(
    src: &mut impl Read,
    blob_len: u64,
    dst: &mut impl Write,
    vault_id: &VaultId,
    fref: &FileRef,
    cancel: &CancelToken,
) -> Result<()> {
    check_record(fref)?;
    if blob_len != self::blob_len(fref.length) {
        return Err(DAMAGED);
    }
    let ad = chunk_ad(vault_id, fref);
    let mut stream =
        DecryptorBE32::<Cipher>::new(fref.file_key.as_bytes().into(), stream_nonce(fref));
    let mut buf = chunk_buffer();
    let mut read_chunk = |index: u64, buf: &mut Vec<u8>| -> Result<()> {
        cancel.check()?;
        buf.resize(plain_len(fref, index) + TAG_LEN as usize, 0);
        // A short read means the blob shrank after the size check.
        if fill(src, buf)? != buf.len() {
            return Err(DAMAGED);
        }
        Ok(())
    };
    let last = fref.chunk_count - 1;
    for index in 0..last {
        read_chunk(index, &mut buf)?;
        stream
            .decrypt_next_in_place(&ad, &mut *buf)
            .map_err(|_| DAMAGED)?;
        dst.write_all(&buf)?;
    }
    read_chunk(last, &mut buf)?;
    if !at_end(src)? {
        return Err(DAMAGED);
    }
    stream
        .decrypt_last_in_place(&ad, &mut *buf)
        .map_err(|_| DAMAGED)?;
    dst.write_all(&buf)?;
    Ok(())
}

/// Hands out `src`'s bytes and copies each one into `dst` and the hasher as it goes.
struct Tee<'a, R, W> {
    src: &'a mut R,
    dst: &'a mut W,
    hash: Sha256,
    #[cfg(any(test, feature = "test-internals"))]
    read: u64,
}

impl<R: Read, W: Write> Read for Tee<'_, R, W> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.src.read(buf)?;
        self.dst.write_all(&buf[..n])?;
        self.hash.update(&buf[..n]);
        #[cfg(any(test, feature = "test-internals"))]
        {
            const STEP: u64 = CHUNK + TAG_LEN;
            let before = self.read;
            self.read += n as u64;
            if self.read / STEP > before / STEP {
                crate::fsio::failpoint::check("tee.after_chunk").map_err(std::io::Error::other)?;
            }
        }
        Ok(n)
    }
}

/// Copies a blob of `blob_size` bytes from `src` to `dst` unchanged while authenticating every
/// chunk, and returns the SHA-256 of the bytes copied. Any authentication failure is
/// `Damaged { "file" }`; `dst` must then be thrown away, as it may hold part of the blob.
pub fn authenticate_copy(
    src: &mut impl Read,
    blob_size: u64,
    dst: &mut impl Write,
    vault_id: &VaultId,
    fref: &FileRef,
    cancel: &CancelToken,
) -> Result<[u8; 32]> {
    let mut tee = Tee {
        src,
        dst,
        hash: Sha256::new(),
        #[cfg(any(test, feature = "test-internals"))]
        read: 0,
    };
    decrypt_stream(
        &mut tee,
        blob_size,
        &mut std::io::sink(),
        vault_id,
        fref,
        cancel,
    )?;
    Ok(tee.hash.finalize().into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ad::{encode_ad, v16};
    use crate::aead;
    use crate::ids::FileId;
    use std::io::Cursor;

    const MIB: usize = 1_048_576;
    const VAULT: VaultId = VaultId([0xA1; 16]);

    fn plain(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i.wrapping_mul(31) % 251) as u8).collect()
    }

    fn fref(len: usize) -> FileRef {
        new_file_ref(len as u64, "n".into(), "application/octet-stream".into())
    }

    fn seal(data: &[u8], fref: &FileRef) -> Vec<u8> {
        let mut blob = Vec::new();
        encrypt_stream(
            &mut Cursor::new(data),
            data.len() as u64,
            &mut blob,
            &VAULT,
            fref,
            &CancelToken::new(),
        )
        .unwrap();
        blob
    }

    fn open_with(blob: &[u8], vault: &VaultId, fref: &FileRef) -> Result<Vec<u8>> {
        let mut out = Vec::new();
        decrypt_stream(
            &mut Cursor::new(blob),
            blob.len() as u64,
            &mut out,
            vault,
            fref,
            &CancelToken::new(),
        )?;
        Ok(out)
    }

    fn open(blob: &[u8], fref: &FileRef) -> Result<Vec<u8>> {
        open_with(blob, &VAULT, fref)
    }

    fn damaged<T: std::fmt::Debug>(r: Result<T>) -> bool {
        matches!(r, Err(CoreError::Damaged { .. }))
    }

    /// Hands out at most `max` bytes per read, to prove short reads are handled.
    struct Trickle<R>(R, usize);

    impl<R: Read> Read for Trickle<R> {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let n = buf.len().min(self.1);
            self.0.read(&mut buf[..n])
        }
    }

    #[test]
    fn round_trip_sizes() {
        for len in [0, 1, MIB - 1, MIB, MIB + 1, 3 * MIB + 7] {
            let data = plain(len);
            let fref = fref(len);
            let blob = seal(&data, &fref);
            assert_eq!(blob.len() as u64, blob_len(len as u64), "len {len}");
            assert_eq!(open(&blob, &fref).unwrap(), data, "len {len}");
        }
    }

    #[test]
    fn chunk_counts() {
        assert_eq!(chunk_count(0), 1);
        assert_eq!(chunk_count(1), 1);
        assert_eq!(chunk_count(MIB as u64), 1);
        assert_eq!(chunk_count(MIB as u64 + 1), 2);
        assert_eq!(chunk_count(MAX_FILE_BYTES), 262_144);
    }

    /// Review Minor: both helpers are public, so no `u64` may overflow them.
    #[test]
    fn lengths_never_overflow() {
        assert_eq!(chunk_count(u64::MAX), u64::MAX.div_ceil(MIB as u64));
        assert_eq!(blob_len(u64::MAX), u64::MAX);
        assert_eq!(blob_len(MAX_FILE_BYTES), MAX_FILE_BYTES + 16 * 262_144);
    }

    #[test]
    fn empty_file_is_one_final_chunk() {
        let f = fref(0);
        assert_eq!(f.chunk_count, 1);
        let blob = seal(&[], &f);
        assert_eq!(blob.len(), 16);
        assert!(open(&blob, &f).unwrap().is_empty());
    }

    #[test]
    fn short_reads_are_handled() {
        let data = plain(MIB + 10);
        let f = fref(data.len());
        let mut blob = Vec::new();
        encrypt_stream(
            &mut Trickle(Cursor::new(&data), 4093),
            data.len() as u64,
            &mut blob,
            &VAULT,
            &f,
            &CancelToken::new(),
        )
        .unwrap();
        let mut out = Vec::new();
        decrypt_stream(
            &mut Trickle(Cursor::new(&blob), 4093),
            blob.len() as u64,
            &mut out,
            &VAULT,
            &f,
            &CancelToken::new(),
        )
        .unwrap();
        assert_eq!(out, data);
    }

    /// The chunk AD, built by hand (spec 5.1 / 5.5), so a change to the encoding is noticed.
    #[test]
    fn chunk_ad_golden_bytes() {
        let mut f = fref(5_000_000);
        f.file_id = FileId([0x33; 16]);
        let mut expected = b"lockbox/chunk".to_vec();
        expected.extend([2, 0, 0, 0, 1, 0]); // blob_version 1
        expected.extend([16, 0, 0, 0]);
        expected.extend([0xA1; 16]); // vault id
        expected.extend([16, 0, 0, 0]);
        expected.extend([0x33; 16]); // file id
        expected.extend([8, 0, 0, 0]);
        expected.extend(5_000_000u64.to_le_bytes());
        expected.extend([8, 0, 0, 0]);
        expected.extend(5u64.to_le_bytes());
        assert_eq!(f.chunk_count, 5);
        assert_eq!(chunk_ad(&VAULT, &f), expected);
        // ... and the field encoder agrees with the hand-built bytes.
        let by_encoder = encode_ad(
            "lockbox/chunk",
            &[
                &v16(1),
                &VAULT.0,
                &[0x33; 16],
                &5_000_000u64.to_le_bytes(),
                &5u64.to_le_bytes(),
            ],
        );
        assert_eq!(by_encoder, expected);
    }

    /// Opens a real blob with plain XChaCha20-Poly1305, no `aead-stream`: proves the nonce
    /// layout of spec 5.5 (prefix, big-endian counter, last flag) independently.
    #[test]
    fn blob_opens_with_plain_xchacha_and_documented_nonce() {
        let len = MIB + 5; // two chunks, so both flag values are used
        let data = plain(len);
        let f = fref(len);
        let blob = seal(&data, &f);
        let ad = chunk_ad(&VAULT, &f);
        let nonce = |counter: u32, last: u8| {
            let mut n = [0u8; 24];
            n[..19].copy_from_slice(&f.nonce_prefix);
            n[19..23].copy_from_slice(&counter.to_be_bytes());
            n[23] = last;
            n
        };
        let (first, second) = blob.split_at(MIB + 16);
        let mut chunk0 = first.to_vec();
        aead::decrypt_in_place(&f.file_key, &nonce(0, 0), &ad, &mut chunk0).unwrap();
        assert_eq!(chunk0, &data[..MIB]);
        let mut chunk1 = second.to_vec();
        aead::decrypt_in_place(&f.file_key, &nonce(1, 1), &ad, &mut chunk1).unwrap();
        assert_eq!(chunk1, &data[MIB..]);
        // The flag really matters: the last chunk does not open as a non-last one.
        let mut wrong = second.to_vec();
        assert!(aead::decrypt_in_place(&f.file_key, &nonce(1, 0), &ad, &mut wrong).is_err());
        // An empty file is a single chunk carrying the last flag.
        let empty = fref(0);
        let mut only = seal(&[], &empty);
        let empty_ad = chunk_ad(&VAULT, &empty);
        let mut n = [0u8; 24];
        n[..19].copy_from_slice(&empty.nonce_prefix);
        n[23] = 1;
        aead::decrypt_in_place(&empty.file_key, &n, &empty_ad, &mut only).unwrap();
        assert!(only.is_empty());
    }

    #[test]
    fn tamper_refused() {
        let len = 2 * MIB + 100; // three chunks
        let data = plain(len);
        let f = fref(len);
        let blob = seal(&data, &f);
        let step = MIB + 16;

        let flip = |at: usize| {
            let mut b = blob.clone();
            b[at] ^= 1;
            b
        };
        assert!(damaged(open(&flip(0), &f)), "flip in chunk 0");
        assert!(
            damaged(open(&flip(blob.len() - 1), &f)),
            "flip in last chunk"
        );

        let mut swapped = blob.clone();
        let (a, rest) = swapped.split_at_mut(step);
        a.swap_with_slice(&mut rest[..step]);
        assert!(damaged(open(&swapped, &f)), "chunks 0 and 1 swapped");

        let dropped = &blob[..blob.len() - 116]; // last chunk (100 + 16) gone
        assert!(damaged(open(dropped, &f)), "last chunk dropped");

        let mut duplicated = blob[..step].to_vec();
        duplicated.extend_from_slice(&blob);
        assert!(damaged(open(&duplicated, &f)), "chunk duplicated");

        let mut appended = blob.clone();
        appended.extend([0u8; 17]);
        assert!(damaged(open(&appended, &f)), "17 bytes appended");

        assert!(damaged(open(&blob[..blob.len() - 1], &f)), "truncated by 1");
    }

    /// Chunks of equal size swapped keep the size right, so only authentication can refuse.
    #[test]
    fn authentication_runs_after_the_size_check() {
        let len = 2 * MIB;
        let f = fref(len);
        let blob = seal(&plain(len), &f);
        // Right size, wrong content: refused by authentication, not by the size check.
        let mut forged = blob.clone();
        forged[100] ^= 0xFF;
        assert_eq!(forged.len() as u64, blob_len(len as u64));
        assert!(damaged(open(&forged, &f)));
        // Wrong size: refused before any output is produced.
        struct NoWrite;
        impl Write for NoWrite {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                panic!("output before the size check")
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let result = decrypt_stream(
            &mut Cursor::new(&blob[..blob.len() - 1]),
            blob.len() as u64 - 1,
            &mut NoWrite,
            &VAULT,
            &f,
            &CancelToken::new(),
        );
        assert!(damaged(result));
    }

    #[test]
    fn wrong_vault_or_file_id_refused() {
        let f = fref(MIB + 1);
        let blob = seal(&plain(MIB + 1), &f);
        assert!(damaged(open_with(&blob, &VaultId([0xB2; 16]), &f)));
        let mut other = f.clone();
        other.file_id = FileId([0x77; 16]);
        assert!(damaged(open(&blob, &other)));
    }

    #[test]
    fn inconsistent_file_record_refused() {
        let f = fref(10);
        let blob = seal(&plain(10), &f);
        let mut bad = f.clone();
        bad.chunk_count = 2;
        assert!(damaged(open(&blob, &bad)));
        let mut bad = f.clone();
        bad.chunk_size = 1024;
        assert!(damaged(open(&blob, &bad)));
        let mut bad = f.clone();
        bad.blob_version = 2;
        assert!(matches!(
            open(&blob, &bad),
            Err(CoreError::UnsupportedVersion)
        ));
    }

    /// Cancels when the first chunk has been written.
    struct CancelOnWrite(CancelToken, Vec<u8>);

    impl Write for CancelOnWrite {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            self.0.cancel();
            self.1.extend_from_slice(data);
            Ok(data.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn cancel_stops_and_errors() {
        let len = 3 * MIB;
        let f = fref(len);
        let data = plain(len);
        let cancel = CancelToken::new();
        let mut out = CancelOnWrite(cancel.clone(), Vec::new());
        let result = encrypt_stream(
            &mut Cursor::new(&data),
            len as u64,
            &mut out,
            &VAULT,
            &f,
            &cancel,
        );
        assert!(matches!(result, Err(CoreError::Cancelled)));
        assert_eq!(out.1.len(), MIB + 16, "stopped after the first chunk");

        let blob = seal(&data, &f);
        let cancel = CancelToken::new();
        let mut out = CancelOnWrite(cancel.clone(), Vec::new());
        let result = decrypt_stream(
            &mut Cursor::new(&blob),
            blob.len() as u64,
            &mut out,
            &VAULT,
            &f,
            &cancel,
        );
        assert!(matches!(result, Err(CoreError::Cancelled)));
        assert_eq!(out.1.len(), MIB);
    }

    #[test]
    fn authenticate_copy_tees_and_checks() {
        let len = 2 * MIB + 5; // three chunks
        let f = fref(len);
        let blob = seal(&plain(len), &f);
        let copy = |blob: &[u8]| {
            let mut dst = Vec::new();
            let result = authenticate_copy(
                &mut Trickle(Cursor::new(blob), 70_000),
                blob.len() as u64,
                &mut dst,
                &VAULT,
                &f,
                &CancelToken::new(),
            );
            (result, dst)
        };
        let (hash, dst) = copy(&blob);
        assert_eq!(dst, blob);
        assert_eq!(hash.unwrap(), <[u8; 32]>::from(Sha256::digest(&blob)));

        let mut tampered = blob.clone();
        tampered[MIB + 16 + 3] ^= 1; // inside chunk 1
        assert!(matches!(
            copy(&tampered).0,
            Err(CoreError::Damaged { what: "file" })
        ));
    }

    #[test]
    fn authenticate_copy_cancels_after_a_chunk() {
        let len = 3 * MIB;
        let f = fref(len);
        let blob = seal(&plain(len), &f);
        let cancel = CancelToken::new();
        crate::fsio::failpoint::arm_cancel("tee.after_chunk", cancel.clone());
        let mut dst = Vec::new();
        let result = authenticate_copy(
            &mut Cursor::new(&blob),
            blob.len() as u64,
            &mut dst,
            &VAULT,
            &f,
            &cancel,
        );
        crate::fsio::failpoint::disarm_all();
        assert!(matches!(result, Err(CoreError::Cancelled)));
        assert_eq!(dst.len(), MIB + 16);
    }

    #[test]
    fn cancel_token_clones_share_the_flag() {
        let a = CancelToken::new();
        let b = a.clone();
        assert!(!b.is_cancelled());
        a.cancel();
        assert!(b.is_cancelled());
    }

    #[test]
    fn source_size_change_is_refused() {
        let f = fref(2 * MIB);
        let mut sink = Vec::new();
        let run = |actual: usize, sink: &mut Vec<u8>| {
            encrypt_stream(
                &mut Cursor::new(plain(actual)),
                2 * MIB as u64,
                sink,
                &VAULT,
                &f,
                &CancelToken::new(),
            )
        };
        let changed = |r: Result<()>| {
            matches!(
                r,
                Err(CoreError::InvalidInput {
                    what: "source size changed"
                })
            )
        };
        assert!(changed(run(MIB, &mut sink)), "shorter");
        assert!(changed(run(2 * MIB + 1, &mut sink)), "longer");
        assert!(changed(run(0, &mut sink)), "empty");
        sink.clear();
        run(2 * MIB, &mut sink).unwrap();
    }

    #[test]
    fn file_over_256_gib_rejected_before_any_io() {
        struct Boom;
        impl Read for Boom {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                panic!("read")
            }
        }
        impl Write for Boom {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                panic!("write")
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let len = MAX_FILE_BYTES + 1;
        let f = new_file_ref(len, "n".into(), "m".into());
        let result = encrypt_stream(&mut Boom, len, &mut Boom, &VAULT, &f, &CancelToken::new());
        assert!(matches!(result, Err(CoreError::TooLarge { .. })));
        assert!(matches!(
            check_length(MAX_FILE_BYTES + 1),
            Err(CoreError::TooLarge { .. })
        ));
        check_length(MAX_FILE_BYTES).unwrap();
    }

    #[test]
    fn declared_length_must_match_the_record() {
        let f = fref(10);
        let result = encrypt_stream(
            &mut Cursor::new(plain(11)),
            11,
            &mut Vec::new(),
            &VAULT,
            &f,
            &CancelToken::new(),
        );
        assert!(matches!(result, Err(CoreError::InvalidInput { .. })));
    }

    #[test]
    fn new_file_refs_are_unique_and_consistent() {
        let (a, b) = (fref(3 * MIB + 1), fref(3 * MIB + 1));
        assert_ne!(a.file_id, b.file_id);
        assert_ne!(a.file_key.as_bytes(), b.file_key.as_bytes());
        assert_ne!(a.nonce_prefix, b.nonce_prefix);
        assert_eq!(
            (a.blob_version, a.chunk_size, a.chunk_count),
            (1, 1_048_576, 4)
        );
        assert!(!format!("{a:?}").contains("file_key"));
    }
}
