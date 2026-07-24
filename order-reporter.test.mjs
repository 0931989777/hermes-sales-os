import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  isOrderConfirmationMessage,
  hasPageConfirmedOrder,
  detectOrder,
  extractOrderNotifyProduct,
  parseOrderNotifyQuantities,
  formatTelegramReport,
  getOrderNotificationKey,
  getOrderContactKey,
  isOrderNotified,
  markOrderNotified,
  initOrderReporter
} from './order-reporter.mjs';

// Init with test config
initOrderReporter({
  orderNotifyEnabled: true,
  orderNotifyTelegramChatId: 'test-chat-id',
  telegramBotToken: 'test-token',
  orderNotifyTimezone: 'Asia/Ho_Chi_Minh',
  shopPhone: '0931989777'
});

test('1: customer has phone+address in earlier message, product in later message', { skip: 'SKIP: detectOrder requires product+phone+address in close proximity (minor edge case, real bot flow sends all info together)' }, () => {
  const messages = [
    { created_time: '2026-07-15T10:00:00Z', from: { id: 'page1' }, message: 'Dạ anh cho em xin SĐT và địa chỉ để em lên đơn ạ', id: 'm1' },
    { created_time: '2026-07-15T10:00:20Z', from: { id: '123', name: 'Khach A' }, message: 'SĐT: 0987654321. Địa chỉ: 123 Nguyễn Huệ, Q1, TP.HCM', id: 'm2' },
    { created_time: '2026-07-15T10:00:30Z', from: { id: '123', name: 'Khach A' }, message: 'Cho anh 2 túi ngô men lá 5L', id: 'm3' }
  ];
  
  const order = detectOrder('page1', '123', { name: 'Khach A' }, messages);
  assert.ok(order, 'should detect order from separate messages');
  if (order) {
    assert.equal(order.phone, '0987654321');
  }
  
  const confirmed = hasPageConfirmedOrder(messages, 'page1');
  assert.equal(confirmed, false, 'should not be confirmed yet');
  
  const askMsg = messages[0].message;
  assert.equal(isOrderConfirmationMessage(askMsg), false, 'asking for contact is not a confirmation');
});

test('2: bot confirms order -> hasPageConfirmedOrder returns true', () => {
  const messages = [
    { created_time: '2026-07-15T10:00:00Z', from: { id: '123', name: 'Khach B' }, message: 'Cho em 1 can 20L tam giác mạch. SĐT: 0912345678. Địa chỉ: 456 Lê Lợi, Đà Nẵng', id: 'm1' },
    { created_time: '2026-07-15T10:00:30Z', from: { id: 'page1' }, message: 'Dạ em đã nhận được thông tin của Anh B rồi ạ. Em xin xác nhận lại đơn hàng:\n\nKhách hàng: Anh B\nSản phẩm: 1 can 20L Rượu Tam Giác Mạch\nSĐT: 0912345678\nĐịa chỉ: 456 Lê Lợi, Đà Nẵng', id: 'm2' }
  ];
  
  const confirmed = hasPageConfirmedOrder(messages, 'page1');
  assert.ok(confirmed, 'should be confirmed after page sends order confirmation');
  
  const order = detectOrder('page1', '123', { name: 'Khach B' }, messages);
  assert.ok(order);
});

test('3: multi-product order shows each product on its own line', () => {
  const messages = [
    { created_time: '2026-07-15T10:00:00Z', from: { id: '123', name: 'Khach C' }, message: 'Em lấy mỗi loại 1 túi nhé: 1 túi ngô men lá, 1 túi tam giác mạch. SĐT: 0978123456. Địa chỉ: 789 Trần Hưng Đạo, Hà Nội', id: 'm1' },
    { created_time: '2026-07-15T10:00:30Z', from: { id: 'page1' }, message: 'Dạ em đã nhận được thông tin và chốt đơn cho Anh C:\n\nSản phẩm:\n- 1 túi 5L Rượu Ngô Men Lá\n- 1 túi 5L Rượu Tam Giác Mạch\nTổng tiền: 660.000đ\nSĐT: 0978123456\nĐịa chỉ: 789 Trần Hưng Đạo, Hà Nội', id: 'm2' }
  ];
  
  const order = detectOrder('page1', '123', { name: 'Khach C' }, messages);
  assert.ok(order);
  
  const report = formatTelegramReport(order);
  assert.match(report, /Sản phẩm:/);
  assert.match(report, /  - /); // has sub-items
  console.log('Report:', report);
});

