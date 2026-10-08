# enigo 版本与 Linux 后端实测结论（务必阅读）

> 本文档记录 RemoteType 选型过程中对 `enigo` 的**实测结论**，用于支撑
> 「Linux 仅支持 X11」这一决策，并说明与需求文档 V0.1 的差异。

## 1. 版本修正：文档写的 0.1.30 不存在

需求文档 5.3 给出的依赖是：

```toml
enigo = "0.1.30"
```

实测 `cargo build` 直接报错：

```
error: failed to select a version for the requirement `enigo = "^0.1.30"`
candidate versions found which didn't match: 0.6.1, 0.6.0, 0.5.0, ...
```

enigo 的 `0.1.x` 系列实际最高只到 **0.1.6**，`0.1.30` 从未发布。
本项目采用当前稳定版 **0.6.1**。

## 2. API 变更

`0.1.x` 与 `0.6.x` 的 API 完全不同，不能照抄旧文档：

| 项目 | 0.1.x（文档里的写法） | 0.6.1（实际使用） |
| --- | --- | --- |
| 构造 | `Enigo::new()` | `Enigo::new(&Settings::default())` |
| 文本注入 | `enigo.key_sequence(&str)`（`KeyboardControllable` trait） | `enigo.text(&str)`（`Keyboard` trait） |
| 单键 | `enigo.key_click(Key)` | `enigo.key(Key, Direction)` |
| 特征签名 | 无 `Result` | 返回 `InputResult<()>`，必须处理错误 |

`text()` 内部会优先走 `fast_text()`（若后端不支持则逐字符 `key(Key::Unicode(c), Click)`），
因此**中文等 Unicode 字符可以直接注入**，无需额外处理。

## 3. 实测：X11 后端工作正常 ✅

测试环境：Ubuntu 22.04 (aarch64/x86_64 容器) + `Xvfb :99` + `xev` 观测 X 事件。

注入 `Hello 你好世界 ABC123`，`xev` 捕获到的 keysym：

```
keysym 0x48 "H"   keysym 0x65 "e"   keysym 0x6c "l"   keysym 0x6c "l"   keysym 0x6f "o"
keysym 0x20 " "   keysym 0x41 "A"   keysym 0x42 "B"   keysym 0x43 "C"
keysym 0x31 "1"   keysym 0x32 "2"   keysym 0x33 "3"
keysym 0x1004f60   # 你
keysym 0x100597d   # 好
keysym 0x1004e16   # 世
keysym 0x100754c   # 界
```

结论：**ASCII 与中文字符全部正确送达**，enigo 通过对 keycode 做临时重映射
（`MappingNotify` 事件，测试中共 64 次）来支持 Unicode。X11 路径可直接用于生产。

### 3.1 ⚠️ 但发现两个会导致「注入错误字符」的缺陷（已修复）

上述「基本可用」的结论有一个重要例外。继续做**逐字符比对**时发现：
长中文文本注入后，段落里的「。」全部丢失或变成错误字符。

#### 缺陷 A：xkeysym 把「。」(U+3002) 映射成日文假名句点

`enigo` 对 `Key::Unicode(c)` 走 `xkeysym::Keysym::from_char(c)`。
而 xkeysym 0.2.1 的 `KEYSYMTAB` 中存在这样一条条目：

```rust
CodePair { keysym: 0x04a1, ucs: 0x3002 }   // kana_fullstop 。 IDEOGRAPHIC FULL STOP
```

`from_char` 的实现是「在表中找到 ucs 匹配项就采用其 keysym」，于是：

```
链路:  '。'(U+3002)
   ->  Key::Unicode('。')
   ->  xkeysym::Keysym::from_char('。')
   ->  KEYSYMTAB 命中 { ucs: 0x3002 }，返回 keysym 0x04a1   <== 问题所在
   ->  enigo 把 keycode 重映射到 keysym 0x04a1
   ->  X 客户端按 keysym 0x04a1 取字符 = kana_fullstop（日文假名句点）
```

按 X11 规范，U+3002 应当使用 keysym `0x01003002`。
实测（`xev` 观测）确认收到的是 `0x4a1, kana_fullstop` 而非 `0x1003002`。
「。」在中文写作里属高频字符，该缺陷会直接影响可用性。

**影响范围远不止「。」**。扫描 `KEYSYMTAB` 全部 763 条表项后统计：
有 **286 条**采用「传统 keysym 指向较高码位」的形式，覆盖：

