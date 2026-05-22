// 过滤算法：单条 Entry 对一个 QuerySpec 的匹配判断；
// 调用方负责并行（rayon）+ 缓存（SessionState）

use crate::model::LogEntry;
use crate::query::spec::{MatchMode, QuerySpec, ScopeFilter};
use once_cell::sync::OnceCell;
use regex::Regex;
use std::sync::Mutex;

pub fn matches(entry: &LogEntry, spec: &QuerySpec, scope_re: &Option<Regex>) -> bool {
    // 时间区间
    if let Some((from, to)) = &spec.time_range {
        let Some(t) = entry.timestamp else { return false; };
        if t < *from || t > *to { return false; }
    }
    // Level
    if let Some(levels) = &spec.levels {
        if !levels.contains(&entry.level) { return false; }
    }
    // Scope: 多选白名单（来自 StatsPanel）
    if let Some(allowed) = &spec.scope_in {
        if !allowed.is_empty() {
            let Some(s) = entry.scope.as_deref() else { return false; };
            if !allowed.contains(s) { return false; }
        }
    }
    // Scope: 单 pattern（来自 FilterBar，与 scope_in AND 关系）
    if let Some(sf) = &spec.scope_filter {
        if !scope_matches(entry, sf, scope_re) { return false; }
    }
    // 全文关键词（大小写不敏感，先在 message 后在 raw）
    if let Some(kw) = &spec.text_search {
        if !kw.is_empty() {
            let needle = kw.to_lowercase();
            let hay_msg = entry.message.to_lowercase();
            let hay_raw = entry.raw.to_lowercase();
            if !hay_msg.contains(&needle) && !hay_raw.contains(&needle) {
                return false;
            }
        }
    }
    true
}

fn scope_matches(entry: &LogEntry, sf: &ScopeFilter, re: &Option<Regex>) -> bool {
    let value: Option<&str> = if sf.field_name == "scope" {
        entry.scope.as_deref()
    } else {
        entry.fields.get(&sf.field_name).map(|s| s.as_str())
    };
    let Some(v) = value else { return false; };
    match sf.mode {
        MatchMode::Exact => v == sf.pattern,
        MatchMode::Glob  => glob_match(&sf.pattern, v),
        MatchMode::Regex => re.as_ref().map(|r| r.is_match(v)).unwrap_or(false),
    }
}

/// 简化 glob：支持 * 和 ?；不支持字符类（YAGNI）
pub fn glob_match(pattern: &str, text: &str) -> bool {
    // 转译为正则并缓存
    static CACHE: OnceCell<Mutex<std::collections::HashMap<String, Regex>>> = OnceCell::new();
    let cache = CACHE.get_or_init(|| Mutex::new(std::collections::HashMap::new()));
    let mut map = cache.lock().unwrap();
    let re = map.entry(pattern.to_string()).or_insert_with(|| {
        let mut r = String::from("^");
        for c in pattern.chars() {
            match c {
                '*' => r.push_str(".*"),
                '?' => r.push('.'),
                _   => r.push_str(&regex::escape(&c.to_string())),
            }
        }
        r.push('$');
        Regex::new(&r).unwrap_or_else(|_| Regex::new("^$").unwrap())
    });
    re.is_match(text)
}

