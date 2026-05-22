// 全局模板注册表：内置 + 自定义（Plan 2a Phase 5 之后会注入自定义）

use crate::parser::builtin;
use crate::parser::json_lines::JsonLinesTemplate;
use crate::parser::regex_template::RegexTemplate;
use crate::parser::template::ParserTemplate;
use parking_lot::RwLock;
use std::sync::Arc;

pub enum Tpl {
    JsonLines(JsonLinesTemplate),
    Regex(RegexTemplate),
    Logfmt(builtin::logfmt::LogfmtTemplate),
}

impl Tpl {
    pub fn as_parser(&self) -> &dyn ParserTemplate {
        match self {
            Tpl::JsonLines(t) => t,
            Tpl::Regex(t) => t,
            Tpl::Logfmt(t) => t,
        }
    }
}

pub struct Registry {
    templates: RwLock<Vec<Arc<Tpl>>>,
}

impl Registry {
    pub fn new_with_builtins() -> Self {
        let templates: Vec<Arc<Tpl>> = vec![
            Arc::new(Tpl::JsonLines(JsonLinesTemplate)),
            Arc::new(Tpl::Regex(builtin::bracket_electron::template())),
            Arc::new(Tpl::Regex(builtin::bracket_common::template())),
            Arc::new(Tpl::Regex(builtin::python_default::template())),
            Arc::new(Tpl::Regex(builtin::nginx_combined::template())),
            Arc::new(Tpl::Logfmt(builtin::logfmt::LogfmtTemplate)),
        ];
        Self { templates: RwLock::new(templates) }
    }

    pub fn all(&self) -> Vec<Arc<Tpl>> {
        self.templates.read().clone()
    }

    pub fn find(&self, id: &str) -> Option<Arc<Tpl>> {
        self.templates.read().iter()
            .find(|t| t.as_parser().id() == id)
            .cloned()
    }

    pub fn add(&self, tpl: Tpl) {
        self.templates.write().push(Arc::new(tpl));
    }

    pub fn remove(&self, id: &str) {
        self.templates.write().retain(|t| t.as_parser().id() != id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_has_six_builtins() {
        let r = Registry::new_with_builtins();
        let all = r.all();
        assert_eq!(all.len(), 6);
        let ids: Vec<&str> = all.iter().map(|t| t.as_parser().id()).collect();
        assert!(ids.contains(&"json-lines"));
        assert!(ids.contains(&"bracket-electron"));
        assert!(ids.contains(&"bracket-common"));
        assert!(ids.contains(&"python-default"));
        assert!(ids.contains(&"nginx-combined"));
        assert!(ids.contains(&"logfmt"));
    }

    #[test]
    fn find_returns_template_by_id() {
        let r = Registry::new_with_builtins();
        assert!(r.find("bracket-electron").is_some());
        assert!(r.find("non-existent").is_none());
    }
}
