#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;

use backend::{
    apply_basics, check_local_console_addr, discover_locals, fetch_config, fetch_status,
    load_locals, load_remotes, local_port_owners, parse_basics, parse_proxies, probe_store,
    proc_stats, put_config, read_config_file, remove_proxy, restart, restore_config_from_backup,
    running_frpcs, save_config, save_locals, save_remotes, start, stop, store_add, store_delete,
    store_proxies, store_replace, store_update, tail, validate_host, wait_ready,
    Basics as BackendBasics, Endpoint, LocalInstance, LocalSaved, NewProxy, ProxyCfg, RemoteTarget,
};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;
use tauri::State;

#[derive(Clone, Debug, PartialEq)]
pub enum Active {
    Local(String), // 本机实例 id（= 配置文件路径）
    Remote(String), // remote 的 name
}

pub struct AppState {
    locals: Mutex<Vec<LocalInstance>>,
    remotes: Mutex<Vec<RemoteTarget>>,
    active: Mutex<Active>,
    staged: Mutex<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BasicsDto {
    server_addr: String,
    server_port: String,
    token: String,
    web_addr: String,
    web_port: String,
    web_user: String,
    web_pass: String,
}

impl BasicsDto {
    fn into_backend(self) -> BackendBasics {
        BackendBasics {
            server_addr: self.server_addr,
            server_port: self.server_port,
            token: self.token,
            web_addr: self.web_addr,
            web_port: self.web_port,
            web_user: self.web_user,
            web_pass: self.web_pass,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewProxyDto {
    name: String,
    ptype: String,
    local_ip: String,
    local_port: String,
    remote_port: String,
    domain: String,
}

impl NewProxyDto {
    fn into_backend(self) -> Result<NewProxy, String> {
        let local_port: i64 = self
            .local_port
            .trim()
            .parse()
            .map_err(|_| "localPort 必须是数字".to_string())?;
        let remote_port = if self.remote_port.trim().is_empty() {
            None
        } else {
            Some(
                self.remote_port
                    .trim()
                    .parse::<i64>()
                    .map_err(|_| "remotePort 必须是数字".to_string())?,
            )
        };
        let domain = if self.domain.trim().is_empty() {
            None
        } else {
            Some(self.domain.trim().to_string())
        };
        Ok(NewProxy {
            name: self.name.trim().to_string(),
            ptype: self.ptype,
            local_ip: self.local_ip,
            local_port,
            remote_port,
            domain,
        })
    }
}

fn local_instance(state: &AppState, id: &str) -> Result<LocalInstance, String> {
    state
        .locals
        .lock()
        .unwrap()
        .iter()
        .find(|x| x.id == id)
        .cloned()
        .ok_or_else(|| "该本机实例已不存在，请重新扫描".to_string())
}

fn active_of(state: &AppState) -> Active {
    state.active.lock().unwrap().clone()
}

/// 当前活动目标的 API 入口
fn active_endpoint(state: &AppState) -> Result<(Active, Endpoint), String> {
    let a = active_of(state);
    match &a {
        Active::Local(id) => {
            let t = local_instance(state, id)?.target;
            Ok((a, t.endpoint()))
        }
        Active::Remote(name) => {
            let rs = state.remotes.lock().unwrap();
            let r = rs
                .iter()
                .find(|r| r.name == *name)
                .ok_or_else(|| format!("远端目标 {name} 已不存在"))?;
            Ok((a, r.endpoint()))
        }
    }
}

async fn blocked<F, T: Send + 'static>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, anyhow::Error> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{e:#}"))
}

/// 从活动目标的权威源重新拉取配置原文（本机文件 / 远端 GET /api/config）
async fn pull_staged(state: &AppState) -> Result<String, String> {
    let (a, ep) = active_endpoint(state)?;
    match a {
        Active::Local(id) => {
            let t = local_instance(state, &id)?.target;
            blocked(move || read_config_file(&t)).await
        }
        Active::Remote(_) => blocked(move || fetch_config(&ep)).await,
    }
}

/// 当前目标的 frpc 是否开了 store（>=0.68 且配置了 store.path）。
/// 探测失败当作不可达直接报错——这时把隧道写进 TOML 会造出同名双份。
async fn store_capable(state: &AppState) -> Result<bool, String> {
    let (_, ep) = active_endpoint(state)?;
    match blocked(move || probe_store(&ep)).await {
        Ok(v) => Ok(v),
        Err(e) => Err(format!("探测 store 能力失败：{e}")),
    }
}

async fn store_list(ep: &Endpoint) -> Result<Vec<ProxyCfg>, String> {
    let e = ep.clone();
    blocked(move || store_proxies(&e)).await
}

/// store 与配置文件条目的合并视图：同名时 store 生效（实测 frpc 就是按这个优先级跑的）
fn merge_effective(file: Vec<ProxyCfg>, store: &[ProxyCfg]) -> Vec<(ProxyCfg, &'static str)> {
    let in_store: HashSet<&str> = store.iter().map(|p| p.name.as_str()).collect();
    let mut out: Vec<(ProxyCfg, &'static str)> =
        store.iter().cloned().map(|c| (c, "store")).collect();
    out.extend(file.into_iter().filter(|c| !in_store.contains(c.name.as_str())).map(|c| (c, "file")));
    out.sort_by(|a, b| a.0.name.cmp(&b.0.name));
    out
}

/// 活动目标的生效隧道定义 + 各自来源。非 store 目标退化为纯文件视图（与旧行为一致）。
/// 这里刻意吞掉探测错误：frpc 停着的时候配置页仍要能编辑。
async fn effective_proxies(state: &AppState) -> (Vec<(ProxyCfg, &'static str)>, bool) {
    let staged = state.staged.lock().unwrap().clone();
    let file = parse_proxies(&staged).unwrap_or_default();
    let ep = match active_endpoint(state) {
        Ok((_, ep)) => ep,
        Err(_) => return (merge_effective(file, &[]), false),
    };
    let capable = store_capable(state).await.unwrap_or(false);
    let store = if capable {
        store_list(&ep).await.unwrap_or_default()
    } else {
        Vec::new()
    };
    (merge_effective(file, &store), capable)
}

/// 本机实例的保存闸门：控制台地址必须是这台机器能绑的，且不能是别的目标的地址
fn guard_local_basics(
    state: &AppState,
    id: &str,
    b: &BackendBasics,
) -> Result<(), String> {
    check_local_console_addr(&b.web_addr).map_err(|e| format!("{e:#}"))?;
    let port = b.web_port.trim();
    let clash = |host: &str, p: &str| -> bool {
        host.eq_ignore_ascii_case(b.web_addr.trim()) && !port.is_empty() && p == port
    };
    for r in state.remotes.lock().unwrap().iter() {
        if clash(&r.host, &r.port.to_string()) {
            return Err(format!(
                "{}:{} 是远端目标「{}」的控制台地址，不能写进本机实例的配置",
                b.web_addr, b.web_port, r.name
            ));
        }
    }
    for l in state.locals.lock().unwrap().iter() {
        if l.id != id {
            let (h, p) = host_port_of(&l.target.base_url);
            if clash(&h, &p) {
                return Err(format!(
                    "{}:{} 是本机另一个实例「{}」的控制台地址，两个实例不能共用一个端口",
                    b.web_addr, b.web_port, l.name
                ));
            }
        }
    }
    Ok(())
}

fn local_os() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        _ => "linux",
    }
}

fn valid_os(s: &str) -> bool {
    matches!(s, "" | "macos" | "windows" | "linux")
}

fn host_port_of(base_url: &str) -> (String, String) {
    let rest = base_url.split("://").nth(1).unwrap_or(base_url);
    match rest.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.to_string()),
        None => (rest.to_string(), String::new()),
    }
}

/// 重新发现本机实例，并保证活动目标仍然有效
async fn rescan(state: &AppState) -> Result<(), String> {
    let list = tauri::async_runtime::spawn_blocking(discover_locals)
        .await
        .map_err(|e| e.to_string())?;
    *state.locals.lock().unwrap() = list;
    let a = active_of(state);
    let ok = match &a {
        Active::Local(id) => local_instance(state, id).is_ok(),
        Active::Remote(name) => state.remotes.lock().unwrap().iter().any(|r| &r.name == name),
    };
    if !ok {
        let next = {
            let ls = state.locals.lock().unwrap();
            ls.first().map(|x| Active::Local(x.id.clone()))
        }
        .or_else(|| {
            state
                .remotes
                .lock()
                .unwrap()
                .first()
                .map(|r| Active::Remote(r.name.clone()))
        });
        match next {
            Some(n) => {
                *state.active.lock().unwrap() = n;
                let src = pull_staged(state).await.unwrap_or_default();
                *state.staged.lock().unwrap() = src;
            }
            None => return Err("既没有本机实例也没有远端目标".into()),
        }
    }
    Ok(())
}

fn upsert_local_saved(id: &str, f: impl FnOnce(&mut LocalSaved)) -> Result<(), String> {
    let mut ls = load_locals();
    match ls.iter_mut().find(|x| x.config_path == id) {
        Some(x) => f(x),
        None => {
            let mut n = LocalSaved {
                config_path: id.to_string(),
                ..Default::default()
            };
            f(&mut n);
            ls.push(n);
        }
    }
    save_locals(&ls).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn get_targets(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let a = active_of(&state);
    let mut list = Vec::new();
    for l in state.locals.lock().unwrap().iter() {
        let (host, port) = host_port_of(&l.target.base_url);
        list.push(serde_json::json!({
            "kind": "local", "id": l.id, "name": l.name, "host": host, "port": port,
            "user": l.target.user, "os": local_os(), "managed": l.managed, "pid": l.pid,
            "needCreds": l.need_creds, "configPath": l.id,
        }));
    }
    for r in state.remotes.lock().unwrap().iter() {
        list.push(serde_json::json!({
            "kind": "remote", "id": r.name, "name": r.name, "host": r.host, "port": r.port,
            "user": r.user, "os": r.os, "managed": false, "pid": null, "needCreds": false, "configPath": "",
        }));
    }
    let (active_kind, active_id) = match &a {
        Active::Local(id) => ("local", id.clone()),
        Active::Remote(n) => ("remote", n.clone()),
    };
    let active_name = list
        .iter()
        .find(|x| x["id"].as_str() == Some(active_id.as_str()))
        .and_then(|x| x["name"].as_str())
        .unwrap_or("")
        .to_string();
    Ok(serde_json::json!({
        "active": active_kind, "activeId": active_id, "activeName": active_name, "list": list,
    }))
}

#[tauri::command]
async fn set_target(state: State<'_, AppState>, kind: String, id: String) -> Result<String, String> {
    let next = match kind.as_str() {
        "local" => {
            local_instance(&state, &id)?;
            Active::Local(id)
        }
        "remote" => {
            if !state.remotes.lock().unwrap().iter().any(|r| r.name == id) {
                return Err(format!("远端目标 {id} 不存在"));
            }
            Active::Remote(id)
        }
        other => return Err(format!("未知目标类型 {other}")),
    };
    *state.active.lock().unwrap() = next.clone();
    // 选中一台设备不该要求它活着：连不上的设备同样要被改名、补凭据或移除，
    // 所以这里照样切过去，只是暂存区清空并在提示里说明不可达。
    let (staged, warn) = match pull_staged(&state).await {
        Ok(s) => (s, ""),
        Err(_) => (String::new(), " · 目标当前不可达"),
    };
    *state.staged.lock().unwrap() = staged;
    let label = match &next {
        Active::Local(i) => local_instance(&state, i)?.name,
        Active::Remote(n) => n.clone(),
    };
    Ok(format!("已切换到目标「{label}」{warn}"))
}

/// 手动添加/更新一个本机实例（配置文件路径 + 可选的控制台凭据）
#[tauri::command]
async fn add_local(
    state: State<'_, AppState>,
    config_path: String,
    name: Option<String>,
    addr: Option<String>,
    port: Option<String>,
    user: Option<String>,
    password: Option<String>,
) -> Result<String, String> {
    let path = config_path.trim();
    if path.is_empty() {
        return Err("配置文件路径不能为空".into());
    }
    // 与探测到的实例用同一套字面路径比较，所以这里不做 canonicalize（符号链接会改写路径）
    let id = match path.strip_prefix("~/") {
        Some(rest) => format!(
            "{}/{}",
            std::env::var("HOME").unwrap_or_default(),
            rest
        ),
        None => path.to_string(),
    };
    if !std::path::Path::new(&id).is_absolute() {
        return Err("请填写绝对路径，例如 /opt/homebrew/etc/frpc/frpc.toml".into());
    }
    if !std::path::Path::new(&id).exists() {
        return Err(format!("文件不存在：{id}"));
    }
    let name = name.unwrap_or_default().trim().to_string();
    let addr = addr.unwrap_or_default().trim().to_string();
    let port = port.unwrap_or_default().trim().to_string();
    let user = user.unwrap_or_default().trim().to_string();
    let password = password.unwrap_or_default();
    if !addr.is_empty() {
        validate_host(&addr).map_err(|e| format!("{e:#}"))?;
        check_local_console_addr(&addr).map_err(|e| format!("{e:#}"))?;
    }
    upsert_local_saved(&id, |s| {
        if !name.is_empty() {
            s.name = name.clone();
        }
        if !addr.is_empty() {
            s.addr = addr.clone();
            s.port = if port.is_empty() { "7400".into() } else { port.clone() };
        }
        if !user.is_empty() {
            s.user = user.clone();
        }
        if !password.is_empty() {
            s.password = password.clone();
        }
    })?;
    rescan(&state).await?;
    let found = local_instance(&state, &id).is_ok();
    if found {
        Ok(format!("已添加本机实例 {id}"))
    } else {
        Err("添加后未能识别该实例".into())
    }
}

/// 补全/修改某个本机实例的控制台地址与凭据
#[tauri::command]
async fn set_local_console(
    state: State<'_, AppState>,
    id: String,
    addr: String,
    port: String,
    user: String,
    password: String,
) -> Result<String, String> {
    let addr = addr.trim().to_string();
    let port = if port.trim().is_empty() { "7400".to_string() } else { port.trim().to_string() };
    let user = user.trim().to_string();
    validate_host(&addr).map_err(|e| format!("{e:#}"))?;
    check_local_console_addr(&addr).map_err(|e| format!("{e:#}"))?;
    if user.is_empty() {
        return Err("webServer 用户名不能为空".into());
    }
    upsert_local_saved(&id, |s| {
        s.addr = addr.clone();
        s.port = port.clone();
        s.user = user.clone();
        if !password.is_empty() {
            s.password = password.clone();
        }
    })?;
    rescan(&state).await?;
    let inst = local_instance(&state, &id)?;
    let ep = inst.target.endpoint();
    let note = match blocked(move || fetch_status(&ep)).await {
        Ok(list) => format!("已保存，控制台可达（{} 条隧道）", list.len()),
        Err(e) => format!("已保存，但控制台仍不可达：{e}"),
    };
    if active_of(&state) == Active::Local(id.clone()) {
        let src = pull_staged(&state).await.unwrap_or_default();
        *state.staged.lock().unwrap() = src;
    }
    Ok(note)
}

#[tauri::command]
async fn rename_local(state: State<'_, AppState>, id: String, name: String) -> Result<String, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("名称不能为空".into());
    }
    local_instance(&state, &id)?;
    upsert_local_saved(&id, |s| s.name = name.clone())?;
    rescan(&state).await?;
    Ok(format!("已改名为「{name}」"))
}

#[tauri::command]
async fn remove_local(state: State<'_, AppState>, id: String) -> Result<String, String> {
    let mut ls = load_locals();
    let before = ls.len();
    ls.retain(|x| x.config_path != id);
    if ls.len() == before {
        return Err("该实例没有可移除的标注（它是由进程或 LaunchAgent 探测到的）".into());
    }
    save_locals(&ls).map_err(|e| format!("{e:#}"))?;
    rescan(&state).await?;
    if local_instance(&state, &id).is_ok() {
        return Ok("已移除标注，但该实例仍在运行或被 LaunchAgent 监督，会重新出现".to_string());
    }
    Ok("已移除本机实例标注".to_string())
}

#[tauri::command]
async fn rescan_locals(state: State<'_, AppState>) -> Result<String, String> {
    rescan(&state).await?;
    let n = state.locals.lock().unwrap().len();
    Ok(format!("已重新扫描，识别到 {n} 个本机实例"))
}

#[tauri::command]
async fn add_target(
    state: State<'_, AppState>,
    name: String,
    host: String,
    port: String,
    user: String,
    password: String,
    os: Option<String>,
) -> Result<String, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("目标名称不能为空".into());
    }
    validate_host(&host).map_err(|e| format!("{e:#}"))?;
    let port: u16 = port.trim().parse().map_err(|_| "端口必须是数字".to_string())?;
    if user.trim().is_empty() {
        return Err("webServer 用户名不能为空".into());
    }
    let os = os.unwrap_or_default();
    if !valid_os(&os) {
        return Err("机器类型不合法".into());
    }
    let r = RemoteTarget {
        name: name.clone(),
        host: host.trim().to_string(),
        port,
        user: user.trim().to_string(),
        password,
        os,
    };
    let ep = r.endpoint();
    if state
        .remotes
        .lock()
        .unwrap()
        .iter()
        .any(|x| x.name == r.name)
    {
        return Err(format!("已存在同名目标 {name}"));
    }
    blocked(move || fetch_status(&ep))
        .await
        .map_err(|e| format!("连接测试失败：{e}"))?;
    let mut rs = state.remotes.lock().unwrap();
    if rs.iter().any(|x| x.name == r.name) {
        return Err(format!("已存在同名目标 {name}"));
    }
    rs.push(r);
    save_remotes(&rs).map_err(|e| format!("{e:#}"))?;
    Ok(format!("已添加远端目标「{name}」"))
}

