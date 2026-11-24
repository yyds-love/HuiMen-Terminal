//! Staged configuration replacements. Callers serialize the full read/modify/write
//! operation; each individual replacement is atomic, while multi-file rollback
//! handles ordinary I/O failures (not process crashes or power loss).

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use tempfile::NamedTempFile;

struct PreparedWrite {
    path: PathBuf,
    next: Option<NamedTempFile>,
    backup: Option<NamedTempFile>,
}

fn stage(parent: &Path, content: &[u8], prefix: &str) -> Result<NamedTempFile, String> {
    let mut file = tempfile::Builder::new()
        .prefix(prefix)
        .tempfile_in(parent)
        .map_err(|e| {
            format!(
                "Failed to create configuration temporary file in {}: {e}",
                parent.display()
            )
        })?;
    file.write_all(content)
        .and_then(|()| file.as_file().sync_all())
        .map_err(|e| {
            format!(
                "Failed to prepare configuration in {}: {e}",
                parent.display()
            )
        })?;
    Ok(file)
}

fn prepare(path: &Path, text: &str) -> Result<PreparedWrite, String> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    let original = match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(format!(
                    "Refusing to replace a non-regular configuration file: {}",
                    path.display()
                ));
            }
            if metadata.permissions().readonly() {
                return Err(format!(
                    "Configuration file is read-only: {}",
                    path.display()
                ));
            }
            Some(fs::read(path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?)
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("Failed to inspect {}: {e}", path.display())),
    };
    // NamedTempFile uses exclusive creation, random names and mode 0600 on Unix.
    // Windows uses the target directory's inherited ACL, like a newly created
    // configuration file; custom per-file ACLs are not copied by tempfile.
    let backup = original
        .as_deref()
        .map(|bytes| stage(parent, bytes, ".xuya-agent-backup-"))
        .transpose()?;
    let next = stage(parent, text.as_bytes(), ".xuya-agent-write-")?;
    Ok(PreparedWrite {
        path: path.to_path_buf(),
        next: Some(next),
        backup,
    })
}

pub(super) fn write_files_atomic(writes: &[(&Path, &str)]) -> Result<(), String> {
    let prepared = writes
        .iter()
        .map(|(path, text)| prepare(path, text))
        .collect::<Result<Vec<_>, _>>()?;
    commit_prepared(prepared, |file, path| file.persist(path))
}

fn commit_prepared(
    mut prepared: Vec<PreparedWrite>,
    mut replace: impl FnMut(NamedTempFile, &Path) -> Result<File, tempfile::PersistError>,
) -> Result<(), String> {
    for index in 0..prepared.len() {
        let pending = prepared[index]
            .next
            .take()
            .expect("each staged file is committed once");
        if let Err(error) = replace(pending, &prepared[index].path) {
            let mut message = format!(
                "Failed to replace {}: {}",
                prepared[index].path.display(),
                error.error
            );
            // A failed persist returns the still-owned temporary file. Dropping
            // it here removes the uncommitted credential copy.
            drop(error);
            let mut rollback_errors = Vec::new();
            for previous in prepared[..index].iter_mut().rev() {
                if let Err(error) = rollback(previous, &mut replace) {
                    rollback_errors.push(error);
                }
            }
            if rollback_errors.is_empty() {
                message.push_str("; earlier replacements were rolled back");
            } else {
                message.push_str("; partial configuration update, recovery required: ");
                message.push_str(&rollback_errors.join("; "));
            }
            return Err(message);
        }
    }
    Ok(())
}

