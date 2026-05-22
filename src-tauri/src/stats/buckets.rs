// 时间桶聚合：把 entries 按时间均匀分到 N 个桶，每桶含 total + by_level

use crate::model::{LogEntry, LogLevel, TimeBucket};
use chrono::{DateTime, Duration, Utc};
use std::collections::HashMap;

pub const DEFAULT_BUCKET_COUNT: u32 = 60;

/// 在已匹配的 entries 上按时间均分到 bucket_count 个桶。
/// range 是显示窗口；entries 之外的 ts 会被忽略。
/// 返回的 Vec 长度恰好 = bucket_count（即使某些桶是空也保留，便于前端图表 X 轴对齐）。
pub fn time_buckets(
    entries: &[LogEntry],
    matched: &[u32],
    range: (DateTime<Utc>, DateTime<Utc>),
    bucket_count: u32,
) -> Vec<TimeBucket> {
    let (start, end) = range;
    if end <= start || bucket_count == 0 {
        return vec![];
    }
    let total_ms = (end - start).num_milliseconds().max(1);
    let bucket_ms = (total_ms as f64 / bucket_count as f64).ceil() as i64;
    let bucket_dur = Duration::milliseconds(bucket_ms.max(1));

    let mut buckets: Vec<TimeBucket> = (0..bucket_count).map(|i| TimeBucket {
        bucket_start: start + bucket_dur * (i as i32),
        total: 0,
        by_level: HashMap::new(),
    }).collect();

    for &idx in matched {
        let Some(e) = entries.get(idx as usize) else { continue; };
        let Some(t) = e.timestamp else { continue; };
        if t < start || t >= end { continue; }
        let offset_ms = (t - start).num_milliseconds();
        let bi = ((offset_ms / bucket_ms) as usize).min((bucket_count - 1) as usize);
        let b = &mut buckets[bi];
        b.total += 1;
        *b.by_level.entry(e.level).or_insert(0) += 1;
    }

    buckets
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use std::collections::HashMap as HMap;

    fn entry_at(level: LogLevel, ts: DateTime<Utc>) -> LogEntry {
        LogEntry {
            line_no: 0,
            line_count: 1,
            timestamp: Some(ts),
            level,
            scope: None,
            message: String::new(),
            fields: HMap::new(),
            raw: String::new(),
        }
    }

    #[test]
    fn allocates_entries_into_buckets() {
        let start = Utc.with_ymd_and_hms(2026, 5, 22, 9, 0, 0).unwrap();
        let end = Utc.with_ymd_and_hms(2026, 5, 22, 9, 1, 0).unwrap();
        let entries = vec![
            entry_at(LogLevel::Info,  start),
            entry_at(LogLevel::Info,  start + Duration::seconds(30)),
            entry_at(LogLevel::Error, start + Duration::seconds(59)),
        ];
        let matched: Vec<u32> = vec![0, 1, 2];
        let buckets = time_buckets(&entries, &matched, (start, end), 60);
        assert_eq!(buckets.len(), 60);
        assert_eq!(buckets[0].total, 1);
        assert_eq!(buckets[0].by_level.get(&LogLevel::Info), Some(&1));
        assert_eq!(buckets[30].total, 1);
        assert_eq!(buckets[59].total, 1);
        assert_eq!(buckets[59].by_level.get(&LogLevel::Error), Some(&1));
    }

    #[test]
    fn ignores_entries_outside_range() {
        let start = Utc.with_ymd_and_hms(2026, 5, 22, 9, 0, 0).unwrap();
        let end = Utc.with_ymd_and_hms(2026, 5, 22, 9, 1, 0).unwrap();
        let entries = vec![
            entry_at(LogLevel::Info, start - Duration::seconds(10)),
            entry_at(LogLevel::Info, end + Duration::seconds(10)),
        ];
        let matched: Vec<u32> = vec![0, 1];
        let buckets = time_buckets(&entries, &matched, (start, end), 60);
        let sum: u32 = buckets.iter().map(|b| b.total).sum();
        assert_eq!(sum, 0);
    }

    #[test]
    fn returns_empty_for_invalid_range_or_zero_count() {
        let t = Utc.with_ymd_and_hms(2026, 5, 22, 9, 0, 0).unwrap();
        assert!(time_buckets(&[], &[], (t, t), 60).is_empty());
        assert!(time_buckets(&[], &[], (t, t + Duration::seconds(1)), 0).is_empty());
    }
}