/// 更新一台已登记的远端设备（改名 / 换地址端口 / 轮换凭据）。
/// 先测连通再落盘：填错了不该把设备留在打不开的状态。password 留空表示沿用原密码。
#[tauri::command]
async fn update_target(
    state: State<'_, AppState>,
    original: String,
    name: String,
    host: String,
    port: String,
    user: String,
    password: String,
    os: Option<String>,
) -> Result<String, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("设备名称不能为空".into());
    }
    validate_host(&host).map_err(|e| format!("{e:#}"))?;
    let port: u16 = port.trim().parse().map_err(|_| "端口必须是数字".to_string())?;
    if user.trim().is_empty() {
        return Err("webServer 用户名不能为空".into());
    }
    let os = os.unwrap_or_default();
    if !valid_os(&os) {
        return Err("机器类型不合法".into());
    }
    let next = {
        let rs = state.remotes.lock().unwrap();
        let cur = rs
            .iter()
            .find(|r| r.name == original)
            .ok_or_else(|| format!("远端设备 {original} 不存在"))?;
        if rs.iter().any(|r| r.name == name && r.name != original) {
            return Err(format!("已存在同名设备 {name}"));
        }
        RemoteTarget {
            name: name.clone(),
            host: host.trim().to_string(),
            port,
            user: user.trim().to_string(),
            password: if password.is_empty() { cur.password.clone() } else { password },
            os,
        }
    };
    let ep = next.endpoint();
    blocked(move || fetch_status(&ep))
        .await
        .map_err(|e| format!("连接测试失败，未保存：{e}"))?;
    {
        let mut rs = state.remotes.lock().unwrap();
        let i = rs
            .iter()
            .position(|r| r.name == original)
            .ok_or_else(|| format!("远端设备 {original} 不存在"))?;
        rs[i] = next;
        save_remotes(&rs).map_err(|e| format!("{e:#}"))?;
    }
    if matches!(&*state.active.lock().unwrap(), Active::Remote(n) if n == &original) {
        *state.active.lock().unwrap() = Active::Remote(name.clone());
        if let Ok(src) = pull_staged(&state).await {
            *state.staged.lock().unwrap() = src;
        }
    }
    Ok(format!("已更新设备「{name}」"))
}

