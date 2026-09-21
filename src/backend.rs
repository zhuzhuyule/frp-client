use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use toml_edit::{value, Array, ArrayOfTables, DocumentMut, Item, Table, Value};

// ---------- environment / target discovery ----------

pub const DEFAULT_CONFIG_PATH: &str = "/opt/homebrew/etc/frpc/frpc.toml";
pub const DEFAULT_LOG_PATH: &str = "/tmp/frpc.log";
pub const DEFAULT_ERR_PATH: &str = "/tmp/frpc.err";
pub const DEFAULT_LAUNCHD_LABEL: &str = "com.frp.client";
pub const DEFAULT_PLIST_PATH: &str = "~/Library/LaunchAgents/com.frp.client.plist";

#[derive(Clone, Debug)]
pub struct Target {
    pub config_path: PathBuf,
    pub log_path: PathBuf,
    pub err_path: PathBuf,
    pub launchd_label: String,
    pub plist_path: PathBuf,
    pub base_url: String,
    pub user: String,
    pub password: String,
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

pub fn gui_domain() -> String {
    let uid = std::process::Command::new("id")
        .arg("-u")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|_| "501".into());
    format!("gui/{uid}")
}

fn target_from_config(config_path: &Path) -> Result<Target> {
    let src = std::fs::read_to_string(config_path)
        .with_context(|| format!("无法读取 {}", config_path.display()))?;
    let doc = src
        .parse::<DocumentMut>()
        .context("frpc.toml 解析失败")?;

    let get_str = |keys: &[&str], default: &str| -> String {
        let mut cur = doc.as_item();
        for k in keys {
            match cur.get(*k) {
                Some(item) => cur = item,
                None => return default.to_string(),
            }
        }
        cur.as_str().unwrap_or(default).to_string()
    };
    let get_int = |keys: &[&str], default: i64| -> i64 {
        let mut cur = doc.as_item();
        for k in keys {
            match cur.get(*k) {
                Some(item) => cur = item,
                None => return default,
            }
        }
        cur.as_integer().unwrap_or(default)
    };

    let web_addr = get_str(&["webServer", "addr"], "127.0.0.1");
    let web_port = get_int(&["webServer", "port"], 7400);
    // 每个实例的日志位置不同，优先用配置里的 logging.to
    let log_cfg = get_str(&["logging", "to"], "");
    let log_default = if log_cfg.is_empty() { DEFAULT_LOG_PATH } else { &log_cfg };

    Ok(Target {
        config_path: config_path.to_path_buf(),
        log_path: PathBuf::from(env_or("FRPC_LOG_PATH", log_default)),
        err_path: PathBuf::from(env_or("FRPC_ERR_PATH", DEFAULT_ERR_PATH)),
        launchd_label: env_or("FRPC_LAUNCHD_LABEL", DEFAULT_LAUNCHD_LABEL),
        plist_path: expand_tilde(&env_or("FRPC_PLIST_PATH", DEFAULT_PLIST_PATH)),
        base_url: format!(
            "http://{}:{}",
            local_console_addr(&web_addr),
            web_port
        ),
        user: get_str(&["webServer", "user"], ""),
        password: get_str(&["webServer", "password"], ""),
    })
}

fn expand_tilde(raw: &str) -> PathBuf {
    match raw.strip_prefix("~/") {
        Some(rest) => {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/Users".into());
            PathBuf::from(home).join(rest)
        }
        None => PathBuf::from(raw),
    }
}

/// 本机网卡上的地址（`ifconfig -a` 里的 inet 行）
pub fn local_interface_ips() -> Vec<String> {
    let Ok(out) = std::process::Command::new("ifconfig").arg("-a").output() else {
        return Vec::new();
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| {
            let t = l.trim();
            let rest = t.strip_prefix("inet ")?;
            rest.split_whitespace().next().map(|s| s.to_string())
        })
        .collect()
}

/// 本机实例的控制台地址：配置里可能写的是别的机器的 IP（那是在那台机器上生成的配置），
/// 连不上自己，所以只有当它确实是本机网卡地址时才沿用，否则走回环。
pub fn local_console_addr(configured: &str) -> String {
    let a = configured.trim();
    if a.is_empty() || a == "0.0.0.0" || a == "::" || a.starts_with("127.") {
        return "127.0.0.1".to_string();
    }
    if local_interface_ips().iter().any(|ip| ip == a) {
        a.to_string()
    } else {
        "127.0.0.1".to_string()
    }
}

/// 本机实例的 webServer.addr 只允许写这台机器能绑定的地址。
/// 曾经把另一台机器的控制台地址写进本机配置，热加载时看不出问题（不会重新 bind），
/// 下一次真实重启才 bind 失败，整机隧道全部下线。
pub fn check_local_console_addr(addr: &str) -> Result<()> {
    let a = addr.trim();
    if a.is_empty() {
        bail!("控制台地址不能为空，本机一般填 127.0.0.1");
    }
    if a == "0.0.0.0" || a == "::" {
        bail!("控制台不能绑定 {a}：会把 frpc 的管理接口暴露给整个局域网");
    }
    if a.starts_with("127.") || a.eq_ignore_ascii_case("localhost") {
        return Ok(());
    }
    if local_interface_ips().iter().any(|ip| ip == a) {
        return Ok(());
    }
    bail!("{a} 不是本机地址：这里要填的是这台机器上 frpc 绑定的控制台地址，本机一般用 127.0.0.1")
}

// ---------- remote targets (app-owned config) ----------

pub fn app_config_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/Users".into());
    PathBuf::from(home).join(".config/frp-client/app.toml")
}

#[derive(Clone, Debug, PartialEq)]
pub struct RemoteTarget {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    /// 机器类型（frpc API 探测不到 OS，由用户标注）："macos" | "windows" | "linux" | ""（未知）
    pub os: String,
}

impl RemoteTarget {
    pub fn endpoint(&self) -> Endpoint {
        Endpoint {
            base_url: format!("http://{}:{}", self.host, self.port),
            user: self.user.clone(),
            password: self.password.clone(),
        }
    }
}

/// IPv4 或主机名：非空、无空白、仅字母数字 . -，且若像 IPv4 则四段 0-255
pub fn validate_host(s: &str) -> Result<()> {
    let h = s.trim();
    if h.is_empty() {
        bail!("地址不能为空");
    }
    if h.chars().any(|c| c.is_whitespace()) {
        bail!("地址不能含空格");
    }
    let ok = h.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    if !ok {
        bail!("地址只允许字母、数字、. 和 -（收到 {h}）");
    }
    // 以数字开头的地址必须写成完整 IPv4，挡掉 192.168.3.10cc 这类手滑
    if h.starts_with(|c: char| c.is_ascii_digit()) {
        let parts: Vec<_> = h.split('.').collect();
        if parts.len() != 4 {
            bail!("IPv4 需要四段（收到 {h}）");
        }
        for p in parts {
            let n: u32 = p.parse().context(format!("IPv4 段不合法：{h}"))?;
            if n > 255 {
                bail!("IPv4 段超出 0-255：{h}");
            }
        }
    }
    Ok(())
}

pub fn load_remotes() -> Result<Vec<RemoteTarget>> {
    let path = app_config_path();
    if !path.exists() {
        return Ok(Vec::new());
    }
    let src = std::fs::read_to_string(&path)
        .with_context(|| format!("读取 {} 失败", path.display()))?;
    let doc = src.parse::<DocumentMut>().context("app.toml 解析失败")?;
    let mut out = Vec::new();
    if let Some(Item::ArrayOfTables(aot)) = doc.get("remote") {
        for tbl in aot.iter() {
            let s = |k: &str| -> String {
                tbl.get(k)
                    .and_then(|it| it.as_value())
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            };
            let port = tbl
                .get("port")
                .and_then(|it| it.as_value())
                .and_then(|v| v.as_integer())
                .unwrap_or(7400);
            out.push(RemoteTarget {
                name: s("name"),
                host: s("host"),
                port: port.clamp(1, 65535) as u16,
                user: s("user"),
                password: s("password"),
                os: s("os"),
            });
        }
    }
    Ok(out)
}

