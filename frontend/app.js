const { invoke } = window.__TAURI__.core;

const $ = (id) => document.getElementById(id);

const state = {
  page: "tunnels",
  busy: false,
  dirty: false,
  search: "",
  status: null,
  targets: { active: "local", activeName: "本机", list: [] },
  cfg: { raw: "", basics: null, proxies: [] },
  logKind: "stdout",
  showRaw: false,
};

const PAGE_META = {
  tunnels: ["隧道管理", "管理本地服务映射并生成客户端配置"],
  config: ["配置预览", "编辑后将写入当前目标 · 本机需重启生效，远端自动热加载"],
  ai: ["AI 编排", "自然语言生成隧道配置（规划中）"],
  logs: ["日志", "查看 frpc 标准输出 / 标准错误日志"],
};

function typeCls(t) {
  return t === "tcp" || t === "http" || t === "udp" ? t : "other";
}
function typeDesc(t) {
  return t === "tcp" ? "TCP 端口映射" : t === "http" ? "HTTP 域名映射" : t === "udp" ? "UDP 转发" : "frpc 代理";
}
function esc(s) {
  return (s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
const isRemote = () => state.targets.active === "remote";

/* ---------- toast ---------- */
function toast(text, kind = "ok") {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.innerHTML = `<span class="t-mark">${kind === "err" ? "✕" : kind === "info" ? "ℹ" : "✓"}</span><span>${esc(text)}</span>`;
  $("toasts").appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 300);
  }, kind === "err" ? 6000 : 4000);
}

function setDirty(v) {
  state.dirty = v;
  const b = $("save-badge");
  b.textContent = v ? "● 未保存" : "● 已保存";
  b.className = "badge " + (v ? "stop" : "run");
}

function setBusy(b) {
  state.busy = b;
  $("busy").classList.toggle("hidden", !b);
  document.querySelectorAll(".btn").forEach((el) => (el.disabled = b));
  if (!b && state.status) renderOverview(state.status);
}

async function call(name, args) {
  setBusy(true);
  try {
    return await invoke(name, args);
  } catch (e) {
    toast(String(e), "err");
    return null;
  } finally {
    setBusy(false);
  }
}

/* ---------- navigation ---------- */
function showPage(p) {
  state.page = p;
  document.querySelectorAll(".nav-item").forEach((el) => el.classList.toggle("active", el.dataset.page === p));
  document.querySelectorAll(".page").forEach((el) => el.classList.toggle("show", el.id === "page-" + p));
  document.querySelectorAll(".ha").forEach((el) => (el.style.display = "none"));
  const ha = document.querySelector(".ha-" + p);
  if (ha) ha.style.display = "";
  $("page-title").textContent = PAGE_META[p][0];
  $("page-sub").textContent = PAGE_META[p][1];
  if (p === "tunnels") renderTunnels();
  if (p === "config") { renderConfig(); renderTargets(); }
  if (p === "logs") loadLog();
}

document.querySelectorAll(".nav-item").forEach((el) =>
  el.addEventListener("click", () => showPage(el.dataset.page))
);
$("btn-new").addEventListener("click", () => showPage("config"));

/* ---------- targets ---------- */
async function loadTargets() {
  const t = await call("get_targets");
  if (t) {
    state.targets = t;
    renderTargetList();
  }
}

function renderTargetList() {
  const { active, list } = state.targets;
  $("target-list").innerHTML = list
    .map((x) => {
      const isActive = (x.kind === "local" && active === "local") || (x.kind === "remote" && active === "remote" && x.name === state.targets.activeName);
      return `<div class="tg-item ${isActive ? "active" : ""}" data-kind="${x.kind}" data-name="${esc(x.name)}">
        <span class="tg-dot"></span>
        <span class="tg-name">${esc(x.name)}</span>
        <span class="tg-host">${esc(x.host)}</span>
      </div>`;
    })
    .join("");
  document.querySelectorAll("#target-list .tg-item").forEach((el) =>
    el.addEventListener("click", async () => {
      const { kind, name } = el.dataset;
      if ((kind === "local" && !isRemote()) || (kind === "remote" && state.targets.activeName === name)) return;
      const note = await call("set_target", { kind, name });
      if (note) {
        toast(note);
        await loadTargets();
        await refreshStatus();
        await loadConfig();
        setDirty(false);
        applyMode();
      }
    })
  );
}

