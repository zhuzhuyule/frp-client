/* ---------- i18n ----------
   双语两轨：
   - JS 里的动态文案 → tx("中文", "English")，调用点并列两版；
   - index.html 静态文案 → data-i18n / data-i18n-ph / data-i18n-title + 本文件里的字典（k 登记）。
   语言在 app.js 之前定妥：本脚本 await get_lang 后再动态加载 app.js，
   所以模块顶层的中英文常量求值时 LANG 一定已是最终值。 */
let LANG = "zh";

const I18N_DICT = {};
function k(key, zh, en) {
  I18N_DICT[key] = [zh, en];
  return key;
}
function tt(key) {
  const e = I18N_DICT[key];
  if (!e) return key;
  return LANG === "en" ? e[1] : e[0];
}
function tx(zh, en) {
  return LANG === "en" ? en : zh;
}
function applyStaticI18n() {
  document.documentElement.lang = LANG === "en" ? "en" : "zh-CN";
  document.title = tt("app.title");
  document.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = tt(el.dataset.i18n)));
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => (el.placeholder = tt(el.dataset.i18nPh)));
  document.querySelectorAll("[data-i18n-title]").forEach((el) => (el.title = tt(el.dataset.i18nTitle)));
}

/* 静态字典（与 index.html 的 data-i18n 一一对应，index 抽取时逐条补进来） */
k("app.title", "FRP Client", "FRP Client");

/* ---------- 侧栏 / 品牌 ---------- */
k("brand.tagline", "轻量 · 高效 · 稳定", "Lightweight · Efficient · Stable");
k("nav.tunnels", "隧道管理", "Tunnels");
k("nav.config", "配置预览", "Config Preview");
k("nav.ai", "AI 编排", "AI Orchestration");
k("nav.logs", "日志", "Logs");
k("side.statusChecking", "检测中…", "Checking…");
k("side.statusConnecting", "正在连接控制台", "Connecting to console");

/* ---------- 通用 ---------- */
k("common.refresh", "刷新", "Refresh");
k("common.save", "保存", "Save");
k("common.cancel", "取消", "Cancel");
k("common.confirm", "确认", "Confirm");
k("common.start", "启动", "Start");
k("common.restart", "重启", "Restart");
k("common.stop", "停止", "Stop");
k("common.name", "名称", "Name");
k("common.actions", "操作", "Actions");
k("common.showInFinder", "在 Finder 中显示", "Show in Finder");
k("common.close", "关闭", "Close");
k("common.show", "显示", "Show");
k("common.optDefault", "默认", "Default");
k("common.optOn", "开启", "On");
k("common.optOff", "关闭", "Off");

/* ---------- 隧道管理 ---------- */
k("tunnels.pageSub", "管理本地服务映射并生成客户端配置", "Manage local service mappings and generate client config");
k("tunnels.searchPh", "搜索名称、本地或映射地址...", "Search name, local or mapped address...");
k("tunnels.newBtn", "+ 新建隧道", "+ New Tunnel");
k("tunnels.chipRunning", "● 运行中", "● Running");
k("tunnels.chipCount", "隧道 0 / 0", "Tunnels 0 / 0");
k("tunnels.colLocal", "本地 / 后台进程", "Local / background process");
k("tunnels.colRemote", "映射（域名优先）", "Mapping (domain first)");
k("tunnels.colStatus", "运行状态", "Status");
k("tunnels.empty", "暂无隧道 · 管理 API 不可达或 frpc 未配置代理", "No tunnels · management API unreachable or frpc has no proxies");

