const { invoke } = window.__TAURI__.core;

const $ = (id) => document.getElementById(id);

const state = {
  page: "tunnels",
  busy: false,
  dirty: false,
  search: "",
  status: null,
  targets: { active: "local", activeId: "", activeName: "", list: [] },
  cfg: { raw: "", basics: null, proxies: [] },
  logKind: "stdout",
  showRaw: false,
  expandLocal: "",
  promptedCreds: false,
};

const PAGE_META = {
  tunnels: ["隧道管理", "查看隧道与本机进程 · 直接增删映射"],
  config: ["配置预览", "只编辑服务端与控制台参数 · 本机重启生效，远端热加载"],
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
function activeTarget() {
  return state.targets.list.find((x) => x.id === state.targets.activeId) || null;
}
const OS_GLYPH = { macos: "", windows: "⊞", linux: "🐧" };

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
  // 未保存 → 「保存」按钮高亮提醒（「保存并生效」始终是主按钮）
  const b = $("btn-save");
  if (b) {
    b.classList.toggle("primary", v);
    b.title = v ? "有未保存的修改，点击写入当前目标" : "已是最新";
  }
}

function setBusy(b) {
  state.busy = b;
  document.querySelectorAll(".btn").forEach((el) => (el.disabled = b));
  if (!b && state.status) renderOverview(state.status);
}

/* invoke 失败时返回唯一哨兵：void 命令成功会返回 undefined/null，不能拿假值当失败 */
const FAILED = { failed: true };
const okv = (v) => v !== FAILED;

