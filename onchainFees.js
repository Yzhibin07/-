// On-chain fee measurement for Robinhood Chain (id 4663) Uniswap v3 stock/USDG
// pools. Mirrors exactly what app.uniswap.org shows on a pool page: fee = trading
// volume x fee tier. We sum the pool's Swap events over the last N minutes (the
// same as adding up the 10-minute fee buckets on the Uniswap pool chart), read
// straight from the chain because Uniswap's gateway API is IP rate-limited.

const { loadV4Blocking } = require("./onchainV4");

const RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
const POOLS_URL = "https://www.hoodpools.com/data/pools.json";
// Uniswap v3 Swap event topic0 (as emitted on Robinhood Chain).
const SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const BLOCKS_PER_SEC = 10; // measured: exactly 0.1s/block
const CHUNK_BLOCKS = 3000; // ~5 min per getLogs call, keeps under the 10k-log cap

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params, tries = 6) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const j = await r.json();
    if (j.error && (j.error.code === 429 || /Too Many/i.test(j.error.message || ""))) {
      await sleep(500 * (i + 1));
      continue;
    }
    return j;
  }
  const r = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return r.json();
}

function toInt256(word) {
  let n = BigInt("0x" + word);
  const MAX = 1n << 255n, MOD = 1n << 256n;
  if (n >= MAX) n -= MOD;
  return n;
}

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

// Fetch Swap logs for many pools over [from,to] using fixed block chunks, with a
// gentle delay between calls and a recursive split if a chunk still overflows.
async function getSwapLogs(addrs, from, to) {
  const out = [];
  for (let lo = from; lo <= to; lo += CHUNK_BLOCKS + 1) {
    const hi = Math.min(to, lo + CHUNK_BLOCKS);
    out.push(...(await getChunk(addrs, lo, hi)));
    await sleep(250);
  }
  return out;
}
async function getChunk(addrs, from, to) {
  const res = await rpc("eth_getLogs", [
    { address: addrs, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), topics: [SWAP_TOPIC] },
  ]);
  if (res.error) {
    if (/exceeds/i.test(res.error.message || "") && to > from) {
      const mid = Math.floor((from + to) / 2);
      const a = await getChunk(addrs, from, mid);
      await sleep(200);
      const b = await getChunk(addrs, mid + 1, to);
      return a.concat(b);
    }
    throw new Error(JSON.stringify(res.error));
  }
  return res.result || [];
}

// Build a registry of v3 stock/USDG pools from HoodPools (addresses, fee tier,
// which side is the stable, stock price). Cached briefly.
let regCache = { at: 0, reg: null, priceBySymbol: null };
const REG_TTL = 60 * 1000;
async function buildRegistry() {
  if (regCache.reg && Date.now() - regCache.at < REG_TTL) return regCache;
  const pools = await getJson(POOLS_URL);
  const reg = new Map();
  const priceBySymbol = {};
  for (const p of pools.pools || []) {
    const k0 = p.token0 && p.token0.kind, k1 = p.token1 && p.token1.kind;
    const isSS = (k0 === "stock" && k1 === "stable") || (k1 === "stock" && k0 === "stable");
    if (!isSS || p.version !== "v3") continue;
    const stockIs0 = k0 === "stock";
    const stock = stockIs0 ? p.token0 : p.token1;
    const stable = stockIs0 ? p.token1 : p.token0;
    reg.set(p.id.toLowerCase(), {
      id: p.id.toLowerCase(),
      stockSymbol: stock.symbol,
      stockAddress: stock.address,
      stableAddress: stable.address,
      quoteSymbol: stable.symbol,
      feeRate: (p.fee || 0) / 1e6,
      stableIs0: p.token0.address.toLowerCase() === stable.address.toLowerCase(),
      stableDecimals: 6, // USDG
    });
    // Only trust price_usd when it is quoted for the stock itself.
    if (
      p.price_usd &&
      (p.priced_token || "").toLowerCase() === stock.address.toLowerCase()
    ) {
      priceBySymbol[stock.symbol] = p.price_usd;
    }
  }
  regCache = { at: Date.now(), reg, priceBySymbol };
  return regCache;
}

let cache = { at: 0, payload: null };
const TTL_MS = 75 * 1000;

const stockDecCache = new Map(); // stock address (lower) -> decimals
async function ensureStockDecimals(addresses) {
  for (const a0 of addresses) {
    const a = a0.toLowerCase();
    if (stockDecCache.has(a)) continue;
    try {
      const res = await rpc("eth_call", [{ to: a, data: "0x313ce567" }, "latest"]);
      stockDecCache.set(a, res.result ? Number(BigInt(res.result)) : 18);
    } catch {
      stockDecCache.set(a, 18);
    }
    await sleep(80);
  }
}