/* ---------- 配置预览 ---------- */
k("config.connTitle", "这台设备的连接方式", "Connection to This Device");
k("config.connHint", "App 这一侧怎么连它，改动不会落到设备上的 frpc。", "How the app reaches this device; changes here don't touch frpc on the device.");
k("config.kConsole", "控制台", "Console");
k("config.kAccount", "账号", "Account");
k("config.kProcess", "进程", "Process");
k("config.frpcTitle", "这台 frpc 自身的配置", "This frpc's Own Configuration");
k("config.frpcHint", "它连哪个 frps、控制台绑在哪 —— 改这里才会写进该目标的 frpc.toml。", "Which frps it connects to and where the console binds — only changes here are written to this target's frpc.toml.");
k("config.kServer", "frps 服务端", "frps server");
k("config.kConsoleBind", "控制台绑定", "Console binding");
k("config.kTunnels", "隧道", "Tunnels");
k("config.kCfgFile", "配置文件", "Config file");
k("config.kLastSaved", "上次保存", "Last saved");
k("config.revealCfgTitle", "在 Finder 中定位这台设备的 frpc.toml", "Reveal this device's frpc.toml in Finder");
k("config.editDeviceBtn", "编辑设备连接", "Edit Device Connection");
k("config.editDeviceTitle", "改 App 怎么连这台设备的控制台（地址 / 端口 / 账号），不动设备上的 frpc", "Change how the app connects to this device's console (address / port / account), without touching frpc on the device");
k("config.editCfgBtn", "编辑设备配置", "Edit Device Config");
k("config.editCfgTitle", "改这台 frpc 自己的配置（服务端、控制台绑定、隧道）", "Change this frpc's own settings (server, console binding, tunnels)");

/* ---------- AI 编排 ---------- */
k("ai.modelConfig", "模型配置", "Model Config");
k("ai.modelHint", "全局配置 · 对所有设备生效，点选一个用于生成（OpenAI 兼容 /chat/completions）", "Global · applies to all devices. Pick one to generate with (OpenAI-compatible /chat/completions)");
k("ai.addProfileBtn", "+ 添加模型配置", "+ Add Model Config");
k("ai.genTitle", "生成隧道草案", "Generate Tunnel Drafts");
k("ai.useNote", "草案不会自动写入，逐条确认后才加到当前设备", "Drafts aren't written automatically; each is added to the current device after you confirm it");
k("ai.promptPh", "例如：把本机 8080 的 web 服务用 tcp 映射到远程 18080；再起一条 http 隧道，把 3000 挂到 app.example.com", "e.g. Map this machine's web service on 8080 to remote port 18080 over tcp; also add an http tunnel putting 3000 behind app.example.com");
k("ai.clearBtn", "清空草案", "Clear Drafts");
k("ai.applyAllBtn", "应用全部", "Apply All");
k("ai.genBtn", "生成草案", "Generate Drafts");
k("ai.colLocal", "本地", "Local");
k("ai.colRemote", "映射（FRP 地址）", "Mapping (FRP address)");
k("ai.colStatus", "状态", "Status");

/* ---------- 日志 ---------- */
k("logs.runBtn", "运行日志", "Runtime Log");
k("logs.errBtn", "错误日志", "Error Log");
k("logs.loadEarlier", "加载更早", "Load Earlier");
k("logs.loadEarlierTitle", "向上追加更早的一页日志", "Prepend the previous page of logs");
k("logs.revealTitle", "在 Finder 中定位当前这个日志文件", "Reveal the current log file in Finder");
k("logs.remoteTitle", "远端目标不支持查看日志", "Logs Aren't Available for Remote Targets");
k("logs.remoteSub", "切换到本机目标查看日志，或 SSH 到目标机器上查看其 frpc 日志。", "Switch to a local target to view logs, or SSH into the machine to check its frpc logs.");

/* ---------- 新建/编辑隧道弹窗 ---------- */
k("proxy.title", "新建隧道", "New Tunnel");
k("proxy.type", "类型", "Type");
k("proxy.localIp", "本地地址", "Local address");
k("proxy.localPort", "本地端口", "Local port");
k("proxy.localPortPh", "如 8080", "e.g. 8080");
k("proxy.remotePort", "映射端口", "Remote port");
k("proxy.remotePortPh", "如 9090", "e.g. 9090");
k("proxy.domain", "域名", "Domain");
k("proxy.advSettings", "高级设置", "Advanced Settings");
k("proxy.advSetTag", "已设置", "Set");
k("proxy.encryption", "链路加密", "Transport encryption");
k("proxy.compression", "数据压缩", "Data compression");
k("proxy.bandwidth", "带宽限制", "Bandwidth limit");
k("proxy.bandwidthPh", "如 1MB", "e.g. 1MB");
k("proxy.bwHint", "只认大写 KB / MB，留空为不限", "Only uppercase KB / MB accepted; leave empty for no limit");
k("proxy.healthCheck", "健康检查", "Health check");
k("proxy.tcpProbe", "tcp 探测", "tcp probe");
k("proxy.hcInterval", "探测间隔（秒）", "Probe interval (seconds)");
k("proxy.hcIntervalPh", "如 10", "e.g. 10");
k("proxy.hcMaxFailed", "失败次数", "Max failures");
k("proxy.hcMaxFailedPh", "如 3", "e.g. 3");
k("proxy.hintDefault", "加入暂存列表后仍需点右上角的保存按钮写入当前目标", "After adding to the draft list, still click Save at the top right to write to the current target");
k("proxy.stageBtn", "加入暂存", "Add to Drafts");

