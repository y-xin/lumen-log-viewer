// 行合并：按当前模板的 is_record_start 切分原始行为"逻辑日志"

use crate::parser::template::ParserTemplate;

pub struct RawRecord {
    pub start_line: u32,     // 1-based
    pub lines: Vec<String>,
}

pub fn group_records<T: ParserTemplate + ?Sized>(tpl: &T, lines: &[String]) -> Vec<RawRecord> {
    let mut out: Vec<RawRecord> = Vec::new();
    let mut current: Option<RawRecord> = None;

    for (i, line) in lines.iter().enumerate() {
        let is_start = tpl.is_record_start(line);
        if is_start || current.is_none() {
            if let Some(r) = current.take() {
                out.push(r);
            }
            current = Some(RawRecord {
                start_line: (i + 1) as u32,
                lines: vec![line.clone()],
            });
        } else if let Some(r) = current.as_mut() {
            r.lines.push(line.clone());
        }
    }
    if let Some(r) = current {
        out.push(r);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::template::{ParserTemplate, PartialEntry};

    struct DummyTpl;
    impl ParserTemplate for DummyTpl {
        fn id(&self) -> &str { "dummy" }
        fn name(&self) -> &str { "Dummy" }
        fn is_record_start(&self, line: &str) -> bool { line.starts_with('[') }
        fn parse_record(&self, _: &[String]) -> Option<PartialEntry> { None }
    }

    fn s(v: &str) -> String { v.to_string() }

    #[test]
    fn single_line_records() {
        let lines = vec![s("[a]"), s("[b]"), s("[c]")];
        let r = group_records(&DummyTpl, &lines);
        assert_eq!(r.len(), 3);
        assert_eq!(r[0].start_line, 1);
        assert_eq!(r[1].start_line, 2);
        assert_eq!(r[2].start_line, 3);
    }

    #[test]
    fn multiline_record_merged() {
        let lines = vec![s("[a]"), s("  cont1"), s("  cont2"), s("[b]")];
        let r = group_records(&DummyTpl, &lines);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].start_line, 1);
        assert_eq!(r[0].lines, vec!["[a]", "  cont1", "  cont2"]);
        assert_eq!(r[1].start_line, 4);
        assert_eq!(r[1].lines, vec!["[b]"]);
    }

    #[test]
    fn orphan_leading_lines_form_single_record() {
        let lines = vec![s("orphan1"), s("orphan2"), s("[a]")];
        let r = group_records(&DummyTpl, &lines);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].start_line, 1);
        assert_eq!(r[0].lines, vec!["orphan1", "orphan2"]);
        assert_eq!(r[1].start_line, 3);
    }

    #[test]
    fn empty_input_yields_empty() {
        let r = group_records(&DummyTpl, &[]);
        assert!(r.is_empty());
    }
}
