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
      body.task_text,
      body.input,
      body.message,
      body.query,
      body.prompt,
      body.text,

      body?.data?.task,
      body?.data?.task_text,
      body?.data?.input,
      body?.data?.message,
      body?.data?.query,
      body?.data?.prompt,
      body?.data?.text,

      body?.payload?.task,
      body?.payload?.task_text,
      body?.payload?.input,
      body?.payload?.message,
      body?.payload?.query,
      body?.payload?.prompt,
      body?.payload?.text,

      body?.request?.task,
      body?.request?.task_text,
      body?.request?.input,
      body?.request?.message,
      body?.request?.query,
      body?.request?.prompt,
      body?.request?.text,

      body?.job?.task,
      body?.job?.task_text,
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
    req.query?.task_text,
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

async function getAllOrders() {
  const total = await getOrderCountNumber();
  const orders = [];

  for (let i = 1; i <= total; i++) {
    const order = await agent.getOrder(i);
    orders.push(formatOrder(order));
  }

  return orders;
}

async function getPendingOrders() {
  const orders = await getAllOrders();
  return orders.filter(order => !order.executed);
}

async function getExecutedOrders() {
  const orders = await getAllOrders();
  return orders.filter(order => order.executed);
}

app.get('/orders', async (req, res) => {
  try {
    const orders = await getAllOrders();

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
    console.log(
      'Body:',
      typeof req.body === 'string'
        ? req.body
        : JSON.stringify(req.body, null, 2)
    );
    console.log('Query:', JSON.stringify(req.query, null, 2));

    const rawTask = extractTask(req);
    const t = String(rawTask || '').toLowerCase().trim();

    console.log('Parsed task:', t);

    let response = '';

    if (!t) {
      response =
        'I am a commerce and payments agent. I can help with:\n' +
        '- "check balance"\n' +
        '- "list orders"\n' +
        '- "order #1"\n' +
        '- "pending orders"\n' +
        '- "completed orders"\n' +
        '- "payment status for order #1"\n' +
        '- "what can you do?"';
    }

    else if (
      t === 'what can you do' ||
      t === 'what can you do?' ||
      t === 'help' ||
      t.includes('commands')
    ) {
      response =
        'I am a commerce and payments agent. I can help with:\n' +
        '- check balance\n' +
        '- list orders\n' +
        '- order #1\n' +
        '- pending orders\n' +
        '- completed orders\n' +
        '- payment status for order #1';
    }

    else if (
      t === 'check balance' ||
      t.includes('balance') ||
      t.includes('contract balance') ||
      t.includes('payment balance')
    ) {
      const formatted = await getFormattedBalance();
      response = `ArcAgent payment balance: ${formatted} ART tokens.`;
    }

    else if (
      t.includes('pending orders') ||
      t.includes('show pending orders') ||
      t.includes('list pending orders') ||
      t === 'pending'
    ) {
      const pendingOrders = await getPendingOrders();

      if (pendingOrders.length === 0) {
        response = 'There are no pending orders right now.';
      } else {
        let list = `There are ${pendingOrders.length} pending orders:\n`;

        for (const order of pendingOrders.slice(-5).reverse()) {
          const amt = parseFloat(order.amount).toFixed(2);
          list += `#${order.id} "${order.item}" — ${amt} ART — Pending\n`;
        }

        response = list.trim();
      }
    }

    else if (
      t.includes('completed orders') ||
      t.includes('executed orders') ||
      t.includes('successful orders') ||
      t === 'completed'
    ) {
      const executedOrders = await getExecutedOrders();

      if (executedOrders.length === 0) {
        response = 'There are no completed orders right now.';
      } else {
        let list = `There are ${executedOrders.length} completed orders:\n`;

        for (const order of executedOrders.slice(-5).reverse()) {
          const amt = parseFloat(order.amount).toFixed(2);
          list += `#${order.id} "${order.item}" — ${amt} ART — Completed\n`;
        }

        response = list.trim();
      }
    }

    else if (
      t.includes('payment status for order') ||
      t.includes('status for order') ||
      t.includes('check payment status for order')
    ) {
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
          const amt = parseFloat(ethers.formatUnits(order.amount, 18)).toFixed(2);

          response =
            `Payment status for Order #${Number(order.id)}:\n` +
            `- Item: ${order.item}\n` +
            `- Amount: ${amt} ART\n` +
            `- Status: ${status}`;
        }
      }
    }

    else if (
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
          const status = order.executed ? 'Completed' : 'Pending';

          response =
            `Order #${Number(order.id)} details:\n` +
            `- Item: ${order.item}\n` +
            `- Amount: ${amt} ART\n` +
            `- Buyer: ${order.buyer}\n` +
            `- Status: ${status}\n` +
            `- Time: ${new Date(Number(order.timestamp) * 1000).toISOString()}`;
        }
      }
    }

    else if (
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
          list += `#${Number(o.id)} "${o.item}" — ${amt} ART — ${o.executed ? 'Completed' : 'Pending'}\n`;
        }

        response = list.trim();
      }
    }

    else {
      const total = await getOrderCountNumber();
      const bal = await getFormattedBalance();

      response =
        `I am a commerce and payments agent.\n\n` +
        `Current stats:\n` +
        `- Total Orders: ${total}\n` +
        `- Payment Balance: ${bal} ART\n\n` +
        `Try:\n` +
        `- check balance\n` +
        `- list orders\n` +
        `- order #1\n` +
        `- pending orders\n` +
        `- completed orders\n` +
        `- payment status for order #1`;
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
    message: 'ArcAgent Commerce & Payments API is running',
    endpoints: ['/orders', '/orders/:id', '/balance', '/task']
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function () {
  console.log('ArcAgent API running on port ' + PORT);
});