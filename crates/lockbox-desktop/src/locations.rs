//! Where a vault may live (spec §6.10): a local, fixed NTFS drive, outside the app-data folders an uninstaller can
//! delete and outside the Roaming profile. A folder a cloud provider syncs is allowed only after the user's yes.
//!
//! Checked when a vault is created (its parent), added, unlocked or recovered (its folder, which may have moved
//! drives since), and restored to (Task 15).

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{ShellError, ShellResult};
use crate::os::{DriveType, Env, KnownFolder, Volumes};
use crate::paths::read_capped;

/// What a folder's check found that the user should hear about before going on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocationCheck {
    /// The cloud provider syncing the folder, if any: not supported, so the user is asked first.
    pub cloud: Option<CloudProvider>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum CloudProvider {
    OneDrive,
    GoogleDrive,
    Dropbox,
    /// A cloud sync root Windows knows of, in none of the providers' known places.
    Other,
}

/// Checks `dir` (an absolute path; a folder still to be made is checked through its nearest existing ancestor)
/// against the rules above. `forbidden` lists the folders no vault may be inside: Tauri's app-data folders, the
/// Roaming profile and the state folder.
///
/// Refusals (`InvalidInput`): `"removable drive"`, `"network drive"`, `"drive type not supported"` (CD-ROM, RAM disk,
/// unknown), `"file system not supported"` (not NTFS), `"app data folder"`; and `"folder"` for a path that is not
/// absolute or not valid Unicode (the vault list stores paths as JSON text).
pub fn check_location(
    volumes: &dyn Volumes,
    env: &dyn Env,
    forbidden: &[PathBuf],
    dir: &Path,
) -> ShellResult<LocationCheck> {
    let refuse = |what| Err(ShellError::InvalidInput { what });
    let Some((existing, full)) = canonical_or_nearest(dir)? else {
        return refuse("folder");
    };
    if full.to_str().is_none() {
        return refuse("folder");
    }
    let root = volumes.volume_root(&existing)?;
    match volumes.drive_type(&root) {
        DriveType::Fixed => {}
        DriveType::Removable => return refuse("removable drive"),
        DriveType::Remote => return refuse("network drive"),
        DriveType::CdRom | DriveType::RamDisk | DriveType::Unknown => {
            return refuse("drive type not supported");
        }
    }
    if !volumes.file_system(&root)?.eq_ignore_ascii_case("NTFS") {
        return refuse("file system not supported");
    }
    let forbidden_here = forbidden.iter().any(|folder| {
        canonical_or_nearest(folder)
            .ok()
            .flatten()
            .is_some_and(|(_, folder)| is_within(&full, &folder))
    });
    if forbidden_here {
        return refuse("app data folder");
    }
    Ok(LocationCheck {
        cloud: cloud_provider(volumes, env, &existing, &full, &root),
    })
}

/// `dir` canonicalised: its nearest existing ancestor's canonical path (the part `fs::canonicalize` can resolve),
/// and that path with the rest of `dir` added back. `None` when `dir` is relative or the rest is not plain names
/// (`..` there could climb anywhere unseen).
fn canonical_or_nearest(dir: &Path) -> io::Result<Option<(PathBuf, PathBuf)>> {
    if !dir.is_absolute() {
        return Ok(None);
    }
    for ancestor in dir.ancestors() {
        let existing = match fs::canonicalize(ancestor) {
            Ok(existing) => existing,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        };
        let rest = dir.strip_prefix(ancestor).unwrap_or(Path::new(""));
        if !rest.components().all(|c| matches!(c, Component::Normal(_))) {
            return Ok(None);
        }
        let full = existing.join(rest);
        return Ok(Some((existing, full)));
    }
    Err(io::ErrorKind::NotFound.into())
}

/// The cloud provider syncing `full` (whose nearest existing folder is `existing`, on the volume `root`). Windows is
/// asked first; then each provider's known places.
fn cloud_provider(
    volumes: &dyn Volumes,
    env: &dyn Env,
    existing: &Path,
    full: &Path,
    root: &Path,
) -> Option<CloudProvider> {
    let known = known_cloud_folders(env)
        .into_iter()
        .find(|(_, folder)| is_within(full, folder))
        .map(|(provider, _)| provider);
    if volumes.under_sync_root(existing) {
        // The sync root's own registration names its provider only as free text; a known place says which one.
        return Some(known.unwrap_or(CloudProvider::Other));
    }
    known.or_else(|| {
        volumes
            .volume_label(root)
            .is_ok_and(|label| label.eq_ignore_ascii_case("Google Drive"))
            .then_some(CloudProvider::GoogleDrive)
    })
}

