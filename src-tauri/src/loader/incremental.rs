// 增量解析：处理 watcher 持续追加的新行
// 关键问题：行可能"半截到"（追加缓冲不完整），且多行合并要跨事件保持状态

use crate::model::LogEntry;
use crate::parser::template::{self, ParserTemplate};

pub struct IncrementalParser {
    /// 未消化的 partial 行（最后一行可能没有 \n）
    partial: String,
    /// 当前正在累积的逻辑日志记录（多行合并）
    pending: Vec<String>,
    pending_start_line: u32,
    /// 下一条 entry 的起始行号
    next_line_no: u32,
}

impl IncrementalParser {
    pub fn new(next_line_no: u32) -> Self {
        Self {
            partial: String::new(),
            pending: Vec::new(),
            pending_start_line: next_line_no,
            next_line_no,
        }
    }

    /// 喂入新增的文本片段（可能跨多行，最后行可能不完整）。
    /// 返回本次完成的 LogEntry（不含还在 pending 里的当前 record）。
    pub fn feed<T: ParserTemplate + ?Sized>(&mut self, tpl: &T, chunk: &str) -> Vec<LogEntry> {
        self.partial.push_str(chunk);
        let mut out = Vec::new();
        while let Some(pos) = self.partial.find('\n') {
            let mut line = self.partial[..pos].to_string();
            if line.ends_with('\r') { line.pop(); }
            self.partial.drain(..=pos);
            self.consume_line(tpl, line, &mut out);
        }
        out
    }

    /// 时间到了（如 watcher 静默 500ms），把当前 pending 收尾推送
    pub fn flush<T: ParserTemplate + ?Sized>(&mut self, tpl: &T) -> Vec<LogEntry> {
        let mut out = Vec::new();
        if !self.pending.is_empty() {
            self.finalize_pending(tpl, &mut out);
        }
        out
    }

    pub fn next_line_no(&self) -> u32 { self.next_line_no }

    fn consume_line<T: ParserTemplate + ?Sized>(&mut self, tpl: &T, line: String, out: &mut Vec<LogEntry>) {
        let is_start = tpl.is_record_start(&line);
        if is_start {
            if !self.pending.is_empty() {
                self.finalize_pending(tpl, out);
            }
            self.pending_start_line = self.next_line_no;
        } else if self.pending.is_empty() {
            self.pending_start_line = self.next_line_no;
        }
        self.pending.push(line);
        self.next_line_no += 1;
    }

    fn finalize_pending<T: ParserTemplate + ?Sized>(&mut self, tpl: &T, out: &mut Vec<LogEntry>) {
        let line_count = self.pending.len() as u32;
        let raw_joined = self.pending.join("\n");
        let entry = match tpl.parse_record(&self.pending) {
            Some(p) => template::finalize(self.pending_start_line, line_count, &raw_joined, p),
            None    => template::fallback(self.pending_start_line, line_count, &raw_joined),
        };
        out.push(entry);
        self.pending.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::json_lines::JsonLinesTemplate;

    #[test]
    fn feed_complete_jsonl_lines() {
        let mut p = IncrementalParser::new(1);
        let r = p.feed(&JsonLinesTemplate, "{\"level\":\"info\",\"msg\":\"a\"}\n{\"level\":\"warn\",\"msg\":\"b\"}\n");
        assert_eq!(r.len(), 1);
        let r2 = p.flush(&JsonLinesTemplate);
        assert_eq!(r2.len(), 1);
    }

    #[test]
    fn feed_handles_partial_last_line() {
        let mut p = IncrementalParser::new(1);
        let r1 = p.feed(&JsonLinesTemplate, "{\"level\":\"info\",\"msg\":\"a\"}\n{\"lev");
        assert_eq!(r1.len(), 0);
        let r2 = p.feed(&JsonLinesTemplate, "el\":\"warn\",\"msg\":\"b\"}\n");
        assert_eq!(r2.len(), 1);
        let r3 = p.flush(&JsonLinesTemplate);
        assert_eq!(r3.len(), 1);
    }

    #[test]
    fn line_numbers_continue_across_feeds() {
        let mut p = IncrementalParser::new(100);
        let _ = p.feed(&JsonLinesTemplate, "{\"level\":\"info\",\"msg\":\"a\"}\n{\"level\":\"info\",\"msg\":\"b\"}\n");
        let _ = p.flush(&JsonLinesTemplate);
        assert_eq!(p.next_line_no(), 102);
    }
}