#[tauri::command]
async fn remove_target(state: State<'_, AppState>, name: String) -> Result<String, String> {
    {
        let mut rs = state.remotes.lock().unwrap();
        let before = rs.len();
        rs.retain(|r| r.name != name);
        if rs.len() == before {
            return Err(format!("远端目标 {name} 不存在"));
        }
        save_remotes(&rs).map_err(|e| format!("{e:#}"))?;
    }
    // 若活动目标正是被删的那个，rescan 会挑一个仍然存在的目标顶上
    rescan(&state).await?;
    Ok(format!("已移除远端目标「{name}」"))
}

#[tauri::command]
async fn get_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let (a, ep) = active_endpoint(&state)?;
    let inst = match &a {
        Active::Local(id) => Some(local_instance(&state, id)?),
        Active::Remote(_) => None,
    };
    let is_local = inst.is_some();
    let t = inst.as_ref().map(|x| x.target.clone());
    let inst_id = match &a {
        Active::Local(id) => id.clone(),
        Active::Remote(n) => n.clone(),
    };
    let staged = state.staged.lock().unwrap().clone();
    let ep2 = ep.clone();
    let t2 = t.clone();
    let inst_pid = inst.as_ref().and_then(|x| x.pid);
    let (status, pid, saved_at, stats, owners) = tauri::async_runtime::spawn_blocking(move || {
        let list = fetch_status(&ep2);
        let pid = t2.as_ref().and_then(|t| {
            let run = running_frpcs();
            run.iter()
                .find(|(_, p)| *p == t.config_path)
                .or_else(|| {
                    inst_pid.and_then(|want| run.iter().find(|(pid, _)| *pid == want))
                })
                .map(|(pid, _)| *pid)
        });
        let stats = pid.and_then(proc_stats);
        let owners = if t2.is_some() { local_port_owners() } else { Default::default() };
        let saved = t2
            .as_ref()
            .and_then(|t| {
                let mt = std::fs::metadata(&t.config_path).and_then(|m| m.modified()).ok()?;
                let secs = mt
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                std::process::Command::new("date")
                    .args(["-r", &secs.to_string(), "+%Y-%m-%d %H:%M:%S"])
                    .output()
                    .ok()
                    .and_then(|o| String::from_utf8(o.stdout).ok())
                    .map(|s| s.trim().to_string())
            })
            .unwrap_or_default();
        (list, pid, saved, stats, owners)
    })
    .await
    .map_err(|e| e.to_string())?;

    let (effective, store_mode) = effective_proxies(&state).await;
    let cfgs: HashMap<String, (ProxyCfg, &'static str)> = effective
        .into_iter()
        .map(|(c, src)| (c.name.clone(), (c, src)))
        .collect();
    let mut proxies = Vec::new();
    let mut api_reachable = false;
    if let Ok(list) = status {
        api_reachable = true;
        for p in list {
            let svc = p
                .local_addr
                .rsplit(':')
                .next()
                .and_then(|v| v.parse::<u16>().ok())
                .and_then(|port| owners.get(&port));
            let cfg = cfgs.get(&p.name);
            proxies.push(serde_json::json!({
                "name": p.name, "ptype": p.ptype, "status": p.status,
                "err": p.err, "localAddr": p.local_addr, "remoteAddr": p.remote_addr,
                "domains": cfg.map(|(c, _)| c.domains.clone()).unwrap_or_default(),
                "remotePort": cfg.map(|(c, _)| c.remote_port.clone()).unwrap_or_default(),
                "source": cfg.map(|(_, s)| *s).unwrap_or("file"),
                "svc": svc.map(|s| serde_json::json!({
                    "pid": s.pid, "name": s.name, "path": s.path,
                    "rssMb": s.rss_mb, "cpuPct": s.cpu_pct,
                })),
            }));
        }
    }
    let running_count = proxies
        .iter()
        .filter(|p| p.get("status").and_then(|s| s.as_str()) == Some("running"))
        .count();
    let b = parse_basics(&staged).ok();
    let log_err = inst
        .as_ref()
        .map(|i| {
            (
                i.target.log_path.display().to_string(),
                i.target.err_path.display().to_string(),
            )
        })
        .unwrap_or_default();
    Ok(serde_json::json!({
        "mode": if is_local { "local" } else { "remote" },
        "targetId": inst_id,
        "targetName": match &a {
            Active::Remote(n) => n.clone(),
            Active::Local(_) => inst.as_ref().map(|i| i.name.clone()).unwrap_or_else(|| "本机".to_string()),
        },
        "managed": inst.as_ref().map(|i| i.managed).unwrap_or(false),
        "needCreds": inst.as_ref().map(|i| i.need_creds).unwrap_or(false),
        "running": if is_local { pid.is_some() } else { api_reachable },
        "pid": pid.unwrap_or(0),
        "apiReachable": api_reachable,
        "storeMode": store_mode,
        "proxyCount": proxies.len(),
        "runningCount": running_count,
        "proxies": proxies,
        "serverAddr": b.as_ref().map(|x| x.server_addr.clone()).unwrap_or_default(),
        "serverPort": b.as_ref().map(|x| x.server_port.clone()).unwrap_or_default(),
        "webUrl": ep.base_url,
        "configPath": t.map(|t| t.config_path.display().to_string()).unwrap_or_default(),
        "logPath": log_err.0,
        "errPath": log_err.1,
        "savedAt": saved_at,
        "procStats": stats.map(|(rss_mb, cpu, etime)| serde_json::json!({ "rssMb": (rss_mb * 10.0).round() / 10.0, "cpuPct": cpu, "etime": etime })),
    }))
}