/// Each provider's known folders, canonical: OneDrive's from its environment variables, Dropbox's from its
/// `info.json`, Google Drive's old folders in the profile. A place that cannot be read is skipped.
fn known_cloud_folders(env: &dyn Env) -> Vec<(CloudProvider, PathBuf)> {
    let mut known = Vec::new();
    for var in ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"] {
        if let Some(value) = env.var(var) {
            known.push((CloudProvider::OneDrive, PathBuf::from(value)));
        }
    }
    for base in [KnownFolder::RoamingAppData, KnownFolder::LocalAppData] {
        if let Ok(base) = env.known_folder(base) {
            let info = base.join("Dropbox").join("info.json");
            known.extend(
                dropbox_folders(&info)
                    .into_iter()
                    .map(|folder| (CloudProvider::Dropbox, folder)),
            );
        }
    }
    if let Ok(profile) = env.known_folder(KnownFolder::Profile) {
        for name in ["Google Drive", "My Drive"] {
            known.push((CloudProvider::GoogleDrive, profile.join(name)));
        }
    }
    known
        .into_iter()
        .filter_map(|(provider, folder)| {
            let (_, folder) = canonical_or_nearest(&folder).ok().flatten()?;
            Some((provider, folder))
        })
        .collect()
}

/// The largest Dropbox `info.json` read.
const MAX_DROPBOX_INFO: u64 = 1024 * 1024;

/// The folders Dropbox's `info.json` lists: `{ "<account>": { "path": "<folder>", .. }, .. }`. Dropbox's own file, so
/// fields Lockbox does not use are allowed; anything unreadable gives nothing.
fn dropbox_folders(info: &Path) -> Vec<PathBuf> {
    #[derive(Deserialize)]
    struct Account {
        path: PathBuf,
    }
    let Ok(Some(bytes)) = read_capped(info, MAX_DROPBOX_INFO) else {
        return Vec::new();
    };
    if bytes.len() as u64 > MAX_DROPBOX_INFO {
        return Vec::new();
    }
    let Ok(accounts) = serde_json::from_slice::<HashMap<String, serde_json::Value>>(&bytes) else {
        return Vec::new();
    };
    accounts
        .into_values()
        .filter_map(|account| serde_json::from_value::<Account>(account).ok())
        .map(|account| account.path)
        .collect()
}

/// Whether `path` is `root` or inside it, both canonical: whole components compared as Windows compares names.
pub fn is_within(path: &Path, root: &Path) -> bool {
    let mut path = path.components();
    root.components().all(|part| {
        path.next().is_some_and(|own| {
            crate::os::same_path(Path::new(own.as_os_str()), Path::new(part.as_os_str()))
        })
    })
}

#[cfg(test)]
mod tests {
    use lockbox_core::internals::fsio::testutil::TempDir;

    use super::*;
    use crate::testing::{FakeEnv, FakeVolume, FakeVolumes, LOCAL_NTFS, TestShell};

    fn refused(what: &'static str) -> ShellResult<LocationCheck> {
        Err(ShellError::InvalidInput { what })
    }

    const NOT_CLOUD: ShellResult<LocationCheck> = Ok(LocationCheck { cloud: None });