/* ---------- 编辑设备配置弹窗 ---------- */
k("server.reloadBtn", "⟳ 重新加载", "⟳ Reload");
k("server.reloadTitle", "丢弃弹窗里的改动，重新读取当前配置", "Discard the changes in this dialog and re-read the current config");
k("server.tabUi", "可视化", "Visual");
k("server.tabRaw", "原始 TOML", "Raw TOML");
k("server.frpsCard", "要连接的服务端（frps）", "Target Server (frps)");
k("server.addr", "服务端地址", "Server address");
k("server.port", "服务端端口", "Server port");
k("server.token", "访问令牌", "Auth token");
k("server.webCard", "这台 frpc 自己的控制台（webServer）", "This frpc's Own Console (webServer)");
k("server.webAddr", "控制台地址", "Console address");
k("server.webPort", "控制台端口", "Console port");
k("server.webUser", "控制台账号", "Console user");
k("server.webPass", "控制台密码", "Console password");
k("server.webWarn", "webServer 只在重启时重新绑定；写成本机绑不到的地址会让下次重启直接失败。", "webServer only rebinds on restart; an address this machine can't bind will fail the next restart outright.");
k("server.rawHint", "整篇 frpc.toml，含尚未保存的隧道增删改。", "The entire frpc.toml, including unsaved tunnel additions, edits and deletions.");
k("server.applyBtn", "保存并热加载", "Save & Hot-reload");

/* ---------- 新建/编辑设备弹窗 ---------- */
k("device.titleNew", "新建设备", "New Device");
k("device.tabRemote", "远端设备", "Remote Device");
k("device.tabLocal", "本机 frpc 实例", "Local frpc Instance");
k("device.machineType", "机器类型", "Machine type");
k("device.osAuto", "自动/未知", "Auto/Unknown");
k("device.hostLabel", "主机地址", "Host address");
k("device.passPh", "留空保持不变", "Leave empty to keep unchanged");
k("device.cfgPath", "配置文件路径", "Config file path");
k("device.removeBtn", "移除设备", "Remove Device");
k("device.rescanBtn", "⟳ 重新扫描本机", "⟳ Rescan This Machine");
k("device.addTestBtn", "添加并测试", "Add & Test");

/* ---------- 模型配置弹窗 ---------- */
k("aiModal.title", "添加模型配置", "Add Model Config");
k("aiModal.name", "配置名称", "Config name");
k("aiModal.namePh", "如 DeepSeek / 本地 Ollama", "e.g. DeepSeek / local Ollama");
k("aiModal.base", "API 地址", "API address");
k("aiModal.keyPh", "只存本机 app.toml", "Stored only in the local app.toml");
k("aiModal.model", "模型", "Model");
k("aiModal.modelPh", "先测连接再从列表选，也可手填", "Test the connection first and pick from the list, or type one in");
k("aiModal.testBtn", "测试连接并加载模型", "Test Connection & Load Models");
k("aiModal.testNote", "用上面的地址和 Key 请求 /models，通了会自动出模型列表", "Sends a /models request with the address and key above; the model list loads automatically on success");


(async function bootI18n() {
  try {
    if (window.__TAURI__) LANG = (await window.__TAURI__.core.invoke("get_lang")) || "zh";
  } catch (e) {
    /* 拿不到就中文兜底 */
  }
  applyStaticI18n();
  const cb = new URLSearchParams(location.search).get("cb");
  const s = document.createElement("script");
  s.src = "app.js" + (cb ? "?cb=" + cb : "");
  document.body.appendChild(s);
})();
