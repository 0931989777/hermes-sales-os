// ai-order-extractor.test.mjs — RED tests for AI-first order extraction
// These MUST fail until ai-order-extractor.mjs is created and implemented
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractOrderFromAI,
  validateAIOrder,
  formatConversationForAI
} from './ai-order-extractor.mjs';

const TEST_PAGE = '625538103984936';
const TEST_CUSTOMER = 'customer1';

// ── Known products (must match server.mjs PRICE_TABLE) ──
const KNOWN_PRODUCTS = {
  'ngo_men_la': { name: 'rượu ngô men lá', price5L: 330000, price20L: 1200000 },
  'tam_giac_mach': { name: 'rượu tam giác mạch', price5L: 330000, price20L: 1200000 }
};

it('add-on order: "thêm 8 can5 lít" extracts 8 × 5L of previous product', { skip: !process.env.AI_ORDER_EXTRACTION_ENABLED && 'AI extraction disabled (set AI_ORDER_EXTRACTION_ENABLED=true to run)' }, () => {
  const messages = [
    { id: '1', created_time: '2026-07-23T14:00:00Z', from: { id: TEST_PAGE }, message: 'Sản phẩm: rượu tam giác mạch - 04 can 5L\nSĐT: 0965378868\nĐịa chỉ: Khối 4, thị trấn Quỳ Hợp, huyện Quỳ Hợp, Nghệ An\nTổng tiền: 1.320.000đ\nEm chốt đơn.' },
    { id: '2', created_time: '2026-07-24T01:05:57Z', from: { id: TEST_CUSTOMER, name: 'Nguyen Son Lam' }, message: 'Cho anh thêm 8 can5 lít nữa nhé,anh nhận kết bạn zalo rồi em' }
  ];

  const order = extractOrderFromAI(messages, TEST_PAGE, TEST_CUSTOMER);
  assert.ok(order, 'should extract an order');
  assert.equal(order.product, 'tam_giac_mach');
  assert.equal(order.quantity, 8);
  assert.equal(order.package, '5L');
  assert.equal(order.phone, '0965378868');
  assert.ok(order.address.includes('Quỳ Hợp'));
  assert.strictEqual(order.isAddOn, true);
});

it('new order with all details extracts correctly', { skip: !process.env.AI_ORDER_EXTRACTION_ENABLED && 'AI extraction disabled' }, () => {
  const messages = [
    { id: '1', created_time: '2026-07-23T10:00:00Z', from: { id: TEST_CUSTOMER, name: 'Nguyen Van A' }, message: 'Em ơi cho anh 2 túi rượu ngô men lá' },
    { id: '2', created_time: '2026-07-23T10:01:00Z', from: { id: TEST_CUSTOMER, name: 'Nguyen Van A' }, message: 'SĐT: 0987654321\nĐịa chỉ: 123 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh' }
  ];

  const order = extractOrderFromAI(messages, TEST_PAGE, TEST_CUSTOMER);
  assert.ok(order);
  assert.equal(order.product, 'ngo_men_la');
  assert.equal(order.quantity, 2);
  assert.equal(order.package, '5L');
  assert.equal(order.phone, '0987654321');
  assert.ok(order.address.includes('Lê Lợi'));
  assert.strictEqual(order.isAddOn, false);
});

it('validator rejects placeholder address cũ', () => {
  const aiOrder = { product: 'tam_giac_mach', quantity: 8, package: '5L', phone: '0965378868', address: 'cũ', isAddOn: true };
  assert.strictEqual(validateAIOrder(aiOrder, KNOWN_PRODUCTS), false);
});

it('validator rejects unknown product', () => {
  assert.strictEqual(validateAIOrder({ product: 'ruou_gao', quantity: 1, package: '5L', phone: '0912345678', address: 'Hà Nội', isAddOn: false }, KNOWN_PRODUCTS), false);
});

it('validator rejects invalid phone (too short)', () => {
  assert.strictEqual(validateAIOrder({ product: 'ngo_men_la', quantity: 1, package: '5L', phone: '0123', address: 'Hà Nội', isAddOn: false }, KNOWN_PRODUCTS), false);
});

it('validator rejects missing address for non-add-on', () => {
  assert.strictEqual(validateAIOrder({ product: 'ngo_men_la', quantity: 2, package: '5L', phone: '0912345678', address: '', isAddOn: false }, KNOWN_PRODUCTS), false);
});

it('validator accepts valid new order', () => {
  const result = validateAIOrder({
    product: 'ngo_men_la', quantity: 2, package: '5L', phone: '0987654321',
    address: '123 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh', isAddOn: false
  }, KNOWN_PRODUCTS);
  assert.ok(result);
  assert.equal(result.productAmount, 2 * 330000);
  assert.equal(result.shippingAmount, 0);
  assert.equal(result.totalAmount, 2 * 330000);
});

it('validator accepts valid add-on with inherited address', () => {
  const result = validateAIOrder({
    product: 'tam_giac_mach', quantity: 8, package: '5L', phone: '0965378868',
    address: 'Khối 4, thị trấn Quỳ Hợp, huyện Quỳ Hợp, Nghệ An', isAddOn: true
  }, KNOWN_PRODUCTS);
  assert.ok(result);
  assert.equal(result.productAmount, 8 * 330000);
  assert.equal(result.shippingAmount, 0);
  assert.equal(result.totalAmount, 8 * 330000);
});

it('validator computes shipping for 1 bag', () => {
  const result = validateAIOrder({
    product: 'ngo_men_la', quantity: 1, package: '5L', phone: '0912345678',
    address: 'Hà Nội', isAddOn: false
  }, KNOWN_PRODUCTS);
  assert.ok(result);
  assert.equal(result.productAmount, 330000);
  assert.equal(result.shippingAmount, 20000);
  assert.equal(result.totalAmount, 350000);
});

it('formatConversationForAI limits to last 20 messages', () => {
  const messages = Array.from({ length: 30 }, (_, i) => ({
    id: `${i + 1}`,
    created_time: `2026-07-24T0${String(i).padStart(2, '0')}:00:00Z`,
    from: { id: i % 2 === 0 ? TEST_PAGE : TEST_CUSTOMER, name: i % 2 === 0 ? undefined : 'Khach' },
    message: `Message ${i + 1}`
  }));
  const formatted = formatConversationForAI(messages, TEST_PAGE);
  const lines = formatted.split('\n').filter(l => l.includes('Message'));
  assert.ok(lines.length <= 20);
});
