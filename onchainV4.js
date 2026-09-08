// On-chain fee + TVL measurement for Robinhood Chain Uniswap v4 stock/USDG pools.
//
// v4 is a singleton: every pool lives inside one PoolManager contract and is keyed
// by a bytes32 poolId (a hash of its PoolKey), so there is no per-pool address and
// HoodPools' static registry does not track these pools. We therefore discover the
// stock/USDG v4 pools straight from the chain:
//   1. Read every Swap event the PoolManager emitted in the window (poolId is the
//      first indexed topic) and aggregate per pool.
//   2. Resolve each active pool's two currencies from its Initialize event
//      (currency0/currency1 are indexed) — batched via an array topic filter.
//   3. Keep pools paired with USDG whose other token is a Robinhood tokenized stock
//      (its ERC-20 name ends with "Robinhood Token").
//   4. Fee = USDG volume x the per-swap fee carried in each Swap event; TVL = the
//      pool's real stock reserve (the stock only lives in the PoolManager for v4, so
//      balanceOf(PoolManager) is exact) valued in USD, doubled — a concentrated v4
//      position is balanced in value at the current price, so the USDG side ≈ the
//      stock side (the true USDG split is not isolatable in the shared singleton).

const RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
const PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951"; // v4 PoolManager
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168"; // stablecoin, 6 decimals
const SWAP_TOPIC = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
const INIT_TOPIC = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";
const BLOCKS_PER_SEC = 10;
const SWAP_CHUNK = 1200; // ~2k logs/chunk, stays under the 10k cap

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad32 = (a) => "0x000000000000000000000000" + a.toLowerCase().replace(/^0x/, "");

async function rpc(method, params, tries = 6) {
  for (let i = 0; i < tries; i++) {
    let j;
    try {
      const r = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (r.status === 429 || r.status === 503) { await sleep(500 * (i + 1)); continue; }
      j = await r.json();
    } catch { await sleep(400 * (i + 1)); continue; }
    if (j.error && (j.error.code === 429 || /Too Many|timed out|rate/i.test(j.error.message || ""))) {
      await sleep(500 * (i + 1));
      continue;
    }
    return j;
  }
  return { error: { message: "rpc gave up" } };
}

// This public RPC hard-throttles *batched* eth_call (returns 429 even at batch size
// 10), but serves single calls happily at ~10/s. So every contract read is a single
// paced call with rate-limit retry.
async function callOne(to, data, tries = 5) {
  for (let t = 0; t < tries; t++) {
    const r = await rpc("eth_call", [{ to, data }, "latest"], 1);
    if (r && r.result) return r.result;
    if (r && r.error && (r.error.code === 429 || /Too Many|rate/i.test(r.error.message || ""))) { await sleep(300 * (t + 1)); continue; }
    return null;
  }
  return null;
}
async function callMany(calls, gap = 25) {
  const out = [];
  for (const c of calls) { out.push(await callOne(c.to, c.data)); await sleep(gap); }
  return out;
}

function toInt(word) {
  let n = BigInt("0x" + word);
  const MAX = 1n << 255n, MOD = 1n << 256n;
  if (n >= MAX) n -= MOD;
  return n;
}
function decodeString(hex) {
  try {
    const h = hex.slice(2);
    const len = parseInt(h.slice(64, 128), 16);
    return Buffer.from(h.slice(128, 128 + len * 2), "hex").toString("utf8");
  } catch { return ""; }
}
// stock USD price from sqrtPriceX96 (same convention as v3).
function priceFromSqrt(sqrt, stockDec, stableIs0) {
  const price1per0 = Number(sqrt * sqrt) / Number(1n << 192n);
  if (!isFinite(price1per0) || price1per0 <= 0) return null;
  const factor = 10 ** (stockDec - 6);
  const px = stableIs0 ? (1 / price1per0) * factor : price1per0 * factor;
  return isFinite(px) && px > 0 ? px : null;
}

// Persistent caches — currencies and token classification never change, so they are
// resolved once and reused across refreshes (only genuinely new pools cost a lookup).
const poolKey = new Map();   // poolId -> { c0, c1, fee, stableIs0 } (USDG pools only; null = not a USDG/stock pool)
const tokenMeta = new Map(); // token addr -> { symbol, decimals, isStock }

