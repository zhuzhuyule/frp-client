//! 极简双语：调用点并列中英两版文案，按全局语言选一条。
//! 用户可见的字符串（返回给前端的 note / 错误）一律走 t!，测试断言默认中文。
use std::sync::atomic::{AtomicBool, Ordering};

static EN: AtomicBool = AtomicBool::new(false);

pub fn set_lang(code: &str) {
    EN.store(code == "en", Ordering::Relaxed);
}

pub fn is_en() -> bool {
    EN.load(Ordering::Relaxed)
}

/// 函数形态，与 t! 宏并存：供不便引入宏的模块（如 backend.rs）直接调用
pub fn t(zh: impl Into<String>, en: impl Into<String>) -> String {
    if is_en() {
        en.into()
    } else {
        zh.into()
    }
}

/// t!("已切换到「x」", "Switched to \"x\"")
#[macro_export]
macro_rules! t {
    ($zh:expr, $en:expr) => {
        if $crate::l10n::is_en() {
            String::from($en)
        } else {
            String::from($zh)
        }
    };
}
