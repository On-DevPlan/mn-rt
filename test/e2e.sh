#!/usr/bin/env bash
#
# RemoteType 端到端测试脚本
#
# 覆盖需求文档第 7 章的测试用例：
#   1. 正向链路（手机 → 服务端 → 客户端 → 窗口）
#   2. 本地单测（remotetype test）
#   3. 子进程崩溃容错（kill Rust，自动重启）
#   4. 队列串行（连发多条，顺序不乱）
#   5. 异常文本过滤（空 / 控制字符）
#   6. 长文本分片（无丢字、无错误字符映射）
#
# 依赖：Xvfb、xev、xdotool（Linux）。macOS/Windows 请参考 README 手工验证。
#
# 用法：
#   bash test/e2e.sh            # 全部用例（推荐，一次跑完最快）
#   bash test/e2e.sh 2 6        # 只跑指定用例
#
# 说明：用例 3/4/5 依赖用例 1 建立的客户端长连接，因此 1 会随它们自动启用。
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLIENT="$ROOT/client"
SERVER="$ROOT/server"
WORK="${RT_E2E_WORK:-/tmp/rt-e2e}"
PORT="${RT_E2E_PORT:-8899}"
DISP="${RT_E2E_DISPLAY:-:99}"
CLIENT_ID="pc-e2e"

PASS=0; FAIL=0; SKIP=0
C_G=$'\033[32m'; C_R=$'\033[31m'; C_Y=$'\033[33m'; C_B=$'\033[1m'; C_0=$'\033[0m'

# 所有输出同时写入结果文件，便于脚本结束后回溯（终端被回收也不丢结果）
RESULT_FILE="${RT_E2E_RESULT:-/tmp/rt-e2e-result.txt}"
exec > "$RESULT_FILE" 2>&1

pass() { PASS=$((PASS+1)); echo "  ${C_G}✓ PASS${C_0} $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ${C_R}✗ FAIL${C_0} $1"; }
skip() { SKIP=$((SKIP+1)); echo "  ${C_Y}- SKIP${C_0} $1"; }
head2() { echo; echo "${C_B}== $1 ==${C_0}"; }

