// Standalone, platform-independent pusher for the Robinhood-Chain tokenized-stock
// leaderboards. Runs anywhere Node 18+ is available (GitHub Actions, a VPS, cron).
// It scans the chain directly (public RPC, no API key) and pushes two boards to
// every configured Telegram bot. Completely decoupled from the Surf sandbox, so it
// keeps working even when the studio preview is suspended.

const { loadOnchainFees } = require("./lib/onchainFees");

// ---------------------------------------------------------------------------
// CONFIG — provide these through environment variables / GitHub Secrets.
//   BOT_TOKENS  : comma-separated "token@chatId:Title" (Title optional)
//   WINDOW_MIN  : fee measurement window in minutes (default: 30)
// ---------------------------------------------------------------------------
function loadTargets() {
  const env = process.env.BOT_TOKENS;
  if (!env) throw new Error("BOT_TOKENS is required; configure it as a secret");
  const targets = env.split(",").map((s) => {
    const [tokenPart, rest] = s.trim().split("@");
    const [chatId, ...titleParts] = (rest || "").split(":");
    return { token: tokenPart.trim(), chatId: chatId.trim(), title: titleParts.join(":").trim() || chatId.trim() };
  }).filter((t) => t.token && t.chatId);
  if (!targets.length) throw new Error("BOT_TOKENS contains no valid target");
  return targets;
}

const TOP_N = 20;

// --- formatting (copied from the backend so output is identical) ------------
function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function usd(n) {
  if (n == null || !isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return "$" + (n / 1e3).toFixed(2) + "K";
  if (a >= 1) return "$" + n.toFixed(2);
  return "$" + n.toFixed(4);
}
function pct(n, digits = 2) {
  if (n == null || !isFinite(n)) return "—";
  return n.toFixed(digits) + "%";
}
function fmtTime(ts) {
  try {
    return (
      new Date(ts || Date.now()).toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
      }) + " (北京时间)"
    );
  } catch {
    return new Date().toISOString();
  }
}

// --- shape raw lib output into the two boards (mirrors the backend routes) ---
function buildFeeItems(data) {
  return data.items.slice(0, TOP_N).map((t, i) => ({
    rank: i + 1,
    symbol: t.symbol,
    pair: t.pair,
    price: t.price,
    version: t.hasV3 && t.hasV4 ? "v3+v4" : t.hasV4 ? "v4" : "v3",
    feeWindow: t.fee30m,
    windowVolume: t.windowVolume,
    swaps: t.swaps,
  }));
}
function buildYieldItems(data) {
  return (data.items || [])
    .filter((it) => it.fee30m > 0 && it.tvl && it.tvl >= 1000)
    .map((it) => ({
      pair: it.pair,
      version: it.hasV3 && it.hasV4 ? "v3+v4" : it.hasV4 ? "v4" : "v3",
      feePct: it.feeRate != null ? it.feeRate * 100 : 0,
      dynamic: false,
      tvl: it.tvl,
      fee30m: it.fee30m,
      feePerTvl: it.fee30m / it.tvl,
    }))
    .sort((a, b) => b.feePerTvl - a.feePerTvl || b.fee30m - a.fee30m)
    .slice(0, TOP_N)
    .map((r, i) => ({ rank: i + 1, ...r }));
}

function buildFeesMessage(items, updatedAt) {
  const lines = [];
  lines.push("🏆 <b>代币化股票交易对 · 近半小时手续费榜</b>");
  lines.push("<i>来源：Robinhood 链上 Uniswap v3+v4 Swap 事件 · 口径同官网</i>");
  lines.push("");
  items.forEach((p) => {
    const medal = p.rank === 1 ? "🥇" : p.rank === 2 ? "🥈" : p.rank === 3 ? "🥉" : `${p.rank}.`;
    const ver = (p.version || "").toUpperCase();
    lines.push(`${medal} <b>${esc(p.pair || p.symbol)}</b>${ver ? `  [${esc(ver)}]` : ""}  —  手续费 <b>${usd(p.feeWindow)}</b>/30m`);
    lines.push(`      价格 ${usd(p.price)} · 30m成交 ${usd(p.windowVolume)} · ${p.swaps || 0} 笔`);
  });
  lines.push("");
  lines.push(`⏱ ${fmtTime(updatedAt)}`);
  return lines.join("\n");
}
function buildYieldMessage(items, updatedAt) {
  const lines = [];
  lines.push("💰 <b>代币化股票交易对 · 半小时手续费 / TVL 榜</b>");
  lines.push("<i>来源：Robinhood 链 · Uniswap v3+v4 链上池 · 手续费与 TVL 均链上实测(TVL 同 Uniswap 代币页)</i>");
  lines.push("");
  items.forEach((p) => {
    const medal = p.rank === 1 ? "🥇" : p.rank === 2 ? "🥈" : p.rank === 3 ? "🥉" : `${p.rank}.`;
    const ver = (p.version || "").toUpperCase();
    const rate = `${pct(p.feePct, 3)}${p.dynamic ? "·动态" : ""}`;
    lines.push(`${medal} <b>${esc(p.pair)}</b>  [${esc(ver)}]  —  费/TVL <b>${pct((p.feePerTvl || 0) * 100)}</b>`);
    lines.push(`      费率 ${esc(rate)} · TVL ${usd(p.tvl)} · 手续费 ${usd(p.fee30m)}/30m`);
  });
  lines.push("");
  lines.push(`⏱ ${fmtTime(updatedAt)}`);
  return lines.join("\n");
}

// --- Telegram send ----------------------------------------------------------
async function sendMessage(token, chatId, text) {
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    signal: AbortSignal.timeout(30_000),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`sendMessage failed: ${j.description || r.status}`);
  return j.result?.message_id;
}

async function main() {
  const targets = loadTargets();
  const windowMin = Number(process.env.WINDOW_MIN || 30);
  if (!Number.isInteger(windowMin) || windowMin < 1 || windowMin > 1440) {
    throw new Error("WINDOW_MIN must be an integer between 1 and 1440");
  }
  console.log(`[${new Date().toISOString()}] scanning chain…`);
  const data = await loadOnchainFees({ windowMin });

  const feeItems = buildFeeItems(data);
  const yieldItems = buildYieldItems(data);
  const feeMsg = buildFeesMessage(feeItems, data.updatedAt);
  const yieldMsg = buildYieldMessage(yieldItems, data.updatedAt);
  console.log(`  fee rows=${feeItems.length}  yield rows=${yieldItems.length}  pools=${data.poolsScanned}  swaps=${data.totalSwaps}`);

  let anyFail = false;
  for (const t of targets) {
    try {
      await sendMessage(t.token, t.chatId, feeMsg);
      await sendMessage(t.token, t.chatId, yieldMsg);
      console.log(`  -> ${t.title}: ok`);
    } catch (e) {
      anyFail = true;
      console.error(`  -> ${t.title}: FAILED ${e.message}`);
    }
  }
  if (anyFail) process.exit(1);
  console.log("done.");
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