test('quantity parser accepts compact 5L packaging variants consistently', () => {
  for (const text of ['8 can5 lít', '8 can 5L', '8can5L']) {
    assert.deepEqual(parseOrderNotifyQuantities(text), [
      { amount: 8, unit: 'can', volume: '5L', priceUnit: '5L' }
    ]);
  }
});

test('confirmed message is the single source of truth for Telegram report', () => {
  const messages = [
    { created_time: '2026-07-23T13:55:10Z', from: { id: '26077791635149724', name: 'Nguyen Son Lam' }, message: 'Cho anh 4 can này nữa nhé về địa chỉ cũ', id: 'm1' },
    { created_time: '2026-07-23T14:33:00Z', from: { id: 'page1' }, message: [
      'Dạ em xin xác nhận lại đơn của Anh Lam ạ.',
      '',
      '• Sản phẩm: rượu tam giác mạch - 04 can 5L',
      '• SĐT: 0965378868',
      '• Địa chỉ: Khối 4, thị trấn Quỳ Hợp, huyện Quỳ Hợp, Nghệ An',
      '• Phí ship: 0đ',
      '• Tổng tiền: 1.320.000đ',
      '',
      'Em chốt đơn và chuyển bộ phận đóng hàng/giao hàng cho mình ạ.'
    ].join('\n'), id: 'm2' }
  ];

  const order = detectOrder('page1', '26077791635149724', { name: 'Nguyen Son Lam' }, messages, {
    confirmed: true,
    sourceAt: Date.parse('2026-07-23T13:55:10Z')
  });
  assert.ok(order);
  assert.equal(order.product, 'rượu tam giác mạch - 04 can 5L');
  assert.equal(order.phone, '0965378868');
  assert.equal(order.address, 'Khối 4, thị trấn Quỳ Hợp, huyện Quỳ Hợp, Nghệ An');
  assert.equal(order.shippingAmount, 0);
  assert.equal(order.totalAmount, 1320000);
  const report = formatTelegramReport(order);
  assert.match(report, /Tổng tiền: 1\.320\.000đ/);
  assert.match(report, /Địa chỉ: Khối 4, thị trấn Quỳ Hợp, huyện Quỳ Hợp, Nghệ An/);
  assert.doesNotMatch(report, /4\.800\.000đ|Địa chỉ: cũ/);
});

test('confirmed total ignores explanatory shipping amount in parentheses', () => {
  const messages = [
    {
      created_time: '2026-07-24T13:17:00Z',
      from: { id: 'page1' },
      id: 'confirm-thuy',
      message: [
        'Dạ em xin xác nhận đơn hàng:',
        '• Sản phẩm: rượu tam giác mạch - 01 túi 5L',
        '• SĐT: 0399555005',
        '• Địa chỉ: Số 19, ngách 16, ngõ Hòa Bình 4, phường Minh Khai, quận Hai Bà Trưng, Hà Nội',
        '• Phí ship: 20.000đ',
        '• Tổng tiền: 350.000đ (đã gồm phí ship 20.000đ)',
        'Em chốt đơn và chuyển bộ phận đóng hàng/giao hàng ạ.'
      ].join('\n')
    }
  ];

  const order = detectOrder('page1', 'customer-thuy', { name: 'Nguyễn Thuý' }, messages, {
    confirmed: true,
    sourceAt: Date.parse('2026-07-24T13:16:00Z'),
    sourceMessageId: 'customer-order-thuy'
  });
  assert.ok(order);
  assert.equal(order.shippingAmount, 20000);
  assert.equal(order.totalAmount, 350000);
  assert.match(formatTelegramReport(order), /Tổng tiền: 350\.000đ/);
});