fn basics_json(b: &BackendBasics) -> serde_json::Value {
    serde_json::json!({
        "serverAddr": b.server_addr, "serverPort": b.server_port, "token": b.token,
        "webAddr": b.web_addr, "webPort": b.web_port, "webUser": b.web_user, "webPass": b.web_pass,
    })
}

#[tauri::command]
async fn get_config(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let staged = state.staged.lock().unwrap().clone();
    let (effective, store_mode) = effective_proxies(&state).await;
    let proxies: Vec<serde_json::Value> = effective
        .into_iter()
        .map(|(c, source)| {
            serde_json::json!({
                "name": c.name, "ptype": c.ptype, "localIp": c.local_ip,
                "localPort": c.local_port, "remotePort": c.remote_port,
                "domains": c.domains, "source": source,
            })
        })
        .collect();
    let basics = parse_basics(&staged).ok().as_ref().map(basics_json);
    Ok(serde_json::json!({ "raw": staged, "basics": basics, "proxies": proxies, "storeMode": store_mode }))
}

#[tauri::command]
async fn reload_config(state: State<'_, AppState>) -> Result<(), String> {
    let src = pull_staged(&state).await?;
    *state.staged.lock().unwrap() = src;
    Ok(())
}

#[tauri::command]
async fn add_proxy_cmd(state: State<'_, AppState>, np: NewProxyDto) -> Result<String, String> {
    let p = np.into_backend()?;
    let (effective, store_mode) = effective_proxies(&state).await;
    let names: Vec<String> = effective.into_iter().map(|(c, _)| c.name).collect();
    backend::validate_new(&p, &names).map_err(|e| format!("{e:#}"))?;
    if store_mode {
        let (_, ep) = active_endpoint(&state)?;
        let ep2 = ep.clone();
        let p2 = p.clone();
        blocked(move || store_add(&ep2, &p2)).await?;
        return Ok(format!("已实时新建隧道「{}」，立即生效，无需重启", p.name));
    }
    let mut staged = state.staged.lock().unwrap();
    *staged = backend::add_proxy(&staged, &p).map_err(|e| format!("{e:#}"))?;
    Ok("已加入暂存列表，点右上角的保存按钮写入目标".to_string())
}

