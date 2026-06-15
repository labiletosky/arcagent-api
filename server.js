require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
const { createGatewayMiddleware } = require('@circle-fin/x402-batching/server');

const app = express();

app.use(cors());
app.use(express.json());

// ── x402 Payment Middleware ───────────────────────────────────
const SELLER_WALLET = process.env.SELLER_WALLET || '0x5a52ed2527159b61f6c44e64a50922635b5b2a5a'

const gateway = createGatewayMiddleware({
  sellerAddress: SELLER_WALLET,
  facilitatorUrl: 'https://gateway-api-testnet.circle.com',
  networks: ['eip155:5042002']
})

// ── x402 paid route wrappers ─────────────────────────────────
const requirePayment = (price) => gateway.require(price)
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: '*/*' }));

if (!process.env.RPC_URL) throw new Error('Missing RPC_URL in .env');
if (!process.env.AGENT_ADDRESS) throw new Error('Missing AGENT_ADDRESS in .env');
if (!process.env.TOKEN_ADDRESS) throw new Error('Missing TOKEN_ADDRESS in .env');

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const TOKEN_SYMBOL = 'USDC';
const TOKEN_DECIMALS = 6;

const AGENT_ABI = [
  "function getOrder(uint256 orderId) view returns (tuple(uint256 id, address buyer, address receiver, string item, uint256 amount, bool executed, bool refunded, uint256 timestamp, uint256 deadline))",
  "function orderCount() view returns (uint256)",
  "function getBalance() view returns (uint256)"
];

const agent = new ethers.Contract(process.env.AGENT_ADDRESS, AGENT_ABI, provider);

function formatTokenAmount(value) {
  return ethers.formatUnits(value, TOKEN_DECIMALS);
}

function formatOrder(order) {
  return {
    id: Number(order.id),
    buyer: order.buyer,
    item: order.item,
    amount: formatTokenAmount(order.amount),
    token: TOKEN_SYMBOL,
    executed: order.executed,
    refunded: order.refunded,
    timestamp: new Date(Number(order.timestamp) * 1000).toISOString()
  };
}

