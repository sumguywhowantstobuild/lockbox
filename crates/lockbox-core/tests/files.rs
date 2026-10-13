//! Encrypted files through the public API only: import, replace, export, purge.
//! Every vault creation runs a real ~1 s Argon2id derivation, so tests share vaults.

use lockbox_core::blob::{CancelToken, NoJournal, OutputJournal};
use lockbox_core::ids::{FileId, ItemId};
use lockbox_core::item::ItemKind;
use lockbox_core::{CoreError, Vault};
use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};

const PW: &str = "correct horse battery";

fn new_vault(parent: &Path) -> Vault {
    Vault::create(parent, "Family", PW).unwrap().vault
}

fn reopen(vault: Vault) -> Vault {
    let dir = vault.dir().to_path_buf();
    drop(vault);
    Vault::unlock_with_password(&dir, PW).unwrap().0
}

fn write(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, bytes).unwrap();
    path
}

fn blob_path(vault: &Vault, id: &FileId) -> PathBuf {
    vault
        .dir()
        .join("files")
        .join(format!("{}.blob", id.to_hex()))
}

fn first_file(vault: &Vault, item: &ItemId) -> FileId {
    vault.get_item(item).unwrap().attachments[0].file_id
}

fn names_in(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn pattern(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i % 253) as u8).collect()
}