pub fn save_remotes(rs: &[RemoteTarget]) -> Result<()> {
    let path = app_config_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .with_context(|| format!("创建 {} 失败", dir.display()))?;
    }
    // 保留文件里的其它表（如 [local]），只整体替换 [[remote]]
    let mut doc = match std::fs::read_to_string(&path) {
        Ok(src) => src.parse::<DocumentMut>().context("app.toml 解析失败")?,
        Err(_) => DocumentMut::new(),
    };
    let mut aot = ArrayOfTables::new();
    for r in rs {
        let mut tbl = Table::new();
        tbl.set_implicit(false);
        tbl["name"] = value(r.name.as_str());
        tbl["host"] = value(r.host.as_str());
        tbl["port"] = value(r.port as i64);
        tbl["user"] = value(r.user.as_str());
        tbl["password"] = value(r.password.as_str());
        if !r.os.is_empty() {
            tbl["os"] = value(r.os.as_str());
        }
        aot.push(tbl);
    }
    doc["remote"] = Item::ArrayOfTables(aot);
    write_app_doc(&doc)
}

/// 本机目标的探测结果
/// 用户为某个本机实例保存的标注：改名、补凭据、手动添加的实例
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LocalSaved {
    pub config_path: String,
    pub name: String,
    pub addr: String,
    pub port: String,
    pub user: String,
    pub password: String,
}

pub fn load_locals() -> Vec<LocalSaved> {
    let Ok(src) = std::fs::read_to_string(app_config_path()) else {
        return Vec::new();
    };
    let Ok(doc) = src.parse::<DocumentMut>() else {
        return Vec::new();
    };
    let Some(Item::ArrayOfTables(aot)) = doc.get("local") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for tbl in aot.iter() {
        let s = |k: &str| -> String {
            tbl.get(k)
                .and_then(|it| it.as_value())
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        };
        let cfg = s("configPath");
        if !cfg.is_empty() {
            out.push(LocalSaved {
                config_path: cfg,
                name: s("name"),
                addr: s("addr"),
                port: s("port"),
                user: s("user"),
                password: s("password"),
            });
        }
    }
    out
}

pub fn save_locals(items: &[LocalSaved]) -> Result<()> {
    let path = app_config_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .with_context(|| format!("创建 {} 失败", dir.display()))?;
    }
    let mut doc = match std::fs::read_to_string(&path) {
        Ok(src) => src.parse::<DocumentMut>().context("app.toml 解析失败")?,
        Err(_) => DocumentMut::new(),
    };
    let mut aot = ArrayOfTables::new();
    for it in items {
        let mut tbl = Table::new();
        tbl.set_implicit(false);
        tbl["configPath"] = value(it.config_path.as_str());
        for (k, v) in [
            ("name", &it.name),
            ("addr", &it.addr),
            ("port", &it.port),
            ("user", &it.user),
            ("password", &it.password),
        ] {
            if !v.is_empty() {
                tbl[k] = value(v.as_str());
            }
        }
        aot.push(tbl);
    }
    if aot.is_empty() {
        doc.remove("local");
    } else {
        doc["local"] = Item::ArrayOfTables(aot);
    }
    write_app_doc(&doc)
}

fn write_app_doc(doc: &DocumentMut) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let path = app_config_path();
    let tmp = path.with_extension("toml.tmp");
    std::fs::write(&tmp, doc.to_string()).context("写 app.toml 失败")?;
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
        .context("app.toml 权限设置失败")?;
    std::fs::rename(&tmp, &path)
        .with_context(|| format!("替换 {} 失败", path.display()))?;
    Ok(())
}

/// 本机一个 frpc 实例：配置文件 + 控制台凭据 + 运行状态
#[derive(Clone, Debug)]
pub struct LocalInstance {
    /// 稳定标识，就是配置文件的绝对路径
    pub id: String,
    pub name: String,
    pub target: Target,
    /// 只有 LaunchAgent 监督的那个实例允许 App 启停
    pub managed: bool,
    pub pid: Option<u32>,
    /// 配置里没有可用的 webServer 凭据，需要用户补全
    pub need_creds: bool,
}

/// 常见安装位置的 frpc.toml
pub fn local_config_candidates() -> Vec<PathBuf> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/Users".into());
    vec![
        PathBuf::from(DEFAULT_CONFIG_PATH),
        PathBuf::from("/usr/local/etc/frpc/frpc.toml"),
        PathBuf::from("/etc/frp/frpc.toml"),
        PathBuf::from(home.clone()).join(".config/frpc/frpc.toml"),
        PathBuf::from(home.clone()).join(".config/frpc.toml"),
        PathBuf::from(home).join("frpc.toml"),
    ]
}

fn push_unique(v: &mut Vec<PathBuf>, p: PathBuf) {
    if !v.contains(&p) {
        v.push(p);
    }
}

fn cn_num(i: usize) -> String {
    ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"]
        .get(i.wrapping_sub(1))
        .map(|s| s.to_string())
        .unwrap_or_else(|| i.to_string())
}

/// 从 frpc 的命令行参数里取 `-c <path>` / `--config <path>` / `--config=<path>`
fn config_path_from_args(args: &str) -> Option<PathBuf> {
    let mut it = args.split_whitespace();
    while let Some(t) = it.next() {
        if t == "-c" || t == "--config" {
            if let Some(v) = it.next() {
                return Some(PathBuf::from(v));
            }
        }
        if let Some(v) = t
            .strip_prefix("--config=")
            .or_else(|| if t.starts_with("-c/") { t.strip_prefix("-c") } else { None })
        {
            if !v.is_empty() {
                return Some(PathBuf::from(v));
            }
        }
    }
    None
}

/// 正在运行的 frpc：(pid, 它用的配置路径)
pub fn running_frpcs() -> Vec<(u32, PathBuf)> {
    let fallback = PathBuf::from(env_or("FRPC_CONFIG_PATH", DEFAULT_CONFIG_PATH));
    frpc_pids()
        .into_iter()
        .filter_map(|pid| {
            let out = std::process::Command::new("ps")
                .args(["-o", "args=", "-p", &pid.to_string()])
                .output()
                .ok()?;
            let args = String::from_utf8_lossy(&out.stdout).to_string();
            Some((pid, config_path_from_args(&args).unwrap_or_else(|| fallback.clone())))
        })
        .collect()
}

/// LaunchAgent 里监督的那个配置路径（决定哪个实例可被 App 启停）
pub fn managed_config_path() -> PathBuf {
    let plist = expand_tilde(&env_or("FRPC_PLIST_PATH", DEFAULT_PLIST_PATH));
    if let Ok(src) = std::fs::read_to_string(&plist) {
        for seg in src.split("<string>") {
            let v = seg.split("</string>").next().unwrap_or("").trim();
            if v.ends_with(".toml") {
                return PathBuf::from(v);
            }
        }
    }
    PathBuf::from(env_or("FRPC_CONFIG_PATH", DEFAULT_CONFIG_PATH))
}

/// 配置读不动时的兜底目标：只能靠用户补全控制台信息
fn fallback_target(config_path: &Path) -> Target {
    Target {
        config_path: config_path.to_path_buf(),
        log_path: PathBuf::from(env_or("FRPC_LOG_PATH", DEFAULT_LOG_PATH)),
        err_path: PathBuf::from(env_or("FRPC_ERR_PATH", DEFAULT_ERR_PATH)),
        launchd_label: env_or("FRPC_LAUNCHD_LABEL", DEFAULT_LAUNCHD_LABEL),
        plist_path: expand_tilde(&env_or("FRPC_PLIST_PATH", DEFAULT_PLIST_PATH)),
        base_url: "http://127.0.0.1:7400".to_string(),
        user: String::new(),
        password: String::new(),
    }
}

