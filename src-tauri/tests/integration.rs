// 通过 lib 直接调用 command 的内部函数，验证完整链路

use log_viewer_lib::loader::reader;
use log_viewer_lib::model::LogLevel;
use log_viewer_lib::parser;
use log_viewer_lib::query::{self, QuerySpec};
use log_viewer_lib::session::SessionState;
use log_viewer_lib::stats;
use std::collections::HashSet;
use std::path::Path;

#[test]
fn end_to_end_open_filter_aggregate() {
    let lines = reader::read_all_lines(Path::new("tests/fixtures/sample.jsonl")).unwrap();
    let entries = parser::parse_lines(&lines);
    let meta = parser::compute_metadata("tests/fixtures/sample.jsonl", &entries, "json-lines");

    let s = SessionState::default();
    s.load(meta, entries);

    // 筛选 error
    let mut levels = HashSet::new();
    levels.insert(LogLevel::Error);
    let spec = QuerySpec { levels: Some(levels), ..Default::default() };

    let matched = query::run_query(&s, &spec).unwrap();
    let agg = s.with_entries(|e| stats::aggregate(e, &matched)).unwrap();

    assert_eq!(matched.len(), 1); // sample.jsonl 里只有 1 条 error
    assert_eq!(agg.total, 1);
    assert_eq!(agg.level_counts.get(&LogLevel::Error), Some(&1));
}
