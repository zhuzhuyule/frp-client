const { invoke } = window.__TAURI__.core;

const $ = (id) => document.getElementById(id);

const state = {
  page: "tunnels",
  busy: false,
  // dirty：暂存区里有还没写入目标的改动
  dirty: false,
  // stale：屏幕上有东西已经过期，需要点刷新
  stale: false,
  // 正在取数：页面上显示的是骨架屏，不是上一台设备的旧内容
  loading: false,
  search: "",
  status: null,
  targets: { active: "local", activeId: "", activeName: "", list: [] },
  // 每台设备的控制台连通性：{ id: { ok, bad } }，只喂页签上的点
  probe: {},
  probing: false,
  cfg: { raw: "", basics: null, proxies: [], storeMode: false },
  logKind: "stdout",
  // 日志分页：下一页（更早）的字节 offset 与是否还有更多
  logOff: 0,
  logMore: false,
  promptedCreds: false,
  storeMode: false,
  // 最近一次「检查更新」的结果：{ version, at }，只在用户点过之后才有值
  latest: null,
  editing: null,
  // 服务器设置弹窗里的草稿：raw 是唯一真相，UI 表单只是它的一个视图
  srv: { tab: "ui", raw: "", dirty: false },
  // 设备弹窗：editing 为已有设备的 id（新建时为空）
  dev: { kind: "remote", editing: "" },
  // AI 编排：profiles 是后端 [[aiModel]] 的只读视图（key 只有 hasKey），default 是点选使用的那份
  ai: { profiles: [], default: "", editing: "", drafts: [], models: [], editDraft: null },
};

const PAGE_META = {
  tunnels: ["隧道管理", "查看隧道与本机进程 · 直接增删映射"],
  config: ["配置预览", "这台设备的连接方式与它自己的配置 · 点右下角进入编辑"],
  ai: ["AI 编排", "自然语言生成隧道草案 · 逐条确认后应用到当前设备"],
  logs: ["日志", "查看 frpc 标准输出 / 标准错误日志"],
};

