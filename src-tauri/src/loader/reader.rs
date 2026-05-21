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
}