/// 发现本机所有 frpc 实例：运行中的进程 → LaunchAgent 监督项 → 用户手工添加项 → 常见路径兜底
pub fn discover_locals() -> Vec<LocalInstance> {
    let saved = load_locals();
    let running = running_frpcs();
    let managed = managed_config_path();

    let mut paths: Vec<PathBuf> = Vec::new();
    for (_, p) in &running {
        push_unique(&mut paths, p.clone());
    }
    if managed.exists() {
        push_unique(&mut paths, managed.clone());
    }
    for s in &saved {
        let p = PathBuf::from(&s.config_path);
        if p.exists() {
            push_unique(&mut paths, p);
        }
    }
    if paths.is_empty() {
        if let Some(p) = local_config_candidates().into_iter().find(|p| p.exists()) {
            paths.push(p);
        }
    }

    let mut out: Vec<LocalInstance> = Vec::new();
    for p in paths {
        let mut t = target_from_config(&p).unwrap_or_else(|_| fallback_target(&p));
        let s = saved.iter().find(|s| PathBuf::from(&s.config_path) == p);
        if let Some(s) = s {
            if !s.user.trim().is_empty() {
                t.user = s.user.trim().to_string();
            }
            if !s.password.is_empty() {
                t.password = s.password.clone();
            }
            if !s.addr.trim().is_empty() {
                let port = if s.port.trim().is_empty() { "7400" } else { s.port.trim() };
                t.base_url = format!("http://{}:{}", s.addr.trim(), port);
            }
        }
        out.push(LocalInstance {
            id: p.display().to_string(),
            name: s.map(|s| s.name.clone()).unwrap_or_default(),
            target: t,
            managed: p == managed,
            pid: running.iter().find(|(_, rp)| *rp == p).map(|(pid, _)| *pid),
            need_creds: false,
        });
    }
    for it in out.iter_mut() {
        it.need_creds = it.target.user.is_empty() || it.target.password.is_empty();
    }
    out.sort_by(|a, b| b.managed.cmp(&a.managed).then(a.id.cmp(&b.id)));
    let n = out.len();
    for (i, it) in out.iter_mut().enumerate() {
        if it.name.is_empty() {
            it.name = if n == 1 { "本机".into() } else { format!("本机{}", cn_num(i + 1)) };
        }
    }
    out
}

// ---------- runtime status (webServer API) ----------