function applyMode() {
  const remote = isRemote();
  $("proc-btns").classList.toggle("hidden", remote);
  document.querySelector("#card-proc .remote-only").classList.toggle("hidden", !remote);
  $("btn-apply").textContent = remote ? "保存并热加载" : "保存并重启 frpc";
  $("btn-save").title = remote ? "保存到远端并热加载" : "写入本机 frpc.toml（不重启）";
  $("log-local").classList.toggle("hidden", remote);
  $("log-remote").classList.toggle("hidden", !remote);
  $("log-box").classList.toggle("hidden", remote);
}

$("btn-add-target").addEventListener("click", async () => {
  const args = {
    name: $("t-name").value.trim(),
    host: $("t-host").value.trim(),
    port: $("t-port").value.trim() || "7400",
    user: $("t-user").value.trim(),
    password: $("t-pass").value,
  };
  if (!args.name || !args.host) { toast("名称和主机必填", "err"); return; }
  const note = await call("add_target", args);
  if (note) {
    toast(note);
    ["t-name", "t-host", "t-port", "t-user", "t-pass"].forEach((i) => ($(i).value = ""));
    await loadTargets();
    renderTargets();
  }
});

async function removeTarget(name) {
  const note = await call("remove_target", { name });
  if (note) {
    toast(note, "info");
    await loadTargets();
    await refreshStatus();
    await loadConfig();
    renderTargets();
    applyMode();
  }
}

function renderTargets() {
  $("target-rows").innerHTML = state.targets.list
    .filter((x) => x.kind === "remote")
    .map(
      (x) => `<div class="crow">
        <span style="width:150px"><b>${esc(x.name)}</b></span>
        <span class="flex1">${esc(x.host)}:${x.port}</span>
        <button class="btn danger sm" data-name="${esc(x.name)}" style="width:60px">移除</button>
      </div>`
    )
    .join("") || `<div class="hint" style="padding:6px 2px">暂无远端目标，添加后会出现在左侧「管理目标」</div>`;
  document.querySelectorAll("#target-rows .btn").forEach((el) =>
    el.addEventListener("click", () => removeTarget(el.dataset.name))
  );
}

/* ---------- status rendering ---------- */
async function refreshStatus() {
  try {
    state.status = await invoke("get_status");
  } catch (e) {
    toast(`状态获取失败：${e}`, "err");
    return;
  }
  const s = state.status;
  const side = $("side-status");
  side.textContent = s.running
    ? `● ${esc(s.targetName)} · frpc 运行中${s.mode === "local" ? " · PID " + s.pid : ""}`
    : `● ${esc(s.targetName)} · frpc 不可达`;
  side.classList.toggle("off", !s.running);
  $("chip-target").textContent = `目标：${s.targetName}`;
  renderTunnels();
  if (state.page === "config") renderOverview(s);
}

function renderOverview(s) {
  if (!s) return;
  const run = $("st-run");
  run.textContent = s.running ? "● 运行中" : "● 不可达";
  run.className = "stat-value " + (s.running ? "ok" : "bad");
  $("st-pid").textContent = s.mode === "local" && s.running ? s.pid : "—";
  $("st-cnt").textContent = `${s.runningCount} / ${s.proxyCount}`;
  const api = $("st-api");
  api.textContent = s.apiReachable ? "● 可达" : "● 不可达";
  api.className = "stat-value " + (s.apiReachable ? "ok" : "bad");
  $("i-server").textContent = `${s.serverAddr}:${s.serverPort}`;
  $("i-web").textContent = s.webUrl;
  $("i-cfg").textContent = s.configPath || "远端（通过 API 读写）";
  $("btn-start").disabled = s.running || state.busy;
  $("btn-stop").disabled = !s.running || state.busy;
}

