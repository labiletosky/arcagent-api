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

// staticNetwork stops ethers from calling eth_chainId before every
// single request — this redundant call was silently doubling our
// actual load on Arc's rate-limited public testnet RPC. Same fix
// already confirmed working in bot.js and main.js.
const ARC_TESTNET_CHAIN_ID = 5042002;
const provider = new ethers.JsonRpcProvider(
  process.env.RPC_URL,
  ARC_TESTNET_CHAIN_ID,
  { staticNetwork: true }
);
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
// Doing a live, synchronous scan of every order on every /stats
// request was reliably failing — even carefully throttled, 500 orders
// takes well over 2 minutes to check safely on Arc's rate-limited
// public RPC, far past any realistic serverless function timeout.
// The real fix: the GitHub Actions bot (which already scans every
// order on a schedule, with a generous 4-minute budget) computes
// these numbers and publishes them to a Cloudflare Worker's KV store.
// This endpoint just reads that instantly — no RPC calls, no timeout
// risk, ever. Stats update roughly every time the bot completes a
// full pass through all orders (which may take a few scheduled runs
// for very large order counts).
const STATS_WORKER_URL = process.env.STATS_WORKER_URL || 'https://arcagent-circle-proxy.arcagent.workers.dev/stats'

app.get('/stats', async (req, res) => {
  try {
    const response = await fetch(STATS_WORKER_URL)
    const data = await response.json()
    res.json(data)
  } catch (e) {
    res.status(500).json({ success: false, error: 'Could not reach stats source: ' + e.message })
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

// ── AI Order Verification ──────────────────────────────────────
// Reviews a pending order using Claude and returns an advisory
// verdict: "execute", "hold", or "refund" — plus reasoning.
// IMPORTANT: this endpoint does NOT call executeOrder/claimRefund
// itself. It only returns advice. The actual onchain action still
// requires the agent wallet, exactly as before, using the existing
// deployed contract (no new functions, no redeploy).
// ── Order verification — spam filter only ──────────────────────
// ArcAgent's real job: execute every genuine order, skip spam/junk.
// There is no "refund" verdict here — refunds are the buyer's own
// claimRefund() path after the deadline, not something this agent
// decides. This endpoint only ever returns "execute" or "hold".
app.post('/verify-order/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ success: false, error: 'Invalid order ID' });
    }

    const count = await getOrderCountNumber();
    if (id > count) {
      return res.status(404).json({ success: false, error: `Order #${id} does not exist` });
    }

    const order = await agent.getOrder(id);
    const formatted = formatOrder(order);

    if (formatted.executed) {
      return res.json({ success: true, verdict: 'already_executed', order: formatted });
    }
    if (formatted.refunded) {
      return res.json({ success: true, verdict: 'already_refunded', order: formatted });
    }

    const useRealAI = !!process.env.ANTHROPIC_API_KEY;
    let verdictObj;

    if (useRealAI) {
      // ── Real Claude call (used once ANTHROPIC_API_KEY is funded) ──
      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 300,
          system:
            'You are ArcAgent\'s spam filter. ArcAgent\'s job is to execute every ' +
            'genuine commerce order — your only task is to flag orders that look like ' +
            'spam, test junk, or gibberish so the agent holds them instead of wasting ' +
            'gas executing nonsense. You do NOT decide refunds — that is the buyer\'s ' +
            'own separate claimRefund() path, never yours to recommend. ' +
            'Respond ONLY with valid JSON, no markdown, no commentary outside the JSON. ' +
            'Schema: {"verdict": "execute" | "hold", "confidence": 0-1, "reason": "short string"}',
          messages: [{
            role: 'user',
            content:
              'Order #' + formatted.id + '\n' +
              'Item description: "' + formatted.item + '"\n' +
              'Amount: ' + formatted.amount + ' USDC\n' +
              'Buyer: ' + formatted.buyer + '\n' +
              'Placed at: ' + formatted.timestamp + '\n\n' +
              'Is this a genuine order (execute) or spam/junk/gibberish (hold)?'
          }]
        })
      });

      if (!claudeRes.ok) {
        const errText = await claudeRes.text();
        throw new Error('Claude API error: ' + errText.slice(0, 300));
      }

      const claudeData = await claudeRes.json();
      const rawText = claudeData?.content?.[0]?.text || '';

      try {
        verdictObj = JSON.parse(rawText);
      } catch (e) {
        throw new Error('Could not parse Claude response as JSON: ' + rawText.slice(0, 200));
      }

    } else {
      // ── Deterministic spam-detection rules (no API key required) ──
      // Swap in the real Claude call above once ANTHROPIC_API_KEY is funded.
      // Default is ALWAYS execute — hold only triggers on clear junk signals.
      const itemRaw = (formatted.item || '').replace(/\[.*?\]/g, '').trim();
      const amt = parseFloat(formatted.amount);

      const isTooShort = itemRaw.length < 2;
      const isZeroOrInvalidAmount = !(amt > 0);
      // Repeated single character only, e.g. "aaaa" or "....." — common junk pattern
      const isRepeatedCharSpam = itemRaw.length > 0 && /^(.)\1+$/.test(itemRaw);

      if (isTooShort || isZeroOrInvalidAmount || isRepeatedCharSpam) {
        let reason = 'Order amount is zero or invalid.';
        if (isTooShort) reason = 'Item description is empty or too short to be a real order.';
        else if (isRepeatedCharSpam) reason = 'Item description looks like junk (repeated characters), not a real item.';

        verdictObj = { verdict: 'hold', confidence: 0.7, reason };
      } else {
        // Default: treat as genuine and execute. ArcAgent's job is to
        // execute orders, not to invent reasons to withhold them.
        verdictObj = {
          verdict: 'execute',
          confidence: 0.75,
          reason: 'Order has a valid item description and a positive amount — no spam signals detected.'
        };
      }
    }

    res.json({
      success: true,
      order: formatted,
      verdict: verdictObj.verdict,
      confidence: verdictObj.confidence,
      reason: verdictObj.reason,
      poweredBy: useRealAI ? 'claude' : 'mock-rules (no ANTHROPIC_API_KEY set — add one to enable real Claude verdicts)',
      note: 'This endpoint only flags execute vs hold (spam check). Refunds are never decided here — that is the buyer\'s own claimRefund() path after the deadline.'
    });

  } catch (e) {
    console.error('verify-order error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function () {
  console.log('ArcAgent API running on port ' + PORT);
});