function typeCls(t) {
  return t === "tcp" || t === "http" || t === "udp" ? t : "other";
}
function typeDesc(t) {
  return t === "tcp" ? "TCP 端口映射" : t === "http" ? "HTTP 域名映射" : t === "udp" ? "UDP 转发" : "frpc 代理";
}
/* 类型标签：TCP / HTTP / UDP 本身已经说明是端口映射还是域名映射，行里不再重复一句描述 */
function typeTag(t) {
  return ({ tcp: "TCP", http: "HTTP", udp: "UDP" })[t] || String(t || "其它").toUpperCase();
}
function esc(s) {
  return (s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
const isRemote = () => state.targets.active === "remote";
/* x.y.z 逐段比较，够 frp 的版本号用；段数不等时缺的按 0 */
function versionAtLeast(cur, want) {
  const nums = (s) => String(s || "").replace(/^v/, "").split(".").map((p) => parseInt(p, 10) || 0);
  const a = nums(cur);
  const b = nums(want);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return true;
}
function nowHM() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
function activeTarget() {
  return state.targets.list.find((x) => x.id === state.targets.activeId) || null;
}
const OS_GLYPH = { macos: "", windows: "⊞", linux: "🐧" };

const SVG = (d) =>
  `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICO_EDIT = SVG('<path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />');
const ICO_DEL = SVG('<path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v5M14 11v5" />');
const ICO_OK = SVG('<path d="M20 6 9 17l-5-5" />');

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

/* 有改动 / 有写入 → 提醒去点刷新；点了刷新就灭 */
function markStale() {
  state.stale = true;
  $("btn-refresh").classList.add("attn");
}
function clearStale() {
  state.stale = false;
  $("btn-refresh").classList.remove("attn");
}

function setDirty(v) {
  state.dirty = v;
  if (v) markStale();
}

/* 计数式忙碌：多步流程（换算 → 写入 → 回读）期间锁到底，步骤之间不把按钮放回去 */
let busyDepth = 0;
function setBusy(b) {
  busyDepth = Math.max(0, busyDepth + (b ? 1 : -1));
  const on = busyDepth > 0;
  if (state.busy === on) return;
  state.busy = on;
  document.querySelectorAll(".btn, .mtab").forEach((el) => (el.disabled = on));
  if (on) return;
  // 上面那句是把所有按钮强行放开，可用性真正由数据决定的几处得立刻交回给各自的渲染函数
  if (state.status) renderOverview(state.status);
  renderConfigOverview();
}

/* 把一串 invoke 包成一个不可打断的写入流程 */
async function withBusy(fn) {
  setBusy(true);
  try {
    return await fn();
  } finally {
    setBusy(false);
  }
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
  if (p === "config") { renderConfigOverview(); renderTargetTabs(); }
  if (p === "ai") renderTargetTabs();
  if (p === "logs") loadLog();
}

document.querySelectorAll(".nav-item").forEach((el) =>
  el.addEventListener("click", () => showPage(el.dataset.page))
);
$("btn-new").addEventListener("click", () => {
  if (!loadingGuard()) openAddProxy();
});

/* ---------- devices（设备 = App 要连的那台 frpc 控制台） ---------- */
async function loadTargets() {
  const t = await call("get_targets");
  if (okv(t)) {
    state.targets = t;
    renderTargetTabs();
    probeTargets();
    if (!state.promptedCreds) {
      const miss = t.list.filter((x) => x.kind === "local" && x.needCreds);
      if (miss.length) {
        state.promptedCreds = true;
        toast(`「${miss[0].name}」还缺控制台凭据，选中它后点底部「编辑设备连接」补全，之后才能读到状态`, "info");
      }
      if (!t.list.length) toast("还没有任何设备，点标签行的「＋ 新建设备」", "info");
    }
  }
}

/* 设备连通性：get_status 只看得见当前一台，页签上的点要覆盖所有设备，所以另开一条批量探活。
   走 invoke 而不是 call —— 后台探活不该上忙碌锁（会把按钮禁用两秒），也不该 toast 报错。 */
async function probeTargets() {
  if (state.probing) return;
  state.probing = true;
  try {
    const r = await invoke("probe_targets");
    if (r) {
      state.probe = r;
      renderTargetTabs();
    }
  } catch (e) {
    /* 探不到就下一轮再探，不打扰 */
  }
  state.probing = false;
}

function tabsHtml() {
  const { activeId, list } = state.targets;
  const add = `<div class="ttab tt-add" title="新建设备"><span class="tt-plus">＋</span><span class="tt-label">新建设备</span></div>`;
  if (!list.length) return add;
  return list
    .map((x) => {
      const isActive = x.id === activeId;
      const glyph = OS_GLYPH[x.os] || "";
      // 所有设备都上色，不只当前一台：绿=控制台连通、黄=连通但有隧道不在跑或报错、红=连不通
      const p = state.probe[x.id];
      const dot = !p ? "" : p.ok ? (p.bad ? "warn" : "run") : "off";
      const tip = !p ? "正在探测这台设备" : p.ok ? (p.bad ? `${p.bad} 条隧道异常` : "控制台连通，隧道正常") : "控制台连不通";
      return `<div class="ttab ${isActive ? "active" : ""}" data-kind="${x.kind}" data-id="${esc(x.id)}" title="${esc(x.host)}${x.port ? ":" + x.port : ""}${x.kind === "local" ? " · " + esc(x.id) : ""}">
        ${glyph ? `<span class="tt-os">${glyph}</span>` : ""}<span class="tt-dot ${dot}" title="${tip}"></span><span class="tt-label">${esc(x.name)}</span>
      </div>`;
    })
    .join("") + add;
}

async function switchTarget(kind, id) {
  return withBusy(async () => {
    const note = await call("set_target", { kind, id });
    if (!okv(note)) return false;
    toast(note, String(note).includes("不可达") ? "info" : "ok");
    await afterTargetChange();
    return true;
  });
}

async function afterTargetChange() {
  showSkeletons();
  await loadTargets();
  await loadConfig();
  await refreshStatus();
  setDirty(false);
  clearStale();
  applyMode();
}

function bindTabs(el) {
  el.querySelectorAll(".ttab[data-id]").forEach((tab) => {
    tab.addEventListener("click", () => {
      const { kind, id } = tab.dataset;
      if (id === state.targets.activeId) return;
      // 设备 tab 是 div，吃不到 setBusy 的 disabled，写入过程中先挡一下
      if (state.busy) {
        toast("上一步还没结束，稍等再切设备", "info");
        return;
      }
      // 点下去就先换骨架屏：set_target 也要一个来回，别让上一台设备的数据挂着
      showSkeletons();
      switchTarget(kind, id);
    });
  });
  el.querySelectorAll(".tt-add").forEach((tab) => tab.addEventListener("click", () => openDeviceModal("")));
}

function renderTargetTabs() {
  const html = tabsHtml();
  for (const id of ["ttabs", "ctabs", "atabs"]) {
    const el = $(id);
    el.innerHTML = html;
    bindTabs(el);
  }
}

function applyMode() {
  const remote = isRemote();
  // 启停接管后所有本机实例都有进程按钮，不再限 LaunchAgent 托管
  $("proc-btns").classList.toggle("hidden", remote);
  const apply = document.querySelectorAll(".js-apply");
  apply.forEach((b) => {
    b.textContent = remote ? "保存并热加载" : "保存并重启 frpc";
    b.disabled = state.busy;
  });
  $("log-local").classList.toggle("hidden", remote);
  $("log-remote").classList.toggle("hidden", !remote);
  $("log-box").classList.toggle("hidden", remote);
}

/* ---------- 设备弹窗：新建与编辑同一个表单 ---------- */
function openDeviceModal(id) {
  const x = id ? state.targets.list.find((y) => y.id === id) : null;
  state.dev = { kind: x ? x.kind : "remote", editing: x ? x.id : "" };
  $("dv-title").textContent = x ? `编辑设备连接 · ${x.name}` : "新建设备";
  $("d-name").value = x ? x.name : "";
  $("d-host").value = x ? x.host : "";
  $("d-port").value = x ? String(x.port || "") : "";
  $("d-user").value = x ? x.user || "" : "";
  $("d-pass").value = "";
  $("d-os").value = x ? x.os || "" : "";
  $("d-cfg").value = x && x.kind === "local" ? x.configPath : "";
  styleDeviceModal();
  $("device-mask").classList.remove("hidden");
  $("d-name").focus();
}

function styleDeviceModal() {
  const { kind, editing } = state.dev;
  $("dv-kind").classList.toggle("hidden", !!editing);
  document.querySelectorAll("#dv-kind .mtab").forEach((b) =>
    b.classList.toggle("active", b.dataset.kind === kind)
  );
  $("d-host-label").textContent = kind === "local" ? "本机地址" : "主机地址";
  // app.toml 里本机段用的是 addr，远端段用的是 host
  $("d-host-key").textContent = kind === "local" ? "addr" : "host";
  $("d-host").placeholder = kind === "local" ? "127.0.0.1" : "192.168.3.10";
  $("d-os-wrap").classList.toggle("hidden", kind === "local");
  // 机器类型藏起来时名称独占一行会缺半截，让它铺满
  $("d-name").closest(".field").classList.toggle("wide", kind === "local");
  $("d-cfg-wrap").classList.toggle("hidden", kind !== "local");
  $("d-cfg").disabled = !!editing;
  $("btn-dv-remove").classList.toggle("hidden", !editing);
  $("btn-dv-rescan").classList.toggle("hidden", kind !== "local");
  $("btn-dv-ok").textContent = editing ? "保存并测试" : "添加并测试";
  renderPresets();
  $("dv-hint").textContent = kind === "local"
    ? "本机实例通常由「重新扫描本机」从运行中的 frpc 进程参数里自动识别；手动填用于 App 读不到进程的情况。凭据存放在 ~/.config/frp-client/app.toml（0600）。"
    : editing
      ? "这里改的是 App 怎么连这台设备，不会动它自己的 frpc 配置；密码留空表示沿用原值。保存前会先测一次连通。"
      : "frpc 的 API 不返回系统信息，机器类型只是展示用的图标；远端可以读取状态与热加载配置，不能控制进程。";
}

function closeDeviceModal() {
  $("device-mask").classList.add("hidden");
  state.dev = { kind: "remote", editing: "" };
}

/* 地址 / 端口的常用值：内网前缀点一下接着敲主机号，已配过的设备也拿来当候选 */
function presetChips(boxId, inputId, values) {
  const seen = [];
  values.forEach((v) => v && !seen.includes(v) && seen.push(v));
  $(boxId).innerHTML = seen
    .slice(0, 6)
    .map((v) => `<button type="button" class="preset" data-target="${inputId}" data-value="${esc(v)}">${esc(v)}</button>`)
    .join("");
}

function renderPresets() {
  const { kind, editing } = state.dev;
  const others = state.targets.list.filter((x) => x.id !== editing);
  const hosts = (kind === "local" ? ["127.0.0.1"] : ["192.168.", "10.", "127.0.0.1"]).concat(others.map((x) => x.host));
  const ports = ["7400", "7500"].concat(others.map((x) => String(x.port || "")));
  presetChips("host-presets", "d-host", hosts);
  presetChips("port-presets", "d-port", ports);
  markPresets();
}

/* 本地地址 / 端口的基底值：这台设备上其它隧道已经用过的排前面
   映射端口反过来 —— 已被占用的不推荐，frps 会直接拒同名端口 */
function renderProxyPresets(exceptName) {
  const others = ((state.cfg && state.cfg.proxies) || []).filter((p) => p.name !== exceptName);
  const ips = others.map((p) => p.localIp).filter(Boolean);
  const localPorts = others.map((p) => String(p.localPort || "")).filter(Boolean);
  const taken = new Set(others.map((p) => String(p.remotePort || "")).filter(Boolean));
  const free = ["8080", "3000", "9000", "8000", "9090", "2080"].filter((v) => !taken.has(v)).slice(0, 3);
  presetChips("n-local-ip-presets", "n-local-ip", ["127.0.0.1"].concat(ips, ["192.168.", "10."]));
  presetChips("n-local-port-presets", "n-local-port", localPorts.concat(["8080", "3000", "8000"]));
  presetChips("n-remote-port-presets", "n-remote-port", free);
  markPresets();
}

/* ---------- 隧道弹窗：高级区 ----------
   键名与后端 NewProxyDto 一一对应，留空 = 不写这一项 */
const ADV_IDS = {
  encrypt: "n-enc",
  compress: "n-comp",
  bandwidth: "n-bw",
  hcType: "n-hc",
  hcInterval: "n-hc-int",
  hcFailed: "n-hc-fail",
};

function advValues() {
  const o = {};
  for (const [k, id] of Object.entries(ADV_IDS)) o[k] = $(id).value.trim();
  return o;
}

/* 没选探测方式时把两个数字框清掉并禁掉，否则提交会撞上"填了间隔就要选方式" */
function syncHc() {
  const off = !$("n-hc").value;
  ["n-hc-int", "n-hc-fail"].forEach((id) => {
    $(id).disabled = off;
    if (off) $(id).value = "";
  });
}

function styleAdv() {
  // store 表达不了显式 false（frpc 会抹成默认值），这种目标上不给"关闭"
  ["n-enc", "n-comp"].forEach((id) => {
    const off = $(id).querySelector('option[value="false"]');
    off.disabled = !!state.storeMode;
    off.textContent = state.storeMode ? "关闭（store 不支持）" : "关闭";
  });
}

function setAdv(a) {
  for (const [k, id] of Object.entries(ADV_IDS)) $(id).value = (a && a[k]) || "";
  syncHc();
  const on = Object.values(ADV_IDS).some((id) => $(id).value);
  $("proxy-adv").open = on;
  $("proxy-adv-tag").classList.toggle("hidden", !on);
}

/* 当前值正好等于某个常用值时把它标出来，一眼看出填的是不是老地址 */
function markPresets() {
  document.querySelectorAll(".mask .preset").forEach((c) =>
    c.classList.toggle("on", $(c.dataset.target).value === c.dataset.value)
  );
}

document.addEventListener("click", (e) => {
  const c = e.target.closest(".preset");
  if (!c) return;
  const input = $(c.dataset.target);
  input.value = c.dataset.value;
  input.focus();
  markPresets();
});
["d-host", "d-port", "c-port", "c-web-addr", "c-web-port", "n-local-ip", "n-local-port", "n-remote-port"].forEach((id) =>
  $(id).addEventListener("input", markPresets)
);

async function submitDevice() {
  const { kind, editing } = state.dev;
  const name = $("d-name").value.trim();
  const host = $("d-host").value.trim();
  const port = $("d-port").value.trim();
  const user = $("d-user").value.trim();
  const password = $("d-pass").value;
  if (!name) {
    toast("名称不能为空", "err");
    return;
  }
  let note;
  if (kind === "local") {
    const configPath = editing || $("d-cfg").value.trim();
    if (!configPath) {
      toast("配置文件路径不能为空", "err");
      return;
    }
    note = await call("add_local", { configPath, name, addr: host, port, user, password });
  } else {
    if (!host) {
      toast("主机地址不能为空", "err");
      return;
    }
    const args = { name, host, port: port || "7400", user, password, os: $("d-os").value };
    note = editing ? await call("update_target", { original: editing, ...args }) : await call("add_target", args);
  }
  if (!okv(note)) return;
  toast(note);
  closeDeviceModal();
  await afterTargetChange();
}

async function removeDevice() {
  const { kind, editing } = state.dev;
  if (!editing) return;
  const ok = await showConfirm(
    "移除该设备？",
    kind === "local"
      ? "只会删除 App 里对这台本机实例的标注；若它仍在运行或被 LaunchAgent 监督，重新扫描后会再出现。"
      : `将从 App 中移除「${editing}」及其存放的凭据，不会影响设备上的 frpc。`,
    "移除"
  );
  if (!ok) return;
  const note = await call(kind === "local" ? "remove_local" : "remove_target", kind === "local" ? { id: editing } : { name: editing });
  closeDeviceModal();
  if (okv(note)) {
    toast(note, "info");
    await afterTargetChange();
  }
}

$("btn-dv-ok").addEventListener("click", submitDevice);
$("btn-dv-cancel").addEventListener("click", closeDeviceModal);
$("btn-dv-close").addEventListener("click", closeDeviceModal);
$("btn-dv-remove").addEventListener("click", removeDevice);
$("device-mask").addEventListener("click", (e) => {
  if (e.target === $("device-mask")) closeDeviceModal();
});
document.querySelectorAll("#dv-kind .mtab").forEach((b) =>
  b.addEventListener("click", () => {
    state.dev.kind = b.dataset.kind;
    styleDeviceModal();
  })
);
$("btn-dv-rescan").addEventListener("click", async () => {
  const note = await call("rescan_locals");
  if (okv(note)) {
    toast(note);
    closeDeviceModal();
    await afterTargetChange();
  }
});
$("btn-edit-device").addEventListener("click", () => openDeviceModal(state.targets.activeId));
$("btn-reveal-cfg").addEventListener("click", async () => {
  const msg = await call("reveal_file", { kind: "config" });
  if (okv(msg)) toast(msg, "ok");
});

/* ---------- 骨架屏 ----------
   取数期间不要把上一台设备的内容留在屏上：先占位，数据回来由各自的渲染函数整片替换。 */
function skel(w) {
  return `<i class="sk" style="width:${w}"></i>`;
}
function showSkeletons() {
  state.loading = true;
  $("tunnel-empty").classList.add("hidden");
  for (const id of ["chip-run", "chip-cnt"]) {
    $(id).className = "chip sk";
    $(id).textContent = "";
  }
  const one = `<div class="trow skel">
      <div class="col-name"><span class="sk sk-ico"></span>
        <div class="t-name">${skel("104px")}${skel("62px")}</div></div>
      <div class="col-local t-two">${skel("88px")}${skel("56px")}</div>
      <div class="col-remote t-two">${skel("118px")}${skel("46px")}</div>
      <span class="col-status"><b class="sk sk-pill"></b></span>
      <span class="col-edit"><i class="sk sk-btn"></i><i class="sk sk-btn"></i></span>
    </div>`;
  $("tunnel-rows").innerHTML = one.repeat(4);
  $("ov-status").innerHTML = `<div class="st-line1">${skel("130px")}${skel("84px")}${skel("180px")}</div>`;
  for (const id of ["i-ep", "i-ep-user", "i-ep-run", "i-srv", "i-web-cfg", "i-tc", "i-cfg", "i-saved"]) {
    $(id).innerHTML = skel("150px");
  }
  $("ov-foot-note").textContent = "";
  // 上一台设备的用量环不留在屏上
  renderSideUsage(null);
}
/* 骨架屏期间屏上挂的还是上一台设备的数据，别让人拿它去写当前目标 */
function loadingGuard() {
  if (!state.loading) return false;
  toast("这台设备的数据还没到，稍等一下", "info");
  return true;
}

/* 状态点：控制台连得上给绿点，连不上给红点
   sub 只放本机 frpc 的运行时长；其它情况留空，侧栏不重复页签上已经有的信息 */
function renderSideStatus(name, sub, up) {
  const el = $("side-status");
  el.innerHTML = `<i class="ss-dot${up ? " on" : " off"}"></i>`
    + `<div class="ss-txt"><span class="ss-name">${esc(name)}</span>`
    + (sub ? `<span class="ss-sub">${esc(sub)}</span>` : "") + `</div>`;
}

/* ---------- 侧边栏分割线上方：本机 frpc 的 CPU / 内存占用环 ---------- */
function ring(pct, label, detail, tip) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const tone = p >= 90 ? "bad" : p >= 80 ? "warn" : "mid";
  const r = 13, c = 2 * Math.PI * r;
  const n = p >= 10 ? Math.round(p) : p >= 1 ? Math.round(p * 10) / 10 : Math.round(p * 100) / 100;
  return `<div class="gauge ${tone}" title="${esc(tip)}">
    <svg width="34" height="34" viewBox="0 0 32 32" aria-hidden="true">
      <circle class="ring-bg" cx="16" cy="16" r="${r}" />
      <circle class="ring-fg" cx="16" cy="16" r="${r}" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - p / 100)).toFixed(1)}" />
      <text class="ring-t" x="16" y="16">${n}</text>
    </svg>
    <div class="gauge-txt"><span class="gauge-k">${esc(label)}</span><span class="gauge-v">${esc(detail)}</span></div>
  </div>`;
}

function renderSideUsage(s) {
  const box = $("side-usage");
  const st = s && s.mode === "local" ? s.procStats : null;
  box.innerHTML = st
    ? ring(st.cpuPct, "CPU 占用", `${st.cpuPct}%`, "frpc 进程的 CPU 占用，100% = 跑满一个核心")
      + ring(st.memPct, "内存占用", `${st.rssMb} MB`, `frpc 常驻内存 ${st.rssMb}MB，占整机内存 ${st.memPct}%`)
    : "";
}

/* ---------- 侧边栏底部：本机 frpc 的版本 + 检查更新 ---------- */
/* frpc 的 webServer 没有任何版本端点（实测只有 status/config/reload/stop/store），
   所以版本只能问本机二进制；远端读不到就整行不显示，不做手填、不加新通道。 */
function renderSideMetrics(s) {
  const box = $("side-metrics");
  const st = s && s.mode === "local" ? s.procStats : null;
  const ver = st && st.binVersion;
  if (!ver) {
    box.innerHTML = "";
    return;
  }
  const L = state.latest;
  const updatable = !!(L && !versionAtLeast(ver, L.version));
  let tip = !L ? "联网查 GitHub 上的最新版"
    : updatable ? `可更新到 ${L.version} · ${L.at} 检查过`
    : `${L.at} 检查过，已是最新`;
  if (st.upgraded) tip = "磁盘上的二进制已更新，重启 frpc 后才生效";
  box.innerHTML = `<div class="sm-ver" title="${esc(tip)}"><span class="sm-k">frpc</span>`
    + `<span class="sm-v${updatable || st.upgraded ? " warn" : ""}">${esc(ver)}</span>`
    + `<button id="btn-update" class="btn xs ghost" title="${esc(tip)}">检查更新</button>`
    + `</div>`;
  const btn = $("btn-update");
  if (btn) btn.addEventListener("click", checkUpdate);
}

let checkingUpdate = false;
async function checkUpdate() {
  if (checkingUpdate) return;
  const st = (state.status || {}).procStats;
  checkingUpdate = true;
  const btn = $("btn-update");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "检查中…";
  }
  const r = await call("check_update", { current: (st && st.binVersion) || "" });
  checkingUpdate = false;
  if (!okv(r)) {
    renderSideMetrics(state.status);
    return;
  }
  state.latest = { version: r.version, at: nowHM() };
  toast(
    r.hasUpdate ? `frp 有新版 ${r.version}（当前 ${r.current || "未知"}）` : `已是最新 ${r.version}`,
    r.hasUpdate ? "info" : "ok"
  );
  renderSideMetrics(state.status);
}

/* ---------- status rendering ---------- */
async function refreshStatus() {
  try {
    state.status = await invoke("get_status");
  } catch (e) {
    state.status = null;
    state.loading = false;
    renderSideStatus("未识别到目标", "", false);
    $("tunnel-rows").innerHTML = "";
    renderSideMetrics(null);
    renderSideUsage(null);
    renderTargetTabs();
    renderConfigOverview();
    toast(`状态获取失败：${e}`, "err");
    return;
  }
  const s = state.status;
  state.loading = false;
  const st = s.procStats;
  // 当前这台的结果已经在 get_status 里了，先填进探活表，页签上的点不用等 probe_targets 那一轮
  state.probe[s.targetId] = {
    ok: !!s.apiReachable,
    bad: (s.proxies || []).filter((p) => p.status !== "running" || p.err).length,
  };
  // 已连上的本机只报运行时长；其它设备页签上已经有名字，这里不再重复一行字
  const sub = s.mode === "local" && s.running && st && st.etime ? fmtEtime(st.etime) : "";
  renderSideStatus(s.targetName, sub, s.apiReachable || s.running);
  renderSideMetrics(s);
  renderSideUsage(s);
  renderTargetTabs();
  renderTunnels();
  renderOverview(s);
  renderConfigOverview();
}

function renderOverview(s) {
  if (!s) return;
  state.storeMode = !!s.storeMode;
  const run = $("chip-run");
  run.textContent = s.running ? `● 运行中 · ${s.runningCount} / ${s.proxyCount} 条隧道` : "● frpc 不可达";
  run.className = "chip " + (s.running ? "ok" : "bad");
  const cnt = $("chip-cnt");
  cnt.className = "chip";
  cnt.textContent = `共 ${s.proxyCount} 条 · API ${s.apiReachable ? "可达" : "不可达"}`;
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
  // 最多两行：域名多了收进「+N 个域名」，完整列表挂在 title 上，行高不会被撑开
  if (doms.length) {
    if (doms.length > 1) return [doms[0], `+${doms.length - 1} 个域名`];
    return port ? [doms[0], ":" + port] : [doms[0]];
  }
  if (addr) return [addr];
  return port ? [":" + port] : [];
}

function renderTunnels() {
  const rows = filteredProxies();
  const s = state.status;
  const hasTarget = state.targets.list.length > 0;
  const emptyEl = $("tunnel-empty");
  emptyEl.classList.toggle("hidden", rows.length > 0);
  // 文案跟着当前状态走，别把上一次「没有设备」的话术留给「有设备但连不上」
  emptyEl.textContent = hasTarget
    ? "暂无隧道 · 管理 API 不可达或 frpc 未配置代理"
    : "未识别到任何设备 · 点标签行的「＋ 新建设备」扫描本机或登记远端";
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
          <div class="t-name"><b title="${esc(p.name)}">${esc(p.name)}</b><span class="tags"><i class="tag ${tc}" title="${esc(typeDesc(p.ptype))}">${esc(typeTag(p.ptype))}</i>${p.source === "store" ? '<i class="tag live" title="改动直接生效，不写配置文件">实时</i>' : ""}${p.err ? '<i class="tag err err-link" title="点击查看日志排查">存在错误</i>' : ""}</span></div>
        </div>
        <div class="col-local t-two">
          <span>${esc(p.localAddr || "—")}</span>
          ${svc ? `<i class="svc" title="${esc(svc.path)} · pid ${svc.pid}">${esc(svc.name)}</i>` : ""}
        </div>
        <div class="col-remote t-two" title="${esc((p.domains || "").trim() || (p.remoteAddr || "").trim())}">${rlines.map((l, i) => `<span class="${i ? "r-sub" : "r-main"}">${esc(l)}</span>`).join("") || "<span>—</span>"}</div>
        <span class="col-status"><span class="badge ${running ? "run" : "stop"}"${p.err ? ` title="${esc(p.err)}"` : ""}>● ${running ? "运行中" : esc(p.status)}</span></span>
        <span class="col-edit">
          <button class="btn icon edit" data-name="${esc(p.name)}" title="编辑该隧道">${ICO_EDIT}</button>
          <button class="btn icon danger del" data-name="${esc(p.name)}" title="删除该隧道">${ICO_DEL}</button>
        </span>
      </div>`;
    })
    .join("");
  box.querySelectorAll(".edit").forEach((el) =>
    el.addEventListener("click", () => openEditProxy(el.dataset.name))
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
  const live = isLiveEntry(name);
  const ok = await showConfirm(
    "删除隧道？",
    live
      ? `将立即从当前 frpc 中移除「${name}」并停止这条映射，无需重启。`
      : `将从暂存配置中移除「${name}」，点右上角的保存按钮后落地。`,
    "删除"
  );
  if (!ok) return;
  await withBusy(async () => {
    const res = await call("remove_proxy_cmd", { name });
    if (!okv(res)) return;
    await loadConfig();
    if (!live) setDirty(true);
    await refreshStatus();
    toast(typeof res === "string" ? res : `已移除「${name}」`, "info");
  });
}

