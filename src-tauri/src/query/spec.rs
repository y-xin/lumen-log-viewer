// 查询规范：前后端契约的核心结构

use crate::model::LogLevel;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::hash::{Hash, Hasher};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct QuerySpec {
    pub time_range: Option<(DateTime<Utc>, DateTime<Utc>)>,
    pub levels: Option<HashSet<LogLevel>>,
    /// 单一 pattern 模式（exact/glob/regex），来自 FilterBar 输入框
    pub scope_filter: Option<ScopeFilter>,
    /// 多选 scope 白名单（来自 StatsPanel 的 Top scope tag 多选）。
    /// 与 `scope_filter` 是 AND 关系；非空时 entry.scope 必须命中其中之一。
    #[serde(default)]
    pub scope_in: Option<HashSet<String>>,
    pub text_search: Option<String>,
    /// "substring"（默认）/ "regex"；None = substring 兼容旧 spec
    #[serde(default)]
    pub text_search_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScopeFilter {
    pub field_name: String, // "scope" → LogEntry.scope；其他 → LogEntry.fields[field_name]
    pub pattern: String,
    pub mode: MatchMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MatchMode {
    Exact,
    Glob,
    Regex,
}

impl QuerySpec {
    /// 用 JSON 序列化结果做哈希 —— 简单、稳定、对 MVP 够用
    pub fn cache_key(&self) -> u64 {
        let s = serde_json::to_string(self).unwrap_or_default();
        let mut h = std::collections::hash_map::DefaultHasher::new();
        s.hash(&mut h);
        h.finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_key_stable_across_equal_specs() {
        let a = QuerySpec {
            text_search: Some("hi".into()),
            ..Default::default()
        };
        let b = QuerySpec {
            text_search: Some("hi".into()),
            ..Default::default()
        };
        assert_eq!(a.cache_key(), b.cache_key());
    }

    #[test]
    fn cache_key_differs_for_different_specs() {
        let a = QuerySpec { text_search: Some("hi".into()), ..Default::default() };
        let b = QuerySpec { text_search: Some("yo".into()), ..Default::default() };
        assert_ne!(a.cache_key(), b.cache_key());
    }
}
