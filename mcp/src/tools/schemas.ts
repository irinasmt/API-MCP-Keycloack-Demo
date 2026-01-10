import { z } from "zod";

export const getProductsSchema = z.object({});

export const getProductSchema = z.object({
  id: z.number().describe("Product ID"),
});

export const createProductSchema = z.object({
  name: z.string().describe("Product name"),
  price: z.number().describe("Product price"),
  description: z.string().optional().describe("Product description"),
});

export const updateProductSchema = z.object({
  id: z.number().describe("Product ID"),
  name: z.string().optional().describe("Product name"),
  price: z.number().optional().describe("Product price"),
  description: z.string().optional().describe("Product description"),
});
