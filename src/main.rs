#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;

use backend::{
    apply_basics, detect_target, fetch_config, fetch_status, frpc_pid, load_remotes, parse_basics,
    parse_proxies, put_config, read_config_file, remove_proxy, restart, restore_config_from_backup,
    save_config, save_remotes, start, stop, tail, validate_host, wait_ready, Basics as BackendBasics,
    Endpoint, NewProxy, RemoteTarget, Target,
};
use serde::Deserialize;
use std::sync::Mutex;
use std::time::Duration;
use tauri::State;

#[derive(Clone, Debug, PartialEq)]
pub enum Active {
    Local,
    Remote(String), // remote 的 name
}

pub struct AppState {
    local: Option<Target>,
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

fn local_target(state: &AppState) -> Result<&Target, String> {
    state
        .local
        .as_ref()
        .ok_or_else(|| "未找到本机 frpc.toml".to_string())
}

fn active_of(state: &AppState) -> Active {
    state.active.lock().unwrap().clone()
}

/// 当前活动目标的 API 入口
fn active_endpoint(state: &AppState) -> Result<(Active, Endpoint), String> {
    let a = active_of(state);
    match &a {
        Active::Local => {
            let t = local_target(state)?;
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
        Active::Local => {
            let t = local_target(state)?.clone();
            blocked(move || read_config_file(&t)).await
        }
        Active::Remote(_) => blocked(move || fetch_config(&ep)).await,
    }
}

#[tauri::command]
async fn get_targets(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let a = active_of(&state);
    let mut list = Vec::new();
    if state.local.is_some() {
        list.push(serde_json::json!({ "kind": "local", "name": "本机", "host": "127.0.0.1" }));
    }
    let rs = state.remotes.lock().unwrap();
    for r in rs.iter() {
        list.push(serde_json::json!({
            "kind": "remote", "name": r.name, "host": r.host, "port": r.port,
        }));
    }
    let active_name = match &a {
        Active::Local => "本机".to_string(),
        Active::Remote(n) => n.clone(),
    };
    Ok(serde_json::json!({
        "active": if a == Active::Local { "local" } else { "remote" },
        "activeName": active_name,
        "list": list,
    }))
}

#[tauri::command]
async fn set_target(
    state: State<'_, AppState>,
    kind: String,
    name: String,
) -> Result<String, String> {
    let next = match kind.as_str() {
        "local" => {
            local_target(&state)?;
            Active::Local
        }
        "remote" => {
            let has = state.remotes.lock().unwrap().iter().any(|r| r.name == name);
            if !has {
                return Err(format!("远端目标 {name} 不存在"));
            }
            Active::Remote(name)
        }
        other => return Err(format!("未知目标类型 {other}")),
    };
    let prev = active_of(&state);
    *state.active.lock().unwrap() = next.clone();
    let staged = match pull_staged(&state).await {
        Ok(s) => s,
        Err(e) => {
            *state.active.lock().unwrap() = prev;
            return Err(format!("切换失败，目标不可达：{e}"));
        }
    };
    *state.staged.lock().unwrap() = staged;
    let label = match &next {
        Active::Local => "本机".to_string(),
        Active::Remote(n) => n.clone(),
    };
    Ok(format!("已切换到目标「{label}」"))
}

#[tauri::command]
async fn add_target(
    state: State<'_, AppState>,
    name: String,
    host: String,
    port: String,
    user: String,
    password: String,
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
    let r = RemoteTarget {
        name: name.clone(),
        host: host.trim().to_string(),
        port,
        user: user.trim().to_string(),
        password,
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
    if active_of(&state) == Active::Remote(name.clone()) {
        *state.active.lock().unwrap() = Active::Local;
        let staged = pull_staged(&state).await.unwrap_or_default();
        *state.staged.lock().unwrap() = staged;
    }
    Ok(format!("已移除远端目标「{name}」"))
}

#[tauri::command]
async fn get_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let (a, ep) = active_endpoint(&state)?;
    let is_local = a == Active::Local;
    let t = if is_local {
        Some(local_target(&state)?.clone())
    } else {
        None
    };
    let staged = state.staged.lock().unwrap().clone();
    let ep2 = ep.clone();
    let t2 = t.clone();
    let (status, pid, saved_at) = tauri::async_runtime::spawn_blocking(move || {
        let list = fetch_status(&ep2);
        let pid = if is_local { frpc_pid() } else { None };
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
        (list, pid, saved)
    })
    .await
    .map_err(|e| e.to_string())?;

    let mut proxies = Vec::new();
    let mut api_reachable = false;
    if let Ok(list) = status {
        api_reachable = true;
        for p in list {
            proxies.push(serde_json::json!({
                "name": p.name, "ptype": p.ptype, "status": p.status,
                "err": p.err, "localAddr": p.local_addr, "remoteAddr": p.remote_addr,
            }));
        }
    }
    let running_count = proxies
        .iter()
        .filter(|p| p.get("status").and_then(|s| s.as_str()) == Some("running"))
        .count();
    let b = parse_basics(&staged).ok();
    Ok(serde_json::json!({
        "mode": if is_local { "local" } else { "remote" },
        "targetName": match &a { Active::Remote(n) => n.clone(), Active::Local => "本机".to_string() },
        "running": if is_local { pid.is_some() } else { api_reachable },
        "pid": pid.unwrap_or(0),
        "apiReachable": api_reachable,
        "proxyCount": proxies.len(),
        "runningCount": running_count,
        "proxies": proxies,
        "serverAddr": b.as_ref().map(|x| x.server_addr.clone()).unwrap_or_default(),
        "serverPort": b.as_ref().map(|x| x.server_port.clone()).unwrap_or_default(),
        "webUrl": ep.base_url,
        "configPath": t.map(|t| t.config_path.display().to_string()).unwrap_or_default(),
        "savedAt": saved_at,
    }))
}

#[tauri::command]
async fn get_config(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let staged = state.staged.lock().unwrap().clone();
    let proxies: Vec<serde_json::Value> = parse_proxies(&staged)
        .unwrap_or_default()
        .into_iter()
        .map(|c| {
            serde_json::json!({
                "name": c.name, "ptype": c.ptype, "localIp": c.local_ip,
                "localPort": c.local_port, "remotePort": c.remote_port, "domains": c.domains,
            })
        })
        .collect();
    let basics = parse_basics(&staged).ok().map(|b| {
        serde_json::json!({
            "serverAddr": b.server_addr, "serverPort": b.server_port, "token": b.token,
            "webAddr": b.web_addr, "webPort": b.web_port, "webUser": b.web_user, "webPass": b.web_pass,
        })
    });
    Ok(serde_json::json!({ "raw": staged, "basics": basics, "proxies": proxies }))
}

#[tauri::command]
async fn reload_config(state: State<'_, AppState>) -> Result<(), String> {
    let src = pull_staged(&state).await?;
    *state.staged.lock().unwrap() = src;
    Ok(())
}

#[tauri::command]
async fn add_proxy_cmd(state: State<'_, AppState>, np: NewProxyDto) -> Result<(), String> {
    let local_port: i64 = np
        .local_port
        .parse()
        .map_err(|_| "localPort 必须是数字".to_string())?;
    let remote_port = if np.remote_port.trim().is_empty() {
        None
    } else {
        Some(
            np.remote_port
                .trim()
                .parse::<i64>()
                .map_err(|_| "remotePort 必须是数字".to_string())?,
        )
    };
    let domain = if np.domain.trim().is_empty() {
        None
    } else {
        Some(np.domain.trim().to_string())
    };
    let p = NewProxy {
        name: np.name.trim().to_string(),
        ptype: np.ptype,
        local_ip: np.local_ip,
        local_port,
        remote_port,
        domain,
    };
    let mut staged = state.staged.lock().unwrap();
    let existing: Vec<String> = parse_proxies(&staged)
        .unwrap_or_default()
        .into_iter()
        .map(|c| c.name)
        .collect();
    backend::validate_new(&p, &existing).map_err(|e| format!("{e:#}"))?;
    *staged = backend::add_proxy(&staged, &p).map_err(|e| format!("{e:#}"))?;
    Ok(())
}

#[tauri::command]
async fn remove_proxy_cmd(state: State<'_, AppState>, name: String) -> Result<(), String> {
    let mut staged = state.staged.lock().unwrap();
    *staged = remove_proxy(&staged, &name).map_err(|e| format!("{e:#}"))?;
    Ok(())
}

#[tauri::command]
async fn save_config_cmd(
    state: State<'_, AppState>,
    basics: BasicsDto,
    with_restart: bool,
) -> Result<String, String> {
    let (a, ep) = active_endpoint(&state)?;
    let staged = state.staged.lock().unwrap().clone();
    let basics = basics.into_backend();
    let new_src = apply_basics(&staged, &basics).map_err(|e| format!("{e:#}"))?;
    let (note, authoritative) = match a {
        Active::Local => {
            let t = local_target(&state)?.clone();
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
                } else if frpc_pid().is_some() {
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
async fn proc_cmd(state: State<'_, AppState>, action: String) -> Result<String, String> {
    if active_of(&state) != Active::Local {
        return Err("远端目标不支持进程控制，请在目标机上操作".into());
    }
    let t = local_target(&state)?.clone();
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
    if active_of(&state) != Active::Local {
        return Err("远端目标不支持查看日志（需 SSH 到目标机查看）".into());
    }
    let t = local_target(&state)?.clone();
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
    let local = detect_target().ok();
    let remotes = load_remotes().unwrap_or_default();
    let active = if local.is_some() {
        Active::Local
    } else if let Some(r) = remotes.first() {
        Active::Remote(r.name.clone())
    } else {
        Active::Local
    };
    let state = AppState {
        local,
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
            add_target,
            remove_target,
            get_status,
            get_config,
            reload_config,
            add_proxy_cmd,
            remove_proxy_cmd,
            save_config_cmd,
            proc_cmd,
            read_log
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
