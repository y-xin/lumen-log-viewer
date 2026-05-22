// FileLoader：MVP 只做 UTF-8 同步读取，按行返回
// （字符集探测、watcher、增量读放 Plan 2）

use crate::error::AppError;
use std::fs;
use std::path::Path;

pub fn read_all_lines(path: &Path) -> Result<Vec<String>, AppError> {
    let bytes = fs::read(path)?;
    // BOM 去除：UTF-8 BOM = EF BB BF
    let start = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) { 3 } else { 0 };
    let text = String::from_utf8_lossy(&bytes[start..]).into_owned();
    // 保留空行（行号要连续），但去掉行尾 \r
    let lines = text.split('\n').map(|l| l.trim_end_matches('\r').to_string()).collect();
    Ok(lines)
}

#[derive(Debug, Clone, Copy)]
pub struct FileMeta {
    pub size: u64,
    pub inode: u64,
}

#[cfg(unix)]
pub fn file_meta(path: &Path) -> Result<FileMeta, AppError> {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::metadata(path)?;
    Ok(FileMeta { size: m.len(), inode: m.ino() })
}

#[cfg(not(unix))]
pub fn file_meta(path: &Path) -> Result<FileMeta, AppError> {
    let m = std::fs::metadata(path)?;
    Ok(FileMeta { size: m.len(), inode: 0 })
}

pub fn read_from(path: &Path, offset: u64) -> Result<String, AppError> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path)?;
    f.seek(SeekFrom::Start(offset))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    fn write_temp(content: &[u8]) -> NamedTempFile {
        let mut f = NamedTempFile::new().unwrap();
        f.write_all(content).unwrap();
        f
    }

    #[test]
    fn reads_unix_lines() {
        let f = write_temp(b"a\nb\nc\n");
        let lines = read_all_lines(f.path()).unwrap();
        // split('\n') 在尾部 '\n' 后会产生一个空字符串，保留以确保行号一致
        assert_eq!(lines, vec!["a", "b", "c", ""]);
    }

    #[test]
    fn strips_crlf() {
        let f = write_temp(b"a\r\nb\r\n");
        let lines = read_all_lines(f.path()).unwrap();
        assert_eq!(lines, vec!["a", "b", ""]);
    }

    #[test]
    fn strips_utf8_bom() {
        let mut content = vec![0xEFu8, 0xBB, 0xBF];
        content.extend_from_slice(b"hello\n");
        let f = write_temp(&content);
        let lines = read_all_lines(f.path()).unwrap();
        assert_eq!(lines[0], "hello");
    }

    #[test]
    fn missing_file_returns_io_error() {
        let r = read_all_lines(Path::new("/nonexistent/path/xyz"));
        assert!(matches!(r, Err(AppError::Io(_))));
    }

    #[test]
    fn file_meta_returns_size() {
        let f = write_temp(b"hello world");
        let m = file_meta(f.path()).unwrap();
        assert_eq!(m.size, 11);
    }

    #[test]
    fn read_from_returns_tail_after_offset() {
        let f = write_temp(b"line1\nline2\n");
        let tail = read_from(f.path(), 6).unwrap();
        assert_eq!(tail, "line2\n");
    }
}
