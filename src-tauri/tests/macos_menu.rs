// macOS 原生菜单需包含编辑项，否则输入框可能无法响应 Cmd+V 等系统编辑动作

#[cfg(target_os = "macos")]
#[test]
fn macos_menu_includes_native_edit_actions() {
    let source = include_str!("../src/lib.rs");
    let required = [
        "SubmenuBuilder::new(app_handle, \"Edit\")",
        ".undo()",
        ".redo()",
        ".cut()",
        ".copy()",
        ".paste()",
        ".select_all()",
    ];

    for needle in required {
        assert!(
            source.contains(needle),
            "macOS 菜单缺少原生编辑项配置：{needle}"
        );
    }
}
