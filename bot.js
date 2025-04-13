const { Telegraf } = require('telegraf');
const { ethers } = require('ethers');
const { ThirdwebSDK } = require('@thirdweb-dev/sdk');
const { Pool } = require('pg');
const fs = require('fs');
require('dotenv').config();

const bot = new Telegraf(process.env.BOT_TOKEN);
const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);
const ASTR_DECIMALS = 18;
const MIN_BALANCE = ethers.utils.parseUnits("10", ASTR_DECIMALS);

const NFT_CONTRACTS = [
  "0x434DFB1A21dd42860ad36A6a0bb4E4a1D7Bf55C9",
  "0xb6B80160cD08AbE679dE2Ff7d7bc0348f6D52a29",
  "0x4DA05305e74Fc5459caf601200E1a8e9a8e56aa3",
  "0x67bDc801e2aDF5D7301F48314a5f5035338b189f",
  "0xe5B371c43bbf4103C3D0d020096a5055579ECbc6",
  "0xa52bfb7BbA6e40a2F0Bc1177787D58bA915bB5aA",
  "0x1D98101247FB761c9aDC4e2EaD6aA6b6a00c170e"
];

const MONITORED = new Map();

async function connectDB() {
  const pool = new Pool({
    connectionString: `postgresql://${process.env.DB_USER}:${process.env.DB_PASS}@${process.env.DB_HOST}/${process.env.DB_NAME}?sslmode=require`,
    ssl: { rejectUnauthorized: false }
  });
  const client = await pool.connect();
  await client.query(`
    CREATE TABLE IF NOT EXISTS wallets (
      id SERIAL PRIMARY KEY,
      address TEXT,
      privatekey TEXT,
      minted BOOLEAN DEFAULT FALSE,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  return client;
}

async function hasEnoughASTR(wallet) {
  const balance = await provider.getBalance(wallet.address);
  return balance.gte(MIN_BALANCE);
}

async function getASTRBalance(wallet) {
  const balance = await provider.getBalance(wallet.address);
  return ethers.utils.formatUnits(balance, ASTR_DECIMALS);
}

async function verifyWallet(wallet) {
  try {
    const msg = "wallet verification";
    const sig = await wallet.signMessage(msg);
    return !!sig;
  } catch {
    return false;
  }
}

async function mintNFT(wallet, ctx) {
  try {
    const sdk = new ThirdwebSDK(wallet);
    const contractAddress = NFT_CONTRACTS[Math.floor(Math.random() * NFT_CONTRACTS.length)];
    console.log(`🎨 Minting NFT from ${contractAddress}...`);
    const contract = await sdk.getContract(contractAddress);
    await contract.erc721.claim(1);
    console.log(`✅ NFT minted successfully for: ${wallet.address}`);
    await ctx.telegram.sendMessage(ctx.chat.id, `✅ Minted NFT from ${contractAddress} for wallet ${wallet.address}`);
  } catch (err) {
    console.log(`❌ Mint failed for ${wallet.address}:`, err.message);
    await ctx.telegram.sendMessage(ctx.chat.id, `❌ Mint error for ${wallet.address}: ${err.message}`);
  }
}

async function monitorWallet(conn, address, privateKey, ctx) {
  const wallet = new ethers.Wallet(privateKey, provider);
  MONITORED.set(address, true);

  const verified = await verifyWallet(wallet);
  if (!verified) {
    console.log(`❌ Verification failed for: ${address}`);
    await ctx.telegram.sendMessage(ctx.chat.id, `❌ Wallet ${address} failed verification`);
    return;
  }

  const balance = await getASTRBalance(wallet);
  console.log(`📱 Monitoring wallet: ${address} | ASTR Balance: ${balance}`);
  await ctx.telegram.sendMessage(ctx.chat.id, `📡 Monitoring wallet ${address}\n💰 Current ASTR Balance: ${balance}`);

  while (MONITORED.get(address)) {
    const enough = await hasEnoughASTR(wallet);
    if (enough) {
      console.log(`💰 ${address} has 10+ ASTR! Minting NFT...`);
      await mintNFT(wallet, ctx);
      await conn.query(`UPDATE wallets SET minted = TRUE WHERE address = $1`, [address]);
      MONITORED.delete(address);
      break;
    }
    await new Promise(r => setTimeout(r, 10000));
  }
}

bot.command('generate_wallets', async (ctx) => {
  const conn = await connectDB();
  const parts = ctx.message.text.split(' ');
  const count = parseInt(parts[1] || 1);

  for (let i = 0; i < count; i++) {
    const wallet = ethers.Wallet.createRandom();
    await conn.query(`INSERT INTO wallets (address, privatekey) VALUES ($1, $2)`, [wallet.address, wallet.privateKey]);
    console.log(`🆕 Wallet created: ${wallet.address}`);
    monitorWallet(conn, wallet.address, wallet.privateKey, ctx);
    await ctx.telegram.sendMessage(ctx.chat.id, `📅 Wallet created: ${wallet.address}`);
  }

  await ctx.telegram.sendMessage(ctx.chat.id, `✅ Generated and monitoring ${count} wallet(s)`);
});

bot.command('check_balance', async (ctx) => {
  const conn = await connectDB();
  const result = await conn.query(`SELECT address, privatekey FROM wallets WHERE active = TRUE`);
  const rows = result.rows;
  if (rows.length === 0) return ctx.reply('📭 No active wallets to check.');

  for (const row of rows) {
    if (!row.privatekey || typeof row.privatekey !== 'string') {
      console.log(`⚠️ Skipping row with missing privateKey: ${JSON.stringify(row)}`);
      continue;
    }
    try {
      const wallet = new ethers.Wallet(row.privatekey, provider);
      const balance = await getASTRBalance(wallet);
      await ctx.telegram.sendMessage(ctx.chat.id, `💼 ${row.address} → ${balance} ASTR`);
    } catch (err) {
      console.log(`⚠️ Failed to check balance for ${row.address}:`, err.message);
    }
  }
});

bot.command('export_wallets', async (ctx) => {
  const conn = await connectDB();
  const result = await conn.query(`SELECT address, privatekey, minted FROM wallets WHERE active = TRUE`);
  const rows = result.rows;

  if (rows.length === 0) return ctx.reply('📍 No wallets to export.');

  const csv = ['Address,PrivateKey,Minted', ...rows.map(r => `${r.address},${r.privatekey},${r.minted ? 'TRUE' : 'FALSE'}`)].join('\n');
  fs.writeFileSync('wallets.csv', csv);

  console.log(`📤 Exported wallets to wallets.csv`);
  await ctx.replyWithDocument({ source: 'wallets.csv', filename: 'wallets.csv' });
  fs.unlinkSync('wallets.csv');
});

bot.command('remove_wallet', async (ctx) => {
  const parts = ctx.message.text.split(' ');
  const address = parts[1];

  if (!address) return ctx.reply("⚠️ Provide wallet address");

  MONITORED.set(address, false);
  const conn = await connectDB();
  await conn.query(`UPDATE wallets SET active = FALSE WHERE address = $1`, [address]);

  console.log(`🧹 Removed wallet ${address} from monitoring`);
  await ctx.reply(`❌ Wallet ${address} removed from monitoring`);
});

bot.launch();
console.log("🚀 Bot is running...");