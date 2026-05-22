// 自动嗅探：对 lines 跑每个模板，按命中率 + 字段完整度打分

use crate::parser::grouping::group_records;
use crate::parser::registry::{Registry, Tpl};
use serde::Serialize;
use std::sync::Arc;

const SAMPLE_LIMIT: usize = 200;
const AUTO_THRESHOLD: f32 = 0.8;
const SUGGEST_THRESHOLD: f32 = 0.4;

#[derive(Debug, Clone, Serialize)]
pub struct TemplateScore {
    pub template_id: String,
    pub template_name: String,
    pub confidence: f32,
    pub hit_rate: f32,
    pub field_completeness: f32,
    pub sample_records: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", content = "data")]
pub enum SniffResult {
    AutoMatch { picked: TemplateScore, alternatives: Vec<TemplateScore> },
    Suggested { picked: TemplateScore, alternatives: Vec<TemplateScore> },
    NoMatch { alternatives: Vec<TemplateScore> },
}

pub fn sniff(registry: &Registry, lines: &[String]) -> SniffResult {
    let sample: &[String] = if lines.len() > SAMPLE_LIMIT {
        &lines[..SAMPLE_LIMIT]
    } else {
        lines
    };

    let mut scores: Vec<TemplateScore> = registry.all().iter()
        .map(|t| score_template(t.clone(), sample))
        .collect();

    scores.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap_or(std::cmp::Ordering::Equal));

    let picked = scores.first().cloned();
    let alternatives = scores.into_iter().skip(1).take(5).collect();

    match picked {
        Some(p) if p.confidence >= AUTO_THRESHOLD => SniffResult::AutoMatch { picked: p, alternatives },
        Some(p) if p.confidence >= SUGGEST_THRESHOLD => SniffResult::Suggested { picked: p, alternatives },
        Some(p) => SniffResult::NoMatch { alternatives: std::iter::once(p).chain(alternatives).collect() },
        None    => SniffResult::NoMatch { alternatives: vec![] },
    }
}

fn score_template(tpl: Arc<Tpl>, sample: &[String]) -> TemplateScore {
    let parser = tpl.as_parser();
    let records = group_records(parser, sample);

    let mut parsed_ok = 0u32;
    let mut total_field_score = 0f32;
    for r in &records {
        if let Some(p) = parser.parse_record(&r.lines) {
            parsed_ok += 1;
            let filled = [
                p.timestamp.is_some(),
                !matches!(p.level, crate::model::LogLevel::Unknown),
                p.scope.is_some(),
                !p.message.is_empty(),
            ];
            let count: u8 = filled.iter().map(|b| *b as u8).sum();
            total_field_score += (count as f32) / 4.0;
        }
    }

    let total = records.len().max(1) as f32;
    let hit_rate = (parsed_ok as f32) / total;
    let field_completeness = if parsed_ok > 0 {
        total_field_score / (parsed_ok as f32)
    } else {
        0.0
    };
    let confidence = hit_rate * 0.6 + field_completeness * 0.4;

    TemplateScore {
        template_id: parser.id().to_string(),
        template_name: parser.name().to_string(),
        confidence,
        hit_rate,
        field_completeness,
        sample_records: records.len() as u32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniff_picks_bracket_electron_for_electron_log() {
        let lines: Vec<String> = vec![
            "[2026-05-21 17:26:37.566] [info] (network) hi".into(),
            "[2026-05-21 17:26:37.576] [warn] (db) slow".into(),
            "[2026-05-21 17:26:37.577] [error] (auth) failed".into(),
        ];
        let r = sniff(&Registry::new_with_builtins(), &lines);
        match r {
            SniffResult::AutoMatch { picked, .. } | SniffResult::Suggested { picked, .. } => {
                assert_eq!(picked.template_id, "bracket-electron");
                assert!(picked.confidence > 0.7);
            }
            SniffResult::NoMatch { .. } => panic!("expected match"),
        }
    }

    #[test]
    fn sniff_picks_json_lines_for_jsonl() {
        let lines: Vec<String> = vec![
            r#"{"time":"2026-05-22T09:00:00Z","level":"info","logger":"a","msg":"x"}"#.into(),
            r#"{"time":"2026-05-22T09:00:01Z","level":"warn","logger":"b","msg":"y"}"#.into(),
        ];
        let r = sniff(&Registry::new_with_builtins(), &lines);
        match r {
            SniffResult::AutoMatch { picked, .. } => {
                assert_eq!(picked.template_id, "json-lines");
            }
            other => panic!("expected AutoMatch json-lines, got {:?}", other),
        }
    }

    #[test]
    fn sniff_returns_no_match_for_garbage() {
        let lines: Vec<String> = vec!["aaaa".into(), "bbbb".into(), "cccc".into()];
        let r = sniff(&Registry::new_with_builtins(), &lines);
        match r {
            SniffResult::NoMatch { .. } => (),
            SniffResult::Suggested { picked, .. } => {
                assert!(picked.confidence < AUTO_THRESHOLD);
            }
            SniffResult::AutoMatch { .. } => panic!("garbage shouldn't auto-match"),
        }
    }
}