$("search").addEventListener("input", (e) => {
  state.search = e.target.value;
  renderTunnels();
});

/* ---------- 隧道页：整篇暂存配置生效 ---------- */
async function applyStaged(withRestart) {
  await withBusy(async () => {
    const note = await call("apply_staged_cmd", { withRestart });
    if (!okv(note)) return;
    toast(note);
    setDirty(false);
    clearStale();
    await loadConfig();
    await refreshStatus();
  });
}

document.querySelectorAll(".js-apply").forEach((b) =>
  b.addEventListener("click", async () => {
    if (loadingGuard()) return;
    const remote = isRemote();
    if (!remote) {
      const ok = await showConfirm(
        "保存并重启 frpc？",
        "写入配置并重启会短暂中断当前所有隧道（约 1-3 秒）。若新配置启动失败，会自动回滚到本次保存前的备份。",
        "确认重启"
      );
      if (ok) applyStaged(true);
      return;
    }
    await applyStaged(false);
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

/* ---------- config（页面只读概览，编辑走弹窗） ---------- */
async function loadConfig() {
  const cfg = await call("get_config");
  if (okv(cfg)) {
    state.cfg = cfg;
    if (typeof cfg.storeMode === "boolean") state.storeMode = cfg.storeMode;
    if (state.srv.dirty) styleSrvFoot();
  }
}

/* tab 行下方：这一台设备当前的连接与运行事实（进程用量在侧边栏底部） */
function fmtEtime(e) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(e || "");
  if (!m) return e || "";
  const sec = +m[4] + +m[3] * 60 + (m[2] ? +m[2] * 3600 : 0) + (+m[1] || 0) * 86400;
  if (sec >= 86400) return `${Math.floor(sec / 86400)} 天 ${Math.floor((sec % 86400) / 3600)} 小时`;
  if (sec >= 3600) return `${Math.floor(sec / 3600)} 小时 ${Math.floor((sec % 3600) / 60)} 分`;
  if (sec >= 60) return `${Math.floor(sec / 60)} 分`;
  return `${sec} 秒`;
}

function statusStrip(t, s) {
  if (!t) return `<span class="faint">还没有设备，点标签行的「＋ 新建设备」</span>`;
  const local = t.kind === "local";
  const live = !!s && s.apiReachable;
  const stats = s && s.procStats;
  const rp = (s && s.proxies) || [];
  const bad = rp.filter((p) => p.status !== "running").length;
  const cell = (k, v, hot) =>
    v ? `<span class="st-in"><span class="st-k">${k}</span><span class="st-v${hot ? " hot" : ""}">${esc(String(v))}</span></span>` : "";
  const run = local
    ? stats
      ? `<span class="st-live on">FRPC 运行中${stats.etime ? " · " + fmtEtime(stats.etime) : ""}</span>`
      : `<span class="st-live${live ? " warm" : " off"}">FRPC ${live ? "进程未识别" : "未运行"}</span>`
    : "";
  return `<div class="st-line1">
      <span class="badge ${live ? "run" : "stop"}">● 控制台${live ? "连接成功" : "连接未成功"}</span>
      <span class="badge ${local && t.bootstrapped ? "mgd" : "ro"}">${local ? (t.bootstrapped ? "本机 · 托管" : "本机") : "远端"}</span>
      ${run}
      ${live ? cell("隧道", `${s.runningCount} / ${s.proxyCount}`) : ""}
      ${bad ? cell("异常", `${bad} 条`, true) : ""}
      ${live ? cell("生效", state.storeMode ? "实时（store）" : "保存后") : ""}
      ${t.needCreds ? '<span class="badge warn">缺控制台凭据</span>' : ""}
    </div>`;
}

function renderConfigOverview() {
  const t = activeTarget();
  const s = state.status;
  const b = state.cfg.basics || {};
  const px = state.cfg.proxies || [];
  $("ov-status").innerHTML = statusStrip(t, s);
  $("i-ep").textContent = t ? `${t.host}:${t.port}` : "—";
  $("i-ep-user").textContent = t ? t.user || "（未填凭据）" : "—";
  $("i-ep-run").textContent = t
    ? t.kind === "local"
      ? t.pid
        ? t.bootstrapped
          ? "运行中 · LaunchAgent 监督"
          : "运行中 · 独立进程"
        : "未运行 · 可由本 App 启动"
      : "需在目标机上操作"
    : "—";
  const hasCfg = !!state.cfg.raw;
  $("i-srv").textContent = b.serverAddr
    ? `${b.serverAddr}:${b.serverPort || ""}`
    : hasCfg
      ? "配置里没有 serverAddr"
      : "未读取到配置";
  $("i-web-cfg").textContent = b.webAddr || b.webPort
    ? `${b.webAddr || "127.0.0.1"}:${b.webPort || ""}${b.webUser ? " · " + b.webUser : ""}`
    : hasCfg
      ? "配置里没有 webServer"
      : "未读取到配置";
  const storeN = px.filter((p) => p.source === "store").length;
  $("i-tc").textContent = hasCfg
    ? `${px.length} 条` + (storeN ? ` · store ${storeN} / 文件 ${px.length - storeN}` : " · 全在配置文件")
    : "未读取到配置";
  const cfgPath = (s && s.configPath) || (t && t.kind === "local" ? t.configPath : "");
  $("i-cfg").textContent = cfgPath || "远端（通过 API 读写）";
  const revealCfg = $("btn-reveal-cfg");
  revealCfg.disabled = !cfgPath || state.busy;
  revealCfg.title = cfgPath
    ? `在 Finder 中定位 ${cfgPath}`
    : "远端设备的配置文件在它自己的机器上，这里定位不了";
  $("i-saved").textContent = (s && s.savedAt) || "—";
  $("btn-edit-device").disabled = !t || state.busy;
  const edit = $("btn-edit-server");
  edit.disabled = !t || !hasCfg || state.busy;
  edit.title = !hasCfg
    ? "读不到这台设备的配置：可能不在线，或地址与凭据不对。先点「编辑设备连接」核对"
    : "改这台 frpc 自己的配置（服务端、控制台绑定、隧道）";
  $("ov-foot-note").textContent = hasCfg
    ? ""
    : t && t.kind === "remote"
      ? "这台设备连不上，读不到它的配置；改完「编辑设备连接」后重新点它的标签"
      : "";
}

/* ---------- 服务器设置弹窗：UI 表单 ⇄ 原始 TOML ---------- */
function srvFields() {
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
function srvFillFields(b) {
  $("c-addr").value = b.serverAddr ?? "";
  $("c-port").value = b.serverPort ?? "";
  $("c-token").value = b.token ?? "";
  $("c-web-addr").value = b.webAddr ?? "";
  $("c-web-port").value = b.webPort ?? "";
  $("c-web-user").value = b.webUser ?? "";
  $("c-web-pass").value = b.webPass ?? "";
  markPresets();
}

async function openServerModal() {
  await loadConfig();
  state.srv = { tab: "ui", raw: state.cfg.raw || "", dirty: false };
  srvFillFields(state.cfg.basics || {});
  $("c-raw").value = state.srv.raw;
  const t = activeTarget();
  // 常用端口和「App 现在是怎么连这台设备的」直接给成候选，省得来回抄
  presetChips("c-port-presets", "c-port", ["7000"]);
  presetChips("c-web-addr-presets", "c-web-addr", ["127.0.0.1", t ? t.host : ""]);
  presetChips("c-web-port-presets", "c-web-port", ["7400", "7500", t ? String(t.port) : ""]);
  markPresets();
  $("srv-title").textContent = `编辑设备配置 · ${t ? t.name : ""}`;
  styleSrvTabs();
  styleSrvFoot();
  $("server-mask").classList.remove("hidden");
}

function styleSrvTabs() {
  document.querySelectorAll("#srv-tabs .mtab").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === state.srv.tab)
  );
  $("srv-ui").classList.toggle("hidden", state.srv.tab !== "ui");
  $("srv-raw").classList.toggle("hidden", state.srv.tab !== "raw");
}

/* 保存动作按设备类型给按钮：远端只能热加载，本机（托管与否）都能保存并重启 */
function styleSrvFoot() {
  const t = activeTarget();
  const remote = !t || t.kind === "remote";
  const save = $("btn-server-save");
  const apply = $("btn-server-apply");
  save.classList.toggle("hidden", remote);
  apply.classList.remove("hidden");
  apply.textContent = remote ? "保存并热加载" : "保存并重启 frpc";
  $("srv-note").textContent = remote
    ? "远端走 API 热加载，不能重启它的进程"
    : "保存＝只写文件；保存并重启会短暂中断所有隧道";
  const attn = state.srv.dirty;
  save.classList.toggle("attn", attn);
  apply.classList.toggle("attn", attn);
  $("btn-modal-reload").classList.toggle("attn", attn);
}

function setSrvDirty(v) {
  state.srv.dirty = v;
  styleSrvFoot();
}

async function switchSrvTab(to) {
  if (to === state.srv.tab) return;
  // 切换前先把两边对齐；对不齐就把人留在原页签改，避免出现两个互相矛盾的草稿
  await withBusy(async () => {
    if (to === "raw") {
      const raw = await call("render_raw_cmd", { basics: srvFields(), base: state.srv.raw });
      if (!okv(raw)) return;
      state.srv.raw = raw;
      $("c-raw").value = raw;
    } else {
      const b = await call("parse_raw_cmd", { raw: $("c-raw").value });
      if (!okv(b)) return;
      state.srv.raw = $("c-raw").value;
      srvFillFields(b);
    }
    state.srv.tab = to;
    styleSrvTabs();
  });
}

document.querySelectorAll("#srv-tabs .mtab").forEach((b) =>
  b.addEventListener("click", () => switchSrvTab(b.dataset.tab))
);
["c-addr", "c-port", "c-token", "c-web-addr", "c-web-port", "c-web-user", "c-web-pass"].forEach((id) =>
  $(id).addEventListener("input", () => setSrvDirty(true))
);
$("c-raw").addEventListener("input", () => setSrvDirty(true));

async function saveServer(withRestart) {
  const t = activeTarget();
  // 远端的「保存并热加载」不动进程；只有本机重启会短暂断流，需要确认
  if (withRestart && (!t || t.kind === "local")) {
    const ok = await showConfirm(
      "保存并重启 frpc？",
      "写入配置并重启会短暂中断这台设备上的所有隧道（约 1-3 秒）。若新配置启动失败，会自动回滚到本次保存前的备份。",
      "确认重启"
    );
    if (!ok) return;
  }
  await withBusy(async () => {
    let raw = $("c-raw").value;
    if (state.srv.tab === "ui") {
      raw = await call("render_raw_cmd", { basics: srvFields(), base: state.srv.raw });
      if (!okv(raw)) return;
    }
    const note = await call("save_raw_cmd", { raw, withRestart });
    if (!okv(note)) return;
    toast(note);
    setSrvDirty(false);
    // 整篇落盘，暂存区里等着的隧道改动也一并生效了
    setDirty(false);
    clearStale();
    await loadConfig();
    await refreshStatus();
    // 弹窗留在原地，内容换成目标上真正生效的那份
    state.srv.raw = state.cfg.raw || "";
    $("c-raw").value = state.srv.raw;
    srvFillFields(state.cfg.basics || {});
    styleSrvFoot();
  });
}

async function reloadSrvDraft() {
  if (state.srv.dirty) {
    const ok = await showConfirm("丢弃弹窗里的改动？", "将重新读取当前配置，弹窗里未保存的改动会被丢掉。", "丢弃并重读");
    if (!ok) return;
  }
  await loadConfig();
  state.srv.raw = state.cfg.raw || "";
  $("c-raw").value = state.srv.raw;
  srvFillFields(state.cfg.basics || {});
  setSrvDirty(false);
  toast("已重新读取当前配置", "info");
}

async function closeServerModal() {
  if (state.srv.dirty) {
    const ok = await showConfirm("关闭编辑？", "弹窗里的改动还没有写入目标，关闭后会被丢弃。", "丢弃改动");
    if (!ok) return;
  }
  setSrvDirty(false);
  $("server-mask").classList.add("hidden");
}

$("btn-edit-server").addEventListener("click", openServerModal);
$("btn-server-cancel").addEventListener("click", closeServerModal);
$("btn-modal-close").addEventListener("click", closeServerModal);
$("btn-modal-reload").addEventListener("click", reloadSrvDraft);
$("btn-server-save").addEventListener("click", () => saveServer(false));
$("btn-server-apply").addEventListener("click", () => saveServer(true));
$("server-mask").addEventListener("click", (e) => {
  if (e.target === $("server-mask")) closeServerModal();
});

document.querySelectorAll(".eye").forEach((btn) =>
  btn.addEventListener("click", () => {
    const inp = $(btn.dataset.for);
    const show = inp.type === "password";
    inp.type = show ? "text" : "password";
    btn.textContent = show ? "隐藏" : "显示";
  })
);

/* ---------- 隧道弹窗 ---------- */
/* 映射端口/域名两个字段跟着类型走：选完类型就知道该不该填，不用背规则 */
function syncProxyTypeHints(clearRemote) {
  const http = $("n-type").value === "http";
  const rh = $("n-remote-hint");
  rh.textContent = http ? "http 走域名访问，一般留空；需要固定端口也可以填" : "必填 · frps 对外暴露的端口";
  rh.classList.toggle("req", !http);
  $("n-remote-port").placeholder = http ? "可留空" : "必填，如 9090";
  const dh = $("n-domain-hint");
  dh.textContent = http ? "必填 · 访问入口，多个用逗号分隔" : "可留空 · tcp 仅作域名记录，frps 不按域名路由";
  dh.classList.toggle("req", http);
  if (clearRemote && http) $("n-remote-port").value = "";
}
$("n-type").addEventListener("change", () => syncProxyTypeHints(true));

function openAddProxy() {
  state.editing = null;
  $("proxy-title").textContent = "新建隧道";
  $("btn-add").textContent = state.storeMode ? "立即创建" : "加入暂存";
  $("proxy-hint").textContent = state.storeMode
    ? "该目标开了 store，新建后立即生效，无需重启"
    : "加入暂存列表后仍需点右上角的保存按钮写入当前目标";
  ["n-name", "n-local-port", "n-remote-port", "n-domain"].forEach((i) => ($(i).value = ""));
  $("n-local-ip").value = "127.0.0.1";
  $("n-type").value = "tcp";
  renderProxyPresets(null);
  syncProxyTypeHints(false);
  styleAdv();
  setAdv(null);
  $("proxy-mask").classList.remove("hidden");
  $("n-name").focus();
}

/* store 里的条目改动立即生效；配置文件里的条目仍要点一次保存按钮才落地 */
function isLiveEntry(name) {
  if (!state.storeMode) return false;
  const c = (state.cfg.proxies || []).find((x) => x.name === name);
  return !!c && c.source === "store";
}

function openEditProxy(name) {
  const c = (state.cfg.proxies || []).find((x) => x.name === name);
  if (!c) {
    toast("未在当前目标里找到该隧道", "err");
    return;
  }
  const live = isLiveEntry(name);
  state.editing = name;
  $("proxy-title").textContent = `编辑隧道 · ${name}`;
  $("btn-add").textContent = live ? "立即保存" : "保存改动";
  $("proxy-hint").textContent = live
    ? "这条隧道存在 frpc 的 store 里，保存后立即生效，无需重启"
    : "改动写入暂存后仍需点右上角的保存按钮落地到当前目标";
  $("n-name").value = c.name;
  $("n-type").value = ["tcp", "http", "udp"].includes(c.ptype) ? c.ptype : "tcp";
  $("n-local-ip").value = c.localIp || "127.0.0.1";
  $("n-local-port").value = c.localPort || "";
  $("n-remote-port").value = c.remotePort || "";
  $("n-domain").value = c.domains || "";
  renderProxyPresets(name);
  syncProxyTypeHints(false);
  styleAdv();
  setAdv(c);
  $("proxy-mask").classList.remove("hidden");
  $("n-name").focus();
}

function closeAddProxy() {
  $("proxy-mask").classList.add("hidden");
  state.editing = null;
  state.ai.editDraft = null;
}
$("btn-add-cancel").addEventListener("click", closeAddProxy);
$("n-hc").addEventListener("change", syncHc);
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
    ...advValues(),
  };
  if (!np.name) {
    toast("名称不能为空", "err");
    return;
  }
  const di = state.ai.editDraft;
  if (di !== null) {
    const d = state.ai.drafts[di];
    if (!d) {
      closeAddProxy();
      return;
    }
    await withBusy(async () => {
      Object.assign(d, np);
      d.st = "";
      d.msg = "";
      await aiApplyOne(di);
      renderAiDrafts();
      if (d.st !== "ok") {
        toast(d.msg || "应用失败，可在弹窗里继续修改", "err");
        return;
      }
      closeAddProxy();
      await loadConfig();
      if (!state.storeMode) setDirty(true);
      await refreshStatus();
      toast(typeof d.note === "string" && d.note ? d.note : "草案已应用", "ok");
    });
    return;
  }
  const editing = state.editing;
  const live = editing ? isLiveEntry(editing) : state.storeMode;
  await withBusy(async () => {
    const res = editing
      ? await call("update_proxy_cmd", { original: editing, np })
      : await call("add_proxy_cmd", { np });
    if (!okv(res)) return;
    closeAddProxy();
    await loadConfig();
    if (!live) setDirty(true);
    await refreshStatus();
    toast(typeof res === "string" ? res : live ? `已改动「${np.name}」` : "已加入暂存列表，点右上角的保存按钮写入目标");
  });
});