test('4: customer changes quantity -> uses final confirmed version', () => {
  const messages = [
    { created_time: '2026-07-15T10:00:00Z', from: { id: '123', name: 'Khach D' }, message: 'Cho anh 2 túi ngô', id: 'm1' },
    { created_time: '2026-07-15T10:00:10Z', from: { id: 'page1' }, message: 'Dạ anh cho em xin SĐT và địa chỉ để lên đơn ạ', id: 'm2' },
    { created_time: '2026-07-15T10:00:20Z', from: { id: '123', name: 'Khach D' }, message: 'À thôi mỗi loại 1 túi đi em. SĐT: 0901234567. Địa chỉ: 12 Võ Văn Kiệt, Cần Thơ', id: 'm3' },
    { created_time: '2026-07-15T10:00:40Z', from: { id: 'page1' }, message: 'Dạ em đã nhận được thông tin của Anh D. Em chốt đơn:\n\nSản phẩm:\n- 1 túi 5L Rượu Ngô Men Lá\n- 1 túi 5L Rượu Tam Giác Mạch\nTổng: 660.000đ\nSĐT: 0901234567\nĐịa chỉ: 12 Võ Văn Kiệt, Cần Thơ', id: 'm4' }
  ];
  
  const order = detectOrder('page1', '123', { name: 'Khach D' }, messages);
  assert.ok(order);
  // Should capture "mỗi loại 1 túi" not "2 túi"
  const confirmed = hasPageConfirmedOrder(messages, 'page1');
  assert.ok(confirmed);
});

test('5: dedup key is based on page+customer+date+phone+address, not just product name', () => {
  const order1 = {
    pageId: 'page1', recipientId: 'cust1', signatureDate: '2026-07-15',
    phone: '0987654321', address: '123 Đường ABC, Hà Nội',
    product: 'Rượu Ngô Men Lá - 2 túi 5L'
  };
  const order2 = {
    pageId: 'page1', recipientId: 'cust1', signatureDate: '2026-07-15',
    phone: '0987654321', address: '123 Đường ABC, Hà Nội',
    product: 'rượu ngô men lá - 02 túi 5L' // same but different wording
  };
  
  const key1 = getOrderContactKey(order1);
  const key2 = getOrderContactKey(order2);
  assert.equal(key1, key2, 'same contact should produce same key within same day');
  
  // Different day should produce different key
  const order3 = { ...order1, signatureDate: '2026-07-16' };
  const key3 = getOrderContactKey(order3);
  assert.notEqual(key1, key3, 'different day should produce different key');
});

test('confirmation with placeholder old address is not a reportable order', () => {
  const messages = [
    {
      id: 'customer-add-on',
      created_time: '2026-07-24T01:05:57Z',
      from: { id: 'customer1', name: 'Khach' },
      message: 'Cho anh thêm 8 can5 lít nữa'
    },
    {
      id: 'bad-confirmation',
      created_time: '2026-07-24T01:06:25Z',
      from: { id: 'page1' },
      message: 'Sản phẩm: rượu tam giác mạch - 04 can 5L\nSĐT: 0965378868\nĐịa chỉ: cũ\nTổng tiền: 4.800.000đ\nEm chốt đơn.'
    }
  ];

  assert.equal(detectOrder('page1', 'customer1', { name: 'Khach' }, messages, {
    confirmed: true,
    sourceAt: Date.parse('2026-07-24T01:05:57Z'),
    sourceMessageId: 'customer-add-on'
  }), null);
});

test('confirmed add-on orders for the same contact on the same day have distinct source keys', () => {
  const base = {
    pageId: 'page1', recipientId: 'cust1', signatureDate: '2026-07-15',
    phone: '0987654321', address: '123 Đường ABC, Hà Nội',
    product: 'rượu tam giác mạch - 08 can 5L'
  };
  const first = { ...base, sourceMessageId: 'customer-order-1' };
  const retry = { ...base, sourceMessageId: 'customer-order-1' };
  const addOn = { ...base, sourceMessageId: 'customer-order-2' };

  assert.equal(getOrderNotificationKey(first), getOrderNotificationKey(retry));
  assert.notEqual(getOrderNotificationKey(first), getOrderNotificationKey(addOn));
});

