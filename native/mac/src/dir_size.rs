//! Disk-usage measurement for the Clean Xcode extension — sizes cache folders
//! (DerivedData, Device Support, …) natively so a multi-gigabyte walk never
//! blocks the Electron main process.

use napi_derive::napi;
use std::sync::Mutex;

/// One directory's on-disk footprint, as reported by `dir_size()`.
#[napi(object)]
pub struct DirSize {
  pub path: String,
  /// Bytes actually allocated on disk (`st_blocks * 512`, what `du` and
  /// Finder's "size on disk" report) — not the sum of logical file lengths,
  /// which overstates sparse files and understates block-rounded small ones.
  pub bytes: f64,
  pub file_count: f64,
  /// Newest modification time among the directory itself and its direct
  /// children, in epoch milliseconds — cheap "last used" signal for the UI.
  pub modified_ms: f64,
}

/// Sums the allocated size of everything under `root`. Symlinks are counted
/// as the link itself, never followed, and a file with several hard links is
/// counted once. Unreadable entries are skipped rather than failing the whole
/// walk — a cache folder with one permission-restricted file still gets a size.
fn measure(root: &str) -> DirSize {
  use std::collections::HashSet;
  use std::os::unix::fs::MetadataExt;

  let mut bytes: u64 = 0;
  let mut files: u64 = 0;
  let mut modified: i64 = 0;
  let mut seen: HashSet<(u64, u64)> = HashSet::new();
  let mut stack = vec![std::path::PathBuf::from(root)];
  let mut is_root = true;

  while let Some(dir) = stack.pop() {
    let Ok(meta) = std::fs::symlink_metadata(&dir) else {
      is_root = false;
      continue;
    };
    if is_root {
      modified = modified.max(meta.mtime() * 1000);
    }
    if !meta.is_dir() {
      // A root that is itself a file (e.g. a single cache file).
      bytes += meta.blocks() * 512;
      files += 1;
      is_root = false;
      continue;
    }
    bytes += meta.blocks() * 512;
    let Ok(entries) = std::fs::read_dir(&dir) else {
      is_root = false;
      continue;
    };
    let direct = is_root;
    is_root = false;
    for entry in entries.flatten() {
      let Ok(meta) = entry.metadata() else { continue };
      // `DirEntry::metadata` doesn't follow symlinks, matching `symlink_metadata`.
      if direct {
        modified = modified.max(meta.mtime() * 1000);
      }
      if meta.is_dir() {
        stack.push(entry.path());
        continue;
      }
      if meta.nlink() > 1 && !seen.insert((meta.dev(), meta.ino())) {
        continue;
      }
      bytes += meta.blocks() * 512;
      files += 1;
    }
  }

  DirSize {
    path: root.to_string(),
    bytes: bytes as f64,
    file_count: files as f64,
    modified_ms: modified as f64,
  }
}

/// Runs `measure` over every path on a small worker pool, off the JS thread.
pub struct DirSizeTask {
  paths: Vec<String>,
}

impl napi::Task for DirSizeTask {
  type Output = Vec<DirSize>;
  type JsValue = Vec<DirSize>;

  fn compute(&mut self) -> napi::Result<Self::Output> {
    use std::sync::atomic::{AtomicUsize, Ordering};

    let next = AtomicUsize::new(0);
    let results: Mutex<Vec<(usize, DirSize)>> = Mutex::new(Vec::new());
    let workers = std::thread::available_parallelism()
      .map(|n| n.get())
      .unwrap_or(4)
      .min(self.paths.len().max(1));

    std::thread::scope(|scope| {
      for _ in 0..workers {
        scope.spawn(|| {
          loop {
            let index = next.fetch_add(1, Ordering::Relaxed);
            let Some(path) = self.paths.get(index) else { break };
            let size = measure(path);
            results.lock().unwrap().push((index, size));
          }
        });
      }
    });

    let mut results = results.into_inner().unwrap();
    results.sort_by_key(|(index, _)| *index);
    Ok(results.into_iter().map(|(_, size)| size).collect())
  }

  fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> napi::Result<Self::JsValue> {
    Ok(output)
  }
}

/// On-disk size of each directory (or file) in `paths`, in the same order.
/// Async — the walk of a multi-gigabyte `DerivedData` runs on the libuv
/// thread pool, so the Electron main process never blocks on it.
#[napi(ts_return_type = "Promise<Array<DirSize>>")]
pub fn dir_size(paths: Vec<String>) -> napi::bindgen_prelude::AsyncTask<DirSizeTask> {
  napi::bindgen_prelude::AsyncTask::new(DirSizeTask { paths })
}