/* ---------- process ---------- */
async function proc(action) {
  await withBusy(async () => {
    const note = await call("proc_cmd", { action });
    if (!okv(note)) return;
    toast(note);
    await loadTargets();
    await refreshStatus();
    applyMode();
  });
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
  $("btn-reveal-log").classList.toggle("hidden", isRemote());
  if (isRemote()) return;
  const s = state.status || {};
  const base = (p) => (p ? p.split("/").pop() : "");
  // 按钮上写中文，具体文件名放 title 里悬停看
  $("log-out").title = base(s.logPath) || "frpc.log";
  $("log-err").title = base(s.errPath) || "frpc.err";
  $("log-path").textContent = state.logKind === "stdout" ? s.logPath || "" : s.errPath || "";
  const page = await call("read_log", { kind: state.logKind, offset: 0 });
  if (okv(page)) {
    state.logOff = page.next;
    state.logMore = page.hasMore;
    $("log-box").textContent = page.text || "（空）";
    $("log-box").scrollTop = $("log-box").scrollHeight;
  }
  $("log-more").classList.toggle("hidden", !state.logMore);
  const out = state.logKind === "stdout";
  $("log-out").className = "btn sm" + (out ? " primary" : "");
  $("log-err").className = "btn sm" + (!out ? " primary" : "");
}

