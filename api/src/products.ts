interface Product {
  id: number;
  name: string;
  price: number;
  description: string;
}

// In-memory database
let products: Product[] = [
  { id: 1, name: 'Laptop', price: 999, description: 'High-performance laptop' },
  { id: 2, name: 'Mouse', price: 29, description: 'Wireless mouse' },
  { id: 3, name: 'Keyboard', price: 79, description: 'Mechanical keyboard' }
];

let nextId = 4;

export function getAllProducts(): Product[] {
  return products;
}

export function getProduct(id: number): Product | undefined {
  return products.find(p => p.id === id);
}

export function createProduct(data: Omit<Product, 'id'>): Product {
  const product = { ...data, id: nextId++ };
  products.push(product);
  return product;
}

export function updateProduct(id: number, data: Partial<Omit<Product, 'id'>>): Product | null {
  const index = products.findIndex(p => p.id === id);
  if (index === -1) return null;
  
  products[index] = { ...products[index], ...data };
  return products[index];
}

export function deleteProduct(id: number): boolean {
  const index = products.findIndex(p => p.id === id);
  if (index === -1) return false;
  
  products.splice(index, 1);
  return true;
}