fn rollback(
    previous: &mut PreparedWrite,
    replace: &mut impl FnMut(NamedTempFile, &Path) -> Result<File, tempfile::PersistError>,
) -> Result<(), String> {
    let Some(backup) = previous.backup.take() else {
        // The destination did not exist before this operation. Remove only
        // that newly created file, never unlink an existing file to replace it.
        return match fs::remove_file(&previous.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!(
                "Failed to remove newly created {}: {e}",
                previous.path.display()
            )),
        };
    };
    if let Err(error) = replace(backup, &previous.path) {
        let reason = error.error.to_string();
        let recovery = match error.file.keep() {
            Ok((_, path)) => path,
            Err(mut error) => {
                // If clearing Windows' temporary attribute also fails, retain
                // the original bytes anyway and report the actual path.
                let path = error.file.path().to_path_buf();
                error.file.disable_cleanup(true);
                path
            }
        };
        return Err(format!(
            "Failed to restore {}: {reason}; original content retained at {}",
            previous.path.display(),
            recovery.display()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;
    use tempfile::tempdir;

    fn names(dir: &Path) -> Vec<PathBuf> {
        let mut result = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        result.sort();
        result
    }

    fn fail(file: NamedTempFile) -> tempfile::PersistError {
        tempfile::PersistError {
            error: io::Error::new(
                io::ErrorKind::PermissionDenied,
                "controlled replacement failure",
            ),
            file,
        }
    }

    #[test]
    fn staged_replacements_are_unique_siblings_and_drop_cleans_both() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.toml");
        fs::write(&path, "old").unwrap();
        let first = prepare(&path, "one").unwrap();
        let second = prepare(&path, "two").unwrap();
        let first_next = first.next.as_ref().unwrap().path();
        let second_next = second.next.as_ref().unwrap().path();
        assert_ne!(first_next, second_next);
        assert_eq!(first_next.parent(), Some(dir.path()));
        assert_eq!(second_next.parent(), Some(dir.path()));
        assert_eq!(fs::read_to_string(&path).unwrap(), "old");
        drop((first, second));
        assert_eq!(names(dir.path()), vec![path]);
    }

    #[test]
    fn pair_commit_replaces_both_and_removes_all_temps() {
        let dir = tempdir().unwrap();
        let config = dir.path().join("config.toml");
        let auth = dir.path().join("auth.json");
        fs::write(&config, "old config").unwrap();
        fs::write(&auth, "old auth").unwrap();
        write_files_atomic(&[(&config, "new config"), (&auth, "new auth")]).unwrap();
        assert_eq!(fs::read_to_string(&config).unwrap(), "new config");
        assert_eq!(fs::read_to_string(&auth).unwrap(), "new auth");
        assert_eq!(names(dir.path()), vec![auth, config]);
    }

    #[test]
    fn preparation_failure_does_not_commit_any_file() {
        let dir = tempdir().unwrap();
        let config = dir.path().join("config.toml");
        let auth = dir.path().join("auth.json");
        fs::write(&config, "old config").unwrap();
        fs::create_dir(&auth).unwrap();
        assert!(write_files_atomic(&[(&config, "new config"), (&auth, "new auth")]).is_err());
        assert_eq!(fs::read_to_string(&config).unwrap(), "old config");
        assert!(auth.is_dir());
        assert_eq!(names(dir.path()), vec![auth, config]);
    }

    #[test]
    fn second_commit_failure_restores_first_file() {
        let dir = tempdir().unwrap();
        let config = dir.path().join("config.toml");
        let auth = dir.path().join("auth.json");
        fs::write(&config, "old config").unwrap();
        fs::write(&auth, "old auth").unwrap();
        let prepared = vec![
            prepare(&config, "new config").unwrap(),
            prepare(&auth, "new auth").unwrap(),
        ];
        let mut calls = 0;
        let error = commit_prepared(prepared, |file, path| {
            calls += 1;
            if calls == 2 {
                Err(fail(file))
            } else {
                file.persist(path)
            }
        })
        .unwrap_err();
        assert!(error.contains("rolled back"));
        assert_eq!(fs::read_to_string(&config).unwrap(), "old config");
        assert_eq!(fs::read_to_string(&auth).unwrap(), "old auth");
        assert_eq!(names(dir.path()), vec![auth, config]);
    }

    #[test]
    fn rollback_removes_a_first_created_file_without_touching_other_files() {
        let dir = tempdir().unwrap();
        let config = dir.path().join("config.toml");
        let auth = dir.path().join("auth.json");
        fs::write(&auth, "old auth").unwrap();
        let prepared = vec![
            prepare(&config, "new config").unwrap(),
            prepare(&auth, "new auth").unwrap(),
        ];
        let mut calls = 0;
        assert!(commit_prepared(prepared, |file, path| {
            calls += 1;
            if calls == 2 {
                Err(fail(file))
            } else {
                file.persist(path)
            }
        })
        .is_err());
        assert!(!config.exists());
        assert_eq!(fs::read_to_string(&auth).unwrap(), "old auth");
        assert_eq!(names(dir.path()), vec![auth]);
    }

    #[test]
    fn failed_rollback_keeps_original_bytes_in_a_reported_recovery_file() {
        let dir = tempdir().unwrap();
        let config = dir.path().join("config.toml");
        let auth = dir.path().join("auth.json");
        fs::write(&config, "old config").unwrap();
        fs::write(&auth, "old auth").unwrap();
        let prepared = vec![
            prepare(&config, "new config").unwrap(),
            prepare(&auth, "new auth").unwrap(),
        ];
        let mut calls = 0;
        let error = commit_prepared(prepared, |file, path| {
            calls += 1;
            if calls >= 2 {
                Err(fail(file))
            } else {
                file.persist(path)
            }
        })
        .unwrap_err();
        let recovery = names(dir.path())
            .into_iter()
            .find(|path| path != &config && path != &auth)
            .unwrap();
        assert!(error.contains("recovery required"));
        assert!(error.contains(recovery.to_str().unwrap()));
        assert_eq!(fs::read_to_string(&recovery).unwrap(), "old config");
        assert_eq!(fs::read_to_string(&auth).unwrap(), "old auth");
        assert_eq!(fs::read_to_string(&config).unwrap(), "new config");
        assert_eq!(names(dir.path()).len(), 3);
    }

    #[test]
    fn failed_first_commit_preserves_both_originals_and_cleans_temps() {
        let dir = tempdir().unwrap();
        let config = dir.path().join("config.toml");
        let auth = dir.path().join("auth.json");
        fs::write(&config, "old config").unwrap();
        fs::write(&auth, "old auth").unwrap();
        let prepared = vec![
            prepare(&config, "new config").unwrap(),
            prepare(&auth, "new auth").unwrap(),
        ];
        assert!(commit_prepared(prepared, |file, _| Err(fail(file))).is_err());
        assert_eq!(fs::read_to_string(&config).unwrap(), "old config");
        assert_eq!(fs::read_to_string(&auth).unwrap(), "old auth");
        assert_eq!(names(dir.path()), vec![auth, config]);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_target_is_rejected_without_changing_link_or_destination() {
        let dir = tempdir().unwrap();
        let real = dir.path().join("real.json");
        let link = dir.path().join("auth.json");
        fs::write(&real, "original").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(write_files_atomic(&[(&link, "replacement")]).is_err());
        assert_eq!(fs::read_link(&link).unwrap(), real);
        assert_eq!(fs::read_to_string(&real).unwrap(), "original");
        assert_eq!(names(dir.path()), vec![link, real]);
    }
}