#[tauri::command]
async fn remove_proxy_cmd(state: State<'_, AppState>, name: String) -> Result<String, String> {
    let (effective, _) = effective_proxies(&state).await;
    let shadowed = |n: &str| {
        effective
            .iter()
            .any(|(c, s)| c.name == n && *s == "file")
    };
    if effective
        .iter()
        .any(|(c, s)| c.name == name && *s == "store")
    {
        let (_, ep) = active_endpoint(&state)?;
        let ep2 = ep.clone();
        let name2 = name.clone();
        blocked(move || store_delete(&ep2, &name2)).await?;
        return Ok(if shadowed(&name) {
            format!("已实时删除「{name}」；配置文件里还有同名条目，store 撤掉后它会重新生效")
        } else {
            format!("已实时删除隧道「{name}」")
        });
    }
    let mut staged = state.staged.lock().unwrap();
    *staged = remove_proxy(&staged, &name).map_err(|e| format!("{e:#}"))?;
    Ok(format!("已从暂存配置移除「{name}」，点右上角的保存按钮写入目标"))
}

/// 改一条隧道：store 条目直接改（立即生效），文件条目仍只动暂存区
#[tauri::command]
async fn update_proxy_cmd(
    state: State<'_, AppState>,
    original: String,
    np: NewProxyDto,
) -> Result<String, String> {
    let p = np.into_backend()?;
    let (effective, _) = effective_proxies(&state).await;
    let names: Vec<String> = effective
        .iter()
        .filter(|(c, _)| c.name != original)
        .map(|(c, _)| c.name.clone())
        .collect();
    backend::validate_new(&p, &names).map_err(|e| format!("{e:#}"))?;
    let cur = effective
        .iter()
        .find(|(c, _)| c.name == original)
        .cloned()
        .ok_or_else(|| format!("未找到隧道 {original}"))?;
    if cur.1 == "store" {
        let (_, ep) = active_endpoint(&state)?;
        let ep2 = ep.clone();
        let p2 = p.clone();
        if p.name == original {
            blocked(move || store_update(&ep2, &p2)).await?;
            return Ok(format!("已实时改动隧道「{original}」，立即生效"));
        }
        let old = cur.0;
        blocked(move || store_replace(&ep2, &old, &p2)).await?;
        return Ok(format!(
            "已实时把「{original}」改名为「{}」，立即生效",
            p.name
        ));
    }
    let mut staged = state.staged.lock().unwrap();
    *staged = backend::update_proxy(&staged, &original, &p).map_err(|e| format!("{e:#}"))?;
    Ok("已改动暂存配置，点右上角的保存按钮写入目标".to_string())
}