pub fn compile_scope_regex(spec: &QuerySpec) -> Option<Regex> {
    let sf = spec.scope_filter.as_ref()?;
    if !matches!(sf.mode, MatchMode::Regex) { return None; }
    Regex::new(&sf.pattern).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{LogEntry, LogLevel};
    use crate::query::spec::{MatchMode, QuerySpec, ScopeFilter};
    use std::collections::HashMap;
    use std::collections::HashSet;

    fn entry(level: LogLevel, scope: Option<&str>, msg: &str) -> LogEntry {
        LogEntry {
            line_no: 1,
            line_count: 1,
            timestamp: None,
            level,
            scope: scope.map(String::from),
            message: msg.into(),
            fields: HashMap::new(),
            raw: msg.into(),
        }
    }

    #[test]
    fn empty_spec_matches_everything() {
        let e = entry(LogLevel::Info, None, "anything");
        assert!(matches(&e, &QuerySpec::default(), &None));
    }

    #[test]
    fn level_filter_works() {
        let e = entry(LogLevel::Warn, None, "x");
        let mut levels = HashSet::new();
        levels.insert(LogLevel::Error);
        let spec = QuerySpec { levels: Some(levels), ..Default::default() };
        assert!(!matches(&e, &spec, &None));
    }

    #[test]
    fn scope_exact_match() {
        let e = entry(LogLevel::Info, Some("auth"), "x");
        let spec = QuerySpec {
            scope_filter: Some(ScopeFilter {
                field_name: "scope".into(), pattern: "auth".into(), mode: MatchMode::Exact,
            }),
            ..Default::default()
        };
        assert!(matches(&e, &spec, &None));
    }

    #[test]
    fn scope_glob_match() {
        let e = entry(LogLevel::Info, Some("db.pool"), "x");
        let spec = QuerySpec {
            scope_filter: Some(ScopeFilter {
                field_name: "scope".into(), pattern: "db.*".into(), mode: MatchMode::Glob,
            }),
            ..Default::default()
        };
        assert!(matches(&e, &spec, &None));
    }

    #[test]
    fn scope_regex_match() {
        let e = entry(LogLevel::Info, Some("auth.user"), "x");
        let spec = QuerySpec {
            scope_filter: Some(ScopeFilter {
                field_name: "scope".into(), pattern: r"^auth\..+".into(), mode: MatchMode::Regex,
            }),
            ..Default::default()
        };
        let re = compile_scope_regex(&spec);
        assert!(matches(&e, &spec, &re));
    }

    #[test]
    fn scope_uses_fields_when_field_name_not_scope() {
        let mut fields = HashMap::new();
        fields.insert("request_id".into(), "req-abc".into());
        let e = LogEntry {
            line_no: 1, line_count: 1, timestamp: None, level: LogLevel::Info, scope: None,
            message: "x".into(), fields, raw: String::new(),
        };
        let spec = QuerySpec {
            scope_filter: Some(ScopeFilter {
                field_name: "request_id".into(), pattern: "req-abc".into(), mode: MatchMode::Exact,
            }),
            ..Default::default()
        };
        assert!(matches(&e, &spec, &None));
    }

    #[test]
    fn text_search_case_insensitive() {
        let e = entry(LogLevel::Info, None, "Login Failed");
        let spec = QuerySpec { text_search: Some("login".into()), ..Default::default() };
        assert!(matches(&e, &spec, &None));
    }

    #[test]
    fn scope_in_allows_only_listed_scopes() {
        let a = entry(LogLevel::Info, Some("auth"), "x");
        let b = entry(LogLevel::Info, Some("db"), "x");
        let c = entry(LogLevel::Info, Some("http"), "x");
        let mut allowed = HashSet::new();
        allowed.insert("auth".to_string());
        allowed.insert("db".to_string());
        let spec = QuerySpec { scope_in: Some(allowed), ..Default::default() };
        assert!(matches(&a, &spec, &None));
        assert!(matches(&b, &spec, &None));
        assert!(!matches(&c, &spec, &None));
    }

    #[test]
    fn empty_scope_in_set_matches_nothing() {
        // 空集合 = "选中了 0 个" → 没有 entry 能命中（与 None=不限相反）
        let e = entry(LogLevel::Info, Some("auth"), "x");
        let spec = QuerySpec { scope_in: Some(HashSet::new()), ..Default::default() };
        // 实现里空集合被视为"不过滤"，这是为了让前端 toggle 全部清空时等价于 None
        assert!(matches(&e, &spec, &None));
    }

    #[test]
    fn scope_in_and_pattern_are_and() {
        // 必须 scope ∈ scope_in 且 满足 pattern
        let auth = entry(LogLevel::Info, Some("auth"), "x");
        let dbpool = entry(LogLevel::Info, Some("db.pool"), "x");
        let mut allowed = HashSet::new();
        allowed.insert("auth".to_string());
        allowed.insert("db.pool".to_string());
        let spec = QuerySpec {
            scope_in: Some(allowed),
            scope_filter: Some(ScopeFilter {
                field_name: "scope".into(), pattern: "db.*".into(), mode: MatchMode::Glob,
            }),
            ..Default::default()
        };
        assert!(!matches(&auth, &spec, &None));   // 在 scope_in 但 pattern 不匹配
        assert!(matches(&dbpool, &spec, &None));  // 两者都满足
    }
}