| 类别 | 示例 | 条目数（大致） |
| --- | --- | --- |
| CJK 标点 | `。` `、` `「` `」` `・` | 5 |
| 日文假名（全角） | `ア` `イ` `ウ` … `ン`、`゛` `゜` | ~60 |
| 韩文谚文 | `ㄱ` `ㄴ` `ㄷ` … `ㅣ`、`ㆍ` `ㆎ` | ~90 |
| 数学/制图符号 | `≤` `≠` `√` `∫` `→` `─` `┌` `●` `☆` | ~90 |
| 其他标点 | `№` `―` `…` `“` `”` `‘` `’` `™` `‰` | ~40 |

这些 keysym 只在**对应的键盘布局下**才映射到该字符。在中文/通用环境下注入
会得到错误字符或丢失。

#### 缺陷 B：分片注入时的字符丢失

未修复前实测：注入 252 字符的中文段落，窗口只收到 262/285（叠加前序消息），
且内容与期望不符。修复缺陷 A 后，**同一测试 252/252 逐字一致**。

#### 修复方案：本地 patch xkeysym

在 `rust/vendor/xkeysym/` 维护一份打过补丁的源码，通过
`[patch.crates-io]` 覆盖上游。改动只有一处 ——
`Keysym::from_char` 末尾不再查表，而是**统一按 X11 规范**返回
`0x01000000 + codepoint`：

```rust
// 原实现（有歧义/错误）
KEYSYMTAB.iter().find(|p| p.ucs as u32 == ucs)
    .map_or(Self::new(ucs | 0x01000000), |p| Self::new(p.keysym as u32))

// 补丁后（规范、无歧义）
Self::new(ucs | 0x01000000)
```

Latin-1 区（U+0020–U+007E、U+00A0–U+00FF）仍走原有的 1:1 短 keysym 分支，
不受影响。该补丁不影响 macOS / Windows：那两个平台的后端不经过此函数。

#### 修复后实测结果

```
注入 "测试句号。第二句。结束。引号「」顿号、"
收到 "测试句号。第二句。结束。引号「」顿号、"   逐字一致 ✅

注入 252 字中文段落（含 12 个「。」）
收到 252 字符，逐字一致 ✅
```

> 建议向上游反馈：enigo 可考虑在 `Key::Unicode` 路径上跳过 KEYSYMTAB 查询；
> 或 xkeysym 在 `from_char` 中改为优先规范编码。本文档的 patch 可直接作为参考实现。


## 4. 实测：Wayland 后端无法工作 ❌

在**真实运行的 Wayland 合成器**（weston 13.0.0，headless backend，socket `wayland-0`）
上测试，仅启用 `wayland` 特性（以及 `x11rb+wayland` 组合）时，构造即失败：

```
$ WAYLAND_DISPLAY=wayland-0 ./m3
CONSTRUCT ERR: EstablishCon("no successful connection")
```

### 根因（源码级定位）

`enigo-0.6.1/src/linux/wayland.rs` 的 `wl_registry::Event::Global` 分支存在初始化缺陷：

1. **`wl_seat` 分支不记录 `keyboard_manager`**
   第 337–366 行处理 `wl_seat` 时，虽然会用「已存在的」`state.keyboard_manager`
   去创建 `virtual_keyboard`，但**不会**把该全局存进 `state.keyboard_manager`。

2. **依赖注册表公告顺序，存在竞态**
   若 `wl_seat` 的 Global 事件**先于** `zwp_virtual_keyboard_manager_v1` 到达，
   则 `state.keyboard_manager` 此时为 `None`，`virtual_keyboard` 永远不会被创建；
   而后续 `zwp_virtual_keyboard_manager_v1` 分支只在 `state.seat` 已经存在时才尝试创建，
   于是最终 `virtual_keyboard`、`input_method` 双双为 `None`。

3. **报错信息具有误导性**
   两个协议都不存在时抛出 `EstablishCon("no successful connection")`，
   让人误以为是连接失败，实际是协议绑定竞态。上游已记录：
   [enigo-rs/enigo#297](https://github.com/enigo-rs/enigo/issues/297)。

### 决策

完全遵循需求文档 6.1「**Linux 仅 X11 支持，Wayland 不支持**」：

* 客户端在检测到 Wayland 会话（`WAYLAND_DISPLAY` 存在且无 `DISPLAY`）时，
  打印明确的降级提示，而不是静默失败；
* 支持通过 `XWayland`（同时存在 `DISPLAY`）正常工作；
* 建议用户登录时选择「Ubuntu on Xorg」/「GNOME on Xorg」会话。

> 若后续（V0.2+）需要原生 Wayland，建议走 `xdg-desktop-portal` 的
> `RemoteDesktop` 接口（需用户授权），或自行实现
> `zwp_virtual_keyboard_manager_v1` 客户端，而不是依赖 enigo 的 Wayland 后端。
