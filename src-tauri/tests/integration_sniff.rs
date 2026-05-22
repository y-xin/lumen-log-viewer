// 端到端：用 fixture 验证 sniff + 多模板解析正确

use log_viewer_lib::loader::reader;
use log_viewer_lib::model::LogLevel;
use log_viewer_lib::parser;
use log_viewer_lib::parser::registry::Registry;
use std::path::Path;

#[test]
fn electron_multiline_log_picks_bracket_electron() {
    let lines = reader::read_all_lines(Path::new("tests/fixtures/electron-multiline.log")).unwrap();
    let registry = Registry::new_with_builtins();
    let (entries, template_id) = parser::parse_with_sniff(&registry, &lines);

    assert_eq!(template_id, "bracket-electron");
    let multiline = entries.iter().find(|e| e.message.contains("service started")).unwrap();
    assert_eq!(multiline.line_count, 4);
    assert_eq!(multiline.level, LogLevel::Info);
    assert_eq!(multiline.scope.as_deref(), Some("app-update"));
    assert!(multiline.fields.contains_key("channel"));
}

#[test]
fn nginx_log_picks_nginx_combined() {
    let lines = reader::read_all_lines(Path::new("tests/fixtures/nginx-access.log")).unwrap();
    let registry = Registry::new_with_builtins();
    let (_entries, template_id) = parser::parse_with_sniff(&registry, &lines);
    assert_eq!(template_id, "nginx-combined");
}

#[test]
fn python_log_picks_python_default() {
    let lines = reader::read_all_lines(Path::new("tests/fixtures/python.log")).unwrap();
    let registry = Registry::new_with_builtins();
    let (_entries, template_id) = parser::parse_with_sniff(&registry, &lines);
    assert_eq!(template_id, "python-default");
}

#[test]
fn logfmt_log_picks_logfmt() {
    let lines = reader::read_all_lines(Path::new("tests/fixtures/logfmt.log")).unwrap();
    let registry = Registry::new_with_builtins();
    let (_entries, template_id) = parser::parse_with_sniff(&registry, &lines);
    assert_eq!(template_id, "logfmt");
}

#[test]
fn jsonl_log_picks_json_lines() {
    let lines = reader::read_all_lines(Path::new("tests/fixtures/sample.jsonl")).unwrap();
    let registry = Registry::new_with_builtins();
    let (_entries, template_id) = parser::parse_with_sniff(&registry, &lines);
    assert_eq!(template_id, "json-lines");
}
