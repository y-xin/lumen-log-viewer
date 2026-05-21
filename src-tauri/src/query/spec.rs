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
    pub scope_filter: Option<ScopeFilter>,
    pub text_search: Option<String>,
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