function extractTask(req) {
  const body = req.body;
  if (typeof body === 'string' && body.trim()) return body.trim();
  if (body && typeof body === 'object') {
    const possibleValues = [
      body.task, body.task_text, body.input, body.message, body.query, body.prompt, body.text,
      body?.data?.task, body?.data?.input, body?.data?.message,
      body?.payload?.task, body?.payload?.input, body?.payload?.message,
      body?.request?.task, body?.request?.input, body?.request?.message,
      body?.job?.task, body?.job?.input, body?.job?.message
    ];
    for (const value of possibleValues) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  const queryValues = [req.query?.task, req.query?.input, req.query?.message, req.query?.query, req.query?.prompt, req.query?.text];
  for (const value of queryValues) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

// ── Stats cache (60 second TTL) ──────────────────────────────
let statsCache = null
let statsCacheTime = 0
const CACHE_TTL = 60 * 1000 // 60 seconds

async function getOrderCountNumber() {
  const count = await agent.orderCount();
  return Number(count);
}

// Fetch ALL orders in parallel batches of 20
async function getAllOrders() {
  const total = await getOrderCountNumber();
  const BATCH = 20
  const ids = []
  for (let i = 1; i <= total; i++) ids.push(i)
  const orders = []
  for (let b = 0; b < ids.length; b += BATCH) {
    const batch = ids.slice(b, b + BATCH)
    const results = await Promise.allSettled(batch.map(i => agent.getOrder(i)))
    for (const r of results) {
      if (r.status === 'fulfilled') orders.push(formatOrder(r.value))
    }
  }
  return orders
}

async function getPendingOrders() {
  const orders = await getAllOrders();
  return orders.filter(o => !o.executed && !o.refunded);
}

async function getExecutedOrders() {
  const orders = await getAllOrders();
  return orders.filter(o => o.executed);
}

async function getFormattedBalance() {
  const balance = await agent.getBalance();
  return parseFloat(formatTokenAmount(balance)).toFixed(4);
}

/* ── Routes ── */

app.get('/orders', requirePayment('$0.001'), async (req, res) => {
  try {
    const orders = await getAllOrders();
    res.json({ success: true, total: orders.length, token: TOKEN_SYMBOL, orders });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/orders/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ success: false, error: 'Invalid order ID' });
    const count = await getOrderCountNumber();
    if (id > count) return res.status(404).json({ success: false, error: `Order #${id} does not exist` });
    const order = await agent.getOrder(id);
    res.json({ success: true, order: formatOrder(order) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/balance', async (req, res) => {
  try {
    const balance = await agent.getBalance();
    res.json({ success: true, balance: `${ethers.formatUnits(balance, TOKEN_DECIMALS)} ${TOKEN_SYMBOL}` });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Stats — cached for 60s, scans ALL orders in parallel ─────
app.get('/stats', async (req, res) => {
  try {
    const now = Date.now()

    // Return cached result if still fresh
    if (statsCache && (now - statsCacheTime) < CACHE_TTL) {
      return res.json({ ...statsCache, cached: true })
    }

    const total = await getOrderCountNumber()
    const BATCH = 20
    const ids = []
    for (let i = 1; i <= total; i++) ids.push(i)

    let executed = 0
    let pending = 0
    let totalUsdc = 0

    for (let b = 0; b < ids.length; b += BATCH) {
      const batch = ids.slice(b, b + BATCH)
      const results = await Promise.allSettled(batch.map(i => agent.getOrder(i)))
      for (const r of results) {
        if (r.status !== 'fulfilled') continue
        const o = r.value
        if (o.executed) {
          executed++
          totalUsdc += parseFloat(ethers.formatUnits(o.amount, 6))
        } else if (!o.refunded) {
          pending++
        }
      }
    }

    // Save to cache
    statsCache = { success: true, total, executed, pending, totalUsdc: totalUsdc.toFixed(2) }
    statsCacheTime = now

    res.json({ ...statsCache, cached: false })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

app.post('/task', requirePayment('$0.005'), async (req, res) => {
  try {
    const rawTask = extractTask(req);
    const t = String(rawTask || '').toLowerCase().trim();

    let response = '';

    if (!t) {
      response = 'I am a commerce and payments agent. I can help with:\n- "check balance"\n- "list orders"\n- "order #1"\n- "pending orders"\n- "completed orders"\n- "payment status for order #1"';
    } else if (t === 'what can you do' || t === 'what can you do?' || t === 'help' || t.includes('commands')) {
      response = 'I am a commerce and payments agent. I can help with:\n- check balance\n- list orders\n- order #1\n- pending orders\n- completed orders\n- payment status for order #1';
    } else if (t === 'check balance' || t.includes('balance')) {
      const formatted = await getFormattedBalance();
      response = `ArcAgent payment balance: ${formatted} ${TOKEN_SYMBOL}.`;
    } else if (t.includes('pending orders') || t === 'pending') {
      const pendingOrders = await getPendingOrders();
      if (pendingOrders.length === 0) {
        response = 'There are no pending orders right now.';
      } else {
        let list = `There are ${pendingOrders.length} pending orders:\n`;
        for (const order of pendingOrders.slice(-5).reverse()) {
          list += `#${order.id} "${order.item}" — ${parseFloat(order.amount).toFixed(2)} ${TOKEN_SYMBOL} — Pending\n`;
        }
        response = list.trim();
      }
    } else if (t.includes('completed orders') || t.includes('executed orders') || t === 'completed') {
      const executedOrders = await getExecutedOrders();
      if (executedOrders.length === 0) {
        response = 'There are no completed orders right now.';
      } else {
        let list = `There are ${executedOrders.length} completed orders:\n`;
        for (const order of executedOrders.slice(-5).reverse()) {
          list += `#${order.id} "${order.item}" — ${parseFloat(order.amount).toFixed(2)} ${TOKEN_SYMBOL} — Completed\n`;
        }
        response = list.trim();
      }
    } else if (t.includes('payment status for order') || t.includes('status for order')) {
      const match = t.match(/\d+/);
      const orderId = match ? Number(match[0]) : null;
      if (!orderId || orderId < 1) {
        response = 'Please provide a valid order number, like "payment status for order #1".';
      } else {
        const count = await getOrderCountNumber();
        if (orderId > count) {
          response = `Order #${orderId} does not exist. Total orders: ${count}.`;
        } else {
          const order = await agent.getOrder(orderId);
          const status = order.executed ? 'Completed' : 'Pending';
          const amt = parseFloat(formatTokenAmount(order.amount)).toFixed(2);
          response = `Payment status for Order #${Number(order.id)}:\n- Item: ${order.item}\n- Amount: ${amt} ${TOKEN_SYMBOL}\n- Status: ${status}`;
        }
      }
    } else if (/(order\s*#?\s*\d+)/i.test(t) || /(lookup\s*\d+)/i.test(t)) {
      const match = t.match(/\d+/);
      const orderId = match ? Number(match[0]) : null;
      if (!orderId || orderId < 1) {
        response = 'Please provide a valid order number, like "order #1".';
      } else {
        const count = await getOrderCountNumber();
        if (orderId > count) {
          response = `Order #${orderId} does not exist. Total orders: ${count}.`;
        } else {
          const order = await agent.getOrder(orderId);
          const amt = parseFloat(formatTokenAmount(order.amount)).toFixed(2);
          const status = order.executed ? 'Completed' : 'Pending';
          response = `Order #${Number(order.id)} details:\n- Item: ${order.item}\n- Amount: ${amt} ${TOKEN_SYMBOL}\n- Buyer: ${order.buyer}\n- Status: ${status}\n- Time: ${new Date(Number(order.timestamp) * 1000).toISOString()}`;
        }
      }
    } else if (t === 'list orders' || t === 'list' || t === 'orders' || t.includes('show orders') || t.includes('all orders') || t.includes('recent orders')) {
      const total = await getOrderCountNumber();
      if (total === 0) {
        response = 'No orders yet on ArcAgent.';
      } else {
        let list = `ArcAgent has ${total} total orders. Latest 5:\n`;
        const start = Math.max(1, total - 4);
        for (let i = total; i >= start; i--) {
          const o = await agent.getOrder(i);
          const amt = parseFloat(formatTokenAmount(o.amount)).toFixed(2);
          list += `#${Number(o.id)} "${o.item}" — ${amt} ${TOKEN_SYMBOL} — ${o.executed ? 'Completed' : 'Pending'}\n`;
        }
        response = list.trim();
      }
    } else {
      const total = await getOrderCountNumber();
      const bal = await getFormattedBalance();
      response = `I am a commerce and payments agent.\n\nCurrent stats:\n- Total Orders: ${total}\n- Payment Balance: ${bal} ${TOKEN_SYMBOL}\n\nTry:\n- check balance\n- list orders\n- order #1\n- pending orders\n- completed orders\n- payment status for order #1`;
    }

    res.json({ success: true, response, agent: 'ArcAgent', network: 'Arc Testnet', token: TOKEN_SYMBOL });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'ArcAgent Commerce & Payments API is running',
    token: TOKEN_SYMBOL,
    endpoints: ['/orders', '/orders/:id', '/balance', '/stats', '/task']
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function () {
  console.log('ArcAgent API running on port ' + PORT);
});