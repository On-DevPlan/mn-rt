'use strict';

/**
 * 统一登录接入层（auth-hub / OIDC 依赖方）+ 设备注册表。
 *
 * ── 为什么这里不引任何新依赖 ────────────────────────────────────────────
 * 服务端原本只有 `ws` 一个依赖。为接入 SSO 拉进 node-oidc-provider / jsonwebtoken
 * 之类，等于给一个哑路由中转服务加上整条供应链。Node 22 的全局 fetch + 内置
 * crypto 足够，且实现面小到可以逐行审。
 *
 * ── 为什么身份用 sub 而不是邮箱 ─────────────────────────────────────────
 * dev_ctr_hello 那边"邮箱优先、sub 只作辅助"是**因为它有一批邮箱密码注册的存量账号**，
 * 顺序反了会把老用户导流到新空账号。本服务没有任何存量账号表，
 * 设备归属是一个全新的关系，所以直接拿认证中心的 `sub` 当 userId：
 * 它是认证中心内部的主键、稳定、且不需要我们复刻一套认领与改绑逻辑。
 * 邮箱只用于展示。**不要照抄邮箱优先** —— 那条规则的前提在这里不存在。
 *
 * ── 为什么不验 id_token 签名 ────────────────────────────────────────────
 * 换到 access_token 后直接 GET 认证中心的 /oauth2/userinfo，让**认证中心自己**
 * 断言"这是谁"。手写 JWKS + RS256 验签是一大片容易静默出错的面（密钥轮换、
 * alg 混淆、aud/iss 漏检），而这里服务端到服务端一跳就能拿到同样的结论。
 *
 * ── 认证中心的 token 一律不持久化 ───────────────────────────────────────
 * 换到的 access_token / refresh_token 只在这一次请求的内存里用于取身份，
 * 用完即弃、不落库不落盘。本服务自己签发的是**设备令牌**（下面 issueDeviceToken），
 * 它是可吊销的本地凭据，与认证中心的凭据是两回事。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** 设备令牌有效期（秒）。30 天，与业务侧惯例一致；到期 CLI 重新 auth login。 */
const DEVICE_TOKEN_TTL_SEC = 30 * 24 * 3600;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlJson(obj) {
  return b64url(Buffer.from(JSON.stringify(obj), 'utf8'));
}
function fromB64url(s) {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(t + '='.repeat((4 - (t.length % 4)) % 4), 'base64');
}

class AuthHub {
  /**
   * @param {object} opts
   * @param {boolean} opts.enabled        关闭时所有判据短路，绝不碰网络
   * @param {string}  opts.issuer        必须与认证中心 IDP_ISSUER 逐字一致
   * @param {string}  opts.clientId      本服务在认证中心注册的 public client
   * @param {string}  opts.redirectUri   授权回调地址，须在白名单内
   * @param {string[]} opts.scopes
   * @param {string}  opts.jwtSecret     设备令牌签名密钥（HS256）
   * @param {string}  opts.deviceFile    设备注册表落盘路径
   * @param {object}  opts.logger
   * @param {number}  opts.httpTimeoutMs
   */
  constructor(opts) {
    this.enabled = !!opts.enabled;
    this.issuer = (opts.issuer || '').replace(/\/+$/, '');
    this.clientId = opts.clientId || '';
    this.redirectUri = opts.redirectUri || '';
    this.scopes = (opts.scopes && opts.scopes.length ? opts.scopes : ['openid', 'profile', 'email']);
    this.jwtSecret = opts.jwtSecret || '';
    this.deviceFile = opts.deviceFile || null;
    this.logger = opts.logger || console;
    this.httpTimeoutMs = opts.httpTimeoutMs || 10_000;

    /** 发现文档缓存。只有成功才固化——失败若被记住，
     *  容器编排下"本服务先于认证中心启动"会让统一登录永久不可用直到重启。 */
    this._endpoints = null;

    /** clientId -> {userId, email, deviceName, pubkey, registeredAt, lastSeenAt} */
    this.devices = new Map();
    this._loadDevices();
  }

  // ==================== 配置与发现 ====================

  /** 下发给客户端的公开参数。**绝不含任何 secret**。 */
  publicConfig() {
    const e = this._endpoints;
    return {
      enabled: this.enabled,
      issuer: this.issuer,
      clientId: this.clientId,
      redirectUri: this.redirectUri,
      scopes: this.scopes,
      authorizationEndpoint: e ? e.authorization_endpoint : `${this.issuer}/oauth2/auth`,
      endSessionEndpoint: e ? e.end_session_endpoint : `${this.issuer}/oauth2/logout`,
      idpAvailable: !!e,
      ...(e ? {} : { idpError: this._discoverError || '未拉取到发现文档' }),
    };
  }