async function call(name, args) {
  setBusy(true);
  try {
    return await invoke(name, args);
  } catch (e) {
    toast(String(e), "err");
    return FAILED;
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
  if (p === "config") { renderConfig(); renderTargetTabs(); }
  if (p === "logs") loadLog();
}

document.querySelectorAll(".nav-item").forEach((el) =>
  el.addEventListener("click", () => showPage(el.dataset.page))
);
$("btn-new").addEventListener("click", openAddProxy);
$("btn-goto-tunnels").addEventListener("click", () => showPage("tunnels"));

/* ---------- targets ---------- */
async function loadTargets() {
  const t = await call("get_targets");
  if (okv(t)) {
    state.targets = t;
    renderTargetTabs();
    renderLocals();
    renderTargets();
    if (!state.promptedCreds) {
      const miss = t.list.filter((x) => x.kind === "local" && x.needCreds);
      if (miss.length) {
        state.promptedCreds = true;
        toast(`「${miss[0].name}」还缺 webServer 凭据，打开「管理目标」补全后即可读取状态`, "info");
      }
      if (!t.list.length) toast("未识别到任何目标，点「管理目标」扫描或手动添加", "info");
    }
  }
}

function tabsHtml() {
  const { activeId, list } = state.targets;
  if (!list.length) {
    return `<div class="ttab active"><span class="tt-dot off"></span><span class="tt-label">未识别到目标</span></div>`;
  }
  return list
    .map((x) => {
      const isActive = x.id === activeId;
      const dot = isActive ? (state.status && state.status.running ? "run" : "off") : "";
      const glyph = OS_GLYPH[x.os] || "";
      return `<div class="ttab ${isActive ? "active" : ""}" data-kind="${x.kind}" data-id="${esc(x.id)}" title="${esc(x.host)}${x.port ? ":" + x.port : ""}${x.kind === "local" ? " · " + esc(x.id) : ""}">
        ${glyph ? `<span class="tt-os">${glyph}</span>` : ""}<span class="tt-dot ${dot}"></span><span class="tt-label">${esc(x.name)}</span>${x.kind === "local" && !x.managed ? '<span class="tt-os">🔒</span>' : ""}
      </div>`;
    })
    .join("");
}

async function switchTarget(kind, id) {
  const note = await call("set_target", { kind, id });
  if (!okv(note)) return false;
  toast(note);
  await afterTargetChange();
  return true;
}

async function afterTargetChange() {
  await loadTargets();
  await refreshStatus();
  await loadConfig();
  setDirty(false);
  applyMode();
}

function bindTabs(el) {
  el.querySelectorAll(".ttab[data-id]").forEach((tab) =>
    tab.addEventListener("click", () => {
      const { kind, id } = tab.dataset;
      if (id === state.targets.activeId) return;
      switchTarget(kind, id);
    })
  );
}

function renderTargetTabs() {
  const html = tabsHtml();
  for (const id of ["ttabs", "ctabs"]) {
    const el = $(id);
    el.innerHTML = html;
    bindTabs(el);
  }
}

function applyMode() {
  const remote = isRemote();
  const t = activeTarget();
  const managed = !remote && t && t.managed;
  $("proc-btns").classList.toggle("hidden", !managed);
  const apply = document.querySelectorAll(".js-apply");
  apply.forEach((b) => {
    b.textContent = remote ? "保存并热加载" : managed ? "保存并重启 frpc" : "保存";
    b.disabled = state.busy;
  });
  const save = $("btn-save");
  if (save) save.title = remote ? "保存到远端并热加载" : "写入当前目标的配置文件（不重启）";
  $("log-local").classList.toggle("hidden", remote);
  $("log-remote").classList.toggle("hidden", !remote);
  $("log-box").classList.toggle("hidden", remote);
}

/* ---------- 本机实例（管理目标弹窗） ---------- */
function localBadge(x) {
  const parts = [
    x.id === state.targets.activeId ? '<span class="badge cur">当前</span>' : "",
    x.managed ? '<span class="badge mgd">托管</span>' : '<span class="badge ro">只读</span>',
    x.needCreds ? '<span class="badge warn">缺凭据</span>' : "",
    `<span class="badge ${x.pid ? "run" : "stop"}">${x.pid ? "PID " + x.pid : "未运行"}</span>`,
  ];
  return parts.join("");
}

function renderLocals() {
  const box = $("local-rows");
  const locals = state.targets.list.filter((x) => x.kind === "local");
  box.innerHTML =
    locals
      .map((x) => {
        const open = state.expandLocal === x.id;
        const need = x.needCreds;
        return `<div class="lrow ${x.id === state.targets.activeId ? "active-row" : ""}">
          <span class="l-main">
            <b>${esc(x.name)}</b>
            <i title="${esc(x.configPath)}">${esc(x.host)}:${esc(x.port)} · ${esc(x.configPath)}</i>
          </span>
          ${localBadge(x)}
          <button class="btn sm act-use" data-id="${esc(x.id)}" ${x.id === state.targets.activeId ? "disabled" : ""}>切换</button>
          <button class="btn sm act-edit" data-id="${esc(x.id)}">${open ? "收起" : need ? "补全凭据" : "编辑"}</button>
          <button class="btn sm danger act-rm" data-id="${esc(x.id)}">移除</button>
        </div>
        ${open ? editLocalForm(x) : ""}`;
      })
      .join("") ||
    `<div class="hint" style="padding:6px 2px">未识别到本机 frpc 实例。启动 frpc 后点「重新扫描本机」，或手动指定它的配置文件。</div>`;

  box.querySelectorAll(".act-use").forEach((b) =>
    b.addEventListener("click", async () => {
      if (await switchTarget("local", b.dataset.id)) closeTargets();
    })
  );
  box.querySelectorAll(".act-edit").forEach((b) =>
    b.addEventListener("click", () => {
      state.expandLocal = state.expandLocal === b.dataset.id ? "" : b.dataset.id;
      renderLocals();
    })
  );
  box.querySelectorAll(".act-rm").forEach((b) =>
    b.addEventListener("click", () => removeLocal(b.dataset.id))
  );
  box.querySelectorAll(".l-save-name").forEach((b) => b.addEventListener("click", () => saveLocalName(b.dataset.id)));
  box.querySelectorAll(".l-save-cons").forEach((b) => b.addEventListener("click", () => saveLocalConsole(b.dataset.id)));
}

function editLocalForm(x) {
  return `<div class="subform" data-form="${esc(x.id)}">
    <div class="pgrid">
      <label class="field"><span>名称</span><input class="f-name" value="${esc(x.name)}" /></label>
      <label class="field"><span>配置文件</span><input value="${esc(x.configPath)}" disabled /></label>
    </div>
    <div class="pgrid">
      <label class="field"><span>控制台 addr</span><input class="f-addr" value="${esc(x.host)}" /></label>
      <label class="field narrow"><span>port</span><input class="f-port" value="${esc(x.port)}" /></label>
      <label class="field"><span>user</span><input class="f-user" value="${esc(x.user || "")}" /></label>
      <label class="field"><span>password</span><input class="f-pass" type="password" placeholder="${x.needCreds ? "必填" : "留空保持不变"}" /></label>
    </div>
    <div class="row gap">
      <button class="btn sm l-save-name" data-id="${esc(x.id)}">保存名称</button>
      <button class="btn primary sm l-save-cons" data-id="${esc(x.id)}">保存并测试控制台</button>
    </div>
    <div class="hint">只有由 LaunchAgent 监督的实例可由本 App 启停；其余实例只做只读管理。凭据写入 ~/.config/frp-client/app.toml（0600）。</div>
  </div>`;
}

function formOf(id) {
  return document.querySelector(`.subform[data-form="${cssEscape(id)}"]`);
}
function cssEscape(s) {
  return (s ?? "").replace(/["\\]/g, "\\$&");
}

async function saveLocalName(id) {
  const f = formOf(id);
  const name = f.querySelector(".f-name").value.trim();
  const note = await call("rename_local", { id, name });
  if (okv(note)) {
    toast(note);
    await loadTargets();
  }
}

async function saveLocalConsole(id) {
  const f = formOf(id);
  const args = {
    id,
    addr: f.querySelector(".f-addr").value.trim(),
    port: f.querySelector(".f-port").value.trim(),
    user: f.querySelector(".f-user").value.trim(),
    password: f.querySelector(".f-pass").value,
  };
  const note = await call("set_local_console", args);
  if (okv(note)) {
    toast(note, note.startsWith("已保存，但") ? "info" : "ok");
    await loadTargets();
    await refreshStatus();
    applyMode();
  }
}

async function removeLocal(id) {
  const ok = await showConfirm("移除该本机实例？", "只会删除 App 里对该实例的标注；若它仍在运行或由 LaunchAgent 监督，扫描后会重新出现。", "移除");
  if (!ok) return;
  const note = await call("remove_local", { id });
  if (okv(note)) {
    toast(note, "info");
    state.expandLocal = "";
    await afterTargetChange();
    renderLocals();
  }
}

$("btn-show-add-local").addEventListener("click", () => $("add-local").classList.toggle("hidden"));
document.querySelectorAll(".js-hide-local").forEach((b) =>
  b.addEventListener("click", () => $("add-local").classList.add("hidden"))
);
$("btn-add-local").addEventListener("click", async () => {
  const args = {
    configPath: $("l-cfg").value.trim(),
    name: $("l-name").value.trim(),
    addr: $("l-addr").value.trim(),
    port: $("l-port").value.trim(),
    user: $("l-user").value.trim(),
    password: $("l-pass").value,
  };
  if (!args.configPath) {
    toast("配置文件路径不能为空", "err");
    return;
  }
  const note = await call("add_local", args);
  if (okv(note)) {
    toast(note);
    ["l-cfg", "l-name", "l-addr", "l-port", "l-user", "l-pass"].forEach((i) => ($(i).value = ""));
    $("add-local").classList.add("hidden");
    await afterTargetChange();
  }
});

$("btn-rescan").addEventListener("click", async () => {
  const note = await call("rescan_locals");
  if (okv(note)) {
    toast(note);
    await afterTargetChange();
    renderLocals();
  }
});

function openTargets() {
  $("targets-mask").classList.remove("hidden");
  renderLocals();
  renderTargets();
}
function closeTargets() {
  $("targets-mask").classList.add("hidden");
}
$("btn-manage").addEventListener("click", openTargets);
$("btn-close-targets").addEventListener("click", closeTargets);
$("targets-mask").addEventListener("click", (e) => {
  if (e.target === $("targets-mask")) closeTargets();
});

/* ---------- 远端目标 ---------- */
$("btn-add-target").addEventListener("click", async () => {
  const args = {
    name: $("t-name").value.trim(),
    host: $("t-host").value.trim(),
    port: $("t-port").value.trim() || "7400",
    user: $("t-user").value.trim(),
    password: $("t-pass").value,
    os: $("t-os").value,
  };
  if (!args.name || !args.host) {
    toast("名称和主机必填", "err");
    return;
  }
  const note = await call("add_target", args);
  if (okv(note)) {
    toast(note);
    ["t-name", "t-host", "t-port", "t-user", "t-pass"].forEach((i) => ($(i).value = ""));
    $("t-os").value = "";
    $("add-remote").classList.add("hidden");
    await afterTargetChange();
  }
});

async function removeTarget(name) {
  const ok = await showConfirm("移除远端目标？", `将从 App 中移除「${name}」及其保存的凭据，不会影响目标机上的 frpc。`, "移除");
  if (!ok) return;
  const note = await call("remove_target", { name });
  if (okv(note)) {
    toast(note, "info");
    await afterTargetChange();
  }
}

function renderTargets() {
  const osOptions = (cur) =>
    [["", "未知"], ["macos", "macOS"], ["windows", "Windows"], ["linux", "Linux"]]
      .map(([v, l]) => `<option value="${v}" ${v === cur ? "selected" : ""}>${l}</option>`)
      .join("");
  const remotes = state.targets.list.filter((x) => x.kind === "remote");
  $("target-rows").innerHTML =
    remotes
      .map(
        (x) => `<div class="crow">
        <span style="width:150px"><b>${esc(x.name)}</b></span>
        <span class="flex1">${esc(x.host)}:${x.port}</span>
        <select class="os-pick" data-name="${esc(x.name)}" style="width:86px">${osOptions(x.os || "")}</select>
        <button class="btn sm use" data-name="${esc(x.name)}" ${x.id === state.targets.activeId ? "disabled" : ""} style="width:60px">切换</button>
        <button class="btn danger sm rm" data-name="${esc(x.name)}" style="width:60px">移除</button>
      </div>`
      )
      .join("") || `<div class="hint" style="padding:6px 2px">暂无远端目标</div>`;
  document.querySelectorAll("#target-rows .use").forEach((el) =>
    el.addEventListener("click", async () => {
      if (await switchTarget("remote", el.dataset.name)) closeTargets();
    })
  );
  document.querySelectorAll("#target-rows .rm").forEach((el) =>
    el.addEventListener("click", () => removeTarget(el.dataset.name))
  );
  document.querySelectorAll("#target-rows .os-pick").forEach((el) =>
    el.addEventListener("change", async () => {
      const note = await call("set_target_os", { name: el.dataset.name, os: el.value });
      if (okv(note)) {
        toast(note);
        await loadTargets();
        renderTargets();
      }
    })
  );
}
$("btn-show-add-remote").addEventListener("click", () => $("add-remote").classList.toggle("hidden"));
document.querySelectorAll(".js-hide-remote").forEach((b) =>
  b.addEventListener("click", () => $("add-remote").classList.add("hidden"))
);

/* ---------- status rendering ---------- */
async function refreshStatus() {
  try {
    state.status = await invoke("get_status");
  } catch (e) {
    state.status = null;
    $("side-status").textContent = "● 未识别到目标";
    $("side-status").classList.add("off");
    $("tunnel-rows").innerHTML = "";
    $("ov-line").textContent = "";
    renderTargetTabs();
    toast(`状态获取失败：${e}`, "err");
    return;
  }
  const s = state.status;
  const side = $("side-status");
  side.textContent = s.running
    ? `● ${esc(s.targetName)} · frpc 运行中${s.mode === "local" ? " · PID " + s.pid : ""}`
    : `● ${esc(s.targetName)} · frpc 不可达`;
  side.classList.toggle("off", !s.running);
  const proc = $("chip-proc");
  if (s.procStats) {
    proc.textContent = `frpc 内存 ${s.procStats.rssMb}MB · CPU ${s.procStats.cpuPct}% · 运行 ${s.procStats.etime}`;
    proc.classList.remove("hidden");
  } else {
    proc.classList.add("hidden");
  }
  renderTargetTabs();
  renderTunnels();
  renderOverview(s);
  renderConfigMeta();
}

function renderOverview(s) {
  if (!s) return;
  const run = $("chip-run");
  run.textContent = s.running ? "● 运行中" : "● 不可达";
  run.className = "chip " + (s.running ? "ok" : "bad");
  $("chip-cnt").textContent = `隧道 ${s.runningCount} / ${s.proxyCount} · API ${s.apiReachable ? "可达" : "不可达"}`;
  const seg = (k, v) => (v ? `${k} <b>${esc(String(v))}</b>` : "");
  const bits = [
    seg("服务端", `${s.serverAddr}:${s.serverPort}`),
    seg("控制台", s.webUrl),
    s.mode === "local" ? seg("PID", s.running ? s.pid : "未运行") : "",
    seg("配置", s.configPath || "远端（通过 API 读写）"),
    s.mode === "local" ? seg("保存", s.savedAt) : "",
  ].filter(Boolean);
  $("ov-line").innerHTML = bits.join('<span class="sep">·</span>');
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
      p.remoteAddr.toLowerCase().includes(q) ||
      (p.domains || "").toLowerCase().includes(q)
  );
}

/* 映射地址：配了 custom domain 就优先显示域名，其余已配置的映射逐条列出 */
function remoteLines(p) {
  const doms = (p.domains || "").split(",").map((x) => x.trim()).filter(Boolean);
  const addr = (p.remoteAddr || "").trim();
  const port = (addr.match(/:(\d+)$/) || [])[1] || String(p.remotePort || "").trim();
  if (doms.length) {
    const lines = [doms[0]];
    if (port) lines.push(":" + port);
    doms.slice(1).forEach((d) => lines.push(d));
    return lines;
  }
  if (addr) return [addr];
  return port ? [":" + port] : [];
}

function renderTunnels() {
  const rows = filteredProxies();
  const s = state.status;
  const hasTarget = state.targets.list.length > 0;
  $("tunnel-empty").classList.toggle("hidden", rows.length > 0);
  if (!hasTarget) {
    $("tunnel-empty").classList.remove("hidden");
    $("tunnel-empty").innerHTML = "未识别到任何目标 · 点右上角「◫ 管理目标」扫描本机或添加远端";
  }
  if (s) renderOverview(s);
  const box = $("tunnel-rows");
  box.innerHTML = rows
    .map((p) => {
      const tc = typeCls(p.ptype);
      const running = p.status === "running";
      const svc = p.svc;
      const rlines = remoteLines(p);
      return `<div class="trow">
        <div class="col-name">
          <div class="t-ico ico ${tc}">${esc((p.name[0] || "?").toUpperCase())}</div>
          <div class="t-name"><b>${esc(p.name)}</b><i class="${p.err ? "err" : ""}">${p.err ? "存在错误" : esc(typeDesc(p.ptype))}</i></div>
        </div>
        <div class="col-local t-two">
          <span>${esc(p.localAddr || "—")}</span>
          ${svc ? `<i class="svc" title="${esc(svc.path)} · pid ${svc.pid} · CPU ${svc.cpuPct}%">${esc(svc.name)} · ${svc.rssMb}MB</i>` : ""}
        </div>
        <div class="col-remote t-two">${rlines.map((l, i) => `<span class="${i ? "r-sub" : "r-main"}">${esc(l)}</span>`).join("") || "<span>—</span>"}</div>
        <span class="col-status"><span class="badge ${running ? "run" : "stop"}">● ${running ? "运行中" : esc(p.status)}</span></span>
        <span class="col-err${p.err ? " err-link" : ""}" ${p.err ? 'title="点击查看日志排查" ' : ""}data-err="${esc(p.err)}">${esc(p.err)}</span>
        <span class="col-edit">
          <button class="btn icon edit" data-name="${esc(p.name)}" title="到配置页查看原文">✎</button>
          <button class="btn icon danger del" data-name="${esc(p.name)}" title="删除该隧道">🗑</button>
        </span>
      </div>`;
    })
    .join("");
  box.querySelectorAll(".edit").forEach((el) =>
    el.addEventListener("click", () => {
      state.showRaw = true;
      $("raw-box").classList.remove("hidden");
      $("btn-raw").textContent = "隐藏原始 TOML";
      $("raw-box").textContent = `# 目标：${state.targets.activeName}\n` + state.cfg.raw;
      showPage("config");
      toast(`「${el.dataset.name}」的原文已在下方标出，逐条编辑仍在规划中`, "info");
    })
  );
  box.querySelectorAll(".del").forEach((el) =>
    el.addEventListener("click", () => deleteProxy(el.dataset.name))
  );
  box.querySelectorAll(".err-link").forEach((el) =>
    el.addEventListener("click", () => {
      if (isRemote()) {
        toast("远端不支持查看日志，请 SSH 到目标机排查", "info");
        return;
      }
      showPage("logs");
      toast("已跳到日志页，可切换 stdout / stderr 排查该报错", "info");
    })
  );
}

async function deleteProxy(name) {
  const ok = await showConfirm("删除隧道？", `将从当前目标的配置中移除「${name}」，点「保存并生效」后落地。`, "删除");
  if (!ok) return;
  const res = await call("remove_proxy_cmd", { name });
  if (!okv(res)) return;
  await loadConfig();
  setDirty(true);
  toast(`已移除「${name}」，点「保存并生效」写入目标`, "info");
}

$("search").addEventListener("input", (e) => {
  state.search = e.target.value;
  renderTunnels();
});

/* ---------- save ---------- */
["c-addr", "c-port", "c-token", "c-web-addr", "c-web-port", "c-web-user", "c-web-pass"].forEach((id) =>
  $(id).addEventListener("input", () => setDirty(true))
);

document.querySelectorAll(".eye").forEach((btn) =>
  btn.addEventListener("click", () => {
    const inp = $(btn.dataset.for);
    const show = inp.type === "password";
    inp.type = show ? "text" : "password";
    btn.textContent = show ? "隐藏" : "显示";
  })
);

async function saveCfg(withRestart) {
  const note = await call("save_config_cmd", { basics: basicsFromForm(), withRestart });
  if (okv(note)) {
    toast(note);
    setDirty(false);
    await loadConfig();
    await refreshStatus();
  }
}
document.querySelectorAll(".js-save").forEach((b) => b.addEventListener("click", () => saveCfg(false)));
document.querySelectorAll(".js-apply").forEach((b) =>
  b.addEventListener("click", async () => {
    const remote = isRemote();
    const t = activeTarget();
    const managed = !remote && t && t.managed;
    if (!remote && !managed) {
      toast("该实例不由 App 监督，只写入配置文件，请自行重启它", "info");
    }
    if (remote || !managed) {
      await saveCfg(false);
      return;
    }
    const ok = await showConfirm(
      "保存并重启 frpc？",
      "写入配置并重启会短暂中断当前所有隧道（约 1-3 秒）。若新配置启动失败，会自动回滚到本次保存前的备份。",
      "确认重启"
    );
    if (ok) saveCfg(true);
  })
);

function showConfirm(title, body, okLabel = "确认") {
  $("confirm-title").textContent = title;
  $("confirm-body").textContent = body;
  $("confirm-ok").textContent = okLabel;
  const mask = $("confirm-mask");
  mask.classList.remove("hidden");
  return new Promise((resolve) => {
    const done = (v) => {
      mask.classList.add("hidden");
      $("confirm-ok").onclick = $("confirm-cancel").onclick = mask.onclick = null;
      resolve(v);
    };
    $("confirm-ok").onclick = () => done(true);
    $("confirm-cancel").onclick = () => done(false);
    mask.onclick = (e) => {
      if (e.target === mask) done(false);
    };
  });
}

/* ---------- config ---------- */
async function loadConfig() {
  const cfg = await call("get_config");
  if (okv(cfg)) {
    state.cfg = cfg;
    renderConfig();
  }
}

function renderConfig() {
  const c = state.cfg;
  const b = c.basics || {};
  $("c-addr").value = b.serverAddr ?? "";
  $("c-port").value = b.serverPort ?? "";
  $("c-token").value = b.token ?? "";
  $("c-web-addr").value = b.webAddr ?? "";
  $("c-web-port").value = b.webPort ?? "";
  $("c-web-user").value = b.webUser ?? "";
  $("c-web-pass").value = b.webPass ?? "";
  renderConfigMeta();
  if (state.showRaw) $("raw-box").textContent = c.raw;
}

function renderConfigMeta() {
  const s = state.status;
  const t = activeTarget();
  $("i-target").textContent = t ? `${t.name}（${t.kind === "local" ? (t.managed ? "本机 · 托管" : "本机 · 只读") : "远端"}）` : "—";
  $("i-tc").textContent = `${state.cfg.proxies.length} 条`;
  $("i-web").textContent = s ? s.webUrl : t ? `${t.host}:${t.port}` : "—";
  $("i-cfg").textContent = (s && s.configPath) || (t && t.kind === "local" ? t.configPath : "远端（通过 API 读写）");
  $("i-saved").textContent = (s && s.savedAt) || "—";
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

function openAddProxy() {
  $("proxy-mask").classList.remove("hidden");
  $("n-name").focus();
}
function closeAddProxy() {
  $("proxy-mask").classList.add("hidden");
}
$("btn-add-cancel").addEventListener("click", closeAddProxy);
$("proxy-mask").addEventListener("click", (e) => {
  if (e.target === $("proxy-mask")) closeAddProxy();
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
  if (!np.name) {
    toast("名称不能为空", "err");
    return;
  }
  const ok = await call("add_proxy_cmd", { np });
  if (okv(ok)) {
    await loadConfig();
    setDirty(true);
    closeAddProxy();
    toast("已加入暂存列表，点「保存并生效」写入目标");
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
  if (okv(note)) {
    toast(note);
    await loadTargets();
    await refreshStatus();
    applyMode();
  }
}
$("btn-start").addEventListener("click", () => proc("start"));
$("btn-restart").addEventListener("click", async () => {
  const ok = await showConfirm("重启 frpc？", "重启会短暂中断当前所有隧道（约 1-3 秒）。", "确认重启");
  if (ok) proc("restart");
});
$("btn-stop").addEventListener("click", async () => {
  const ok = await showConfirm("停止 frpc？", "停止将中断当前所有隧道，直到再次启动。", "确认停止");
  if (ok) proc("stop");
});

/* ---------- logs ---------- */
async function loadLog() {
  if (isRemote()) return;
  const s = state.status || {};
  const base = (p) => (p ? p.split("/").pop() : "");
  $("log-out").textContent = base(s.logPath) || "frpc.log";
  $("log-err").textContent = base(s.errPath) || "frpc.err";
  $("log-path").textContent = state.logKind === "stdout" ? s.logPath || "" : s.errPath || "";
  const text = await call("read_log", { kind: state.logKind });
  if (okv(text)) {
    $("log-box").textContent = text || "（空）";
    $("log-box").scrollTop = $("log-box").scrollHeight;
  }
  const out = state.logKind === "stdout";
  $("log-out").className = "btn sm" + (out ? " primary" : "");
  $("log-err").className = "btn sm" + (!out ? " primary" : "");
}
$("log-out").addEventListener("click", () => {
  state.logKind = "stdout";
  loadLog();
});
$("log-err").addEventListener("click", () => {
  state.logKind = "stderr";
  loadLog();
});
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
  renderLocals();
  setInterval(() => {
    if (document.hidden || state.busy) return;
    refreshStatus();
  }, 5000);
})();
