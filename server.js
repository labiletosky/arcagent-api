require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');

const app = express();
app.use(cors());
app.use(express.json());

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

// GET all orders
app.get('/orders', async (req, res) => {
  try {
    const count = await agent.orderCount();
    const orders = [];
    for (let i = 1; i <= Number(count); i++) {
      const order = await agent.getOrder(i);
      orders.push({
        id: Number(order.id),
        buyer: order.buyer,
        item: order.item,
        amount: ethers.formatUnits(order.amount, 18),
        executed: order.executed,
        timestamp: new Date(Number(order.timestamp) * 1000).toISOString()
      });
    }
    res.json({ success: true, total: orders.length, orders });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET single order
app.get('/orders/:id', async (req, res) => {
  try {
    const order = await agent.getOrder(req.params.id);
    res.json({
      success: true,
      order: {
        id: Number(order.id),
        buyer: order.buyer,
        item: order.item,
        amount: ethers.formatUnits(order.amount, 18),
        executed: order.executed,
        timestamp: new Date(Number(order.timestamp) * 1000).toISOString()
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET contract balance
app.get('/balance', async (req, res) => {
  try {
    const balance = await agent.getBalance();
    res.json({
      success: true,
      balance: ethers.formatUnits(balance, 18) + ' ART'
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /task - receive tasks from Arcade marketplace
app.post('/task', async (req, res) => {
  try {
    const { task } = req.body;
    const t = (task || '').toLowerCase().trim();
    let response = '';

    if (t.includes('balance')) {
      const balance = await agent.getBalance();
      const formatted = parseFloat(ethers.formatUnits(balance, 18)).toFixed(4);
      response = 'ArcAgent contract balance: ' + formatted + ' ART tokens.';

    } else if ((t.includes('order') || t.includes('lookup')) && t.match(/\d+/)) {
      const match = t.match(/\d+/);
      const order = await agent.getOrder(Number(match[0]));
      const amt = parseFloat(ethers.formatUnits(order.amount, 18)).toFixed(2);
      const status = order.executed ? 'Executed' : 'Pending';
      response = 'Order #' + order.id + ': "' + order.item + '" — ' + amt + ' ART — Status: ' + status + ' — Buyer: ' + order.buyer.slice(0,6) + '...' + order.buyer.slice(-4);

    } else if (t.includes('list') || t.includes('orders') || t.includes('show') || t.includes('made')) {
      const count = await agent.orderCount();
      const total = Number(count);
      if (total === 0) {
        response = 'No orders yet on ArcAgent.';
      } else {
        let list = 'ArcAgent has ' + total + ' total orders. Latest 5:\n';
        const start = Math.max(1, total - 4);
        for (let i = total; i >= start; i--) {
          const o = await agent.getOrder(i);
          const amt = parseFloat(ethers.formatUnits(o.amount, 18)).toFixed(2);
          list += '#' + o.id + ' "' + o.item + '" — ' + amt + ' ART — ' + (o.executed ? 'Executed' : 'Pending') + '\n';
        }
        response = list.trim();
      }

    } else {
      response = 'I am ArcAgent — an autonomous on-chain commerce protocol on Arc Testnet. I can help you: check balance, list orders, or look up a specific order (e.g. "order #1"). What would you like to know?';
    }

    res.json({ success: true, response: response, agent: 'ArcAgent', network: 'Arc Testnet' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'ArcAgent API is running',
    endpoints: ['/orders', '/orders/:id', '/balance', '/task']
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('ArcAgent API running on port ' + PORT);
});