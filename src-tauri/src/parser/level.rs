// 把任意大小写的 level 字符串归一化到 LogLevel 枚举

use crate::model::LogLevel;

pub fn parse_level(s: &str) -> LogLevel {
    match s.trim().to_ascii_lowercase().as_str() {
        "trace" => LogLevel::Trace,
        "debug" => LogLevel::Debug,
        "info" | "information" => LogLevel::Info,
        "warn" | "warning" => LogLevel::Warn,
        "error" | "err" | "fatal" | "critical" => LogLevel::Error,
        _ => LogLevel::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::LogLevel;

    #[test]
    fn maps_common_aliases() {
        assert_eq!(parse_level("INFO"), LogLevel::Info);
        assert_eq!(parse_level("Information"), LogLevel::Info);
        assert_eq!(parse_level(" warn "), LogLevel::Warn);
        assert_eq!(parse_level("warning"), LogLevel::Warn);
        assert_eq!(parse_level("err"), LogLevel::Error);
        assert_eq!(parse_level("Fatal"), LogLevel::Error);
        assert_eq!(parse_level("Critical"), LogLevel::Error);
    }

    #[test]
    fn unknown_falls_back() {
        assert_eq!(parse_level("verbose"), LogLevel::Unknown);
        assert_eq!(parse_level(""), LogLevel::Unknown);
    }
}
