'use strict';

/**
 * 多账号账号簿（纯逻辑：不碰 fs / os，落盘全部交给 config.js）。
 *
 * 背景：服务端注册表是 `clientId → userId` 的**永久一对一**绑定，跨属主改绑一律拒绝
 * （/auth/verify 403 device_owned_by_other，WS register 关闭码 4403），也没有解绑途径。
 * 所以「同一台电脑多账号」不能靠改绑，只能靠**每个账号各持一个 clientId**——
 * 服务端从不拒绝新 clientId 登记为新设备。
 *
 * 数据结构（config.json v2）：
 *   activeAccount: "<accountKey>"          当前生效的账号
 *   accounts: { "<accountKey>": {…} }      各账号的完整登录态
 *   …其余 flat 字段（deviceToken/sessionKey/authUser/serverHttp/url/deviceName/clientId）
 *   语义升级为「恒等于 accounts[activeAccount] 的镜像」——loadConfig 与既有命令
 *   （serve/status/doctor）全都只读 flat，因此读路径一行不用改。
 *
 * accountKey = "<serverHttp>::<userId>"：账号按部署实例隔离，同一个 userId 在两台
 * 服务器上是两套彼此独立的凭据，不会互相覆盖。
 *
 * 本模块只做「读视图 / 定位 / 生成 flat 补丁」三件事，且是纯函数——
 * 文件写入在 config.js（writeConfigFile 原子写）。
 */

/** 服务端 HTTP 基址归一：去首尾空白与尾斜杠（两种写法必须落成同一个 key）。 */
function normalizeServerHttp(s) {
  return String(s == null ? '' : s).trim().replace(/\/+$/, '');
}

/** 账号唯一键：部署实例 + 认证中心 sub。 */
function accountKey(serverHttp, userId) {
  return `${normalizeServerHttp(serverHttp)}::${String(userId == null ? '' : userId)}`;
}

/** 从条目自身推出它的 key（条目里同时存了 serverHttp 与 userId）。 */
function entryKeyOf(entry) {
  return accountKey(entry && entry.serverHttp, entry && entry.userId);
}

/**
 * 条目是否可用：至少要有 userId 与 deviceToken。
 * 缺这两样的条目（手改坏 / 半截写入）直接丢弃，绝不让它参与匹配或激活。
 */
function isUsableEntry(e) {
  return Boolean(e && typeof e === 'object' && e.userId && e.deviceToken);
}

/**
 * 得到「账号视图」。纯函数、不改入参。
 *
 * 惰性迁移：老版本配置里只有 flat 的 deviceToken/authUser（无 accounts），
 * 这里在内存里把它合成成首个条目——老用户的既有绑定原样保留，下次写盘时固化。
 * clientId 优先取 flat 的 file.clientId，其次由调用方给的 defaultClientId
 * （即 ensureClientId() 的机器标识）兜底。
 *
 * @param {object} raw config.json 原始内容
 * @param {{defaultClientId?: string}} [opts]
 * @returns {{accounts: object, activeAccountKey: string|null}}
 */
function withAccounts(raw, opts = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const accounts = {};
  let migratedKey = null;

  // 注意用**原始键数**判断是否已迁移：手改留下的空 accounts 表不该把 flat 里的
  // 凭据一起吞掉——那种情况按「未迁移」处理，从 flat 合成条目更接近真相。
  if (src.accounts && typeof src.accounts === 'object' && Object.keys(src.accounts).length > 0) {
    for (const [k, v] of Object.entries(src.accounts)) {
      if (isUsableEntry(v)) accounts[k] = { ...v };
    }
  } else if (src.authUser && isUsableEntry({ ...src.authUser, deviceToken: src.deviceToken })) {
    const u = src.authUser;
    const entry = {
      userId: u.userId,
      email: u.email || '',
      username: u.username || '',
      nickname: u.nickname || '',
      deviceToken: src.deviceToken,
      expiresAt: u.expiresAt ?? null,
      sessionKey: src.sessionKey || '',
      serverHttp: normalizeServerHttp(src.serverHttp),
      url: src.url || '',
      deviceName: src.deviceName || '',
      clientId: src.clientId || opts.defaultClientId || '',
      loginAt: u.loginAt ?? null,
    };
    migratedKey = accountKey(entry.serverHttp, entry.userId);
    accounts[migratedKey] = entry;
  }

  // 指针只在确实指向一个存在的条目时有效；迁移出来的单条目就是当前生效账号。
  // 刻意**不做**"只剩一个条目就自动激活"——logout 之后必须如实显示"未登录"。
  const activeAccountKey = accounts[src.activeAccount]
    ? src.activeAccount
    : migratedKey;

  return { accounts, activeAccountKey };
}