async function getSwapLogs(from, to) {
  const out = [];
  for (let lo = from; lo <= to; lo += SWAP_CHUNK + 1) {
    const hi = Math.min(to, lo + SWAP_CHUNK);
    const r = await rpc("eth_getLogs", [{ address: PM, fromBlock: "0x" + lo.toString(16), toBlock: "0x" + hi.toString(16), topics: [SWAP_TOPIC] }]);
    if (!r.error && r.result) out.push(...r.result);
    await sleep(120);
  }
  return out;
}

// Resolve currencies for poolIds we have never seen, via Initialize events (poolId
// indexed) using an array topic filter — a few sparse calls cover thousands of pools.
async function resolvePoolKeys(poolIds) {
  const unknown = poolIds.filter((id) => !poolKey.has(id));
  for (let i = 0; i < unknown.length; i += 300) {
    const chunk = unknown.slice(i, i + 300);
    const r = await rpc("eth_getLogs", [{ address: PM, fromBlock: "0x0", toBlock: "latest", topics: [INIT_TOPIC, chunk] }]);
    if (!r.error && r.result) {
      for (const l of r.result) {
        const c0 = ("0x" + l.topics[2].slice(26)).toLowerCase();
        const c1 = ("0x" + l.topics[3].slice(26)).toLowerCase();
        const fee = parseInt(l.data.slice(2, 66), 16);
        poolKey.set(l.topics[1], (c0 === USDG || c1 === USDG) ? { c0, c1, fee, stableIs0: c0 === USDG } : null);
      }
    }
    // Any pool whose Initialize we didn't find (shouldn't happen) -> mark non-USDG.
    for (const id of chunk) if (!poolKey.has(id)) poolKey.set(id, null);
    await sleep(150);
  }
}

// Classify Robinhood stock tokens for addresses we haven't seen. A tokenized stock's
// ERC-20 name ends with "Robinhood Token". Two-phase to stay cheap: read name() for
// everything first (most are memecoins we discard), then fetch symbol()/decimals()
// only for the handful that are actually stocks.
async function resolveTokens(addrs) {
  const unknown = [...new Set(addrs)].filter((a) => !tokenMeta.has(a));
  if (!unknown.length) return;
  const names = await callMany(unknown.map((a) => ({ to: a, data: "0x06fdde03" })));
  const stocks = [];
  unknown.forEach((a, i) => {
    const isStock = /Robinhood Token/i.test(names[i] ? decodeString(names[i]) : "");
    if (isStock) stocks.push(a);
    else tokenMeta.set(a, { symbol: "", decimals: 18, isStock: false });
  });
  for (const a of stocks) {
    const sym = await callOne(a, "0x95d89b41");
    const dec = await callOne(a, "0x313ce567");
    tokenMeta.set(a, { symbol: sym ? decodeString(sym) : "", decimals: dec ? Number(BigInt(dec)) : 18, isStock: true });
    await sleep(25);
  }
}

let cache = { at: 0, windowMin: 0, perStock: {} };
const TTL = 150 * 1000; // v4 layer is heavier; refresh at most every 2.5 min
let inFlight = null;

