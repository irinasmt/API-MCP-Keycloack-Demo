import express from 'express';
import cors from 'cors';
import { validateToken } from './auth';
import { getAllProducts, getProduct, createProduct, updateProduct, deleteProduct } from './products';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// All product routes require authentication
app.get('/products', validateToken, (req, res) => {
  res.json(getAllProducts());
});

app.get('/products/:id', validateToken, (req, res) => {
  const product = getProduct(parseInt(req.params.id));
  if (!product) return res.status(404).json({ error: 'Product not found' });
  res.json(product);
});

app.post('/products', validateToken, (req, res) => {
  const { name, price, description } = req.body;
  if (!name || !price) return res.status(400).json({ error: 'Name and price required' });
  
  const product = createProduct({ name, price, description: description || '' });
  res.status(201).json(product);
});

app.put('/products/:id', validateToken, (req, res) => {
  const product = updateProduct(parseInt(req.params.id), req.body);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  res.json(product);
});

app.delete('/products/:id', validateToken, (req, res) => {
  const deleted = deleteProduct(parseInt(req.params.id));
  if (!deleted) return res.status(404).json({ error: 'Product not found' });
  res.status(204).send();
});

app.listen(PORT, () => {
  console.log(`🚀 Product API running on http://localhost:${PORT}`);
});