/** 账号列表，按 key 升序（展示序号与按序号匹配共用同一顺序）。 */
function listAccounts(view) {
  return Object.entries((view && view.accounts) || {})
    .map(([key, entry]) => ({ key, entry }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** 按「部署 + userId」精确找条目（登录时判断"是不是同一个账号又登了一次"）。 */
function findExact(view, serverHttp, userId) {
  return ((view && view.accounts) || {})[accountKey(serverHttp, userId)] || null;
}

/** 给人看的账号标签：昵称 > 用户名 > 邮箱 > userId。 */
function labelOf(entry) {
  if (!entry) return '(未知账号)';
  return entry.nickname || entry.username || entry.email || entry.userId || '(未知账号)';
}

/** 候选清单（错误信息里内联，让用户当场能照着改）。 */
function formatCandidates(list) {
  return list
    .map((a, i) => `    ${i + 1}. ${labelOf(a.entry)}${a.entry.email ? ` <${a.entry.email}>` : ''}`
      + ` — clientId ${a.entry.clientId || '(无)'} — ${a.entry.serverHttp || '(未知服务端)'}`)
    .join('\n');
}

/**
 * 决定这次登录该用哪个 clientId 去登记——多账号的核心决策（纯函数、无副作用）。
 *
 * 服务端注册表是 clientId→属主 的**永久一对一**，所以只能是：
 *   - 这个账号本机已有条目 → 沿用它的 clientId（只换令牌：绑定与会话密钥都不变，
 *     手机端缓存的那把密钥继续有效）；
 *   - 凭据已登出、但本机**记得**这个账号的设备标识（config.json 的 deviceIds）
 *     → 仍沿用旧标识：同一个账号重登不该变成"一台新电脑"；
 *   - 本机一个账号都没有 → 用机器默认标识（= 首次登录的既有行为）；万一这个标识
 *     其实早已被别人登记（配置被清过 / 换过机器），服务端会 403，此时
 *     retryOnOwnedByOther 让调用方带着 prevErr 再来问一次，换新标识兜底；
 *   - 本机已有别的账号 → 领一个**新** clientId（同机多账号各持各的标识）。
 * 显式 --client-id 永远最高优先（想固定标识的 power user）。
 *
 * 打印提示这类副作用刻意留在命令层：这里只回答"用哪个 id、为什么"。
 *
 * @param {{accounts:object}} view withAccounts 的视图
 * @param {{userId:string}} identity 身份预检结果
 * @param {{serverHttp:string, machineClientId:string, explicitClientId?:string|null,
 *          rememberedClientId?:string|null, deviceName?:string, explicitDeviceName?:boolean,
 *          prevErr?:Error|null, generate?:(taken:Set<string>) => string}} opts
 *        generate 是注入点，真实调用方传 config.generateClientId（会把已用过的 id 排除）；
 *        不传时用本地兜底生成器，好让本模块保持零依赖。
 * @returns {{clientId:string, deviceName:string, retryOnOwnedByOther:boolean,
 *            reason:'explicit'|'reuse'|'remembered'|'machine'|'fresh'|'retry'}}
 */
function planLoginClientId(view, identity, opts = {}) {
  const list = listAccounts(view);
  const taken = new Set(list.map((a) => a.entry.clientId).filter(Boolean));
  const fresh = () => (opts.generate ? opts.generate(taken) : fallbackId(taken));
  const name = opts.deviceName || '';
  // 设备名：显式 --device-name 最高优先，其次沿用条目里存的名字（手机端看着不变）
  const pickName = (stored) => name ? (opts.explicitDeviceName ? name : (stored || name)) : (stored || '');

  // 兜底：机器默认标识已被别人登记（prevErr = device_owned_by_other）→ 换新标识
  if (opts.prevErr) {
    return { clientId: fresh(), deviceName: name, retryOnOwnedByOther: false, reason: 'retry' };
  }
  if (opts.explicitClientId) {
    return {
      clientId: opts.explicitClientId, deviceName: name, retryOnOwnedByOther: false, reason: 'explicit',
    };
  }
  const hit = identity ? findExact(view, opts.serverHttp, identity.userId) : null;
  if (hit) {
    return {
      clientId: hit.clientId || fresh(),
      deviceName: pickName(hit.deviceName),
      retryOnOwnedByOther: false,
      reason: 'reuse',
    };
  }
  // 本机曾为这个账号登记过设备标识，只是凭据被登出清掉了（deviceIds 记着）：
  // 沿用旧标识——同一个账号重登不该变成"一台新电脑"。否则手机会多出一条再也
  // 连不上的设备，服务端注册表也会一直堆孤儿记录（服务端没有解绑途径）。
  // 这里允许 403 兜底：万一这个标识在服务端已属于别人（配置被搬过），
  // 换新标识是对的，不能卡死在登录不了。
  if (opts.rememberedClientId) {
    return {
      clientId: opts.rememberedClientId,
      deviceName: name,
      retryOnOwnedByOther: true,
      reason: 'remembered',
    };
  }
  if (list.length === 0) {
    return {
      clientId: opts.machineClientId || fresh(),
      deviceName: name,
      retryOnOwnedByOther: true,
      reason: 'machine',
    };
  }
  return { clientId: fresh(), deviceName: name, retryOnOwnedByOther: false, reason: 'fresh' };
}

/** 没有注入 generate 时的兜底生成器（只为让本模块不依赖 config/os）。 */
function fallbackId(taken) {
  let id = '';
  for (let i = 0; i < 20; i += 1) {
    id = `pc-${Math.random().toString(36).slice(2, 8)}`;
    if (!taken.has(id)) return id;
  }
  return id;
}

/**
 * 把一个用户给的目标解析成唯一条目。
 *
 * 匹配顺序（先精确后模糊；纯数字一律当序号，绝不被子串截胡）：
 *   完整 accountKey → userId 精确 → email 精确（忽略大小写）→ 纯数字 = 展示序号（从 1 起）
 *   → email/username/nickname 唯一子串（忽略大小写）
 *
 * 未命中 / 歧义 / 越界都抛错，错误信息内联候选清单——CLI 直接把这行原样打给用户。
 *
 * @param {object} raw config.json 原始内容
 * @param {string} target 用户输入
 * @param {{defaultClientId?: string}} [opts]
 * @returns {{key: string, entry: object}}
 * @throws {Error}
 */
function resolveAccountEntry(raw, target, opts = {}) {
  const view = withAccounts(raw, opts);
  const list = listAccounts(view);
  const t = String(target == null ? '' : target).trim();

  if (!list.length) {
    throw new Error('本机还没有已存账号（先执行 npx nx-rt auth login）');
  }
  if (!t) {
    throw new Error(`未指定账号。可用账号：\n${formatCandidates(list)}`);
  }

  const notFound = () => new Error(
    `找不到账号「${t}」。可用账号：\n${formatCandidates(list)}\n`
    + '  可用的写法：序号 / 邮箱 / 用户名 / 昵称，或 npx nx-rt auth list 查看',
  );
  const ambiguous = (hits) => new Error(
    `「${t}」匹配到多个账号，请写得更具体：\n${formatCandidates(hits)}`,
  );

  // ① 完整 key（脚本化调用用得上）
  if (view.accounts[t]) return { key: t, entry: view.accounts[t] };

  // ② userId 精确
  const byUserId = list.filter((a) => a.entry.userId === t);
  if (byUserId.length === 1) return byUserId[0];
  if (byUserId.length > 1) throw ambiguous(byUserId);

  // ③ email 精确（忽略大小写）
  const lower = t.toLowerCase();
  const byEmail = list.filter((a) => String(a.entry.email || '').toLowerCase() === lower);
  if (byEmail.length === 1) return byEmail[0];
  if (byEmail.length > 1) throw ambiguous(byEmail);

  // ④ 展示序号（1 起）——**必须排在子串匹配之前**：交互选择器回传的就是数字串，
  //    而邮箱/用户名里出现同一串数字是常事（alice2@x.com 里的 "2"），
  //    先跑子串就会把「照着屏幕敲的 2」解析成另一个账号——切错人比报错危险得多。
  if (/^\d+$/.test(t)) {
    const idx = Number.parseInt(t, 10);
    if (idx >= 1 && idx <= list.length) return list[idx - 1];
    throw new Error(`序号 ${idx} 超出范围（本机共 ${list.length} 个账号）`);
  }

  // ⑤ 子串：email / username / nickname
  const bySub = list.filter((a) => [a.entry.email, a.entry.username, a.entry.nickname]
    .some((v) => String(v || '').toLowerCase().includes(lower)));
  if (bySub.length === 1) return bySub[0];
  if (bySub.length > 1) throw ambiguous(bySub);

  throw notFound();
}

/**
 * 条目 → flat 补丁。**entry↔flat 的映射只此一处**，login / switch 共用。
 *
 * 空字段一律不下发：绝不把 flat 里已有的值抹白（老字段可能还在被旧版本读取）。
 * clientId 必须在补丁里——loadConfig 的解析顺序是 flags > env > file.clientId >
 * ensureClientId()，切换账号后若不把 clientId 一起打平，serve 会退回机器默认标识，
 * WS register 直接 4401 token_client_mismatch。
 */
function buildFlatSyncPatch(entry) {
  const patch = {};
  if (entry.deviceToken) patch.deviceToken = entry.deviceToken;
  if (entry.sessionKey) patch.sessionKey = entry.sessionKey;
  if (entry.clientId) patch.clientId = entry.clientId;
  if (entry.serverHttp) patch.serverHttp = normalizeServerHttp(entry.serverHttp);
  if (entry.url) patch.url = entry.url;
  if (entry.deviceName) patch.deviceName = entry.deviceName;
  // 身份快照永远写：有效期展示（auth status）统一读 authUser.expiresAt，
  // 刻意不再引入第二个 tokenExpiresAt 字段，免得两处打架。
  patch.authUser = {
    userId: entry.userId,
    email: entry.email || '',
    username: entry.username || '',
    nickname: entry.nickname || '',
    loginAt: entry.loginAt ?? null,
    expiresAt: entry.expiresAt ?? null,
  };
  return patch;
}

/**
 * 运行期字段合并（url / sessionKey / serverHttp / deviceName）——这些是 serve
 * 连上以后会被服务端纠正或更新的字段；patch 里没有的键一律保留原值。
 */
function mergeEntryFields(entry, patch) {
  const next = { ...entry };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v !== undefined && v !== null && v !== '') next[k] = v;
  }
  return next;
}

/** 条目里的令牌是否已过期（没有 expiresAt 的旧条目视为未知 → 不算过期）。 */
function isExpired(entry) {
  const exp = entry && entry.expiresAt;
  return Boolean(exp && exp - Date.now() <= 0);
}

module.exports = {
  normalizeServerHttp,
  accountKey,
  entryKeyOf,
  isUsableEntry,
  withAccounts,
  listAccounts,
  findExact,
  labelOf,
  formatCandidates,
  resolveAccountEntry,
  planLoginClientId,
  buildFlatSyncPatch,
  mergeEntryFields,
  isExpired,
};