/* 往前翻一页：新内容拼在顶部，滚动位置按增高量补偿，视口不跳 */
async function loadOlderLog() {
  if (state.busy) return;
  const box = $("log-box");
  const prevH = box.scrollHeight;
  const prevT = box.scrollTop;
  state.busy = true;
  try {
    const page = await call("read_log", { kind: state.logKind, offset: state.logOff });
    if (!okv(page)) return;
    box.textContent = (page.text || "") + box.textContent;
    state.logOff = page.next;
    state.logMore = page.hasMore;
    $("log-more").classList.toggle("hidden", !page.hasMore);
    box.scrollTop = prevT + (box.scrollHeight - prevH);
  } finally {
    state.busy = false;
  }
}
$("log-more").addEventListener("click", loadOlderLog);
$("log-out").addEventListener("click", () => {
  state.logKind = "stdout";
  loadLog();
});
$("log-err").addEventListener("click", () => {
  state.logKind = "stderr";
  loadLog();
});
$("log-refresh").addEventListener("click", loadLog);
$("btn-reveal-log").addEventListener("click", async () => {
  const msg = await call("reveal_file", { kind: state.logKind === "stdout" ? "log" : "err" });
  if (okv(msg)) toast(msg, "ok");
});

/* ---------- AI 编排 ---------- */
/* 常用 OpenAI 兼容服务：点 chip 填 base_url + 一个能用的模型名，仍可手改 */
const AI_PROVIDERS = [
  ["OpenAI", "https://api.openai.com/v1", "gpt-4o-mini"],
  ["DeepSeek", "https://api.deepseek.com/v1", "deepseek-chat"],
  ["Kimi", "https://api.moonshot.cn/v1", "moonshot-v1-8k"],
  ["百炼", "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus"],
  ["Ollama 本地", "http://127.0.0.1:11434/v1", "qwen2.5"],
];