fn field_str(obj: &serde_json::Value, key: &str) -> String {
    obj.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

/// 一个可调 webServer API 的 frpc 实例（本机或远端）
#[derive(Clone, Debug)]
pub struct Endpoint {
    pub base_url: String,
    pub user: String,
    pub password: String,
}

impl Target {
    pub fn endpoint(&self) -> Endpoint {
        Endpoint {
            base_url: self.base_url.clone(),
            user: self.user.clone(),
            password: self.password.clone(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct ProxyStatus {
    pub name: String,
    pub ptype: String,
    pub status: String,
    pub err: String,
    pub local_addr: String,
    pub remote_addr: String,
}

fn auth_header(e: &Endpoint) -> String {
    use base64::Engine;
    let creds =
        base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", e.user, e.password));
    format!("Basic {creds}")
}

pub fn fetch_status(e: &Endpoint) -> Result<Vec<ProxyStatus>> {
    let url = format!("{}/api/status", e.base_url);
    let resp = ureq::get(&url)
        .set("Authorization", &auth_header(e))
        .timeout(Duration::from_secs(4))
        .call()
        .with_context(|| format!("GET {url} 失败（frpc 是否在运行？）"))?;
    let body: serde_json::Value = resp.into_json()?;

    let mut out = Vec::new();
    let map = body
        .as_object()
        .ok_or_else(|| anyhow!("意外的 /api/status 响应结构"))?;
    for (_ptype, arr) in map {
        if let Some(list) = arr.as_array() {
            for p in list {
                out.push(ProxyStatus {
                    name: field_str(p, "name"),
                    ptype: field_str(p, "type"),
                    status: field_str(p, "status"),
                    err: field_str(p, "err"),
                    local_addr: field_str(p, "local_addr"),
                    remote_addr: field_str(p, "remote_addr"),
                });
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// 读取远端/本机 frpc 的当前 TOML 原文（GET /api/config）
pub fn fetch_config(e: &Endpoint) -> Result<String> {
    let url = format!("{}/api/config", e.base_url);
    let resp = ureq::get(&url)
        .set("Authorization", &auth_header(e))
        .timeout(Duration::from_secs(5))
        .call()
        .with_context(|| format!("GET {url} 失败"))?;
    Ok(resp.into_string()?)
}

/// 热加载新配置（PUT /api/config）。写入前先做 TOML 合法性校验。
pub fn put_config(e: &Endpoint, toml_src: &str) -> Result<()> {
    toml_src
        .parse::<DocumentMut>()
        .context("新配置不是合法 TOML，拒绝提交")?;
    let url = format!("{}/api/config", e.base_url);
    ureq::put(&url)
        .set("Authorization", &auth_header(e))
        .set("Content-Type", "text/plain")
        .timeout(Duration::from_secs(8))
        .send_string(toml_src)
        .with_context(|| format!("PUT {url} 失败（热加载未生效）"))?;
    Ok(())
}

// ---------- store API (frpc >= 0.68 且配置了 store.path) ----------
//
// 实测契约（0.71.0，隔离 frps）：
//   GET    /api/store/proxies        200 {"proxies":[..]}；未开 store 或 <0.68 一律 404 "page not found"
//   POST   /api/store/proxies        200 立即可用（无需重启）；同名 409 conflict
//   PUT    /api/store/proxies/{name} 200 原地更新；URL 与 body 的 name 不一致 400（不支持改名）；不存在 404
//   DELETE /api/store/proxies/{name} 200；不存在 404
// 响应里的代理条目会把配置嵌套在 obj[type] 下，并补齐 frpc 自己的默认字段。

fn store_err(code: u16, body: &str) -> anyhow::Error {
    let msg = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("Msg").and_then(|m| m.as_str()).map(|s| s.to_string()))
        .unwrap_or_else(|| body.trim().to_string());
    anyhow!("HTTP {code} {msg}")
}

/// store 端点统一入口；非 2xx 时把 frpc 返回的 Msg 透出来
fn store_call(method: &str, e: &Endpoint, path: &str, body: Option<&str>) -> Result<String> {
    let url = format!("{}{}", e.base_url, path);
    let mut req = ureq::request(method, &url)
        .set("Authorization", &auth_header(e))
        .timeout(Duration::from_secs(6));
    if let Some(b) = body {
        req = req.set("Content-Type", "application/json");
        match req.send_string(b) {
            Ok(r) => return Ok(r.into_string()?),
            Err(ureq::Error::Status(code, resp)) => return Err(store_err(code, &resp.into_string().unwrap_or_default())),
            Err(other) => return Err(other).with_context(|| format!("{method} {url} 失败")),
        }
    }
    match req.call() {
        Ok(r) => Ok(r.into_string()?),
        Err(ureq::Error::Status(code, resp)) => {
            Err(store_err(code, &resp.into_string().unwrap_or_default()))
        }
        Err(other) => Err(other).with_context(|| format!("{method} {url} 失败")),
    }
}

fn store_body(p: &NewProxy) -> String {
    let mut conf = serde_json::Map::new();
    conf.insert("localIP".into(), serde_json::json!(p.local_ip));
    conf.insert("localPort".into(), serde_json::json!(p.local_port));
    if let Some(rp) = p.remote_port {
        conf.insert("remotePort".into(), serde_json::json!(rp));
    }
    let domains = domain_list(p.domain.as_deref().unwrap_or(""));
    if !domains.is_empty() {
        conf.insert("customDomains".into(), serde_json::json!(domains));
    }
    let mut root = serde_json::Map::new();
    root.insert("name".into(), serde_json::json!(p.name.as_str()));
    root.insert("type".into(), serde_json::json!(p.ptype.as_str()));
    root.insert(p.ptype.clone(), serde_json::Value::Object(conf));
    serde_json::Value::Object(root).to_string()
}

/// store 能力探测：200 才算开启；404 表示这台 frpc 不支持 store（<0.68）或没配 store.path；
/// 其余（超时 / 401 / 连接被拒）说明控制台本身有问题，交给调用方决定是报错还是回退
pub fn probe_store(e: &Endpoint) -> Result<bool> {
    let url = format!("{}/api/store/proxies", e.base_url);
    match ureq::get(&url)
        .set("Authorization", &auth_header(e))
        .timeout(Duration::from_secs(4))
        .call()
    {
        Ok(_) => Ok(true),
        Err(ureq::Error::Status(404, _)) => Ok(false),
        Err(other) => Err(anyhow::Error::new(other).context(format!("GET {url} 失败"))),
    }
}

/// store 里的代理条目；Err 表示这台 frpc 没有 store 能力（或不可达）
pub fn store_proxies(e: &Endpoint) -> Result<Vec<ProxyCfg>> {
    let text = store_call("GET", e, "/api/store/proxies", None)?;
    let val: serde_json::Value =
        serde_json::from_str(&text).context("/api/store/proxies 返回的不是合法 JSON")?;
    let arr = val
        .get("proxies")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for item in arr {
        let ptype = field_str(&item, "type");
        let conf = item.get(&ptype).cloned().unwrap_or(serde_json::Value::Null);
        let num = |k: &str| -> String {
            conf.get(k)
                .map(|v| match v {
                    serde_json::Value::String(s) => s.clone(),
                    serde_json::Value::Number(n) => n.to_string(),
                    _ => String::new(),
                })
                .unwrap_or_default()
        };
        let domains = conf
            .get("customDomains")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str())
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_default();
        let local_ip = match conf.get("localIP") {
            Some(serde_json::Value::String(s)) => s.clone(),
            _ => String::new(),
        };
        out.push(ProxyCfg {
            name: field_str(&item, "name"),
            ptype,
            local_ip: if local_ip.is_empty() { "127.0.0.1".into() } else { local_ip },
            local_port: num("localPort"),
            remote_port: num("remotePort"),
            domains,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

pub fn store_add(e: &Endpoint, p: &NewProxy) -> Result<()> {
    store_call("POST", e, "/api/store/proxies", Some(&store_body(p)))?;
    Ok(())
}

/// 原地更新（同名）。改名要走 store_replace。
pub fn store_update(e: &Endpoint, p: &NewProxy) -> Result<()> {
    let path = format!("/api/store/proxies/{}", p.name);
    store_call("PUT", e, &path, Some(&store_body(p)))?;
    Ok(())
}

pub fn store_delete(e: &Endpoint, name: &str) -> Result<()> {
    store_call("DELETE", e, &format!("/api/store/proxies/{name}"), None)?;
    Ok(())
}

/// 改名 = 先删旧的再建新的；建新失败时把旧条目原样放回，避免隧道凭空消失
pub fn store_replace(e: &Endpoint, original: &ProxyCfg, p: &NewProxy) -> Result<()> {
    let old = original.to_new_proxy()?;
    store_delete(e, &original.name)?;
    match store_add(e, p) {
        Ok(()) => Ok(()),
        Err(new_err) => {
            // 回滚：恢复原条目，原错误一并报出
            let name = original.name.clone();
            match store_add(e, &old) {
                Ok(()) => bail!("{new_err}（原隧道 {name} 已还原）"),
                Err(rb) => bail!(
                    "{new_err}，且还原 {name} 也失败：{rb}，请手动检查该目标的隧道列表"
                ),
            }
        }
    }
}

// ---------- process control (launchd) ----------
pub fn frpc_pids() -> Vec<u32> {
    let Ok(out) = std::process::Command::new("pgrep").arg("-x").arg("frpc").output() else {
        return Vec::new();
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.trim().parse().ok())
        .collect()
}

/// 本机进程指标：(RSS MB, CPU %, 运行时长)，来自 ps，无需额外依赖
pub fn proc_stats(pid: u32) -> Option<(f64, f64, String)> {
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=,%cpu=,etime=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut it = text.split_whitespace();
    let rss_mb = it.next()?.parse::<f64>().ok()? / 1024.0;
    let cpu = it.next()?.parse::<f64>().ok()?;
    let etime = it.next()?.to_string();
    Some((rss_mb, cpu, etime))
}

/// 本地端口背后那个服务的进程信息
#[derive(Clone, Debug)]
pub struct ServiceInfo {
    pub pid: u32,
    pub name: String,
    pub path: String,
    pub rss_mb: f64,
    pub cpu_pct: f64,
}

/// 跳过前 n 个空白字段后取剩余整段（ps 的 comm 路径可能含空格）
fn after_fields(line: &str, n: usize) -> Option<&str> {
    let mut seen = 0usize;
    let mut prev_ws = true;
    for (i, ch) in line.char_indices() {
        let ws = ch.is_whitespace();
        if !ws && prev_ws {
            seen += 1;
            if seen > n {
                return Some(line[i..].trim_end());
            }
        }
        prev_ws = ws;
    }
    None
}

fn lsof_ports(args: &[&str]) -> Vec<(u16, u32)> {
    let out = match std::process::Command::new("lsof").args(args).output() {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    let mut hits = Vec::new();
    for line in String::from_utf8_lossy(&out.stdout).lines().skip(1) {
        // COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME [(STATE)]
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 9 {
            continue;
        }
        let Ok(pid) = cols[1].parse::<u32>() else { continue };
        let Some(port) = cols[8].rsplit(':').next().and_then(|p| p.parse::<u16>().ok()) else {
            continue;
        };
        hits.push((port, pid));
    }
    hits
}

/// 本机「监听端口 -> 承载进程」索引（lsof + ps，零额外依赖）。
/// 只能看到当前用户有权限探测的进程；远端目标没有对应能力。
pub fn local_port_owners() -> std::collections::HashMap<u16, ServiceInfo> {
    use std::collections::HashMap;
    let mut port_pid: HashMap<u16, u32> = HashMap::new();
    for pid in lsof_ports(&["-nP", "-iTCP", "-sTCP:LISTEN"])
        .into_iter()
        .chain(lsof_ports(&["-nP", "-iUDP"]))
    {
        port_pid.entry(pid.0).or_insert(pid.1);
    }
    if port_pid.is_empty() {
        return HashMap::new();
    }

    let out = match std::process::Command::new("ps")
        .args(["-axo", "pid=,rss=,pcpu=,comm="])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return HashMap::new(),
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut by_pid: HashMap<u32, ServiceInfo> = HashMap::new();
    for line in text.lines() {
        let line = line.trim_start();
        let mut it = line.split_whitespace();
        let Some(pid) = it.next().and_then(|v| v.parse::<u32>().ok()) else {
            continue;
        };
        if !port_pid.values().any(|&p| p == pid) {
            continue;
        }
        let (Some(rss), Some(cpu)) = (
            it.next().and_then(|v| v.parse::<f64>().ok()),
            it.next().and_then(|v| v.parse::<f64>().ok()),
        ) else {
            continue;
        };
        let Some(path) = after_fields(line, 3) else {
            continue;
        };
        let name = path.rsplit('/').next().unwrap_or(path).to_string();
        by_pid.insert(
            pid,
            ServiceInfo {
                pid,
                name,
                path: path.to_string(),
                rss_mb: (rss / 1024.0 * 10.0).round() / 10.0,
                cpu_pct: cpu,
            },
        );
    }

    port_pid
        .into_iter()
        .filter_map(|(port, pid)| by_pid.remove(&pid).map(|s| (port, s)))
        .collect()
}

fn run(cmd: &str, args: &[&str]) -> Result<std::process::Output> {
    std::process::Command::new(cmd)
        .args(args)
        .output()
        .with_context(|| format!("执行 {cmd} {args:?} 失败"))
}

fn check(ok: bool, stderr: &[u8], what: &str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        bail!("{what} 失败: {}", String::from_utf8_lossy(stderr).trim())
    }
}

/// restart：kickstart -k 杀掉再拉起，KeepAlive 保证由 launchd 监督
pub fn restart(t: &Target) -> Result<()> {
    let target = format!("{}/{}", gui_domain(), t.launchd_label);
    let o = run("launchctl", &["kickstart", "-k", &target])?;
    check(o.status.success(), &o.stderr, &format!("launchctl kickstart {target}"))
}

/// stop：bootout 会从 launchd 注销服务
pub fn stop(t: &Target) -> Result<()> {
    let target = format!("{}/{}", gui_domain(), t.launchd_label);
    let o = run("launchctl", &["bootout", &target])?;
    check(o.status.success(), &o.stderr, &format!("launchctl bootout {target}"))
}

/// start：bootstrap 重新加载 LaunchAgent
pub fn start(t: &Target) -> Result<()> {
    let dom = gui_domain();
    let o = run(
        "launchctl",
        &["bootstrap", &dom, &t.plist_path.to_string_lossy()],
    )?;
    check(
        o.status.success(),
        &o.stderr,
        &format!("launchctl bootstrap {dom} {}", t.plist_path.display()),
    )
}

/// 轮询 /api/status 直到可达或超时
pub fn wait_ready(e: &Endpoint, timeout: Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if fetch_status(e).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    false
}

// ---------- config file write (backup + atomic rename) ----------

fn timestamp() -> String {
    std::process::Command::new("date")
        .arg("+%Y%m%d-%H%M%S")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|_| "unknown".into())
}

pub fn save_config(t: &Target, toml_src: &str) -> Result<PathBuf> {
    toml_src
        .parse::<DocumentMut>()
        .context("新配置不是合法 TOML，拒绝写入")?;

    let bak = t.config_path.with_file_name(format!(
        "{}.bak-{}",
        t.config_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("frpc.toml"),
        timestamp()
    ));
    if t.config_path.exists() {
        std::fs::copy(&t.config_path, &bak)
            .with_context(|| format!("备份到 {} 失败", bak.display()))?;
    }

    let tmp = t.config_path.with_extension("toml.tmp");
    std::fs::write(&tmp, toml_src).context("写临时文件失败")?;
    std::fs::rename(&tmp, &t.config_path)
        .with_context(|| format!("替换 {} 失败", t.config_path.display()))?;
    Ok(bak)
}

/// 用备份文件覆盖当前配置（原子替换），返回还原后的配置原文
pub fn restore_config_from_backup(t: &Target, bak: &Path) -> Result<String> {
    let src = std::fs::read_to_string(bak)
        .with_context(|| format!("读取备份 {} 失败", bak.display()))?;
    let tmp = t.config_path.with_extension("toml.tmp");
    std::fs::write(&tmp, &src).context("写临时文件失败")?;
    std::fs::rename(&tmp, &t.config_path)
        .with_context(|| format!("还原 {} 失败", t.config_path.display()))?;
    Ok(src)
}

// ---------- structured TOML editing (comment preserving) ----------

#[derive(Clone, Debug)]
pub struct ProxyCfg {
    pub name: String,
    pub ptype: String,
    pub local_ip: String,
    pub local_port: String,
    pub remote_port: String,
    pub domains: String,
}

impl ProxyCfg {
    /// 还原成可提交的形态（store 改名回滚时要用原条目）
    pub fn to_new_proxy(&self) -> Result<NewProxy> {
        let n = |k: &str, v: &str| -> Result<i64> {
            v.trim().parse::<i64>()
                .with_context(|| format!("隧道 {} 的 {k} 无法当作端口：{v}", self.name))
        };
        Ok(NewProxy {
            name: self.name.clone(),
            ptype: self.ptype.clone(),
            local_ip: self.local_ip.clone(),
            local_port: n("localPort", &self.local_port)?,
            remote_port: if self.remote_port.trim().is_empty() {
                None
            } else {
                Some(n("remotePort", &self.remote_port)?)
            },
            domain: if self.domains.trim().is_empty() {
                None
            } else {
                Some(self.domains.clone())
            },
        })
    }
}

pub struct Basics {
    pub server_addr: String,
    pub server_port: String,
    pub token: String,
    pub web_addr: String,
    pub web_port: String,
    pub web_user: String,
    pub web_pass: String,
}

pub fn parse_proxies(src: &str) -> Result<Vec<ProxyCfg>> {
    let doc = src.parse::<DocumentMut>()?;
    let mut out = Vec::new();
    if let Some(Item::ArrayOfTables(aot)) = doc.get("proxies") {
        for tbl in aot.iter() {
            let scalar = |k: &str| -> String {
                tbl.get(k).and_then(|it| it.as_value()).map(|v| match v {
                    Value::String(s) => s.value().clone(),
                    Value::Integer(i) => i.value().to_string(),
                    Value::Boolean(b) => b.to_string(),
                    _ => String::new(),
                }).unwrap_or_default()
            };
            let domains = tbl
                .get("customDomains")
                .and_then(|it| it.as_value())
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect::<Vec<_>>()
                        .join(",")
                })
                .unwrap_or_default();
            out.push(ProxyCfg {
                name: scalar("name"),
                ptype: {
                    let t = scalar("type");
                    if t.is_empty() { "tcp".into() } else { t }
                },
                local_ip: {
                    let ip = scalar("localIP");
                    if ip.is_empty() { "127.0.0.1".into() } else { ip }
                },
                local_port: scalar("localPort"),
                remote_port: scalar("remotePort"),
                domains,
            });
        }
    }
    Ok(out)
}

pub fn parse_basics(src: &str) -> Result<Basics> {
    let doc = src.parse::<DocumentMut>()?;
    let s = |keys: &[&str]| -> String {
        let mut cur = doc.as_item();
        for k in keys {
            cur = match cur.get(*k) {
                Some(item) => item,
                None => return String::new(),
            };
        }
        cur.as_str().unwrap_or("").to_string()
    };
    let i = |keys: &[&str]| -> String {
        let mut cur = doc.as_item();
        for k in keys {
            cur = match cur.get(*k) {
                Some(item) => item,
                None => return String::new(),
            };
        }
        cur.as_integer().map(|v| v.to_string()).unwrap_or_default()
    };
    Ok(Basics {
        server_addr: s(&["serverAddr"]),
        server_port: i(&["serverPort"]),
        token: s(&["auth", "token"]),
        web_addr: s(&["webServer", "addr"]),
        web_port: i(&["webServer", "port"]),
        web_user: s(&["webServer", "user"]),
        web_pass: s(&["webServer", "password"]),
    })
}

pub fn apply_basics(src: &str, b: &Basics) -> Result<String> {
    let mut doc = src.parse::<DocumentMut>()?;
    doc["serverAddr"] = value(b.server_addr.as_str());
    let port: i64 = b
        .server_port
        .trim()
        .parse()
        .context("serverPort 必须是数字")?;
    doc["serverPort"] = value(port);

    let auth = doc.entry("auth").or_insert(Item::Table(Table::new()));
    let auth = auth.as_table_mut().context("auth 不是 table")?;
    auth["token"] = value(b.token.as_str());

    let ws = doc
        .entry("webServer")
        .or_insert(Item::Table(Table::new()));
    let ws = ws.as_table_mut().context("webServer 不是 table")?;
    ws["addr"] = value(b.web_addr.as_str());
    let wp: i64 = b.web_port.trim().parse().context("webServer.port 必须是数字")?;
    ws["port"] = value(wp);
    ws["user"] = value(b.web_user.as_str());
    ws["password"] = value(b.web_pass.as_str());
    Ok(doc.to_string())
}

fn proxies_aot(doc: &mut DocumentMut) -> &mut ArrayOfTables {
    if !doc.contains_key("proxies") {
        doc["proxies"] = Item::ArrayOfTables(ArrayOfTables::new());
    }
    doc["proxies"].as_array_of_tables_mut().unwrap()
}

pub fn remove_proxy(src: &str, name: &str) -> Result<String> {
    let mut doc = src.parse::<DocumentMut>()?;
    let keep: Vec<_> = proxies_aot(&mut doc)
        .iter()
        .filter(|t| {
            t.get("name")
                .and_then(|it| it.as_value())
                .and_then(|v| v.as_str())
                != Some(name)
        })
        .cloned()
        .collect();
    *doc["proxies"].as_array_of_tables_mut().unwrap() = keep.into_iter().collect();
    Ok(doc.to_string())
}

#[derive(Clone, Debug)]
pub struct NewProxy {
    pub name: String,
    pub ptype: String,
    pub local_ip: String,
    pub local_port: i64,
    pub remote_port: Option<i64>,
    pub domain: Option<String>,
}

pub fn validate_new(p: &NewProxy, existing: &[String]) -> Result<()> {
    if p.name.trim().is_empty() {
        bail!("隧道名称不能为空");
    }
    if existing.iter().any(|n| n == &p.name) {
        bail!("已存在同名隧道 {}", p.name);
    }
    if p.local_port <= 0 || p.local_port > 65535 {
        bail!("localPort 不合法");
    }
    match p.ptype.as_str() {
        "tcp" | "udp" => {
            let rp = p.remote_port.context(format!("{} 隧道必须填 remotePort", p.ptype))?;
            if rp <= 0 || rp > 65535 {
                bail!("remotePort 不合法");
            }
        }
        "http" => {
            if domain_list(p.domain.as_deref().unwrap_or("")).is_empty() {
                bail!("http 隧道必须填域名");
            }
        }
        other => bail!("不支持的隧道类型 {other}"),
    }
    Ok(())
}

/// 域名输入允许逗号 / 空格分隔多个
pub fn domain_list(s: &str) -> Vec<String> {
    s.split([',', ' '])
        .map(|x| x.trim().to_string())
        .filter(|x| !x.is_empty())
        .collect()
}

fn set_domains(tbl: &mut Table, domains: &[String]) {
    if domains.is_empty() {
        tbl.remove("customDomains");
        return;
    }
    let mut arr = Array::new();
    for d in domains {
        arr.push(Value::from(d.clone()));
    }
    tbl["customDomains"] = Item::Value(Value::Array(arr));
}

pub fn add_proxy(src: &str, p: &NewProxy) -> Result<String> {
    let mut doc = src.parse::<DocumentMut>()?;
    let mut tbl = Table::new();
    tbl.set_implicit(false);
    tbl["name"] = value(p.name.as_str());
    tbl["type"] = value(p.ptype.as_str());
    tbl["localIP"] = value(p.local_ip.as_str());
    tbl["localPort"] = value(p.local_port);
    if let Some(rp) = p.remote_port {
        tbl["remotePort"] = value(rp);
    }
    set_domains(&mut tbl, &domain_list(p.domain.as_deref().unwrap_or("")));
    proxies_aot(&mut doc).push(tbl);
    Ok(doc.to_string())
}

/// 原地改一条隧道：保留它在文件里的位置和周围注释
pub fn update_proxy(src: &str, original: &str, p: &NewProxy) -> Result<String> {
    let mut doc = src.parse::<DocumentMut>()?;
    let idx = proxies_aot(&mut doc)
        .iter()
        .position(|t| {
            t.get("name")
                .and_then(|it| it.as_value())
                .and_then(|v| v.as_str())
                == Some(original)
        })
        .ok_or_else(|| anyhow!("未找到隧道 {original}"))?;
    let tbl = proxies_aot(&mut doc)
        .iter_mut()
        .nth(idx)
        .ok_or_else(|| anyhow!("未找到隧道 {original}"))?;
    tbl["name"] = value(p.name.as_str());
    tbl["type"] = value(p.ptype.as_str());
    tbl["localIP"] = value(p.local_ip.as_str());
    tbl["localPort"] = value(p.local_port);
    match p.remote_port {
        Some(rp) => tbl["remotePort"] = value(rp),
        None => {
            tbl.remove("remotePort");
        }
    }
    set_domains(tbl, &domain_list(p.domain.as_deref().unwrap_or("")));
    Ok(doc.to_string())
}

pub fn read_config_file(t: &Target) -> Result<String> {
    std::fs::read_to_string(&t.config_path)
        .with_context(|| format!("读取 {} 失败", t.config_path.display()))
}

// ---------- logs ----------

pub fn tail(path: &Path, max_bytes: u64) -> Result<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path)
        .with_context(|| format!("打开日志 {} 失败", path.display()))?;
    let len = f.metadata()?.len();
    let start = len.saturating_sub(max_bytes);
    if start > 0 {
        f.seek(SeekFrom::Start(start))?;
    }
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)?;
    // 若是从中间截断，丢掉第一行（可能不完整）
    if start > 0 {
        if let Some(nl) = buf.iter().position(|b| *b == b'\n') {
            buf.drain(..=nl);
        }
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"# 顶部注释要保留
serverAddr = "1.2.3.4"
serverPort = 7000
auth.token = "tok"

webServer.addr = "127.0.0.1"
webServer.port = 7400
webServer.user = "admin"
webServer.password = "pw"

# 第一个隧道
[[proxies]]
name = "web"
type = "http"
localIP = "127.0.0.1"
localPort = 9092
customDomains = ["a.example.com"]

[[proxies]]
name = "ssh"
type = "tcp"
localPort = 22
remotePort = 2222
"#;

    #[test]
    fn parses_proxies_and_basics() {
        let ps = parse_proxies(SAMPLE).unwrap();
        assert_eq!(ps.len(), 2);
        assert_eq!(ps[0].ptype, "http");
        assert_eq!(ps[0].domains, "a.example.com");
        assert_eq!(ps[1].local_ip, "127.0.0.1"); // 缺省补齐
        assert_eq!(ps[1].remote_port, "2222");

        let b = parse_basics(SAMPLE).unwrap();
        assert_eq!(b.server_addr, "1.2.3.4");
        assert_eq!(b.token, "tok");
        assert_eq!(b.web_port, "7400");
    }

    #[test]
    fn remove_proxy_keeps_comments_and_others() {
        let out = remove_proxy(SAMPLE, "web").unwrap();
        out.parse::<DocumentMut>().unwrap();
        let ps = parse_proxies(&out).unwrap();
        assert_eq!(ps.len(), 1);
        assert_eq!(ps[0].name, "ssh");
        assert!(out.contains("# 顶部注释要保留"));
        assert!(!out.contains("a.example.com"));
    }

    #[test]
    fn add_proxy_round_trip() {
        let np = NewProxy {
            name: "newtcp".into(),
            ptype: "tcp".into(),
            local_ip: "127.0.0.1".into(),
            local_port: 8080,
            remote_port: Some(9090),
            domain: None,
        };
        let out = add_proxy(SAMPLE, &np).unwrap();
        let ps = parse_proxies(&out).unwrap();
        assert_eq!(ps.len(), 3);
        assert_eq!(ps[2].name, "newtcp");
        assert_eq!(ps[2].remote_port, "9090");
        assert!(validate_new(&np, &["x".into()]).is_ok());
        assert!(validate_new(&np, &["newtcp".into()]).is_err()); // 重名
    }

    #[test]
    fn update_proxy_edits_in_place() {
        let np = NewProxy {
            name: "web2".into(),
            ptype: "tcp".into(),
            local_ip: "127.0.0.1".into(),
            local_port: 9092,
            remote_port: Some(19092),
            domain: None,
        };
        let out = update_proxy(SAMPLE, "web", &np).unwrap();
        out.parse::<DocumentMut>().unwrap();
        let ps = parse_proxies(&out).unwrap();
        assert_eq!(ps.len(), 2);
        assert_eq!(ps[0].name, "web2"); // 位置不变
        assert_eq!(ps[0].ptype, "tcp");
        assert_eq!(ps[0].remote_port, "19092");
        assert!(ps[0].domains.is_empty()); // customDomains 被清掉
        assert!(out.contains("# 顶部注释要保留"));
        assert!(!out.contains("a.example.com"));
        assert!(update_proxy(SAMPLE, "ghost", &np).is_err());
    }

    #[test]
    fn validate_new_rules() {
        let base = NewProxy {
            name: "n".into(),
            ptype: "tcp".into(),
            local_ip: "127.0.0.1".into(),
            local_port: 80,
            remote_port: Some(8080),
            domain: None,
        };
        assert!(validate_new(&base, &[]).is_ok());
        assert!(validate_new(&base, &["n".into()]).is_err());
        assert!(validate_new(
            &NewProxy { remote_port: None, ..base.clone() },
            &[]
        )
        .is_err());
        assert!(validate_new(&NewProxy { local_port: 0, ..base.clone() }, &[]).is_err());
        let http = NewProxy {
            name: "h".into(),
            ptype: "http".into(),
            local_port: 80,
            remote_port: None,
            domain: Some("a.b.com".into()),
            ..base.clone()
        };
        assert!(validate_new(&http, &[]).is_ok());
        assert!(validate_new(
            &NewProxy { domain: None, ..http.clone() },
            &[]
        )
        .is_err());
        assert!(validate_new(&NewProxy { ptype: "smtp".into(), ..base.clone() }, &[]).is_err());
    }

    #[test]
    fn store_body_matches_measured_contract() {
        let p = NewProxy {
            name: "web".into(),
            ptype: "http".into(),
            local_ip: "127.0.0.1".into(),
            local_port: 8080,
            remote_port: None,
            domain: Some("a.example.com, b.example.com".into()),
        };
        let v: serde_json::Value = serde_json::from_str(&store_body(&p)).unwrap();
        assert_eq!(v["name"], "web");
        assert_eq!(v["type"], "http");
        // 类型块必须用 type 同名做 key，否则 frpc 报 exactly one proxy type block is required
        assert_eq!(v["http"]["localPort"], 8080);
        assert_eq!(v["http"]["customDomains"].as_array().unwrap().len(), 2);
        assert!(v.get("remotePort").is_none());
        let tcp: serde_json::Value = serde_json::from_str(&store_body(&NewProxy {
            ptype: "tcp".into(),
            remote_port: Some(19092),
            domain: None,
            ..p
        }))
        .unwrap();
        assert_eq!(tcp["tcp"]["remotePort"], 19092);
        assert!(tcp["tcp"].get("customDomains").is_none());
    }

    #[test]
    fn proxy_cfg_to_new_proxy_roundtrip() {
        let cfg = ProxyCfg {
            name: "web".into(),
            ptype: "http".into(),
            local_ip: "127.0.0.1".into(),
            local_port: "8080".into(),
            remote_port: String::new(),
            domains: "a.example.com".into(),
        };
        let p = cfg.to_new_proxy().unwrap();
        assert_eq!((p.local_port, p.remote_port), (8080, None));
        assert_eq!(p.domain.as_deref(), Some("a.example.com"));
        let bad = ProxyCfg { local_port: "http".into(), ..cfg };
        assert!(bad.to_new_proxy().is_err());
    }

    #[test]
    fn local_console_addr_must_be_bindable() {
        assert!(check_local_console_addr("127.0.0.1").is_ok());
        assert!(check_local_console_addr("localhost").is_ok());
        // 这两个都会让 frpc 重启时要么全机下线要么暴露管理接口
        assert!(check_local_console_addr("0.0.0.0").is_err());
        assert!(check_local_console_addr("").is_err());
        // 另一台机器的 IP：热加载不报错，下次真实重启才 bind 失败
        assert!(check_local_console_addr("203.0.113.9").is_err());
    }

    #[test]
    fn apply_basics_updates_in_place() {
        let b = Basics {
            server_addr: "9.9.9.9".into(),
            server_port: "7001".into(),
            token: "newtok".into(),
            web_addr: "127.0.0.1".into(),
            web_port: "7400".into(),
            web_user: "admin".into(),
            web_pass: "pw".into(),
        };
        let out = apply_basics(SAMPLE, &b).unwrap();
        assert!(out.contains("serverAddr = \"9.9.9.9\""));
        assert!(out.contains("serverPort = 7001"));
        assert!(out.contains("# 顶部注释要保留"));
        let ps = parse_proxies(&out).unwrap();
        assert_eq!(ps.len(), 2); // 隧道不受影响
    }

    #[test]
    fn save_config_backs_up_and_rejects_invalid() {
        let dir = std::env::temp_dir().join(format!("frpc-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = dir.join("frpc.toml");
        std::fs::write(&cfg, SAMPLE).unwrap();
        let t = Target {
            config_path: cfg.clone(),
            log_path: dir.join("frpc.log"),
            err_path: dir.join("frpc.err"),
            launchd_label: "x".into(),
            plist_path: dir.join("x.plist"),
            base_url: "http://x".into(),
            user: "".into(),
            password: "".into(),
        };
        assert!(save_config(&t, "not = = valid").is_err());
        assert_eq!(std::fs::read_to_string(&cfg).unwrap(), SAMPLE); // 非法写入不留痕
        let out = save_config(&t, "serverAddr = \"5.5.5.5\"").unwrap();
        assert!(out.exists()); // 备份存在
        let now = std::fs::read_to_string(&cfg).unwrap();
        assert!(now.contains("5.5.5.5"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn restore_config_from_backup_round_trip() {
        let dir = std::env::temp_dir().join(format!("frpc-restore-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = dir.join("frpc.toml");
        std::fs::write(&cfg, SAMPLE).unwrap();
        let t = Target {
            config_path: cfg.clone(),
            log_path: dir.join("frpc.log"),
            err_path: dir.join("frpc.err"),
            launchd_label: "x".into(),
            plist_path: dir.join("x.plist"),
            base_url: "http://x".into(),
            user: "".into(),
            password: "".into(),
        };
        let bad = "serverAddr = \"5.5.5.5\"";
        let bak = save_config(&t, bad).unwrap();
        assert_eq!(std::fs::read_to_string(&cfg).unwrap(), bad);
        let src = restore_config_from_backup(&t, &bak).unwrap();
        assert_eq!(src, SAMPLE);
        assert_eq!(std::fs::read_to_string(&cfg).unwrap(), SAMPLE);
        assert!(restore_config_from_backup(&t, &dir.join("nope.bak")).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn tail_trims_to_last_lines() {
        let dir = std::env::temp_dir().join(format!("frpc-tail-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("a.log");
        std::fs::write(&p, "line1\nline2\nline3\n").unwrap();
        let s = tail(&p, 12).unwrap(); // 从中间截断，首行不完整被丢弃
        assert_eq!(s, "line3\n");
        let s = tail(&p, 1000).unwrap();
        assert_eq!(s, "line1\nline2\nline3\n");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn validate_host_rules() {
        assert!(validate_host("192.168.3.10").is_ok());
        assert!(validate_host("mac-mini.local").is_ok());
        assert!(validate_host("192.168.3.10cc").is_err());
        assert!(validate_host("192.168.3").is_err()); // 像 IPv4 但只有三段
        assert!(validate_host("300.1.1.1").is_err());
        assert!(validate_host("").is_err());
        assert!(validate_host("a b").is_err());
        assert!(validate_host("evil;rm").is_err());
    }

    #[test]
    fn remotes_round_trip_via_app_toml() {
        let dir = std::env::temp_dir().join(format!("frpc-app-{}", std::process::id()));
        std::env::set_var("HOME", &dir);
        let rs = vec![RemoteTarget {
            name: "Mac Mini".into(),
            host: "192.168.3.10".into(),
            port: 7400,
            user: "admin".into(),
            password: "pw".into(),
            os: "macos".into(),
        }, RemoteTarget {
            name: "win-box".into(),
            host: "192.168.3.11".into(),
            port: 7400,
            user: "admin".into(),
            password: "pw2".into(),
            os: String::new(),
        }];
        save_remotes(&rs).unwrap();
        let got = load_remotes().unwrap();
        assert_eq!(got, rs);
        // [[local]] 与 [[remote]] 共存，互不覆盖（两个测试若并行改 HOME 会互串，故合并为一个）
        let ls = vec![LocalSaved {
            config_path: "/tmp/a.toml".into(),
            name: "本机一".into(),
            addr: "127.0.0.1".into(),
            port: "7500".into(),
            user: "u".into(),
            password: "p".into(),
        }];
        save_locals(&ls).unwrap();
        assert_eq!(load_remotes().unwrap(), rs);
        assert_eq!(load_locals(), ls);
        save_remotes(&[]).unwrap();
        assert_eq!(load_locals(), ls);
        assert!(load_remotes().unwrap().is_empty());
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(app_config_path()).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        std::env::remove_var("HOME");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn local_console_addr_falls_back_to_loopback() {
        assert_eq!(local_console_addr(""), "127.0.0.1");
        assert_eq!(local_console_addr("0.0.0.0"), "127.0.0.1");
        assert_eq!(local_console_addr("::"), "127.0.0.1");
        assert_eq!(local_console_addr("127.0.0.1"), "127.0.0.1");
        // TEST-NET-3 不可能出现在真实网卡上
        assert_eq!(local_console_addr("203.0.113.77"), "127.0.0.1");
    }

    #[test]
    fn config_path_from_args_variants() {
        assert_eq!(
            config_path_from_args("frpc -c /etc/frpc.toml"),
            Some(PathBuf::from("/etc/frpc.toml"))
        );
        assert_eq!(
            config_path_from_args("frpc --config /x/y.toml"),
            Some(PathBuf::from("/x/y.toml"))
        );
        assert_eq!(
            config_path_from_args("frpc --config=/z.toml"),
            Some(PathBuf::from("/z.toml"))
        );
        assert_eq!(config_path_from_args("frpc check"), None);
    }

    #[test]
    #[ignore = "需要一个开了 store.path 的 frpc 实例（默认 127.0.0.1:17499），会真的增删隧道"]
    fn live_store_crud() {
        let e = Endpoint {
            base_url: env_or("FRPC_STORE_TEST_BASE", "http://127.0.0.1:17499"),
            user: env_or("FRPC_STORE_TEST_USER", "probe"),
            password: env_or("FRPC_STORE_TEST_PASS", "probe"),
        };
        let port_of = |name: &str| -> Option<String> {
            store_proxies(&e)
                .ok()
                .and_then(|l| l.into_iter().find(|c| c.name == name).map(|c| c.remote_port))
        };
        let a = "zz-store-a";
        let b = "zz-store-b";
        let _ = store_delete(&e, a);
        let _ = store_delete(&e, b);
        assert!(probe_store(&e).unwrap(), "该实例应已开启 store");

        let np = NewProxy {
            name: a.into(),
            ptype: "tcp".into(),
            local_ip: "127.0.0.1".into(),
            local_port: 8001,
            remote_port: Some(18011),
            domain: None,
        };
        store_add(&e, &np).unwrap();
        let got = store_proxies(&e)
            .unwrap()
            .into_iter()
            .find(|c| c.name == a)
            .expect("新建后应能读回");
        assert_eq!(got.ptype, "tcp");
        assert_eq!((got.local_port.as_str(), got.remote_port.as_str()), ("8001", "18011"));
        assert_eq!(port_of(a).as_deref(), Some("18011"));
        // 同名新建必须被拒（0.70 起 frpc 也不允许重名）
        assert!(store_add(&e, &np).is_err());

        store_update(&e, &NewProxy { remote_port: Some(18012), ..np.clone() }).unwrap();
        assert_eq!(port_of(a).as_deref(), Some("18012"));
        // URL 与 body 名字不一致会被拒，所以改名只能删旧建新
        assert!(store_update(&e, &NewProxy { name: b.into(), ..np.clone() }).is_err());
        let cur = store_proxies(&e).unwrap().into_iter().find(|c| c.name == a).unwrap();
        store_replace(&e, &cur, &NewProxy { name: b.into(), ..np.clone() }).unwrap();
        assert_eq!(port_of(a), None);
        assert_eq!(port_of(b).as_deref(), Some("18011"));

        store_delete(&e, b).unwrap();
        assert_eq!(port_of(b), None);
        assert!(store_delete(&e, b).is_err());

        // 没配 store.path 的 0.71 / 更早版本：探测必须是 false，走原来的文件编辑路径
        let off = Endpoint { base_url: env_or("FRPC_NOSTORE_TEST_BASE", "http://127.0.0.1:17498"), ..e };
        assert!(!probe_store(&off).unwrap());
        assert!(store_proxies(&off).is_err());
    }

    #[test]
    #[ignore = "需要本机 frpc 正在运行；只读，不会改动配置"]
    fn live_frpc_readonly() {
        let locals = discover_locals();
        assert!(!locals.is_empty(), "应至少识别到一个本机实例");
        let t = locals[0].target.clone();
        assert!(t.base_url.starts_with("http://"));
        let ps = fetch_status(&t.endpoint()).unwrap();
        assert!(!ps.is_empty(), "应有运行中的隧道");
        assert!(!frpc_pids().is_empty());
        let src = read_config_file(&t).unwrap();
        assert!(src.contains("[[proxies]]"));
        assert!(tail(&t.log_path, 5000).is_ok());

        let owners = local_port_owners();
        for l in &locals {
            println!(
                "本机实例「{}」pid={:?} managed={} api={} needCreds={}",
                l.name, l.pid, l.managed, l.target.base_url, l.need_creds
            );
        }
        for p in &ps {
            let port = p.local_addr.rsplit(':').next().and_then(|v| v.parse::<u16>().ok());
            let svc = port.and_then(|x| owners.get(&x));
            println!(
                "{} {} -> {}",
                p.name,
                p.local_addr,
                match svc {
                    Some(s) => format!("{} pid={} {}MB {}%", s.name, s.pid, s.rss_mb, s.cpu_pct),
                    None => "（未找到监听进程）".into(),
                }
            );
        }
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn local_port_owners_finds_own_listener() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let m = local_port_owners();
        let s = m.get(&port).unwrap_or_else(|| panic!("{port} 未被 lsof 找到"));
        assert_eq!(s.pid, std::process::id());
        assert!(!s.name.is_empty());
    }
}