/// Remembers every call, in order.
#[derive(Default)]
struct Recorder(RefCell<Vec<(&'static str, PathBuf)>>);

impl OutputJournal for Recorder {
    fn record(&self, temp: &Path) {
        self.0.borrow_mut().push(("record", temp.to_path_buf()));
    }
    fn clear(&self, temp: &Path) {
        self.0.borrow_mut().push(("clear", temp.to_path_buf()));
    }
}

#[test]
fn import_export_round_trip_across_unlock() {
    let parent = tempfile::tempdir().unwrap();
    let cancel = CancelToken::new();
    let mut vault = new_vault(parent.path());
    let data = pattern(2 * 1_048_576 + 5);
    let src = write(parent.path(), "photo.jpg", &data);

    let id = vault.new_file_item(None, &src, &cancel).unwrap();
    let item = vault.get_item(&id).unwrap();
    assert!(matches!(item.kind, ItemKind::File));
    assert_eq!(item.title, "photo.jpg");
    let file = &item.attachments[0];
    assert_eq!(file.name, "photo.jpg");
    assert_eq!(file.media_type, "application/octet-stream");
    assert_eq!((file.length, file.chunk_count), (data.len() as u64, 3));
    let (file_id, blob_len) = (file.file_id, file.length + 16 * 3);
    assert_eq!(
        fs::metadata(blob_path(&vault, &file_id)).unwrap().len(),
        blob_len
    );
    assert!(
        names_in(&vault.dir().join("files"))
            .iter()
            .all(|n| !n.contains("partial"))
    );

    let vault = reopen(vault);
    let dest = parent.path().join("copy.jpg");
    vault
        .export_file(&id, &file_id, &dest, &NoJournal, &cancel)
        .unwrap();
    assert_eq!(fs::read(&dest).unwrap(), data);
}

#[test]
fn attach_file_adds_to_an_existing_item() {
    let parent = tempfile::tempdir().unwrap();
    let cancel = CancelToken::new();
    let mut vault = new_vault(parent.path());
    let note = vault.new_item(ItemKind::Note, "Tax", None).unwrap();
    let src = write(parent.path(), "a.txt", b"one");
    let file = vault.attach_file(&note, &src, &cancel).unwrap();
    let item = vault.get_item(&note).unwrap();
    assert_eq!((item.revision, item.attachments.len()), (1, 1));
    assert_eq!(item.attachments[0].file_id, file);
    assert_eq!(item.title, "Tax");

    // Not on a missing item, a collection, or a trashed item.
    let missing = ItemId::random();
    assert!(matches!(
        vault.attach_file(&missing, &src, &cancel),
        Err(CoreError::NotFound)
    ));
    let collection = vault.new_item(ItemKind::Collection, "C", None).unwrap();
    assert!(matches!(
        vault.attach_file(&collection, &src, &cancel),
        Err(CoreError::InvalidInput { .. })
    ));
    vault.trash_item(&note).unwrap();
    assert!(matches!(
        vault.attach_file(&note, &src, &cancel),
        Err(CoreError::InvalidInput { .. })
    ));
    // The refusals happen before any blob is written.
    assert_eq!(
        names_in(&vault.dir().join("files")),
        [format!("{}.blob", file.to_hex()), "orphaned".to_string()]
    );
}

#[test]
fn new_file_item_can_join_a_collection() {
    let parent = tempfile::tempdir().unwrap();
    let mut vault = new_vault(parent.path());
    let collection = vault.new_item(ItemKind::Collection, "Taxes", None).unwrap();
    let src = write(parent.path(), "w2.pdf", b"pdf");
    let id = vault
        .new_file_item(Some(collection), &src, &CancelToken::new())
        .unwrap();
    assert_eq!(vault.get_item(&id).unwrap().collection, Some(collection));
    let bad = vault.new_file_item(Some(ItemId::random()), &src, &CancelToken::new());
    assert!(matches!(bad, Err(CoreError::InvalidInput { .. })));
}

#[test]
fn odd_names_preserved() {
    let parent = tempfile::tempdir().unwrap();
    let cancel = CancelToken::new();
    let mut vault = new_vault(parent.path());
    let long = "é".repeat(100); // 200 bytes: a legal name on Windows and Linux
    let names = ["Q3 report - final (v2).pdf", long.as_str(), "README"];
    let mut ids = Vec::new();
    for (i, name) in names.iter().enumerate() {
        let src = write(parent.path(), name, format!("content {i}").as_bytes());
        ids.push(vault.new_file_item(None, &src, &cancel).unwrap());
    }
    let vault = reopen(vault);
    for (i, (id, name)) in ids.iter().zip(names).enumerate() {
        let item = vault.get_item(id).unwrap();
        assert_eq!(item.attachments[0].name, name);
        assert_eq!(item.title, name);
        let dest = parent.path().join(format!("out{i}"));
        vault
            .export_file(id, &item.attachments[0].file_id, &dest, &NoJournal, &cancel)
            .unwrap();
        assert_eq!(fs::read(&dest).unwrap(), format!("content {i}").as_bytes());
    }
}

#[test]
fn replace_records_retired_blob() {
    let parent = tempfile::tempdir().unwrap();
    let cancel = CancelToken::new();
    let mut vault = new_vault(parent.path());
    let first = write(parent.path(), "v1.txt", b"version one");
    let second = write(parent.path(), "v2.txt", b"version two!");
    let id = vault.new_file_item(None, &first, &cancel).unwrap();
    let old = first_file(&vault, &id);
    let old_key = vault.get_item(&id).unwrap().attachments[0]
        .file_key
        .as_bytes()
        .to_owned();

    let new = vault
        .replace_attachment(&id, &old, &second, &cancel)
        .unwrap();
    assert_ne!(new, old);
    let item = vault.get_item(&id).unwrap();
    assert_eq!(item.attachments.len(), 1);
    assert_eq!(item.attachments[0].file_id, new);
    assert_eq!(item.attachments[0].name, "v2.txt");
    assert_ne!(
        item.attachments[0].file_key.as_bytes(),
        &old_key,
        "a new key"
    );
    assert_eq!(item.retired_blobs, [old]);
    assert_eq!(item.revision, 1);
    assert!(
        blob_path(&vault, &old).exists(),
        "the old blob is not touched"
    );
    assert!(blob_path(&vault, &new).exists());

    // The record survives a restart, and the old file cannot be named any more.
    let vault = reopen(vault);
    assert_eq!(vault.get_item(&id).unwrap().retired_blobs, [old]);
    let dest = parent.path().join("out");
    assert!(matches!(
        vault.export_file(&id, &old, &dest, &NoJournal, &cancel),
        Err(CoreError::NotFound)
    ));
    vault
        .export_file(&id, &new, &dest, &NoJournal, &cancel)
        .unwrap();
    assert_eq!(fs::read(&dest).unwrap(), b"version two!");
}

#[test]
fn replace_of_an_unknown_file_is_refused() {
    let parent = tempfile::tempdir().unwrap();
    let cancel = CancelToken::new();
    let mut vault = new_vault(parent.path());
    let src = write(parent.path(), "a.txt", b"a");
    let id = vault.new_file_item(None, &src, &cancel).unwrap();
    let result = vault.replace_attachment(&id, &FileId::random(), &src, &cancel);
    assert!(matches!(result, Err(CoreError::NotFound)));
    assert_eq!(
        names_in(&vault.dir().join("files")).len(),
        2,
        "no new blob: the blob and orphaned/"
    );
}

#[test]
fn export_verify_then_publish() {
    let parent = tempfile::tempdir().unwrap();
    let cancel = CancelToken::new();
    let mut vault = new_vault(parent.path());
    let data = pattern(1_048_576 + 100);
    let src = write(parent.path(), "report.pdf", &data);
    let id = vault.new_file_item(None, &src, &cancel).unwrap();
    let file = first_file(&vault, &id);

    let out = tempfile::tempdir().unwrap();
    let dest = write(out.path(), "report.pdf", b"OLD");

    // A damaged last chunk is only found after the first chunk was already decrypted.
    let blob = blob_path(&vault, &file);
    let good = fs::read(&blob).unwrap();
    let mut bad = good.clone();
    *bad.last_mut().unwrap() ^= 1;
    fs::write(&blob, &bad).unwrap();
    let journal = Recorder::default();
    let result = vault.export_file(&id, &file, &dest, &journal, &cancel);
    assert!(matches!(result, Err(CoreError::Damaged { .. })));
    assert_eq!(fs::read(&dest).unwrap(), b"OLD", "destination untouched");
    assert_eq!(names_in(out.path()), ["report.pdf"], "no temp file left");
    let calls = journal.0.borrow();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].0, "record");
    assert_eq!(calls[1].0, "clear");
    assert_eq!(calls[0].1, calls[1].1);
    let temp_name = calls[0]
        .1
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert!(temp_name.starts_with('.') && temp_name.ends_with(".lockbox-partial"));
    assert_eq!(calls[0].1.parent().unwrap(), out.path());
    drop(calls);

    // Intact again: the copy replaces the old file, and the journal sees record, then clear.
    fs::write(&blob, &good).unwrap();
    let journal = Recorder::default();
    vault
        .export_file(&id, &file, &dest, &journal, &cancel)
        .unwrap();
    assert_eq!(fs::read(&dest).unwrap(), data);
    assert_eq!(names_in(out.path()), ["report.pdf"]);
    let calls = journal.0.borrow();
    assert_eq!(
        calls.iter().map(|c| c.0).collect::<Vec<_>>(),
        ["record", "clear"]
    );
    assert!(!calls[0].1.exists());

    // The published copy is an ordinary, visible file, whether it replaced one or not.
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        let fresh = out.path().join("fresh.pdf");
        vault
            .export_file(&id, &file, &fresh, &NoJournal, &cancel)
            .unwrap();
        for path in [&dest, &fresh] {
            assert_eq!(
                fs::metadata(path).unwrap().file_attributes() & 0x2,
                0,
                "hidden"
            );
        }
    }
}