function renderAiProviders() {
  const cur = $("ai-f-base").value.trim().replace(/\/+$/, "");
  $("ai-providers").innerHTML = AI_PROVIDERS.map(([n, u, m]) =>
    `<button class="preset ${cur === u ? "on" : ""}" data-base="${esc(u)}" data-model="${esc(m)}" title="${esc(u)}">${esc(n)}</button>`
  ).join("");
}

function renderAiProfiles() {
  const ps = state.ai.profiles;
  $("ai-profiles").innerHTML = ps.length
    ? ps
        .map(
          (p) => `
    <div class="ai-prof ${p.name === state.ai.default ? "on" : ""}" data-name="${esc(p.name)}" title="点击选用这个配置">
      <span class="ap-dot"></span>
      <span class="ap-name">${esc(p.name)}</span>
      <span class="ap-model">${esc(p.model)} · ${esc(p.baseUrl)}</span>
      <span class="flex1"></span>
      <button class="btn xs ap-edit" data-name="${esc(p.name)}">编辑</button>
      <button class="btn xs ghost ap-del" data-name="${esc(p.name)}">删除</button>
    </div>`
        )
        .join("")
    : `<div class="hint">还没有模型配置，点右上角「+ 添加模型配置」，填一个 OpenAI 兼容服务的地址即可（DeepSeek / Kimi / 百炼 / Ollama 都有预置）。</div>`;
  const cur = ps.find((p) => p.name === state.ai.default);
  $("ai-use-note").textContent = cur
    ? `使用「${cur.name}」(${cur.model}) · 草案不会自动写入，逐条确认后才加到当前设备`
    : "草案不会自动写入，逐条确认后才加到当前设备";
}