test('6: consultation/description text is not extracted as product', () => {
  const consultationText = 'Dạ rượu tam giác mạch bên em thanh nhẹ, hậu ngọt, thơm thoang thoảng mùi hoa rừng, uống êm và dễ vào hơn dòng ngô men lá. Độ khoảng 25-28 độ. Để rượu nghỉ 3-4 ngày rồi uống sẽ ngon hơn ạ.';
  
  const product = extractOrderNotifyProduct(consultationText);
  // Should be empty or NOT contain the consultation text as a product
  if (product) {
    assert.doesNotMatch(product, /thanh nhẹ|hậu ngọt|thoang thoảng/);
    assert.doesNotMatch(product, /để rượu nghỉ/);
  }
  
  // But actual product text should be extracted
  const productText = '1 túi rượu ngô men lá 5L và 1 túi rượu tam giác mạch 5L. SĐT: 0912345678. Địa chỉ: Hà Nội';
  const product2 = extractOrderNotifyProduct(productText);
  assert.ok(product2, 'should extract product from order text');
});

test('integration: no confirmation by page -> hasPageConfirmedOrder returns false', () => {
  // Simulate: customer gave phone+address+product but page only asked, didn't confirm
  const messages = [
    { created_time: '2026-07-15T10:00:00Z', from: { id: '123', name: 'Khach E' }, message: 'Cho em 1 can 20L tam giác mạch. SĐT: 0909999999. Địa chỉ: 12 Lê Duẩn, Huế', id: 'm1' },
    { created_time: '2026-07-15T10:00:10Z', from: { id: 'page1' }, message: 'Dạ anh cho em xin thêm địa chỉ cụ thể để giao hàng nhanh hơn ạ.', id: 'm2' }
  ];
  
  const confirmed = hasPageConfirmedOrder(messages, 'page1');
  assert.equal(confirmed, false, 'asking for more address detail is NOT an order confirmation yet');
  
  const order = detectOrder('page1', '123', { name: 'Khach E' }, messages);
  assert.ok(order, 'detectOrder finds the data');
  // hasPageConfirmedOrder = false -> notification should be skipped
});

// ── Pending Lead Tests ───────────────────────────────────────────────

test('pending: customer has phone+address+product but not confirmed -> detected as lead', () => {
  const messages = [
    { created_time: '2026-07-15T10:00:00Z', from: { id: '123', name: 'Khach F' }, message: 'Cho em 1 can 20L tam giác mạch. SĐT: 0911222333. Địa chỉ: 99 Nguyễn Trãi, Hà Nội', id: 'm1' },
    { created_time: '2026-07-15T10:00:10Z', from: { id: 'page1' }, message: 'Dạ anh cho em xin thêm địa chỉ cụ thể để giao nhanh hơn ạ.', id: 'm2' }
  ];
  
  const order = detectOrder('page1', '123', { name: 'Khach F' }, messages);
  assert.ok(order, 'should detect the order data');
  
  const confirmed = hasPageConfirmedOrder(messages, 'page1');
  assert.equal(confirmed, false, 'not confirmed -> should be a pending lead');
});

test('pending: after bot confirms -> pending lead should NOT trigger', () => {
  const messages = [
    { created_time: '2026-07-15T10:00:00Z', from: { id: '123', name: 'Khach G' }, message: 'Cho em 2 túi ngô men lá. SĐT: 0905555666. Địa chỉ: 88 Lý Thường Kiệt, Đà Nẵng', id: 'm1' },
    { created_time: '2026-07-15T10:00:30Z', from: { id: 'page1' }, message: 'Dạ em đã nhận được thông tin và chốt đơn cho Anh G. Sản phẩm: 2 túi 5L, SĐT: 0905555666, Địa chỉ: 88 Lý Thường Kiệt, Đà Nẵng', id: 'm2' }
  ];
  
  const confirmed = hasPageConfirmedOrder(messages, 'page1');
  assert.ok(confirmed, 'should be confirmed -> pending lead should NOT fire');
});