#[test]
fn export_refuses_a_cancelled_or_missing_blob_cleanly() {
    let parent = tempfile::tempdir().unwrap();
    let mut vault = new_vault(parent.path());
    let src = write(parent.path(), "a.txt", b"hello");
    let id = vault
        .new_file_item(None, &src, &CancelToken::new())
        .unwrap();
    let file = first_file(&vault, &id);
    let out = tempfile::tempdir().unwrap();
    let dest = out.path().join("a.txt");

    let cancel = CancelToken::new();
    cancel.cancel();
    let journal = Recorder::default();
    let result = vault.export_file(&id, &file, &dest, &journal, &cancel);
    assert!(matches!(result, Err(CoreError::Cancelled)));
    assert!(names_in(out.path()).is_empty(), "no temp, no destination");
    assert_eq!(journal.0.borrow().len(), 2);

    fs::remove_file(blob_path(&vault, &file)).unwrap();
    let result = vault.export_file(&id, &file, &dest, &NoJournal, &CancelToken::new());
    assert!(matches!(result, Err(CoreError::Damaged { .. })));
    assert!(names_in(out.path()).is_empty());
}

#[test]
fn purge_needs_the_trash_and_removes_everything() {
    let parent = tempfile::tempdir().unwrap();
    let cancel = CancelToken::new();
    let mut vault = new_vault(parent.path());
    let first = write(parent.path(), "a.txt", b"a");
    let second = write(parent.path(), "b.txt", b"b");
    let id = vault.new_file_item(None, &first, &cancel).unwrap();
    let old = first_file(&vault, &id);
    vault
        .replace_attachment(&id, &old, &second, &cancel)
        .unwrap();
    let kept = vault.new_file_item(None, &first, &cancel).unwrap();

    assert!(matches!(
        vault.purge_item(&id),
        Err(CoreError::InvalidInput {
            what: "not in trash"
        })
    ));
    vault.trash_item(&id).unwrap();
    vault.purge_item(&id).unwrap();

    let mut vault = reopen(vault);
    assert!(matches!(vault.get_item(&id), Err(CoreError::NotFound)));
    assert!(vault.get_item(&kept).is_ok(), "other items are untouched");
    let files = names_in(&vault.dir().join("files"));
    assert_eq!(
        files.len(),
        2,
        "the other item's blob and orphaned/: {files:?}"
    );
    assert!(matches!(vault.purge_item(&id), Err(CoreError::NotFound)));
}