/// 把一整篇 TOML 写入活动目标：本机走文件（可选重启 + 失败自动回滚），远端走热加载。
/// 两种入口（UI 换算出的文本、裸 TOML 编辑）共用这条路径，因此闸门按文本里解析出的
/// webServer 检查，而不是按界面提交的表单——裸编辑同样不能写出绑不了的管理接口。
async fn write_config(state: &AppState, new_src: String, with_restart: bool) -> Result<String, String> {
    let (a, ep) = active_endpoint(state)?;
    let (note, authoritative) = match a {
        Active::Local(id) => {
            let inst = local_instance(state, &id)?;
            let basics = parse_basics(&new_src).map_err(|e| format!("{e:#}"))?;
            guard_local_basics(state, &id, &basics)?;
            if with_restart && !inst.managed {
                return Err(
                    "该实例不由本 App 的 LaunchAgent 监督，只能保存配置，请自行重启它".to_string()
                );
            }
            let t = inst.target.clone();
            let new_src2 = new_src.clone();
            blocked(move || -> anyhow::Result<(String, String)> {
                let bak = save_config(&t, &new_src2)?;
                let bak_name = bak
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("?")
                    .to_string();
                let mut note = format!("已保存（备份 {bak_name}）");
                let mut src = new_src2.clone();
                if with_restart {
                    restart(&t)?;
                    if wait_ready(&t.endpoint(), Duration::from_secs(15)) {
                        note.push_str(" · frpc 已重启并就绪");
                    } else {
                        match restore_config_from_backup(&t, &bak) {
                            Ok(restored) => {
                                restart(&t)?;
                                if wait_ready(&t.endpoint(), Duration::from_secs(15)) {
                                    src = restored;
                                    note.push_str(&format!(
                                        " · 新配置启动失败，已自动回滚到 {bak_name} 并恢复运行"
                                    ));
                                } else {
                                    note.push_str(&format!(
                                        " · 新配置启动失败，已回滚 {bak_name} 但 API 仍未就绪，请查看日志"
                                    ));
                                }
                            }
                            Err(e) => note.push_str(&format!(
                                " · 已重启但 API 15s 内未就绪，且回滚失败：{e:#}"
                            )),
                        }
                    }
                } else {
                    note.push_str(" · 未重启，改动需重启后生效");
                }
                Ok((note, src))
            })
            .await?
        }
        Active::Remote(name) => {
            let new_src2 = new_src.clone();
            blocked(move || -> anyhow::Result<(String, String)> {
                put_config(&ep, &new_src2)?;
                Ok((format!("已保存到 {name} 并热加载生效"), new_src2))
            })
            .await?
        }
    };
    *state.staged.lock().unwrap() = authoritative;
    Ok(note)
}