SRV_PID=""; CLI_PID=""; XEV_WIN=""; XEV_PID=""; XVFB_PID=""
cleanup() {
  [[ -n "$CLI_PID" ]] && kill "$CLI_PID" 2>/dev/null
  [[ -n "$SRV_PID" ]] && kill "$SRV_PID" 2>/dev/null
  # 子进程是 setsid/独立会话，kill 父进程不会自动带走，必须显式回收，
  # 否则残留进程会持续占用 X11 客户端连接与键盘焦点，污染后续用例。
  pkill -f "$ROOT/client/binaries/" 2>/dev/null
  pkill -f "$ROOT/server/src/server.js" 2>/dev/null
  pkill -f "$ROOT/client/bin/index.js" 2>/dev/null
  [[ -n "$XEV_PID" ]] && kill "$XEV_PID" 2>/dev/null
  pkill -f "xev -geometry" 2>/dev/null
  # 私有 Xvfb 随脚本一起销毁，避免污染下一次运行的 X server 状态
  [[ -n "${XVFB_PID:-}" ]] && kill "$XVFB_PID" 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT

# 前置清理：上次运行残留的进程会抢占焦点/连接，必须先清干净
pkill -f "xev -geometry" 2>/dev/null
pkill -f "input-agent" 2>/dev/null
pkill -f "bin/index.js" 2>/dev/null
pkill -f "server/src/server.js" 2>/dev/null
sleep 1

mkdir -p "$WORK"; rm -rf "$WORK"/* 2>/dev/null

# ---------- 环境检查 ----------
head2 "环境检查"
for c in Xvfb xev xdotool python3 curl; do
  command -v "$c" >/dev/null 2>&1 || { echo "${C_R}缺少 $c${C_0}"; exit 1; }
done
echo "  ✓ 依赖工具齐全 (Xvfb / xev / xdotool / python3 / curl)"

# 每次运行都应使用「干净」的 X server。
# 复用外部已存在的 Xvfb 是有害的：长期运行/反复开关客户端后，
# X server 的 client 资源会退化，新建连接会以
#   "no connection could be established: (no successful connection)"
# 失败（但 xdpyinfo 仍正常响应，健康检查无法察觉）。
# 因此这里总是拉起一个私有 Xvfb，只在本脚本生命周期内使用。
if [[ "${RT_E2E_REUSE_DISPLAY:-0}" != "1" ]]; then
  pkill -f "Xvfb $DISP " 2>/dev/null
  sleep 1
fi
if ! DISPLAY="$DISP" xdpyinfo >/dev/null 2>&1; then
  Xvfb "$DISP" -screen 0 1280x800x24 -nolisten tcp >"$WORK/xvfb.log" 2>&1 &
  XVFB_PID=$!
  sleep 2
fi
# 必须 export：注入引擎（Rust 子进程）依赖 DISPLAY 建立 X11 连接
export DISPLAY="$DISP"
xdpyinfo >/dev/null 2>&1 || { echo "${C_R}Xvfb 启动失败${C_0}"; exit 1; }

# X server 可用性自检：真正验证「能否建立新的客户端连接」。
# xdpyinfo 只能证明 server 在跑，不能证明还能接受新连接。
probe_agent() {
  echo '{"action":"type_text","text":"x"}' \
    | timeout 8 "$ROOT/client/binaries/linux-x64/input-agent" 2>/dev/null \
    | grep -q '"ok":true'
}
echo "  ✓ Xvfb 运行于 $DISPLAY"
# 主动清除 Wayland 标记，避免影响会话判定（enigo 不支持 Wayland）
unset WAYLAND_DISPLAY 2>/dev/null || true


AGENT="$CLIENT/binaries/linux-x64/input-agent"
if [[ ! -x "$AGENT" ]]; then
  echo "  未找到预编译二进制，本地编译中…"
  ( cd "$ROOT/rust/input-agent" && cargo build --release --features linux-x11 ) >"$WORK/cargo.log" 2>&1 \
    || { echo "${C_R}编译失败，见 $WORK/cargo.log${C_0}"; exit 1; }
  mkdir -p "$(dirname "$AGENT")"
  cp "$ROOT/rust/input-agent/target/release/input-agent" "$AGENT"
fi
echo "  ✓ 注入引擎就绪：$AGENT"

# X server 连接自检：xdpyinfo 只能证明 server 在跑，不能证明还能接受新连接。
# 这里用真实注入做探测，若失败则换一个全新的 Xvfb 重来。
if ! probe_agent; then
  echo "  ${C_Y}当前 X server 无法建立注入连接，重建 Xvfb…${C_0}"
  pkill -f "Xvfb $DISP " 2>/dev/null
  sleep 1
  Xvfb "$DISP" -screen 0 1280x800x24 -nolisten tcp >"$WORK/xvfb.log" 2>&1 &
  XVFB_PID=$!
  sleep 2
  export DISPLAY="$DISP"
  xdpyinfo >/dev/null 2>&1 || { echo "${C_R}Xvfb 重建失败${C_0}"; exit 1; }
  probe_agent || { echo "${C_R}X server 不可用于字符注入${C_0}"; exit 1; }
fi
echo "  ✓ 注入连接自检通过"

# ---------- 观测窗口 ----------
# 全局复用同一个 xev 窗口，日志按「字节偏移」切片，避免反复创建窗口带来的等待
XV="$WORK/xev.log"; : > "$XV"
# 注意：必须让 xev 完全脱离本脚本的 stdout/stderr。
# 否则 xev 会继承脚本的输出管道（例如 `bash e2e.sh | head`），
# 即使脚本结束，管道写端仍被 xev 持有，导致调用方的 head/cat 永不收到 EOF 而挂住。
setsid xev -geometry 400x400 >"$XV" 2>&1 </dev/null &
XEV_PID=$!
disown 2>/dev/null || true
sleep 1
XEV_WIN=$(xwininfo -root -children 2>/dev/null | grep "Event Tester" | head -1 | awk '{print $1}')
if [[ -z "$XEV_WIN" ]]; then echo "${C_R}无法创建观测窗口${C_0}"; exit 1; fi
xdotool windowfocus --sync "$XEV_WIN" >/dev/null 2>&1
sleep 1
cur=$(xdotool getwindowfocus 2>/dev/null)
if [[ "$cur" != "$((XEV_WIN))" ]]; then echo "${C_R}无法聚焦观测窗口${C_0}"; exit 1; fi
echo "  ✓ 观测窗口就绪 (win $XEV_WIN)"

# 读取「自标记位置起」收到的字符
mark() { wc -c < "$XV"; }

# 焦点自愈：某些用例（尤其是 kill 出来的孤儿进程）可能抢走键盘焦点，
# 导致注入的字符落到别处而观测窗口收不到。注入前统一把焦点拉回来。
refocus() {
  for _ in 1 2 3; do
    xdotool windowfocus --sync "$XEV_WIN" >/dev/null 2>&1
    xdotool windowactivate --sync "$XEV_WIN" >/dev/null 2>&1
    [[ "$(xdotool getwindowfocus 2>/dev/null)" == "$((XEV_WIN))" ]] && return 0
    sleep 0.5
  done
  xdotool windowraise "$XEV_WIN" >/dev/null 2>&1
  return 1
}
decode_since() {
  tail -c +"$(( $1 + 1 ))" "$XV" | python3 -c '
import re, sys
log = sys.stdin.read()
ev = re.findall(r"KeyPress event.*?keysym (0x[0-9a-f]+), (\S+)\)", log, re.S)
out = []
for code, name in ev:
    cp = int(code, 16)
    if cp >= 0x1000000: out.append(chr(cp - 0x1000000))   # Unicode keysym
    elif cp < 0x100:    out.append(chr(cp))               # Latin-1
    elif cp == 0x4a1:   out.append("\u3002_FAILED")       # 已知错误映射
    else:               out.append("<0x%x>" % cp)
sys.stdout.write("".join(out))
'
}

RUN="${*:-1 2 3 4 5 6}"
# 用例 3/4/5 依赖用例 1 的客户端
for d in 3 4 5; do
  if [[ " $RUN " == *" $d "*  && " $RUN " != *" 1 "* ]]; then RUN="1 $RUN"; fi
done
want() { [[ " $RUN " == *" $1 "* ]]; }

# ============================================================
if want 1; then
  head2 "用例 1：正向链路（服务端 → 客户端 → 窗口）"
  RT_PORT="$PORT" RT_LOG_DIR="$WORK/srv-logs" RT_RECORD_FILE="$WORK/records.jsonl" \
    node "$SERVER/src/server.js" >"$WORK/server.log" 2>&1 &
  SRV_PID=$!
  sleep 1
  if ! curl -sf "http://127.0.0.1:$PORT/health" >/dev/null; then
    fail "服务端未就绪（见 $WORK/server.log）"
  else
    pass "服务端已启动并响应 /health"

    REMOTETYPE_HOME="$WORK/home" REMOTETYPE_URL="ws://127.0.0.1:$PORT/ws" \
      REMOTETYPE_CLIENT_ID="$CLIENT_ID" \
      node "$CLIENT/bin/index.js" serve --plain >"$WORK/client.log" 2>&1 &
    CLI_PID=$!
    sleep 3

    if curl -s "http://127.0.0.1:$PORT/clients" | grep -q "$CLIENT_ID"; then
      pass "客户端已注册到服务端（clientId=$CLIENT_ID）"
    else
      fail "客户端未完成注册"
    fi

    refocus || fail "焦点未能锁定观测窗口"

    M=$(mark)
    TXT="正向链路测试：Hello 你好世界 12345"
    RESP=$(curl -s -X POST "http://127.0.0.1:$PORT/push" -H 'Content-Type: application/json' \
           -d "{\"clientId\":\"$CLIENT_ID\",\"text\":\"$TXT\"}")
    sleep 3
    GOT=$(decode_since "$M")
    if [[ "$GOT" == "$TXT" ]]; then
      pass "文本完整送达（$(python3 -c "print(len('$TXT'))") 字符，含中文与 ASCII）"
    else
      fail "文本不一致"; echo "      期望: $TXT"; echo "      实际: $GOT"
    fi
    [[ "$RESP" == *'"status":"forwarded"'* ]] && pass "服务端返回 forwarded" || fail "响应异常: $RESP"
    grep -q '"status":"forwarded"' "$WORK/records.jsonl" 2>/dev/null \
      && pass "服务端转录记录已落盘" || fail "服务端记录缺失"
    grep -q '"status":"injected"' "$WORK/home/data/records.jsonl" 2>/dev/null \
      && pass "客户端转录记录已落盘" || fail "客户端记录缺失"
  fi
fi

# ============================================================
if want 2; then
  head2 "用例 2：本地单测（remotetype test，不走公网）"
  refocus || fail "焦点未能锁定观测窗口"
  M=$(mark)
  TXT="本地单测：中文标点。顿号、「引号」"
  OUT=$(REMOTETYPE_HOME="$WORK/home2" timeout 60 node "$CLIENT/bin/index.js" test "$TXT" 2>&1)
  sleep 2
  GOT=$(decode_since "$M")
  [[ "$OUT" == *"注入成功"* ]] && pass "命令返回成功" || { fail "命令失败"; echo "$OUT" | head -5; }
  if [[ "$GOT" == "$TXT" ]]; then
    pass "文本完整送达（含中文标点 。、「」）"
  else
    fail "文本不一致"; echo "      期望: $TXT"; echo "      实际: $GOT"
  fi
fi

# ============================================================
if want 3; then
  head2 "用例 3：子进程崩溃容错（kill 后自动重启）"
  RPID=$(pgrep -f "$AGENT" | head -1)
  if [[ -z "$RPID" ]]; then
    fail "未找到 Rust 子进程"
  else
    kill -9 "$RPID" 2>/dev/null
    sleep 3
    grep -q "restarting input-agent" "$WORK/client.log" 2>/dev/null \
      && pass "检测到子进程崩溃并触发重启" || fail "未记录重启日志"
    NEWP=$(pgrep -f "$AGENT" | head -1)
    if [[ -n "$NEWP" && "$NEWP" != "$RPID" ]]; then
      pass "新子进程已自动拉起 (pid $NEWP，原 $RPID)"
    else
      fail "子进程未重启"
    fi
    refocus || fail "焦点未能锁定观测窗口"
    M=$(mark)
    TXT="崩溃恢复后仍可注入"
    curl -s -X POST "http://127.0.0.1:$PORT/push" -H 'Content-Type: application/json' \
      -d "{\"clientId\":\"$CLIENT_ID\",\"text\":\"$TXT\"}" >/dev/null
    sleep 3
    GOT=$(decode_since "$M")
    [[ "$GOT" == "$TXT" ]] && pass "崩溃恢复后注入正常" || { fail "恢复后注入异常"; echo "      实际: $GOT"; }
  fi
fi

# ============================================================
if want 4; then  head2 "用例 4：队列串行（连发 5 条，顺序不乱）"
  refocus || fail "焦点未能锁定观测窗口"
  M=$(mark)
  for i in 1 2 3 4 5; do
    curl -s -X POST "http://127.0.0.1:$PORT/push" -H 'Content-Type: application/json' \
      -d "{\"clientId\":\"$CLIENT_ID\",\"text\":\"序号${i}；\"}" >/dev/null
  done
  sleep 6
  GOT=$(decode_since "$M")
  EXPECT="序号1；序号2；序号3；序号4；序号5；"
  [[ "$GOT" == "$EXPECT" ]] && pass "5 条消息严格按序注入，无交叉乱序" \
    || { fail "顺序异常"; echo "      期望: $EXPECT"; echo "      实际: $GOT"; }
fi

# ============================================================
if want 5; then
  head2 "用例 5：异常文本过滤（空 / 控制字符）"
  R1=$(curl -s -X POST "http://127.0.0.1:$PORT/push" -H 'Content-Type: application/json' \
       -d "{\"clientId\":\"$CLIENT_ID\",\"text\":\"\"}")
  [[ "$R1" == *'rejected_empty'* ]] && pass "空文本被拒" || fail "空文本未拦截: $R1"

  R2=$(curl -s -X POST "http://127.0.0.1:$PORT/push" -H 'Content-Type: application/json' \
       -d "{\"clientId\":\"$CLIENT_ID\",\"text\":\"   \"}")
  [[ "$R2" == *'rejected_empty'* ]] && pass "纯空白被拒" || fail "纯空白未拦截: $R2"

  R3=$(curl -s -X POST "http://127.0.0.1:$PORT/push" -H 'Content-Type: application/json' \
       -d "{\"clientId\":\"pc-nonexistent\",\"text\":\"离线目标\"}")
  [[ "$R3" == *'target_offline'* ]] && pass "目标 PC 离线时正确告警" || fail "离线处理异常: $R3"

  # 含不可见控制字符：应过滤后注入可见部分
  refocus || fail "焦点未能锁定观测窗口"
  M=$(mark)
  python3 -c "
import json
open('$WORK/ctrl.json','w').write(json.dumps({'clientId':'$CLIENT_ID','text':'可见\u0007\u001b文字'}))
"
  curl -s -X POST "http://127.0.0.1:$PORT/push" -H 'Content-Type: application/json' \
    --data-binary @"$WORK/ctrl.json" >/dev/null
  sleep 3
  GOT=$(decode_since "$M")
  [[ "$GOT" == "可见文字" ]] && pass "不可见控制字符被过滤，可见部分正常注入" \
    || { fail "控制字符处理异常"; echo "      期望: 可见文字"; echo "      实际: $GOT"; }
fi

# ============================================================
if want 6; then
  head2 "用例 6：长文本分片（无丢字、无错误映射）"
  # 用例 6 自带独立的注入引擎（remotetype test），先回收常驻客户端与其 Rust 子进程：
  # 否则它们会持续占用 X11 客户端连接（X server 槽位有限），
  # 新引擎会以 "enigo init failed: no connection could be established" 启动失败。
  [[ -n "$CLI_PID" ]] && { kill "$CLI_PID" 2>/dev/null; CLI_PID=""; }
  pkill -f "$ROOT/client/binaries/" 2>/dev/null
  pkill -f "$ROOT/client/bin/index.js" 2>/dev/null
  sleep 1
  python3 -c "
import json
t = '这是一段用于验证长文本分片注入的中文段落。' * 12
open('$WORK/long.json','w').write(json.dumps({'text': t}))
"
  LEN=$(python3 -c "import json;print(len(json.load(open('$WORK/long.json'))['text']))")
  TEXT=$(python3 -c "import json;print(json.load(open('$WORK/long.json'))['text'])")
  echo "  (文本长度 $LEN 字符，含 12 个中文句号)"
  refocus || fail "焦点未能锁定观测窗口"
  M=$(mark)
  DISPLAY="$DISPLAY" REMOTETYPE_HOME="$WORK/home6" timeout 120 \
    node "$CLIENT/bin/index.js" test "$TEXT" >"$WORK/e2e6.out" 2>&1
  sleep 3
  GOT=$(decode_since "$M")
  GLEN=$(python3 -c "import sys;print(len(sys.argv[1]))" "$GOT")
  [[ "$GLEN" == "$LEN" ]] && pass "长度一致（$LEN 字符）" || fail "长度不符 期望 $LEN / 实际 $GLEN"
  [[ "$GOT" == "$TEXT" ]] && pass "逐字一致，无丢字" || {
    fail "存在丢字或字符错误"
    python3 -c "
import sys
exp, got = sys.argv[1], sys.argv[2]
for i,(a,b) in enumerate(zip(exp,got)):
    if a!=b: print('      首个差异 @%d: %r vs %r' % (i,a,b)); break
print('      期望尾部:', repr(exp[-20:]))
print('      实际尾部:', repr(got[-20:]))
" "$TEXT" "$GOT"
  }
  [[ "$GOT" != *"_FAILED"* ]] && pass "未出现 kana_fullstop 等错误 keysym 映射" \
    || fail "检测到错误 keysym 映射（U+3002 修复失效）"
fi

# ============================================================
echo
echo "${C_B}==================== 汇总 ====================${C_0}"
echo "  ${C_G}通过 $PASS${C_0}    ${C_R}失败 $FAIL${C_0}    ${C_Y}跳过 $SKIP${C_0}"
echo "  工作目录: $WORK"
echo
if [[ "$FAIL" -eq 0 ]]; then echo "${C_G}全部通过 ✅${C_0}"; exit 0; fi
echo "${C_R}存在失败用例 ❌${C_0}"; exit 1