/* ---------- tunnels ---------- */
function filteredProxies() {
  const s = state.status;
  if (!s) return [];
  const q = state.search.trim().toLowerCase();
  if (!q) return s.proxies;
  return s.proxies.filter(
    (p) =>
      p.name.toLowerCase().includes(q) ||
      p.localAddr.toLowerCase().includes(q) ||
      p.remoteAddr.toLowerCase().includes(q)
  );
}

function renderTunnels() {
  const rows = filteredProxies();
  const s = state.status;
  $("tunnel-empty").classList.toggle("hidden", rows.length > 0);
  if (s) {
    const chip = $("chip-run");
    chip.textContent = s.running ? "● 运行中" : "● 不可达";
    chip.className = "chip " + (s.running ? "ok" : "bad");
    $("chip-cnt").textContent = `隧道 ${s.runningCount} / ${s.proxyCount}`;
  }
  const box = $("tunnel-rows");
  box.innerHTML = rows
    .map((p) => {
      const tc = typeCls(p.ptype);
      const running = p.status === "running";
      return `<div class="trow">
        <div class="col-name">
          <div class="t-ico ico ${tc}">${esc((p.name[0] || "?").toUpperCase())}</div>
          <div class="t-name"><b>${esc(p.name)}</b><i class="${p.err ? "err" : ""}">${p.err ? "存在错误" : esc(typeDesc(p.ptype))}</i></div>
        </div>
        <span class="col-type"><span class="badge ${tc}">${esc(p.ptype.toUpperCase())}</span></span>
        <span class="col-local">${esc(p.localAddr || "—")}</span>
        <span class="col-remote">${esc(p.remoteAddr || "—")}</span>
        <span class="col-status"><span class="badge ${running ? "run" : "stop"}">● ${running ? "运行中" : esc(p.status)}</span></span>
        <span class="col-err" title="${esc(p.err)}">${esc(p.err)}</span>
        <span class="col-edit"><button class="btn icon edit" data-name="${esc(p.name)}" title="到配置页编辑">✎</button></span>
      </div>`;
    })
    .join("");
  box.querySelectorAll(".edit").forEach((el) =>
    el.addEventListener("click", () => {
      showPage("config");
      toast(`编辑「${el.dataset.name}」：在隧道列表中删除，或用「新增隧道」重建`, "info");
    })
  );
}

$("search").addEventListener("input", (e) => {
  state.search = e.target.value;
  renderTunnels();
});

/* ---------- save ---------- */
["c-addr", "c-port", "c-token", "c-web-addr", "c-web-port", "c-web-user", "c-web-pass"].forEach((id) =>
  $(id).addEventListener("input", () => setDirty(true))
);

async function saveCfg(withRestart) {
  const note = await call("save_config_cmd", { basics: basicsFromForm(), withRestart });
  if (note) {
    toast(note);
    setDirty(false);
    await loadConfig();
    await refreshStatus();
  }
}
$("btn-save").addEventListener("click", () => saveCfg(false));
$("btn-apply").addEventListener("click", () => saveCfg(isRemote() ? false : true));

/* ---------- config ---------- */
async function loadConfig() {
  const cfg = await call("get_config");
  if (cfg) {
    state.cfg = cfg;
    renderConfig();
  }
}

function renderConfig() {
  const c = state.cfg;
  $("cfg-cnt").textContent = c.proxies.length;
  $("cfg-rows").innerHTML = c.proxies
    .map((p) => {
      const tc = typeCls(p.ptype);
      return `<div class="crow">
        <span style="width:150px"><b>${esc(p.name)}</b></span>
        <span class="type ${tc}" style="width:56px">${esc(p.ptype)}</span>
        <span style="width:150px">${esc(p.localIp)}:${esc(p.localPort)}</span>
        <span style="width:86px">${esc(p.remotePort || "-")}</span>
        <span class="flex1">${esc(p.domains || "-")}</span>
        <button class="btn danger sm" data-name="${esc(p.name)}" style="width:60px">删除</button>
      </div>`;
    })
    .join("");
  document.querySelectorAll("#cfg-rows .btn").forEach((el) =>
    el.addEventListener("click", async () => {
      await call("remove_proxy_cmd", { name: el.dataset.name });
      await loadConfig();
      setDirty(true);
      toast("已从暂存移除，点保存生效", "info");
    })
  );
  const b = c.basics || {};
  $("c-addr").value = b.serverAddr ?? "";
  $("c-port").value = b.serverPort ?? "";
  $("c-token").value = b.token ?? "";
  $("c-web-addr").value = b.webAddr ?? "";
  $("c-web-port").value = b.webPort ?? "";
  $("c-web-user").value = b.webUser ?? "";
  $("c-web-pass").value = b.webPass ?? "";
  if (state.showRaw) $("raw-box").textContent = c.raw;
}

