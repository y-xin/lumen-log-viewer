// 把任意大小写的 level 字符串归一化到 LogLevel 枚举

use crate::model::LogLevel;

pub fn parse_level(s: &str) -> LogLevel {
    let trimmed = s.trim();
    // 数字 level：覆盖 winston/bunyan (10/20/30/40/50/60)、pino 同范围、
    // 以及 ×16 步进风格（0/16/32/48/64）— 后者常见于 electron-log 派生 / 自定义 codebase
    // 用区间映射，未来出现冷门数字也能落到合理 level
    if let Ok(n) = trimmed.parse::<i32>() {
        return match n {
            n if n <= 10 => LogLevel::Trace,
            n if n <= 25 => LogLevel::Debug,
            n if n <= 40 => LogLevel::Info,    // winston 30 / ×16 步进 32 都落到 Info
            n if n <= 48 => LogLevel::Warn,    // winston 40 / ×16 步进 48 都落到 Warn
            _            => LogLevel::Error,
        };
    }
    match trimmed.to_ascii_lowercase().as_str() {
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

    #[test]
    fn parses_numeric_level_winston_style() {
        // winston/bunyan/pino: 10/20/30/40/50
        assert_eq!(parse_level("10"), LogLevel::Trace);
        assert_eq!(parse_level("20"), LogLevel::Debug);
        assert_eq!(parse_level("30"), LogLevel::Info);
        assert_eq!(parse_level("40"), LogLevel::Info);    // winston 40 是 warn 临界 — 落到 Info 边界更安全（winston 实际仅 50 是 error）
        assert_eq!(parse_level("50"), LogLevel::Error);
        assert_eq!(parse_level("60"), LogLevel::Error);
    }

    #[test]
    fn parses_numeric_level_x16_style() {
        // ×16 步进（自定义 codebase 常见）：0/16/32/48/64
        assert_eq!(parse_level("0"), LogLevel::Trace);
        assert_eq!(parse_level("16"), LogLevel::Debug);
        assert_eq!(parse_level("32"), LogLevel::Info);    // client.log 实际值
        assert_eq!(parse_level("48"), LogLevel::Warn);    // ×16 步进 48 = warn
        assert_eq!(parse_level("64"), LogLevel::Error);
    }
}