// balanceOf(holder) calldata for an ERC-20 token.
function balanceOfData(holder) {
  return "0x70a08231" + "000000000000000000000000" + holder.toLowerCase().replace(/^0x/, "");
}

// Batched eth_call (JSON-RPC array), results aligned to input order, with 429/503
// backoff — handles both HTTP-level and JSON-body-level rate limiting. Kept small
// + spaced via rpcBatchChunked so the public RPC stays happy.
async function rpcBatch(calls, tries = 5) {
  if (!calls.length) return [];
  const body = calls.map((c, i) => ({
    jsonrpc: "2.0", id: i, method: "eth_call",
    params: [{ to: c.to, data: c.data }, "latest"],
  }));
  for (let t = 0; t < tries; t++) {
    let r;
    try {
      r = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch { await sleep(400 * (t + 1)); continue; }
    if (r.status === 429 || r.status === 503) { await sleep(500 * (t + 1)); continue; }
    if (!r.ok) throw new Error(`rpc ${r.status}`);
    let arr;
    try { arr = await r.json(); } catch { await sleep(500 * (t + 1)); continue; }
    // Body-level rate limit: a single error object instead of an array, or an
    // array whose entries carry a 429 error. Back off and retry the whole chunk.
    const isRateErr = (e) => e && (e.code === 429 || /Too Many|rate/i.test(e.message || ""));
    if (!Array.isArray(arr)) {
      if (isRateErr(arr && arr.error)) { await sleep(500 * (t + 1)); continue; }
      throw new Error(`rpc batch: ${JSON.stringify(arr).slice(0, 120)}`);
    }
    if (arr.some((row) => isRateErr(row && row.error))) { await sleep(500 * (t + 1)); continue; }
    const out = new Array(calls.length).fill(null);
    for (const row of arr) if (row && typeof row.id === "number" && row.result) out[row.id] = row.result;
    return out;
  }
  throw new Error("rpc rate-limited");
}
async function rpcBatchChunked(calls, size = 20, gap = 350) {
  const out = [];
  for (let i = 0; i < calls.length; i += size) {
    try {
      out.push(...(await rpcBatch(calls.slice(i, i + size))));
    } catch {
      // One chunk gave up after all retries — fill with nulls and keep going so
      // the rest of the tokens still get real TVL (partial > nothing).
      out.push(...new Array(Math.min(size, calls.length - i)).fill(null));
    }
    if (i + size < calls.length) await sleep(gap);
  }
  return out;
}

// Per-token TVL (USD value of both reserves across ALL of a stock's pools) — the
// same figure app.uniswap.org/explore/tokens shows. It moves slowly and the read
// is heavy (2 balanceOf per pool), so it is cached and refreshed independently of
// the 75-s fee cache: at most once every TVL_TTL, in the background, so a fee
// refresh never blocks on it.
const tvlCache = new Map(); // symbol -> tvl(USD), aggregated across pools
const poolTvlCache = new Map(); // poolId -> { tvl, symbol }, last known good per pool
const TVL_TTL = 5 * 60 * 1000;
let tvlComputedAt = 0;
let tvlInFlight = null;

async function refreshTvl(reg, priceBySymbol) {
  await ensureStockDecimals([...reg.values()].map((m) => m.stockAddress));
  const allPools = [...reg.values()];
  const calls = [];
  for (const m of allPools) {
    calls.push({ to: m.stockAddress, data: balanceOfData(m.id) });   // stock reserve
    calls.push({ to: m.stableAddress, data: balanceOfData(m.id) });  // USDG reserve
    calls.push({ to: m.id, data: "0x3850c7bd" });                    // slot0() -> sqrtPriceX96
  }
  const bals = await rpcBatchChunked(calls);
  // Any pool whose batched read failed this cycle (nulls) is retried one call at a
  // time — sequential reads reliably succeed even when big batches get throttled,
  // so cold-start TVL is complete instead of missing whole pools.
  const missing = [];
  allPools.forEach((m, idx) => {
    if (!bals[idx * 3] || !bals[idx * 3 + 1] || !bals[idx * 3 + 2]) missing.push({ m, idx });
  });
  for (const { m, idx } of missing) {
    for (let k = 0; k < 3; k++) {
      if (bals[idx * 3 + k]) continue;
      const c = calls[idx * 3 + k];
      try {
        const res = await rpc("eth_call", [{ to: c.to, data: c.data }, "latest"], 4);
        if (res && res.result) bals[idx * 3 + k] = res.result;
      } catch {}
      await sleep(70);
    }
  }
  // Update per-pool TVL only for pools that returned good reads; pools whose reads
  // still failed keep their last known value (no undercounting).
  allPools.forEach((m, idx) => {
    const stockHex = bals[idx * 3], stableHex = bals[idx * 3 + 1], slot0Hex = bals[idx * 3 + 2];
    if (!stockHex || !stableHex) return; // failed read → keep cached pool TVL
    const dec = stockDecCache.get((m.stockAddress || "").toLowerCase()) ?? 18;
    const stockAmt = Number(BigInt(stockHex)) / 10 ** dec;
    const stableAmt = Number(BigInt(stableHex)) / 10 ** m.stableDecimals;
    // Price the stock side from the pool's live sqrtPriceX96 (slot0). This is the
    // pool's true USD price; pools.json price_usd is unreliable (often =1, quoted
    // against the stable side), which severely undercounts TVL. Fall back to the
    // HoodPools price only if slot0 is unavailable this cycle.
    let px = null;
    if (slot0Hex && slot0Hex.length >= 66) {
      px = priceFromSqrt("0x" + slot0Hex.slice(2, 66), dec, m.stableIs0);
    }
    if (px == null) px = priceBySymbol[m.stockSymbol] ?? null;
    const tvl = stableAmt + (px ? stockAmt * px : 0);
    if (isFinite(tvl) && tvl > 0) poolTvlCache.set(m.id, { tvl, symbol: m.stockSymbol });
  });
  // Aggregate per token from the per-pool cache.
  const stockTvl = {};
  for (const { tvl, symbol } of poolTvlCache.values()) stockTvl[symbol] = (stockTvl[symbol] || 0) + tvl;
  tvlCache.clear();
  for (const [sym, v] of Object.entries(stockTvl)) tvlCache.set(sym, v);
  if (poolTvlCache.size) tvlComputedAt = Date.now();
}

// Ensure TVL is reasonably fresh. Blocks only on the very first population (so the
// board is never empty); afterwards it refreshes in the background and callers
// keep serving the cached values instantly.
async function ensureTvl(reg, priceBySymbol) {
  const fresh = tvlCache.size > 0 && Date.now() - tvlComputedAt < TVL_TTL;
  if (fresh) return;
  if (!tvlInFlight) {
    tvlInFlight = refreshTvl(reg, priceBySymbol)
      .catch(() => {})
      .finally(() => { tvlInFlight = null; });
  }
  if (tvlCache.size === 0) await tvlInFlight; // first run: wait so board isn't empty
}

// stock USD price from a Uniswap v3 pool's sqrtPriceX96 (from its latest swap).
function priceFromSqrt(sqrtHex, stockDec, stableIs0) {
  try {
    const sqrt = BigInt(sqrtHex);
    // price1per0 = (sqrt/2^96)^2 = raw token1 per raw token0
    const num = sqrt * sqrt;
    const price1per0 = Number(num) / Number(1n << 192n);
    if (!isFinite(price1per0) || price1per0 <= 0) return null;
    // stableIs0=false: stock=token0, USDG=token1 -> stock price = price1per0 * 10^(dec0-6)
    // stableIs0=true : stock=token1, USDG=token0 -> stock price = (1/price1per0) * 10^(decStock-6)
    const factor = 10 ** (stockDec - 6);
    const px = stableIs0 ? (1 / price1per0) * factor : price1per0 * factor;
    return isFinite(px) && px > 0 ? px : null;
  } catch {
    return null;
  }
}

async function loadOnchainFees({ windowMin = 30 } = {}) {
  if (cache.payload && cache.payload.windowMin === windowMin && Date.now() - cache.at < TTL_MS) {
    return { ...cache.payload, stale: false, cachedAt: cache.at };
  }
  const { reg, priceBySymbol } = await buildRegistry();
  const addrs = [...reg.keys()];
  const latest = parseInt((await rpc("eth_blockNumber", [])).result, 16);
  const blocks = Math.ceil(windowMin * 60 * BLOCKS_PER_SEC);
  const from = latest - blocks;

  const logs = await getSwapLogs(addrs, from, latest);

  const perPool = new Map(); // id -> {fee, volume, swaps}
  const perStock = new Map(); // symbol -> {fee, volume, swaps, pools:Set, best:{swaps,sqrt,addr,stableIs0}}
  for (const l of logs) {
    const m = reg.get((l.address || "").toLowerCase());
    if (!m) continue;
    const data = l.data.slice(2);
    const a0 = toInt256(data.slice(0, 64));
    const a1 = toInt256(data.slice(64, 128));
    const sqrtHex = "0x" + data.slice(128, 192); // sqrtPriceX96 (word index 2)
    const stableAmt = m.stableIs0 ? a0 : a1;
    const usd = Math.abs(Number(stableAmt)) / 10 ** m.stableDecimals;
    const fee = usd * m.feeRate;

    const pp = perPool.get(m.id) || { fee: 0, volume: 0, swaps: 0 };
    pp.fee += fee; pp.volume += usd; pp.swaps++; pp.lastSqrt = sqrtHex;
    perPool.set(m.id, pp);

    const s = perStock.get(m.stockSymbol) || { fee: 0, volume: 0, swaps: 0, pools: new Set(), bestSwaps: -1, sqrt: null, stockAddr: m.stockAddress, stableIs0: m.stableIs0 };
    s.fee += fee; s.volume += usd; s.swaps++; s.pools.add(m.id);
    // remember the price from this pool if it is the stock's busiest pool
    const poolSwaps = pp.swaps;
    if (poolSwaps > s.bestSwaps) { s.bestSwaps = poolSwaps; s.sqrt = sqrtHex; s.stableIs0 = m.stableIs0; }
    perStock.set(m.stockSymbol, s);
  }

  // resolve prices for the top pairs (on-chain sqrt first, HoodPools fallback)
  const topSymbols = [...perStock.entries()].sort((a, b) => b[1].fee - a[1].fee).slice(0, 25);
  await ensureStockDecimals(topSymbols.map(([, v]) => v.stockAddr).filter(Boolean));
  for (const [, v] of topSymbols) {
    const dec = stockDecCache.get((v.stockAddr || "").toLowerCase()) ?? 18;
    v.price = (v.sqrt ? priceFromSqrt(v.sqrt, dec, v.stableIs0) : null);
  }

  // Per-token TVL across all pools (cached/refreshed in the background, matches
  // the Uniswap explore/tokens TVL column). Never blocks the fee response after
  // the first population.
  await ensureTvl(reg, priceBySymbol);

  // dominant fee tier per stock = the fee rate of its highest-fee pool
  const domRate = {}, domFee = {};
  for (const [id, pp] of perPool) {
    const m = reg.get(id);
    if (!m) continue;
    if ((pp.fee || 0) >= (domFee[m.stockSymbol] ?? -1)) {
      domFee[m.stockSymbol] = pp.fee || 0;
      domRate[m.stockSymbol] = m.feeRate;
    }
  }

  const itemMap = new Map();
  for (const [symbol, v] of perStock.entries()) {
    itemMap.set(symbol, {
      symbol,
      pair: `${symbol}/USDG`,
      stockAddress: v.stockAddr || null,
      price: v.price ?? priceBySymbol[symbol] ?? null,
      fee30m: v.fee,
      windowVolume: v.volume,
      swaps: v.swaps,
      poolCount: v.pools.size,
      tvl: tvlCache.get(symbol) ?? null,
      feeRate: domRate[symbol] ?? null,
      hasV3: true,
      hasV4: false,
    });
  }

  // Merge Uniswap v4 stock/USDG pools (singleton PoolManager — not in HoodPools, so
  // discovered straight from the chain). Non-blocking: returns cached v4 aggregates,
  // refreshed in the background. Stock/USDG v4 pools (e.g. GLXY) that have no v3 pool
  // become brand-new rows so they can still rank on both boards.
  let v4perStock = {};
  try {
    const v4 = await loadV4Blocking({ windowMin });
    v4perStock = v4.perStock || {};
  } catch (e) {
    v4perStock = {};
  }
  for (const [symbol, s] of Object.entries(v4perStock)) {
    if (!symbol) continue;
    const it = itemMap.get(symbol);
    if (it) {
      it.fee30m += s.fee || 0;
      it.windowVolume += s.volume || 0;
      it.swaps += s.swaps || 0;
      it.poolCount += s.poolCount || 0;
      it.tvl = (it.tvl || 0) + (s.tvl || 0);
      it.hasV4 = true;
      if (it.price == null && s.price != null) it.price = s.price;
    } else {
      itemMap.set(symbol, {
        symbol,
        pair: `${symbol}/USDG`,
        stockAddress: s.stockAddress || null,
        price: s.price ?? priceBySymbol[symbol] ?? null,
        fee30m: s.fee || 0,
        windowVolume: s.volume || 0,
        swaps: s.swaps || 0,
        poolCount: s.poolCount || 0,
        tvl: s.tvl ?? null,
        feeRate: s.feeRate ?? null,
        hasV3: false,
        hasV4: true,
      });
    }
  }

  const items = [...itemMap.values()].sort((a, b) => b.fee30m - a.fee30m);

  const payload = {
    updatedAt: Date.now(),
    windowMin,
    windowSeconds: windowMin * 60,
    latestBlock: latest,
    fromBlock: from,
    totalSwaps: logs.length,
    poolsScanned: addrs.length,
    source: "Robinhood Chain (id 4663) · Uniswap v3+v4 池 · 链上 Swap 实测手续费",
    items,
    perPool: Object.fromEntries(perPool),
  };
  cache = { at: Date.now(), payload };
  return { ...payload, stale: false, cachedAt: cache.at };
}

module.exports = { loadOnchainFees };