async function loadAiCfg() {
  const c = await call("get_ai_cfg");
  if (!okv(c)) return;
  state.ai.profiles = c.profiles || [];
  state.ai.default = c.default || "";
  // 默认名对不上任何配置时退回第一条
  if (!state.ai.profiles.some((p) => p.name === state.ai.default)) {
    state.ai.default = state.ai.profiles.length ? state.ai.profiles[0].name : "";
  }
  renderAiProfiles();
}

function openAiModal(original) {
  state.ai.editing = original || "";
  const p = original ? state.ai.profiles.find((x) => x.name === original) : null;
  $("ai-modal-title").textContent = p ? `编辑模型配置「${p.name}」` : "添加模型配置";
  $("ai-f-name").value = p ? p.name : "";
  $("ai-f-base").value = p ? p.baseUrl : "";
  $("ai-f-model").value = p ? p.model : "";
  $("ai-f-key").value = "";
  $("ai-f-key").placeholder = p && p.hasKey ? "已保存，留空则保持不变" : "API Key（只存本机 app.toml）";
  aiEndpointChanged();
  renderAiProviders();
  $("ai-mask").classList.remove("hidden");
  $("ai-f-name").focus();
}

function closeAiModal() {
  $("ai-mask").classList.add("hidden");
  hideAiModels();
}

/* 模型列表：测连接后从 /models 拉来，输入时按子串过滤，也可直接手填 */
const AI_TEST_NOTE = "用上面的地址和 Key 请求 /models，通了会自动出模型列表";

function aiEndpointChanged() {
  state.ai.models = [];
  hideAiModels();
  $("ai-test-note").textContent = AI_TEST_NOTE;
}

function showAiModels() {
  const el = $("ai-model-list");
  if (!state.ai.models.length) {
    el.classList.add("hidden");
    return;
  }
  const cur = $("ai-f-model").value.trim();
  const q = cur.toLowerCase();
  const ms = state.ai.models.filter((m) => !q || m.toLowerCase().includes(q));
  el.innerHTML = ms.length
    ? ms.map((m) => `<div class="ac-item${m === cur ? " on" : ""}">${esc(m)}</div>`).join("")
    : `<div class="ac-empty">列表里没有匹配的，可直接手填</div>`;
  el.classList.remove("hidden");
}

function hideAiModels() {
  $("ai-model-list").classList.add("hidden");
}

function renderAiDrafts() {
  const ds = state.ai.drafts;
  $("btn-ai-clear").classList.toggle("hidden", !ds.length);
  $("btn-ai-apply-all").classList.toggle("hidden", !ds.some((d) => d.st !== "ok"));
  $("ai-drafts-head").classList.toggle("hidden", !ds.length);
  const frps = ((state.cfg.basics || {}).serverAddr || "").trim() || "frps";
  // 草案直接排成隧道页同款的行，所见即所得；成功/失败的补充说明挂在行下
  $("ai-drafts").innerHTML = ds
    .map(
      (d, i) => {
        const tc = typeCls(d.ptype);
        const local = `${d.localIp || "127.0.0.1"}:${d.localPort || "?"}`;
        // http 走 frps 虚拟主端口（一般 80）；tcp/udp 用 real remotePort，缺了标"待补"
        const port = d.ptype === "http" ? (d.remotePort || "80") : d.remotePort;
        const addr = `${frps}:${port || "待补"}`;
        // 第二行优先印域名（tcp 也可能带域名记录），没有才轮到生成理由
        const rSub = d.domain || (d.reason || "");
        const badge = d.st === "ok"
          ? '<span class="badge run">● 已应用</span>'
          : d.st === "err"
            ? `<span class="badge stop" title="${esc(d.msg || "应用失败")}">● 失败</span>`
            : '<span class="badge ro">○ 草案</span>';
        const msg = d.st === "ok" && d.note
          ? `<div class="ad-ok">${esc(d.note)}</div>`
          : d.st === "err"
            ? `<div class="ad-err">${esc(d.msg || "应用失败")}</div>`
            : "";
        return `
    <div class="ai-draft ${d.st}">
      <div class="trow"${d.reason ? ` title="${esc(d.reason)}"` : ""}>
        <div class="col-name">
          <div class="t-ico ico ${tc}">${esc((d.name[0] || "?").toUpperCase())}</div>
          <div class="t-name"><b title="${esc(d.name)}">${esc(d.name)}</b><span class="tags"><i class="tag ${tc}" title="${esc(typeDesc(d.ptype))}">${esc(typeTag(d.ptype))}</i></span></div>
        </div>
        <div class="col-local t-two"><span>${esc(local)}</span></div>
        <div class="col-remote t-two" title="${esc(rSub ? `${addr} · ${rSub}` : addr)}"><span class="r-main">${esc(addr)}</span>${rSub ? `<span class="r-sub">${esc(rSub)}</span>` : ""}</div>
        <span class="col-status">${badge}</span>
        <span class="col-edit">
          <button class="btn icon ad-edit" data-i="${i}" ${d.st === "ok" ? "disabled" : ""} title="编辑这条草案">${ICO_EDIT}</button>
          <button class="btn icon ad-apply" data-i="${i}" ${d.st === "ok" ? "disabled" : ""} title="${d.st === "ok" ? "已应用" : d.st === "err" ? "重试应用到当前设备" : "应用到当前设备"}">${ICO_OK}</button>
        </span>
      </div>
      ${msg}
    </div>`;
      }
    )
    .join("");
}

