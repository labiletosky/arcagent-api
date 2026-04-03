require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: '*/*' }));

if (!process.env.RPC_URL) {
  throw new Error('Missing RPC_URL in .env');
}

if (!process.env.AGENT_ADDRESS) {
  throw new Error('Missing AGENT_ADDRESS in .env');
}

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);

const AGENT_ABI = [
  "function getOrder(uint256 orderId) view returns (tuple(uint256 id, address buyer, string item, uint256 amount, bool executed, uint256 timestamp))",
  "function orderCount() view returns (uint256)",
  "function getBalance() view returns (uint256)"
];

const agent = new ethers.Contract(
  process.env.AGENT_ADDRESS,
  AGENT_ABI,
  provider
);

function formatOrder(order) {
  return {
    id: Number(order.id),
    buyer: order.buyer,
    item: order.item,
    amount: ethers.formatUnits(order.amount, 18),
    executed: order.executed,
    timestamp: new Date(Number(order.timestamp) * 1000).toISOString()
  };
}

function extractTask(req) {
  const body = req.body;

  if (typeof body === 'string' && body.trim()) {
    return body.trim();
  }

  if (body && typeof body === 'object') {
    const possibleValues = [
      body.task,
      body.input,
      body.message,
      body.query,
      body.prompt,
      body.text,

      body?.data?.task,
      body?.data?.input,
      body?.data?.message,
      body?.data?.query,
      body?.data?.prompt,
      body?.data?.text,

      body?.payload?.task,
      body?.payload?.input,
      body?.payload?.message,
      body?.payload?.query,
      body?.payload?.prompt,
      body?.payload?.text,

      body?.request?.task,
      body?.request?.input,
      body?.request?.message,
      body?.request?.query,
      body?.request?.prompt,
      body?.request?.text,

      body?.job?.task,
      body?.job?.input,
      body?.job?.message,
      body?.job?.query,
      body?.job?.prompt,
      body?.job?.text
    ];

    for (const value of possibleValues) {
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
  }

  const queryValues = [
    req.query?.task,
    req.query?.input,
    req.query?.message,
    req.query?.query,
    req.query?.prompt,
    req.query?.text
  ];

  for (const value of queryValues) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return '';
}

async function getFormattedBalance() {
  const balance = await agent.getBalance();
  return parseFloat(ethers.formatUnits(balance, 18)).toFixed(4);
}

async function getOrderCountNumber() {
  const count = await agent.orderCount();
  return Number(count);
}

app.get('/orders', async (req, res) => {
  try {
    const count = await getOrderCountNumber();
    const orders = [];

    for (let i = 1; i <= count; i++) {
      const order = await agent.getOrder(i);
      orders.push(formatOrder(order));
    }

    res.json({
      success: true,
      total: orders.length,
      orders
    });
  } catch (e) {
    console.error('GET /orders error:', e);
    res.status(500).json({
      success: false,
      error: e.message
    });
  }
});

app.get('/orders/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({
        success: false,
        error: 'Invalid order ID'
      });
    }

    const count = await getOrderCountNumber();

    if (id > count) {
      return res.status(404).json({
        success: false,
        error: `Order #${id} does not exist`
      });
    }

    const order = await agent.getOrder(id);

    res.json({
      success: true,
      order: formatOrder(order)
    });
  } catch (e) {
    console.error('GET /orders/:id error:', e);
    res.status(500).json({
      success: false,
      error: e.message
    });
  }
});

app.get('/balance', async (req, res) => {
  try {
    const balance = await agent.getBalance();

    res.json({
      success: true,
      balance: ethers.formatUnits(balance, 18) + ' ART'
    });
  } catch (e) {
    console.error('GET /balance error:', e);
    res.status(500).json({
      success: false,
      error: e.message
    });
  }
});

app.post('/task', async (req, res) => {
  try {
    console.log('Headers:', JSON.stringify(req.headers, null, 2));
    console.log('Body:', typeof req.body === 'string' ? req.body : JSON.stringify(req.body, null, 2));
    console.log('Query:', JSON.stringify(req.query, null, 2));

    const rawTask = extractTask(req);
    const t = String(rawTask || '').toLowerCase().trim();

    console.log('Parsed task:', t);

    let response = '';

    if (!t) {
      response =
        'I can help with:\n' +
        '- "check balance"\n' +
        '- "list orders"\n' +
        '- "order #1"';
    } else if (
      t === 'check balance' ||
      t.includes('balance') ||
      t.includes('contract balance')
    ) {
      const formatted = await getFormattedBalance();
      response = `ArcAgent contract balance: ${formatted} ART tokens.`;
    } else if (
      /(order\s*#?\s*\d+)/i.test(t) ||
      /(lookup\s*\d+)/i.test(t) ||
      /(check\s+order\s*#?\s*\d+)/i.test(t)
    ) {
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
          const amt = parseFloat(ethers.formatUnits(order.amount, 18)).toFixed(2);
          const status = order.executed ? 'Executed' : 'Pending';

          response = `Order #${Number(order.id)}: "${order.item}" — ${amt} ART — Status: ${status}`;
        }
      }
    } else if (
      t === 'list orders' ||
      t === 'list' ||
      t === 'orders' ||
      t.includes('show orders') ||
      t.includes('all orders') ||
      t.includes('recent orders')
    ) {
      const total = await getOrderCountNumber();

      if (total === 0) {
        response = 'No orders yet on ArcAgent.';
      } else {
        let list = `ArcAgent has ${total} total orders. Latest 5:\n`;
        const start = Math.max(1, total - 4);

        for (let i = total; i >= start; i--) {
          const o = await agent.getOrder(i);
          const amt = parseFloat(ethers.formatUnits(o.amount, 18)).toFixed(2);
          list += `#${Number(o.id)} "${o.item}" — ${amt} ART — ${o.executed ? 'Executed' : 'Pending'}\n`;
        }

        response = list.trim();
      }
    } else if (
      t === 'what can you do' ||
      t === 'what can you do?' ||
      t === 'help' ||
      t.includes('commands')
    ) {
      response =
        'I can help with:\n' +
        '- "check balance"\n' +
        '- "list orders"\n' +
        '- "order #1"';
    } else {
      const total = await getOrderCountNumber();
      const bal = await getFormattedBalance();

      response =
        `Task received: "${rawTask}"\n\n` +
        `ArcAgent Stats:\n` +
        `- Total Orders: ${total}\n` +
        `- Contract Balance: ${bal} ART\n\n` +
        `Try:\n` +
        `- "check balance"\n` +
        `- "list orders"\n` +
        `- "order #1"`;
    }

    res.json({
      success: true,
      response,
      agent: 'ArcAgent',
      network: 'Arc Testnet'
    });
  } catch (e) {
    console.error('Task error:', e);
    res.status(500).json({
      success: false,
      error: e.message
    });
  }
});

app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'ArcAgent API is running',
    endpoints: ['/orders', '/orders/:id', '/balance', '/task']
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function () {
  console.log('ArcAgent API running on port ' + PORT);
});