    /// A new folder `name` inside `parent`, made on the spot.
    fn folder(parent: &Path, name: &str) -> PathBuf {
        let dir = parent.join(name);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn locations_refused_table() {
        let ts = TestShell::new();
        let table = [
            (DriveType::Removable, "NTFS", "removable drive"),
            (DriveType::Remote, "NTFS", "network drive"),
            (DriveType::CdRom, "NTFS", "drive type not supported"),
            (DriveType::RamDisk, "NTFS", "drive type not supported"),
            (DriveType::Unknown, "NTFS", "drive type not supported"),
            (DriveType::Fixed, "FAT32", "file system not supported"),
            (DriveType::Fixed, "exFAT", "file system not supported"),
            (DriveType::Fixed, "ReFS", "file system not supported"),
        ];
        for (at, (drive, file_system, what)) in table.into_iter().enumerate() {
            let root = folder(ts.temp.path(), &format!("volume-{at}"));
            ts.volumes.mount(
                &root,
                FakeVolume {
                    drive,
                    file_system,
                    label: "Volume",
                },
            );
            // The volume's root, a folder on it, and a folder still to be made on it.
            let inner = folder(&root, "Vaults");
            for dir in [root.clone(), inner.clone(), inner.join("not yet")] {
                assert_eq!(ts.shell.check_location(&dir), refused(what), "{what}");
            }
        }

        // Inside each forbidden folder: Tauri's two app-data folders, the Roaming profile and the state folder,
        // whether they exist yet or not, in any letter case.
        let forbidden = [
            ts.app_dirs[0].clone(),
            ts.app_dirs[1].clone(),
            ts.env.folder(KnownFolder::RoamingAppData),
            ts.shell.paths.root.clone(),
        ];
        for root in &forbidden {
            for dir in [root.clone(), root.join("Vaults"), root.join("a").join("b")] {
                assert_eq!(
                    ts.shell.check_location(&dir),
                    refused("app data folder"),
                    "{}",
                    dir.display()
                );
            }
            fs::create_dir_all(root.join("Vaults")).unwrap();
            let upper = PathBuf::from(root.join("Vaults").to_string_lossy().to_uppercase());
            assert_eq!(ts.shell.check_location(&upper), refused("app data folder"));
        }
        // Next to them is fine: only the folders themselves are forbidden, not the whole Local profile.
        let beside = ts.env.folder(KnownFolder::LocalAppData).join("Elsewhere");
        assert_eq!(ts.shell.check_location(&beside), NOT_CLOUD);
    }

    #[test]
    fn fixed_ntfs_accepted() {
        let ts = TestShell::new();
        assert_eq!(ts.shell.check_location(&ts.vaults()), NOT_CLOUD);
        assert_eq!(
            ts.shell
                .check_location(&ts.vaults().join("not yet").join("made")),
            NOT_CLOUD
        );
        // A USB hard drive that Windows reports as fixed is accepted (spec §6.10).
        let usb = folder(ts.temp.path(), "usb");
        ts.volumes.mount(
            &usb,
            FakeVolume {
                drive: DriveType::Fixed,
                file_system: "NTFS",
                label: "USB disk",
            },
        );
        assert_eq!(ts.shell.check_location(&folder(&usb, "Vaults")), NOT_CLOUD);
    }

    #[test]
    fn relative_or_climbing_paths_checked_where_they_lead() {
        let ts = TestShell::new();
        assert_eq!(
            ts.shell.check_location(Path::new("Vaults")),
            refused("folder")
        );
        // A name Windows allows but Unicode does not (a lone surrogate): the vault list could not store it.
        let lone_surrogate = {
            use std::os::windows::ffi::OsStringExt;
            std::ffi::OsString::from_wide(&[0x56, 0xD800])
        };
        assert_eq!(
            ts.shell.check_location(&ts.vaults().join(lone_surrogate)),
            refused("folder")
        );
        // `..` is resolved as Windows resolves it, even past a folder still to be made: it cannot climb into a
        // forbidden folder unseen.
        let roaming = ts.env.folder(KnownFolder::RoamingAppData);
        let name = roaming.file_name().unwrap();
        for climbing in [
            ts.vaults().join("..").join(name).join("Vaults"),
            ts.vaults().join("not yet").join("..").join("..").join(name),
        ] {
            assert_eq!(
                ts.shell.check_location(&climbing),
                refused("app data folder"),
                "{}",
                climbing.display()
            );
        }
    }

    fn cloud(volumes: &FakeVolumes, env: &FakeEnv, dir: &Path) -> Option<CloudProvider> {
        check_location(volumes, env, &[], dir).unwrap().cloud
    }

    #[test]
    fn cloud_folder_detected_through_sync_root() {
        let temp = TempDir::new();
        let (env, volumes) = (FakeEnv::new(temp.path()), FakeVolumes::default());
        let synced = folder(temp.path(), "Synced");
        volumes.add_sync_root(&synced);
        assert_eq!(
            cloud(&volumes, &env, &synced.join("Vaults")),
            Some(CloudProvider::Other)
        );
        // A sync root in a provider's known place is that provider's.
        let onedrive = folder(temp.path(), "OneDrive - Contoso");
        env.set_var("OneDriveCommercial", onedrive.as_os_str());
        volumes.add_sync_root(&onedrive);
        assert_eq!(
            cloud(&volumes, &env, &onedrive.join("Vaults")),
            Some(CloudProvider::OneDrive)
        );
        assert_eq!(cloud(&volumes, &env, &folder(temp.path(), "Plain")), None);
    }

    #[test]
    fn known_onedrive_location_detected() {
        let temp = TempDir::new();
        let (env, volumes) = (FakeEnv::new(temp.path()), FakeVolumes::default());
        for (at, var) in ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]
            .into_iter()
            .enumerate()
        {
            let synced = folder(temp.path(), &format!("cloud-{at}"));
            env.set_var(var, synced.as_os_str());
            let dir = synced.join("Vaults");
            assert!(!volumes.under_sync_root(&synced));
            assert_eq!(
                cloud(&volumes, &env, &dir),
                Some(CloudProvider::OneDrive),
                "{var}"
            );
        }
        // A relative or empty value is ignored.
        env.set_var("OneDrive", "relative");
        env.set_var("OneDriveConsumer", "");
        assert_eq!(
            cloud(&volumes, &env, &folder(temp.path(), "relative")),
            None
        );
    }