  /** 拉发现文档。失败不缓存（见上）。 */
  async discover() {
    if (!this.enabled) {
      const err = new Error('统一登录未启用');
      err.code = 'disabled';
      throw err;
    }
    if (this._endpoints) return this._endpoints;
    const url = `${this.issuer}/.well-known/openid-configuration`;
    // 失败原因一定要留在身上再抛出。/auth/oidc/config 常常是这件事唯一被看到的
    // 入口：容器日志人进不去、也没有 UI，如果这里只报"拉不到"，
    // 那 DNS 失败、出网被防火墙掐、issuer 端口写错、对方返回 HTML
    // 这四种完全不同的病就只能靠猜。（真实踩过：线上就卡在这里查不下去。）
    let doc;
    try {
      doc = await this._fetchJson(url, { method: 'GET' });
    } catch (e) {
      this._discoverError = `${e.message || e}（拉取 ${url}）`;
      this.logger.warn?.('拉取认证中心发现文档失败', { url, error: this._discoverError });
      throw e;
    }
    if (!doc || !doc.token_endpoint || !doc.authorization_endpoint) {
      this._discoverError = `发现文档缺少 authorization_endpoint / token_endpoint（${url}）`;
      this.logger.warn?.(this._discoverError);
      throw new Error(this._discoverError);
    }
    this._endpoints = doc;
    this._discoverError = null;
    this.logger.info?.('已连接统一认证中心', { issuer: this.issuer, authorize: doc.authorization_endpoint });
    return doc;
  }

  // ==================== 授权码 → 身份 ====================