#[tauri::command]
async fn save_raw_cmd(
    state: State<'_, AppState>,
    raw: String,
    with_restart: bool,
) -> Result<String, String> {
    write_config(&state, raw, with_restart).await
}

/// 整篇暂存配置生效（含未保存的隧道增删改）
#[tauri::command]
async fn apply_staged_cmd(
    state: State<'_, AppState>,
    with_restart: bool,
) -> Result<String, String> {
    let staged = state.staged.lock().unwrap().clone();
    write_config(&state, staged, with_restart).await
}

/// UI 表单 → TOML 文本：在 base 上覆盖基础配置，不动隧道
#[tauri::command]
fn render_raw_cmd(basics: BasicsDto, base: String) -> Result<String, String> {
    apply_basics(&base, &basics.into_backend()).map_err(|e| format!("{e:#}"))
}

/// TOML 文本 → UI 表单
#[tauri::command]
fn parse_raw_cmd(raw: String) -> Result<serde_json::Value, String> {
    let b = parse_basics(&raw).map_err(|e| format!("{e:#}"))?;
    Ok(basics_json(&b))
}

#[tauri::command]
async fn proc_cmd(state: State<'_, AppState>, action: String) -> Result<String, String> {
    let id = match active_of(&state) {
        Active::Local(id) => id,
        Active::Remote(_) => return Err("远端目标不支持进程控制，请在目标机上操作".into()),
    };
    let inst = local_instance(&state, &id)?;
    if !inst.managed {
        return Err("该实例不由本 App 的 LaunchAgent 监督，只能在配置页保存改动".into());
    }
    let t = inst.target.clone();
    let note = blocked(move || -> anyhow::Result<String> {
        match action.as_str() {
            "start" => start(&t)?,
            "stop" => stop(&t)?,
            _ => restart(&t)?,
        }
        let verb = match action.as_str() {
            "start" => "启动",
            "stop" => "停止",
            _ => "重启",
        };
        if action != "stop" {
            if wait_ready(&t.endpoint(), Duration::from_secs(15)) {
                Ok(format!("frpc 已{verb}并就绪"))
            } else {
                Ok(format!("已{verb}但 API 15s 内未就绪，查看日志"))
            }
        } else {
            Ok(format!("frpc 已{verb}"))
        }
    })
    .await?;
    Ok(note)
}