    #[test]
    fn known_dropbox_and_google_drive_locations_detected() {
        let temp = TempDir::new();
        let (env, volumes) = (FakeEnv::new(temp.path()), FakeVolumes::default());
        // Dropbox writes where its folders are to `info.json`, in Roaming or in Local app data.
        let personal = folder(temp.path(), "Dropbox");
        let business = folder(temp.path(), "Dropbox (Contoso)");
        let info = |base: KnownFolder, account: &str, path: &Path| {
            let dir = folder(&env.folder(base), "Dropbox");
            let json =
                serde_json::json!({ account: { "path": path, "host": 1, "is_team": false } });
            fs::write(dir.join("info.json"), json.to_string()).unwrap();
        };
        info(KnownFolder::RoamingAppData, "personal", &personal);
        info(KnownFolder::LocalAppData, "business", &business);
        for dropbox in [&personal, &business] {
            assert_eq!(
                cloud(&volumes, &env, &dropbox.join("Vaults")),
                Some(CloudProvider::Dropbox)
            );
        }
        // Google Drive: its old folders in the profile, or its drive's label.
        for name in ["Google Drive", "My Drive"] {
            let drive = folder(&env.folder(KnownFolder::Profile), name);
            assert_eq!(
                cloud(&volumes, &env, &drive.join("Vaults")),
                Some(CloudProvider::GoogleDrive)
            );
        }
        let mounted = folder(temp.path(), "G");
        volumes.mount(
            &mounted,
            FakeVolume {
                label: "Google Drive",
                ..LOCAL_NTFS
            },
        );
        assert_eq!(
            cloud(&volumes, &env, &mounted),
            Some(CloudProvider::GoogleDrive)
        );
    }

    #[test]
    fn unreadable_dropbox_info_is_ignored() {
        let temp = TempDir::new();
        let (env, volumes) = (FakeEnv::new(temp.path()), FakeVolumes::default());
        let dir = folder(&env.folder(KnownFolder::RoamingAppData), "Dropbox");
        let plain = folder(temp.path(), "Plain");
        for text in ["not json", "[1, 2]", r#"{ "personal": { "path": 7 } }"#] {
            fs::write(dir.join("info.json"), text).unwrap();
            assert_eq!(cloud(&volumes, &env, &plain), None, "{text}");
        }
    }

    #[test]
    fn within_compares_whole_components_ignoring_case() {
        let root = Path::new(r"C:\Users\Me\AppData\Roaming");
        assert!(is_within(root, root));
        assert!(is_within(Path::new(r"c:\users\me\appdata\roaming\x"), root));
        assert!(!is_within(Path::new(r"C:\Users\Me\AppData\RoamingX"), root));
        assert!(!is_within(Path::new(r"C:\Users\Me\AppData"), root));
    }

    /// Reads only: the real volume calls on this PC's system drive and temp folder.
    #[test]
    #[cfg(windows)]
    fn real_volumes_on_this_pc() {
        use crate::os::win::WinVolumes;
        let volumes = WinVolumes;
        let system = Path::new(r"C:\");
        assert_eq!(volumes.drive_type(system), DriveType::Fixed);
        assert_eq!(volumes.file_system(system).unwrap(), "NTFS");
        assert!(volumes.volume_label(system).is_ok());
        let temp = TempDir::new();
        let canonical = fs::canonicalize(temp.path()).unwrap();
        assert!(!volumes.under_sync_root(&canonical));
        assert!(volumes.exists(&canonical).unwrap());
        assert!(!volumes.exists(&canonical.join("missing")).unwrap());
        // The canonical (`\\?\`) form, as every check passes it.
        let root = volumes.volume_root(&canonical).unwrap();
        assert!(is_within(&canonical, &root), "{}", root.display());
        assert_eq!(volumes.drive_type(&root), DriveType::Fixed);
        assert_eq!(volumes.file_system(&root).unwrap(), "NTFS");
    }
}
