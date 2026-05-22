// 文件 watcher：监听追加 → 触发 on_append；检测 rotation → 触发 on_rotation
// 内部维护 last_offset + last_inode，提供给上层做增量读

use crate::error::AppError;
use crate::loader::reader::{self, FileMeta};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(tag = "kind")]
pub enum RotationEvent {
    Truncated,
    InodeChanged,
    Removed,
}

/// 句柄：drop 时停止 watcher 线程
pub struct FileWatcher {
    _watcher: RecommendedWatcher,
    abort: Arc<AtomicBool>,
}

impl FileWatcher {
    /// 启动 watcher。`on_append(chunk)` 每次有新增字节就回调；`on_rotation` 检测到轮转回调。
    pub fn start(
        path: PathBuf,
        initial_meta: FileMeta,
        on_append: Arc<dyn Fn(String) + Send + Sync>,
        on_rotation: Arc<dyn Fn(RotationEvent) + Send + Sync>,
    ) -> Result<Self, AppError> {
        let (tx, rx) = channel::<notify::Result<notify::Event>>();
        let mut watcher = notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        }).map_err(|e| AppError::Internal(format!("watcher 初始化失败：{e}")))?;
        // macOS FSEvents 在文件粒度下经常错过 append 事件，统一改成 watch 父目录再过滤
        let watch_target = path.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| path.clone());
        watcher.watch(&watch_target, RecursiveMode::NonRecursive)
            .map_err(|e| AppError::Internal(format!("watch 失败：{e}")))?;

        let abort = Arc::new(AtomicBool::new(false));
        let abort_for_thread = abort.clone();
        let last_offset = Arc::new(AtomicU64::new(initial_meta.size));
        let last_inode = initial_meta.inode;
        let path_for_thread = path.clone();

        thread::spawn(move || {
            loop {
                if abort_for_thread.load(Ordering::Relaxed) { break; }
                match rx.recv_timeout(Duration::from_millis(500)) {
                    Ok(Ok(event)) => {
                        // 父目录监听：只关心我们目标文件的事件（按 path 后缀匹配，FSEvents 路径可能规范化）
                        let touches_target = event.paths.is_empty()
                            || event.paths.iter().any(|p| p == &path_for_thread || p.canonicalize().ok() == path_for_thread.canonicalize().ok());
                        if !touches_target { continue; }
                        let Ok(meta) = reader::file_meta(&path_for_thread) else {
                            on_rotation(RotationEvent::Removed);
                            break;
                        };
                        if meta.inode != last_inode {
                            on_rotation(RotationEvent::InodeChanged);
                            break;
                        }
                        let cur_offset = last_offset.load(Ordering::Relaxed);
                        if meta.size < cur_offset {
                            on_rotation(RotationEvent::Truncated);
                            break;
                        }
                        if meta.size > cur_offset {
                            if let Ok(tail) = reader::read_from(&path_for_thread, cur_offset) {
                                last_offset.store(meta.size, Ordering::Relaxed);
                                on_append(tail);
                            }
                        }
                    }
                    Ok(Err(_e)) => { /* notify error，忽略 */ }
                    Err(RecvTimeoutError::Timeout) => { /* periodic abort check */ }
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
        });

        Ok(Self { _watcher: watcher, abort })
    }

    pub fn stop(&self) {
        self.abort.store(true, Ordering::Relaxed);
    }
}

impl Drop for FileWatcher {
    fn drop(&mut self) { self.stop(); }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;
    use std::sync::Mutex;

    #[test]
    fn detects_appended_bytes() {
        // 用 tempdir + 普通文件，避免 NamedTempFile 在 macOS FSEvents 下的事件丢失
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.log");
        {
            let mut f = fs::File::create(&path).unwrap();
            writeln!(f, "init").unwrap();
            f.flush().unwrap();
        }
        let meta = reader::file_meta(&path).unwrap();

        let collected = Arc::new(Mutex::new(String::new()));
        let collected2 = collected.clone();
        let rot_called = Arc::new(AtomicBool::new(false));

        let _w = FileWatcher::start(
            path.clone(),
            meta,
            Arc::new(move |chunk| {
                collected2.lock().unwrap().push_str(&chunk);
            }),
            Arc::new({
                let r = rot_called.clone();
                move |_| r.store(true, Ordering::Relaxed)
            }),
        ).unwrap();

        thread::sleep(Duration::from_millis(300));
        let mut f2 = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(f2, "appended").unwrap();
        f2.flush().unwrap();
        drop(f2);
        thread::sleep(Duration::from_millis(2000));

        let s = collected.lock().unwrap().clone();
        assert!(s.contains("appended"), "expected to capture appended bytes, got: {:?}", s);
        assert!(!rot_called.load(Ordering::Relaxed), "no rotation expected");
    }

    #[test]
    fn detects_truncation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("trunc.log");
        {
            let mut f = fs::File::create(&path).unwrap();
            writeln!(f, "lots of content here that will be truncated").unwrap();
            f.flush().unwrap();
        }
        let meta = reader::file_meta(&path).unwrap();

        let rot_event = Arc::new(Mutex::new(None::<RotationEvent>));
        let rot_event2 = rot_event.clone();
        let _w = FileWatcher::start(
            path.clone(),
            meta,
            Arc::new(|_| {}),
            Arc::new(move |e| *rot_event2.lock().unwrap() = Some(e)),
        ).unwrap();

        thread::sleep(Duration::from_millis(300));
        fs::write(&path, b"").unwrap();
        thread::sleep(Duration::from_millis(2000));

        let e = *rot_event.lock().unwrap();
        assert!(matches!(e, Some(RotationEvent::Truncated)), "got {:?}", e);
    }
}