#[tauri::command]
async fn read_log(state: State<'_, AppState>, kind: String) -> Result<String, String> {
    let id = match active_of(&state) {
        Active::Local(id) => id,
        Active::Remote(_) => {
            return Err("远端目标不支持查看日志（需 SSH 到目标机查看）".into());
        }
    };
    let t = local_instance(&state, &id)?.target;
    let path = if kind == "stderr" {
        t.err_path.clone()
    } else {
        t.log_path.clone()
    };
    blocked(move || {
        if !path.exists() {
            return Ok(format!("（日志文件不存在：{}）", path.display()));
        }
        tail(&path, 64_000).map_err(|e| anyhow::anyhow!("{e}"))
    })
    .await
}

fn main() {
    let locals = discover_locals();
    let remotes = load_remotes().unwrap_or_default();
    let active = locals
        .first()
        .map(|x| Active::Local(x.id.clone()))
        .or_else(|| remotes.first().map(|r| Active::Remote(r.name.clone())))
        .unwrap_or_else(|| Active::Local(String::new()));
    let state = AppState {
        locals: Mutex::new(locals),
        remotes: Mutex::new(remotes),
        active: Mutex::new(active),
        staged: Mutex::new(String::new()),
    };
    if let Ok(src) = tauri::async_runtime::block_on(pull_staged(&state)) {
        *state.staged.lock().unwrap() = src;
    }

    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_targets,
            set_target,
            add_local,
            set_local_console,
            rename_local,
            remove_local,
            rescan_locals,
            add_target,
            update_target,
            remove_target,
            get_status,
            get_config,
            reload_config,
            add_proxy_cmd,
            update_proxy_cmd,
            remove_proxy_cmd,
            save_raw_cmd,
            apply_staged_cmd,
            render_raw_cmd,
            parse_raw_cmd,
            proc_cmd,
            read_log
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::merge_effective;
    use crate::backend::ProxyCfg;

    fn cfg(name: &str, port: &str) -> ProxyCfg {
        ProxyCfg {
            name: name.into(),
            ptype: "tcp".into(),
            local_ip: "127.0.0.1".into(),
            local_port: "8080".into(),
            remote_port: port.into(),
            domains: String::new(),
        }
    }

    #[test]
    fn store_entries_shadow_same_name_file_entries() {
        let file = vec![cfg("dup", "1000"), cfg("only-file", "1001")];
        let store = vec![cfg("dup", "2000"), cfg("only-store", "2001")];
        let merged = merge_effective(file, &store);
        let view: Vec<(&str, &str)> = merged
            .iter()
            .map(|(c, s)| (c.name.as_str(), *s))
            .collect();
        // 同名只出现一次，且以 store 里的值为准（实测 frpc 就是 store 优先）
        assert_eq!(
            view,
            vec![("dup", "store"), ("only-file", "file"), ("only-store", "store")]
        );
        assert_eq!(merged.iter().find(|(c, _)| c.name == "dup").unwrap().0.remote_port, "2000");
        // 没有 store 的目标：合并结果必须等于原来的文件视图，行为不变
        let plain = merge_effective(vec![cfg("a", "1")], &[]);
        assert_eq!(
            plain.iter().map(|(c, s)| (c.name.as_str(), *s)).collect::<Vec<_>>(),
            vec![("a", "file")]
        );
    }
}
