// On the live server (real naira) the demo bot sellers must never be searched, shown or treated as verified.
import { afterEach, describe, expect, it } from 'vitest';
import { catalog, demoSellers, loadSuppliers, searchSuppliers, useDemoSellers } from '../src/tools/suppliers.ts';

const shop = { name: 'Test', lat: 6.6, lng: 3.39 } as unknown as Parameters<typeof searchSuppliers>[1];

describe('demo sellers switch', () => {
  afterEach(() => useDemoSellers(true));

  it('on (local chain): the bots are searchable', () => {
    useDemoSellers(true);
    const item = loadSuppliers()[0].stocks[0].item;
    expect(demoSellers().length).toBeGreaterThan(0);
    expect(searchSuppliers(item, shop, 1000, () => 1).length).toBeGreaterThan(0);
  });

  it('off (live): no bot is listed or found, but the product catalogue stays', () => {
    useDemoSellers(false);
    const item = loadSuppliers()[0].stocks[0].item;
    expect(demoSellers()).toEqual([]);
    expect(searchSuppliers(item, shop, 1000, () => 1)).toEqual([]);
    expect(catalog().length).toBeGreaterThan(0);
  });
});