function basicsFromForm() {
  return {
    serverAddr: $("c-addr").value.trim(),
    serverPort: $("c-port").value.trim(),
    token: $("c-token").value,
    webAddr: $("c-web-addr").value.trim(),
    webPort: $("c-web-port").value.trim(),
    webUser: $("c-web-user").value.trim(),
    webPass: $("c-web-pass").value,
  };
}

$("btn-reload").addEventListener("click", async () => {
  await call("reload_config");
  await loadConfig();
  setDirty(false);
  toast("已重新加载当前目标的配置");
});
$("btn-add").addEventListener("click", async () => {
  const np = {
    name: $("n-name").value.trim(),
    ptype: $("n-type").value,
    localIp: $("n-local-ip").value.trim() || "127.0.0.1",
    localPort: $("n-local-port").value.trim(),
    remotePort: $("n-remote-port").value.trim(),
    domain: $("n-domain").value.trim(),
  };
  if (!np.name) { toast("名称不能为空", "err"); return; }
  const ok = await call("add_proxy_cmd", { np });
  if (ok !== null) {
    await loadConfig();
    setDirty(true);
    toast("已加入暂存列表，点保存生效");
    ["n-name", "n-local-port", "n-remote-port", "n-domain"].forEach((i) => ($(i).value = ""));
  }
});
$("btn-raw").addEventListener("click", () => {
  state.showRaw = !state.showRaw;
  $("raw-box").classList.toggle("hidden", !state.showRaw);
  $("btn-raw").textContent = state.showRaw ? "隐藏原始 TOML" : "查看原始 TOML";
  if (state.showRaw) $("raw-box").textContent = state.cfg.raw;
});

/* ---------- process ---------- */
async function proc(action) {
  const note = await call("proc_cmd", { action });
  if (note) { toast(note); await refreshStatus(); }
}
$("btn-start").addEventListener("click", () => proc("start"));
$("btn-restart").addEventListener("click", () => proc("restart"));
$("btn-stop").addEventListener("click", () => proc("stop"));

/* ---------- logs ---------- */
async function loadLog() {
  if (isRemote()) return;
  const text = await call("read_log", { kind: state.logKind });
  if (text !== null) {
    $("log-box").textContent = text || "（空）";
    $("log-box").scrollTop = $("log-box").scrollHeight;
  }
  $("log-out").className = "btn sm" + (state.logKind === "stdout" ? " primary" : "");
  $("log-err").className = "btn sm" + (state.logKind === "stderr" ? " primary" : "");
  $("log-path").textContent = state.logKind === "stdout" ? "/tmp/frpc.log" : "/tmp/frpc.err";
}
$("log-out").addEventListener("click", () => { state.logKind = "stdout"; loadLog(); });
$("log-err").addEventListener("click", () => { state.logKind = "stderr"; loadLog(); });
$("log-refresh").addEventListener("click", loadLog);

/* ---------- global ---------- */
$("btn-refresh").addEventListener("click", async () => {
  await refreshStatus();
  if (state.page === "config") await loadConfig();
  if (state.page === "logs") await loadLog();
});

(async function init() {
  showPage("tunnels");
  setDirty(false);
  await loadTargets();
  await refreshStatus();
  await loadConfig();
  applyMode();
  setInterval(refreshStatus, 5000);
})();