/* 草案就地编辑：借用隧道弹窗，保存 = 写回草案并立即应用到当前目标 */
function openEditDraft(i) {
  const d = state.ai.drafts[i];
  if (!d || d.st === "ok") return;
  state.editing = null;
  state.ai.editDraft = i;
  $("proxy-title").textContent = `编辑草案 · ${d.name}`;
  $("btn-add").textContent = "保存并应用";
  $("proxy-hint").textContent = "改好后保存，这条会直接应用到当前目标";
  $("n-name").value = d.name || "";
  $("n-type").value = ["tcp", "http", "udp"].includes(d.ptype) ? d.ptype : "tcp";
  $("n-local-ip").value = d.localIp || "127.0.0.1";
  $("n-local-port").value = d.localPort || "";
  $("n-remote-port").value = d.remotePort || "";
  $("n-domain").value = d.domain || "";
  renderProxyPresets(null);
  syncProxyTypeHints(false);
  styleAdv();
  setAdv(d);
  $("proxy-mask").classList.remove("hidden");
  $("n-name").focus();
}

async function aiApplyOne(i) {
  const d = state.ai.drafts[i];
  if (!d || d.st === "ok") return;
  const np = {
    name: d.name,
    ptype: d.ptype,
    localIp: d.localIp || "127.0.0.1",
    localPort: d.localPort,
    remotePort: d.remotePort,
    domain: d.domain,
    encrypt: "", compress: "", bandwidth: "", hcType: "", hcInterval: "", hcFailed: "",
  };
  try {
    // 直连 invoke：逐条结果印在卡片上，不挨个弹 toast
    d.note = await invoke("add_proxy_cmd", { np });
    d.st = "ok";
    d.msg = "";
  } catch (e) {
    d.st = "err";
    d.msg = String(e);
  }
}

async function aiApply(indices) {
  await withBusy(async () => {
    let ok = 0;
    let bad = 0;
    for (const i of indices) {
      await aiApplyOne(i);
      if (state.ai.drafts[i].st === "ok") ok++;
      else bad++;
    }
    if (ok) {
      await loadConfig();
      if (!state.storeMode) setDirty(true);
      await refreshStatus();
    }
    renderAiDrafts();
    if (bad) toast(`应用了 ${ok} 条，${bad} 条失败，原因见草案卡片`, "err");
    else
      toast(
        state.storeMode
          ? `${ok} 条隧道已实时生效，无需重启`
          : `${ok} 条已加入暂存，点右上角「保存」写入目标`,
        "ok"
      );
  });
}

$("ai-providers").addEventListener("click", (e) => {
  const b = e.target.closest(".preset");
  if (!b) return;
  $("ai-f-base").value = b.dataset.base;
  $("ai-f-model").value = b.dataset.model;
  aiEndpointChanged();
  renderAiProviders();
});
$("ai-f-base").addEventListener("input", () => {
  renderAiProviders();
  aiEndpointChanged();
});
$("ai-f-key").addEventListener("input", aiEndpointChanged);
$("ai-f-model").addEventListener("focus", showAiModels);
$("ai-f-model").addEventListener("input", showAiModels);
$("ai-f-model").addEventListener("blur", () => setTimeout(hideAiModels, 120));
$("ai-f-model").addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideAiModels();
});
$("ai-model-list").addEventListener("mousedown", (e) => {
  const it = e.target.closest(".ac-item");
  if (!it) return;
  e.preventDefault(); // 赶在 input blur 之前，否则下拉先被关掉
  $("ai-f-model").value = it.textContent;
  hideAiModels();
});
$("btn-ai-test").addEventListener("click", async () => {
  await withBusy(async () => {
    const r = await call("ai_models_cmd", {
      baseUrl: $("ai-f-base").value.trim(),
      apiKey: $("ai-f-key").value.trim(),
      profile: state.ai.editing,
    });
    if (!okv(r)) {
      $("ai-test-note").textContent = "连接未通过，先看提示再改地址或 Key";
      return;
    }
    state.ai.models = r.models || [];
    $("ai-test-note").textContent = `连接成功 · ${state.ai.models.length} 个模型，点模型框即可选择`;
    if (state.ai.models.length === 1 && !$("ai-f-model").value.trim()) {
      $("ai-f-model").value = state.ai.models[0];
    }
    $("ai-f-model").focus();
    showAiModels();
  });
});
$("btn-ai-add").addEventListener("click", () => openAiModal(""));
$("btn-ai-cancel").addEventListener("click", closeAiModal);
$("ai-mask").addEventListener("click", (e) => {
  if (e.target === $("ai-mask")) closeAiModal();
});
$("btn-ai-ok").addEventListener("click", async () => {
  await withBusy(async () => {
    const r = await call("save_ai_profile", {
      original: state.ai.editing,
      name: $("ai-f-name").value.trim(),
      baseUrl: $("ai-f-base").value.trim(),
      model: $("ai-f-model").value.trim(),
      apiKey: $("ai-f-key").value.trim(),
    });
    if (!okv(r)) return;
    closeAiModal();
    toast(r, "ok");
    await loadAiCfg();
  });
});
$("ai-profiles").addEventListener("click", async (e) => {
  if (state.busy) return;
  const edit = e.target.closest(".ap-edit");
  if (edit) {
    openAiModal(edit.dataset.name);
    return;
  }
  const del = e.target.closest(".ap-del");
  if (del) {
    const name = del.dataset.name;
    const yes = await showConfirm("删除模型配置", `删除「${name}」？API Key 也会一并从本机移除。`, "删除");
    if (!yes) return;
    await withBusy(async () => {
      const r = await call("remove_ai_profile", { name });
      if (!okv(r)) return;
      toast(r, "ok");
      await loadAiCfg();
    });
    return;
  }
  const row = e.target.closest(".ai-prof");
  if (row && row.dataset.name !== state.ai.default) {
    await withBusy(async () => {
      const r = await call("set_ai_default", { name: row.dataset.name });
      if (!okv(r)) return;
      state.ai.default = row.dataset.name;
      renderAiProfiles();
    });
  }
});
$("btn-ai-gen").addEventListener("click", async () => {
  const prompt = $("ai-prompt").value.trim();
  if (!prompt) {
    toast("先描述需求", "err");
    return;
  }
  if (!state.ai.default) {
    toast("先添加并选择一个模型配置", "err");
    return;
  }
  await withBusy(async () => {
    const r = await call("ai_generate_cmd", { profile: state.ai.default, prompt });
    if (!okv(r)) return;
    state.ai.drafts = (r.tunnels || []).map((t) => ({ ...t, st: "", msg: "" }));
    renderAiDrafts();
    toast(
      state.ai.drafts.length ? `生成了 ${state.ai.drafts.length} 条草案，确认后应用` : "模型没有给出草案",
      state.ai.drafts.length ? "ok" : "info"
    );
  });
});
$("btn-ai-clear").addEventListener("click", () => {
  state.ai.drafts = [];
  renderAiDrafts();
});
$("btn-ai-apply-all").addEventListener("click", () => {
  aiApply(state.ai.drafts.map((d, i) => i).filter((i) => state.ai.drafts[i].st !== "ok"));
});
$("ai-drafts").addEventListener("click", (e) => {
  if (state.busy) return;
  const ed = e.target.closest(".ad-edit");
  if (ed) {
    openEditDraft(parseInt(ed.dataset.i, 10));
    return;
  }
  const b = e.target.closest(".ad-apply");
  if (b) aiApply([parseInt(b.dataset.i, 10)]);
});

/* ---------- global ---------- */
$("btn-refresh").addEventListener("click", async () => {
  showSkeletons();
  if (state.page === "config") await loadConfig();
  await refreshStatus();
  if (state.page === "logs") await loadLog();
  clearStale();
});

(async function init() {
  showPage("tunnels");
  showSkeletons();
  await loadTargets();
  await refreshStatus();
  await loadConfig();
  applyMode();
  clearStale();
  loadAiCfg();
  let tick = 0;
  setInterval(() => {
    if (document.hidden || state.busy) return;
    refreshStatus();
    // 页签上其它设备的点：每 15s 整批探一次（离线设备要等超时，比状态轮询贵）
    if (++tick % 3 === 0) probeTargets();
  }, 5000);
})();