async function refresh(windowMin) {
  const latest = parseInt((await rpc("eth_blockNumber", [])).result, 16);
  const from = latest - Math.ceil(windowMin * 60 * BLOCKS_PER_SEC);
  const logs = await getSwapLogs(from, latest);

  // aggregate raw swap sums per pool (both sides, since USDG side unknown pre-resolve)
  const agg = new Map(); // poolId -> { s0, s1, f0, f1, swaps, sqrt, liq }
  for (const l of logs) {
    const d = l.data.slice(2);
    const a0 = toInt(d.slice(0, 64)), a1 = toInt(d.slice(64, 128));
    const sqrt = BigInt("0x" + d.slice(128, 192));
    const liq = BigInt("0x" + d.slice(192, 256));
    const fee = Number(BigInt("0x" + d.slice(320, 384))); // per-swap fee, pips (1e-6)
    const abs0 = a0 < 0n ? -a0 : a0, abs1 = a1 < 0n ? -a1 : a1;
    const g = agg.get(l.topics[1]) || { s0: 0n, s1: 0n, f0: 0, f1: 0, swaps: 0, sqrt, liq };
    g.s0 += abs0; g.s1 += abs1;
    g.f0 += Number(abs0) * (fee / 1e6);
    g.f1 += Number(abs1) * (fee / 1e6);
    g.swaps++; g.sqrt = sqrt; g.liq = liq;
    agg.set(l.topics[1], g);
  }

  await resolvePoolKeys([...agg.keys()]);

  // gather the non-USDG token of every USDG pool that traded, then classify
  const others = [];
  for (const [id] of agg) {
    const k = poolKey.get(id);
    if (!k) continue;
    others.push(k.stableIs0 ? k.c1 : k.c0);
  }
  await resolveTokens(others);

  // Per stock: fee, volume, swaps, pools, price.
  const perStock = {};
  for (const [id, g] of agg) {
    const k = poolKey.get(id);
    if (!k) continue;
    const other = (k.stableIs0 ? k.c1 : k.c0);
    const meta = tokenMeta.get(other);
    if (!meta || !meta.isStock) continue;

    const dec = meta.decimals || 18;
    // USDG side (6 decimals) = the stable currency's summed absolute amount.
    const usdgRaw = k.stableIs0 ? g.s0 : g.s1;
    const usdgFee = k.stableIs0 ? g.f0 : g.f1;
    const volume = Number(usdgRaw) / 1e6;
    const fee = usdgFee / 1e6;
    const price = priceFromSqrt(g.sqrt, dec, k.stableIs0);

    const s = (perStock[meta.symbol] = perStock[meta.symbol] || { symbol: meta.symbol, stockAddress: other, decimals: dec, fee: 0, volume: 0, swaps: 0, poolCount: 0, price: null });
    s.fee += fee; s.volume += volume; s.swaps += g.swaps; s.poolCount++;
    if (price && !s.price) s.price = price;
  }

  // TVL: the stock token lives ONLY in the PoolManager for v4, so balanceOf gives the
  // exact stock reserve summed across all of the stock's v4 pools. A concentrated v4
  // position is balanced in value at the current price (virtual reserves are always
  // 50/50), so the USDG side ≈ the stock side and TVL ≈ 2 x the stock-side value.
  // This is an estimate (the true USDG split is not isolatable in the shared
  // singleton) but is exact on the dominant stock side and cannot blow up.
  const symbols = Object.keys(perStock);
  if (symbols.length) {
    const bals = await callMany(symbols.map((sym) => ({ to: perStock[sym].stockAddress, data: "0x70a08231" + pad32(PM).slice(2) })));
    symbols.forEach((sym, i) => {
      const s = perStock[sym];
      const price = s.price || 0;
      if (bals[i] && price) {
        const realStock = Number(BigInt(bals[i])) / 10 ** (s.decimals || 18);
        const stockValue = realStock * price;
        const tvl = stockValue * 2;
        s.tvl = isFinite(tvl) && tvl > 0 ? tvl : null;
      } else {
        s.tvl = null;
      }
      s.feeRate = s.volume > 0 ? s.fee / s.volume : null; // realized average fee rate
    });
  }

  cache = { at: Date.now(), windowMin, perStock };
}

// Public: per-stock v4 aggregates. Always non-blocking — returns whatever is cached
// (empty until the first background refresh finishes ~40s after boot) and kicks off a
// background refresh when stale, so the fee route never waits on the heavy v4 scan.
async function loadV4({ windowMin = 30 } = {}) {
  const fresh = cache.at > 0 && cache.windowMin === windowMin && Date.now() - cache.at < TTL;
  if (!fresh && !inFlight) {
    inFlight = refresh(windowMin)
      .catch((e) => { console.error("[v4] refresh failed", e && e.message); })
      .finally(() => { inFlight = null; });
  }
  return { perStock: cache.perStock || {}, cachedAt: cache.at, stale: cache.at === 0 };
}

// Blocking variant for one-shot runs (e.g. GitHub Actions): always waits for a full
// scan so v4-only pools (e.g. GLXY/USDG) are present in a single cold process.
async function loadV4Blocking({ windowMin = 30 } = {}) {
  await refresh(windowMin);
  return { perStock: cache.perStock || {}, cachedAt: cache.at, stale: false };
}

module.exports = { loadV4, loadV4Blocking };