  /**
   * 用授权码 + PKCE verifier 换身份。
   * 返回 {userId, sub, email, name, preferredUsername}；失败抛错。
   */
  async exchange({ code, codeVerifier, redirectUri }) {
    if (!this.enabled) throw Object.assign(new Error('统一登录未启用'), { code: 'disabled' });
    if (!code || !codeVerifier) throw Object.assign(new Error('缺少 code / codeVerifier'), { code: 'bad_request' });

    const doc = await this.discover();
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: this.clientId,
      redirect_uri: redirectUri || this.redirectUri,
      code_verifier: codeVerifier,
    });

    const tok = await this._fetchJson(doc.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (tok.error) {
      throw Object.assign(new Error(`换 token 被拒: ${tok.error} ${tok.error_description || ''}`.trim()),
        { code: tok.error });
    }
    if (!tok.access_token) throw Object.assign(new Error('令牌响应缺少 access_token'), { code: 'no_access_token' });

    // 让认证中心自己断言身份。用完即弃：这两个 token 都不进任何存储。
    const ui = await this._fetchJson(doc.userinfo_endpoint || `${this.issuer}/oauth2/userinfo`, {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    if (!ui || !ui.sub) throw Object.assign(new Error('userinfo 未返回 sub'), { code: 'no_sub' });

    return {
      userId: String(ui.sub),
      sub: String(ui.sub),
      email: ui.email || '',
      name: ui.name || '',
      preferredUsername: ui.preferred_username || '',
    };
  }

  /**
   * 校验一枚**认证中心**的 access_token，返回身份。
   *
   * 给 PC CLI 用：CLI 自己走 PKCE + 回环收到 code、自己换到 access_token，
   * 然后拿它来这里换设备令牌。这样 CLI 全程不需要用户复制粘贴任何码。
   *
   * 与 exchange() 的分工：exchange 是"我有 code，服务器你帮我换"，
   * verifyBearer 是"我有 token，服务器你帮我确认是谁"。两条路最终都收敛到
   * 同一个结论——认证中心自己断言的 sub，所以属主判定只有一份实现。
   */
  async verifyBearer(accessToken) {
    if (!accessToken) throw Object.assign(new Error('缺少 access_token'), { code: 'bad_request' });
    const doc = await this.discover();
    const ui = await this._fetchJson(doc.userinfo_endpoint || `${this.issuer}/oauth2/userinfo`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!ui || ui.error) {
      throw Object.assign(new Error(`令牌无效: ${ui && ui.error ? ui.error : '无 sub'}`),
        { code: (ui && ui.error) || 'invalid_token' });
    }
    if (!ui.sub) throw Object.assign(new Error('userinfo 未返回 sub'), { code: 'no_sub' });
    return {
      userId: String(ui.sub),
      sub: String(ui.sub),
      email: ui.email || '',
      name: ui.name || '',
      preferredUsername: ui.preferred_username || '',
    };
  }

  // ==================== 设备令牌（本服务自己的凭据） ====================

  /**
   * 签发设备令牌。HS256 JWT，payload 带 userId 与 clientId。
   *
   * 吊销靠下面的 revoked 名单而不是缩短有效期：JWT 本身无法作废，
   * 所以每次校验都要查一次名单 —— 否则"吊销"只是句空话。
   */
  issueDeviceToken({ userId, clientId, deviceName }) {
    if (!this.jwtSecret) throw Object.assign(new Error('未配置 RT_AUTH_JWT_SECRET'), { code: 'no_secret' });
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'HS256', typ: 'JWT' };
    const payload = {
      sub: userId,
      cid: clientId,
      dn: deviceName || '',
      iat: now,
      exp: now + DEVICE_TOKEN_TTL_SEC,
      // jti 让单枚令牌可被单独吊销（重新 auth login 会发新的）
      jti: crypto.randomBytes(9).toString('hex'),
    };
    const head = b64urlJson(header);
    const body = b64urlJson(payload);
    const sig = b64url(crypto.createHmac('sha256', this.jwtSecret).update(`${head}.${body}`).digest());
    return { token: `${head}.${body}.${sig}`, expiresAt: (now + DEVICE_TOKEN_TTL_SEC) * 1000, jti: payload.jti };
  }

  /** 校验设备令牌。返回 payload 或 null。 */
  verifyDeviceToken(token) {
    if (!this.jwtSecret || !token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [head, body, sig] = parts;
    const want = b64url(crypto.createHmac('sha256', this.jwtSecret).update(`${head}.${body}`).digest());
    // 常量时间比较：这里比的是"能不能冒充某个用户的一台电脑"
    const a = Buffer.from(sig);
    const b = Buffer.from(want);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let payload;
    try { payload = JSON.parse(fromB64url(body).toString('utf8')); } catch { return null; }
    if (!payload || !payload.sub) return null;
    if (typeof payload.exp !== 'number' || Math.floor(Date.now() / 1000) >= payload.exp) return null;
    if (this._isRevoked(payload.jti)) return null;
    return payload;
  }

  /**
   * 吊销某枚令牌。
   *
   * 名单本身要落盘：否则重启即"全部恢复"，而吊销通常恰恰是因为设备丢了。
   * 这里用带 TTL 的名单——过期的令牌本来就不再被接受，不必永久占位。
   */
  revoke(jti) {
    if (!jti) return;
    this.revoked = this.revoked || new Map();
    this.revoked.set(jti, Date.now() + DEVICE_TOKEN_TTL_SEC * 1000);
    this._saveDevices();
  }

  _isRevoked(jti) {
    if (!this.revoked || !jti) return false;
    const until = this.revoked.get(jti);
    if (until == null) return false;
    if (Date.now() > until) { this.revoked.delete(jti); return false; }
    return true;
  }

  // ==================== 设备注册表（clientId → 属主） ====================

  /**
   * 登记/更新一台 PC。
   *
   * `sessionKey` 是这台电脑的**会话密钥**，取代原来人手传过去的配对 key：
   * 服务端生成（或由 PC 自带）、持久化、只发给两个地方——
   * 该设备自己（register 的 ack）与它的属主（/my/devices）。
   * 两端拿到同一个值，喂进现有的 PBKDF2→HKDF 派生链，
   * 于是 rt-crypto / RT1 信封协议**一行都不用改**，变的只是密钥怎么到手里。
   *
   * 稳定性是刻意的：密钥一旦生成就固定下来，PC 重启、换 clientId 都不重生成——
   * 否则手机端已缓存的密钥会突然对不上，表现为"连上但全部信封被静默丢弃"，
   * 那是最难排查的一类故障（README 里已经写了这个症状）。
   *
   * ── 返回值为什么是 {rec, rejected} 而不是直接返回记录 ──────────────────
   * 换绑被拒时，`rec` 仍是**真属主**的那条记录，里面带着真的 sessionKey。
   * 早先这里直接返回 `{...prev}`，于是 `/auth/verify` 与 register 的 ack
   * 会把受害者电脑的会话密钥发给攻击者——拿到它就能向那台电脑注入文本，
   * 整套属主校验当场归零。把"被拒"做成一个必须显式读取的标志位，
   * 调用方就不可能"顺手"把 rec 当自己的设备信息回出去（编译器帮不了，
   * 但 `.rejected` 摆在那儿，漏掉它需要同时无视字段名与本函数的注释）。
   *
   * @returns {{rec: object, rejected: boolean}} rejected=true 表示该 clientId 属他人，
   *          本次未写入任何数据，rec 只可用于展示"归属在谁那里"，**不得**下发密钥。
   */
  upsertDevice({ clientId, userId, email, deviceName, sessionKey }) {
    if (!clientId || !userId) return { rec: null, rejected: false };
    const prev = this.devices.get(clientId) || {};
    // 换绑保护：已绑定过且属主不同 → 拒绝，且绝不回写任何字段
    if (prev.userId && prev.userId !== String(userId)) {
      this.logger.warn?.('拒绝设备换绑尝试', {
        clientId, boundOwner: prev.userId, attemptedOwner: String(userId),
      });
      return { rec: { ...prev, lastSeenAt: prev.lastSeenAt }, rejected: true };
    }
    const now = new Date().toISOString();
    const rec = {
      clientId,
      userId: String(userId),
      email: email ?? prev.email ?? '',
      deviceName: deviceName || prev.deviceName || clientId,
      sessionKey: prev.sessionKey || sessionKey || crypto.randomBytes(32).toString('hex'),
      ownerBoundAt: prev.ownerBoundAt && prev.userId === String(userId) ? prev.ownerBoundAt : (prev.ownerBoundAt || now),
      registeredAt: prev.registeredAt || now,
      lastSeenAt: now,
    };
    this.devices.set(clientId, rec);
    this._saveDevices();
    return { rec, rejected: false };
  }

  /** 只换会话密钥（PC 主动要求重置时调）。 */
  rotateSessionKey(clientId) {
    const d = this.devices.get(clientId);
    if (!d) return null;
    d.sessionKey = crypto.randomBytes(32).toString('hex');
    this._saveDevices();
    return d;
  }

  getDevice(clientId) { return this.devices.get(clientId) || null; }

  /** 只返回属于该 userId 的设备。跨用户不可见是这套设计的核心约束。 */
  listDevicesByUser(userId) {
    const uid = String(userId);
    return [...this.devices.values()].filter((d) => String(d.userId) === uid);
  }

  // ==================== 持久化 ====================

  _loadDevices() {
    this.revoked = new Map();
    if (!this.deviceFile || !fs.existsSync(this.deviceFile)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.deviceFile, 'utf8'));
      for (const d of raw.devices || []) if (d && d.clientId) this.devices.set(d.clientId, d);
      for (const [jti, until] of Object.entries(raw.revoked || {})) this.revoked.set(jti, until);
    } catch (e) {
      // 注册表读坏绝不能让服务起不来：宁可退化成"需要重新登记"，
      // 也不要一个损坏的 json 把整个中转服务打挂。
      this.logger.warn?.('设备注册表解析失败，按空表启动', { error: e.message });
      this.devices = new Map();
    }
  }

  _saveDevices() {
    if (!this.deviceFile) return;
    const tmp = `${this.deviceFile}.tmp`;
    const payload = {
      version: 1,
      devices: [...this.devices.values()],
      revoked: Object.fromEntries(this.revoked || []),
    };
    fs.mkdirSync(path.dirname(this.deviceFile), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, this.deviceFile); // 原子替换，防写一半被读到
  }

  // ==================== HTTP ====================

  async _fetchJson(url, init = {}) {
    if (!this.enabled) throw Object.assign(new Error('统一登录未启用'), { code: 'disabled' });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.httpTimeoutMs);
    try {
      const resp = await fetch(url, { ...init, signal: ctrl.signal });
      const text = await resp.text();
      if (!text) throw Object.assign(new Error(`响应为空 (HTTP ${resp.status})`), { code: 'empty_response' });
      try {
        return JSON.parse(text);
      } catch {
        // 网关返回 HTML 错误页时会落到这里。必须单独成类，
        // 否则上层把它当"认证中心拒绝了我"处理，方向完全错。
        throw Object.assign(
          new Error(`响应不是 JSON (HTTP ${resp.status}): ${text.slice(0, 120)}`),
          { code: 'bad_response' },
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { AuthHub, DEVICE_TOKEN_TTL_SEC };
