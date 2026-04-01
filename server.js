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

// Health check
app.get('/', (req, res) => {
  res.json({ 
    success: true, 
    message: 'ArcAgent API is running',
    endpoints: ['/orders', '/orders/:id', '/balance']
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ArcAgent API running on port ${PORT}`);
});