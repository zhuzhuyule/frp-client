# 自动更新说明

分两部分：**装的人**看前半段就够了，**发版的人**再看后半段。

## 一、作为使用者：不需要任何配置

装完打开就能用，更新也是自动的：

1. App 启动时静默读一次 GitHub Release 上的 `latest.json`；
2. 有新版就在侧边栏出现「立即更新」；
3. 点一下 → 下载 → minisign 验签 → 替换 → 自动重启。

正在跑的 frpc 隧道不受影响，也不需要你填地址、密钥或命令行。各平台用的包：macOS `.app.tar.gz`、Windows NSIS `.exe`、Linux AppImage。

### 两个已知的"要动一次手"的场景

- **你装的是 v0.2.x 或更早**：那批二进制里还没有 updater 代码，所以它不会自动跳到 v0.3.0，需要手动重装一次新版（从 v0.3.0 起才永久免手）。
- **macOS 首次安装被 Gatekeeper 拦**：包只有 minisign 更新签名，没有 Apple 开发者证书和公证，所以可能提示"已损坏"或"无法验证开发者"。优先用「从 dmg 拖进 Applications」；真被拦了执行一次即可，之后内置的自动更新不会再触发（它自己下载解压不带隔离标记）：

  ```bash
  xattr -dr com.apple.quarantine /Applications/FRP\ Client.app
  ```

## 二、作为维护者：发版只需打 tag

签名与更新链的配置是一次性的，做完之后每次发版只有一条命令：

```bash
git tag vX.Y.Z && git push origin vX.Y.Z
```

CI（`.github/workflows/build.yml`）会自动三平台打包、签名、发布 Release 并生成 `latest.json`。

### 一次性准备：minisign 密钥

公钥已经写进 `tauri.conf.json` 的 `plugins.updater.pubkey`，只在需要新密钥时才生成：

```bash
# -p '' 表示不设口令，见下一节
cargo tauri signer generate -w ~/.tauri/frp-client.key -p ''
```

仓库 Secrets **只配一个**：`TAURI_SIGNING_PRIVATE_KEY`（私钥文件的全部内容）。

**不要配 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。** 私钥是无口令生成的，而只要这个 Secret 存在且有值，CI 就会拿它去解私钥并失败：

```
failed to decode secret key: incorrect updater private key password
```

留空或不配都能正常签名；填占位值必挂（这是 v0.3.0 首轮 CI 三平台全挂的原因）。

顺带一句：**本地跑 `cargo tauri build` 时如果没设 `TAURI_SIGNING_PRIVATE_KEY`，会在打包阶段因无法签名而失败**。日常开发用 `cargo tauri dev` 或 `cargo build --release` 不受影响；真要本地出带更新的包，`export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/frp-client.key)"` 即可。

### 关于签名的两个事实

- **私钥丢了 = 已装出去的客户端永久收不到更新**；私钥泄了 = 别人可以给所有用户推任意代码。它不是 Git 历史的一部分，只在本机和仓库 Secret 里。
- **这条签名链不等于 Apple 公证**。minisign 只保证"更新包确实来自本项目"，Gatekeeper 那句"无法验证开发者"依然存在，要根治得 99 刀/年的 Apple 开发者账号 + notarytool。

### `latest.json` 的三个坑（都已在 workflow 里处理）

1. `tauri-action` 只在**存在 `.sig`** 时才上传 `latest.json`——私钥缺失时 Release 照样发，只是静默没有更新元数据。
2. `latest.json` 默认让 Windows 指向 `.msi`，而 updater 装不了 msi，必须显式 `updaterJsonPreferNsis: true`。
3. macOS 用 `--target universal-apple-darwin` 出的单个 `.app.tar.gz` 会被自动拆成 `darwin-aarch64` / `darwin-x86_64` 两个键，客户端查的是 `{os}-{arch}`，所以 universal 不需要额外处理。

### 发版后建议验一次

```bash
gh release view vX.Y.Z --json isDraft,publishedAt
gh release download vX.Y.Z -p latest.json --clobber   # 看 version 与 platforms 键
```

要真验签名，就下载对应归档 + `.sig`，用客户端同款库 `minisign-verify` 验（注意 `.sig` 和配置里的 `pubkey` 都是 base64 包了一层的 minisign 文本块，得先解码；算法标记是 `ED` 即 prehashed，手搓 Ed25519 验不出来）。
