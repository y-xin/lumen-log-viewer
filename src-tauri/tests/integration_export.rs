// 端到端：跑 fixture → 调用 export 模块写文件 → 读回断言

use log_viewer_lib::export;
use log_viewer_lib::loader::reader;
use log_viewer_lib::parser;
use log_viewer_lib::parser::registry::Registry;
use std::io::BufWriter;
use std::path::Path;
use tempfile::tempdir;

#[test]
fn jsonl_roundtrips_full_fixture() {
    let lines = reader::read_all_lines(Path::new("tests/fixtures/sample.jsonl")).unwrap();
    let (entries, _) = parser::parse_with_sniff(&Registry::new_with_builtins(), &lines);
    let matched: Vec<u32> = (0..entries.len() as u32).collect();

    let dir = tempdir().unwrap();
    let path = dir.path().join("out.jsonl");
    let file = std::fs::File::create(&path).unwrap();
    let mut w = BufWriter::new(file);
    export::export_jsonl(&entries, &matched, &mut w).unwrap();
    drop(w);

    let body = std::fs::read_to_string(&path).unwrap();
    let line_count = body.lines().count();
    assert_eq!(line_count, entries.len());
}

#[test]
fn csv_has_header_plus_one_row_per_entry() {
    let lines = reader::read_all_lines(Path::new("tests/fixtures/sample.jsonl")).unwrap();
    let (entries, _) = parser::parse_with_sniff(&Registry::new_with_builtins(), &lines);
    let matched: Vec<u32> = (0..entries.len() as u32).collect();

    let dir = tempdir().unwrap();
    let path = dir.path().join("out.csv");
    let file = std::fs::File::create(&path).unwrap();
    let mut w = BufWriter::new(file);
    export::export_csv(&entries, &matched, &mut w).unwrap();
    drop(w);

    let body = std::fs::read_to_string(&path).unwrap();
    let line_count = body.lines().count();
    assert_eq!(line_count, entries.len() + 1, "expected 1 header + N data rows");
    assert!(body.starts_with("line_no,line_count,timestamp,level,scope,message,fields_json\n"));
}

#[test]
fn json_array_parses_back_to_vec() {
    let lines = reader::read_all_lines(Path::new("tests/fixtures/sample.jsonl")).unwrap();
    let (entries, _) = parser::parse_with_sniff(&Registry::new_with_builtins(), &lines);
    let matched: Vec<u32> = (0..entries.len() as u32).collect();

    let dir = tempdir().unwrap();
    let path = dir.path().join("out.json");
    let file = std::fs::File::create(&path).unwrap();
    let mut w = BufWriter::new(file);
    export::export_json_array(&entries, &matched, &mut w).unwrap();
    drop(w);

    let body = std::fs::read_to_string(&path).unwrap();
    let back: Vec<log_viewer_lib::model::LogEntry> = serde_json::from_str(&body).unwrap();
    assert_eq!(back.len(), entries.len());
}
