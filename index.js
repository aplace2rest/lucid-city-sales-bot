
const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const Database = require('better-sqlite3');
require('dotenv').config();

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const TIMEZONE = process.env.TIMEZONE || 'America/Chicago';
const WEBHOOK_PORT = process.env.WEBHOOK_PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'changeme';

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID in .env');
  process.exit(1);
}

// --- Initialize DB ---
const DB_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR);
const db = new Database(path.join(DB_DIR, 'sales.db'));

db.prepare(`CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id TEXT,
  seller_tag TEXT,
  product TEXT NOT NULL,
  amount REAL NOT NULL,
  commission REAL NOT NULL,
  timestamp INTEGER NOT NULL,
  notes TEXT,
  source TEXT
)`).run();

db.prepare(`CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT
)`).run();

const getConfig = (key, fallback=null) => {
  const r = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return r ? r.value : fallback;
};

const setConfig = (key, value) => {
  db.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
};

if (getConfig('commission_rate') === null) setConfig('commission_rate', '10');

const calculateCommission = (amount, ratePercent) => {
  const amt = Number(amount) || 0;
  const rate = Number(ratePercent) || 0;
  const commission = +(amt * (rate / 100));
  return Math.round(commission * 100) / 100;
};

const insertSale = (seller, sellerTag, product, amount, commission, timestamp, notes, source) => {
  return db.prepare('INSERT INTO sales (seller_id, seller_tag, product, amount, commission, timestamp, notes, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(seller, sellerTag, product, amount, commission, timestamp, notes, source);
};

// --- Express Webhook Server ---
const app = express();
app.use(bodyParser.json());

app.post('/webhook', (req, res) => {
  const { secret, seller_id, seller_tag, product, amount, notes, source } = req.body;
  if (secret !== WEBHOOK_SECRET) return res.status(403).json({ error: 'Invalid secret' });
  if (!product || !amount) return res.status(400).json({ error: 'Missing product or amount' });

  const rate = Number(getConfig('commission_rate') || 10);
  const commission = calculateCommission(amount, rate);
  const ts = Math.floor(Date.now() / 1000);
  insertSale(seller_id || 'unknown', seller_tag || 'external', product, amount, commission, ts, notes || null, source || 'webhook');

  console.log(`[Webhook] Sale logged: ${product} for ${amount} (${commission})`);
  res.json({ success: true });
});

app.listen(WEBHOOK_PORT, () => console.log(`Webhook receiver listening on port ${WEBHOOK_PORT}`));

// --- Discord client setup ---
const client = new Client({ intents: [GatewayIntentBits.Guilds], partials: [Partials.Channel] });
client.once('ready', () => console.log(`Logged in as ${client.user.tag}`));

// Minimal commands
const commands = [
  new SlashCommandBuilder()
    .setName('commission_set')
    .setDescription('Set commission % (admin only)')
    .addNumberOption(o => o.setName('rate').setDescription('Rate %').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON(),
  new SlashCommandBuilder()
    .setName('sales_summary')
    .setDescription('Show sales summary')
    .addStringOption(o => o.setName('period').setDescription('day|week|month').setRequired(true))
    .toJSON()
];

(async () => {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  }
})();

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const name = interaction.commandName;
  if (name === 'commission_set') {
    const rate = interaction.options.getNumber('rate', true);
    setConfig('commission_rate', rate);
    await interaction.reply({ content: `Commission set to ${rate}%`, ephemeral: true });
  } else if (name === 'sales_summary') {
    const period = interaction.options.getString('period', true);
    const now = new Date();
    const start = new Date(now);
    if (period === 'day') start.setUTCDate(now.getUTCDate() - 1);
    if (period === 'week') start.setUTCDate(now.getUTCDate() - 7);
    if (period === 'month') start.setUTCMonth(now.getUTCMonth() - 1);
    const fromTs = Math.floor(start.getTime() / 1000);
    const toTs = Math.floor(now.getTime() / 1000);
    const summary = db.prepare('SELECT COUNT(*) as txCount, SUM(amount) as totalSales, SUM(commission) as totalCommission FROM sales WHERE timestamp BETWEEN ? AND ?').get(fromTs, toTs);
    const embed = new EmbedBuilder()
      .setTitle(`Sales Summary (${period})`)
      .setDescription(`Transactions: ${summary.txCount}\nTotal: ${summary.totalSales || 0}\nCommissions: ${summary.totalCommission || 0}`)
      .setTimestamp();
    await interaction.reply({ embeds: [embed] });
  }
});

client.login(TOKEN);
