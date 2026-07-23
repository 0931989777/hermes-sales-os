import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { __test } from './server.mjs';

const history = [
  'Page/admin/bot: dạ loại nhẹ dễ uống thì tam giác mạch, đậm thơm men lá thì ngô men lá ạ.',
  'Khach: Đảm bảo ngon và ko đau đầu chứ nhỉ???',
  'Page/admin/bot: Dạ em đây ạ. Anh NT cần hỏi giá, xem sản phẩm hay đặt rượu Bản Mộc loại nào ạ?',
  'Khach: Chỉ Tam giác mạch thôi. Vị hướng thế nào nhỉ?',
  'Page/admin/bot: Dạ Bản Mộc có rượu ngô men lá và rượu tam giác mạch Hà Giang. Túi 5L giá 330.000đ, can 20L giá 1.200.000đ. Anh NT cần tư vấn loại nào ạ?',
  'Khach: Trả lời theo dòng trao đổi chứ, cứ lộn xộn thông tin thế?',
  'Page/admin/bot: Dạ em đây ạ. Anh NT cần hỏi giá, xem sản phẩm hay đặt rượu Bản Mộc loại nào ạ?',
  'Khach: Xem từ trên đi'
].join('\n');

test('emergency reply follows tam giac mach taste context instead of generic greeting', () => {
  const reply = __test.buildEmergencySalesReply('Xem từ trên đi', { conversationHistory: history });
  assert.match(reply, /xin lỗi/i);
  assert.match(reply, /tam giác mạch/i);
  assert.match(reply, /thanh nhẹ|hậu/i);
  assert.doesNotMatch(reply, /cần hỏi giá, xem sản phẩm hay đặt/i);
  assert.doesNotMatch(reply, /Túi 5L giá/i);
});

test('tam giac mach taste question does not list unrelated products/prices', () => {
  const reply = __test.buildEmergencySalesReply('Chỉ Tam giác mạch thôi. Vị hướng thế nào nhỉ?', { conversationHistory: history });
  assert.match(reply, /tam giác mạch/i);
  assert.match(reply, /thanh nhẹ|hậu/i);
  assert.doesNotMatch(reply, /rượu ngô men lá và rượu tam giác mạch/i);
  assert.doesNotMatch(reply, /Túi 5L giá/i);
});

test('product color question says clear white instead of pale yellow', () => {
  const reply = __test.buildEmergencySalesReply('Rượu ngô men lá có màu gì vậy?');
  assert.match(reply, /trắng trong/i);
  assert.match(reply, /chưng cất|hạ thổ/i);
  assert.doesNotMatch(reply, /có màu vàng nhạt|màu vàng nhạt tự nhiên/i);
  assert.doesNotMatch(reply, /gửi ảnh sản phẩm/i);
});

test('aldehyde treatment questions receive the verified production answer', () => {
  for (const text of [
    'Rượu đã khử andehit chưa?',
    'Bên mình lọc an đe hit chưa shop?',
    'Đã xử lý aldehyde chưa?'
  ]) {
    const reply = __test.buildEmergencySalesReply(text);
    assert.match(reply, /đã được lọc/i);
    assert.match(reply, /khử andehit/i);
    assert.match(reply, /quá trình lão hóa/i);
  }
});

test('generic look-up phrase is not treated as product media request', () => {
  assert.equal(__test.isExplicitProductMediaRequest('Xem từ trên đi'), false);
  assert.equal(__test.getMatchedProductMediaRules('Xem từ trên đi').length, 0);
});

test('generic product bag photo request selects product images', () => {
  for (const text of ['Hình túi ruou', 'Gửi hình túi rượu cho anh xem', 'Cho xem ảnh túi rượu']) {
    assert.equal(__test.isExplicitProductMediaRequest(text), true);
    const rules = __test.getMatchedProductMediaRules(text);
    assert.ok(rules.length > 0, `expected media rule for: ${text}`);
    assert.ok(rules.some((rule) => rule.name === 'anh-san-pham'));
  }
});

test('Vietnamese pronoun anh alone is not mistaken for an image request', () => {
  for (const text of ['Cho anh 4 can 5L', 'Anh muốn mua rượu', 'Gửi cho anh nhé']) {
    assert.equal(__test.isExplicitProductMediaRequest(text), false, text);
  }
});

test('media selector sends only the exact requested product and at most two images', () => {
  const tam = __test.selectProductMediaImagePaths('Gửi ảnh rượu tam giác mạch');
  assert.deepEqual(tam, ['tam-giac-mach-product.jpg', 'tam-giac-mach-ingredient.jpg']);
  assert.ok(tam.length <= 2);

  const ngo = __test.selectProductMediaImagePaths('Cho xem hình rượu ngô men lá');
  assert.deepEqual(ngo, ['ngo-men-la-product.jpg', 'ngo-men-la-ingredient.jpg']);
  assert.ok(ngo.length <= 2);
});

test('media selector caps every request at two images and prioritizes specific intent', () => {
  const feedback = __test.selectProductMediaImagePaths('Gửi ảnh feedback khách hàng');
  assert.equal(feedback.length, 2);
  assert.ok(feedback.every((path) => path.startsWith('feedback-khach-hang-')));

  assert.deepEqual(
    __test.selectProductMediaImagePaths('Cho xem ảnh giấy phép sản xuất và giấy kiểm nghiệm'),
    ['ruou-giay-phep-san-xuat.jpg', 'ruou-giay-kiem-nghiem-ngo-men-la.jpg']
  );
  assert.deepEqual(
    __test.selectProductMediaImagePaths('Gửi ảnh giấy an toàn thực phẩm'),
    ['ruou-giay-to-an-toan-thuc-pham.jpg']
  );
  assert.deepEqual(
    __test.selectProductMediaImagePaths('Cho xem ảnh đăng ký kinh doanh'),
    ['ruou-giay-dang-ky-kinh-doanh.jpg']
  );

  assert.deepEqual(
    __test.selectProductMediaImagePaths('Cho xem ảnh can 20L'),
    ['can-20l-packaging.jpg']
  );
});

test('request for both products sends one matching product image for each', () => {
  assert.deepEqual(
    __test.selectProductMediaImagePaths('Gửi ảnh rượu tam giác mạch và rượu ngô men lá'),
    ['tam-giac-mach-product.jpg', 'ngo-men-la-product.jpg']
  );
});

test('order confirmation includes mandatory transport storage advice', () => {
  const reply = __test.buildOrderDetailsConfirmationReply({
    product: 'rượu tam giác mạch - 01 túi 5L',
    phone: '0332516949',
    address: 'xã Tân Lập, huyện Bắc Quang, tỉnh Hà Giang',
    totalAmount: 350000
  }, { name: 'Pham Triệu' });

  assert.match(reply, /vận chuyển xa.*thời tiết nắng nóng.*rượu bị sốc/is);
  assert.match(reply, /thoáng mát.*3-4 ngày/is);
  assert.match(reply, /ngăn mát tủ lạnh.*3-4 tiếng/is);
});

test('existing-order delivery questions never enter a new-order flow', () => {
  for (const text of [
    'Gởi rượu cho anh gần tới chưa em',
    'Gửi rượu cho anh gần tới chưa em',
    'Đơn của anh gần đến chưa?',
    'Hàng gửi tới đâu rồi em?'
  ]) {
    assert.equal(__test.isExistingOrderInquiry(text), true);
    const reply = __test.buildEmergencySalesReply(text);
    assert.match(reply, /kiểm tra.*tình trạng vận chuyển/is);
    assert.doesNotMatch(reply, /chốt đơn|lên đơn|2-3 ngày|3-4 ngày/i);
  }
});

test('old order history plus a delivery inquiry does not produce a detected order', () => {
  const pageId = '625538103984936';
  const customerId = '37318798874431675';
  const messages = [
    {
      id: 'old-customer-order',
      created_time: '2026-07-22T09:01:10Z',
      from: { id: customerId, name: 'Phêrô Thảo' },
      message: 'Gởi cho anh 1 túi 5 lít rượu tam giác mạch uống thử. Về 70 Hoàng Dư Khương phường Cẩm Lệ Đà Nẵng sdt 0903575215'
    },
    {
      id: 'old-page-confirmation',
      created_time: '2026-07-22T09:03:22Z',
      from: { id: pageId, name: 'BẢN MỘC' },
      message: 'Sản phẩm: rượu tam giác mạch - 01 túi 5L\nSĐT: 0903575215\nĐịa chỉ: 70 Hoàng Dư Khương, Cẩm Lệ, Đà Nẵng\nEm chốt đơn.'
    },
    {
      id: 'delivery-question',
      created_time: '2026-07-23T12:21:19Z',
      from: { id: customerId, name: 'Phêrô Thảo' },
      message: 'Gởi rượu cho anh gần tới chưa em'
    }
  ];

  const order = __test.detectNewOrderForNotification(pageId, customerId, { name: 'Phêrô Thảo' }, messages, {
    sourceAt: Date.parse('2026-07-23T12:21:19Z'),
    sourceMessageId: 'delivery-question'
  });
  assert.equal(order, null);
  assert.equal(__test.shouldConfirmOrderDetailsFromCustomer('Gởi rượu cho anh gần tới chưa em', messages, pageId), false);
});

test('repeat customer can reuse old phone and address for a new order', () => {
  const pageId = '625538103984936';
  const customerId = '26077791635149724';
  const messages = [
    {
      id: 'old-order',
      created_time: '2026-07-07T00:36:53Z',
      from: { id: customerId, name: 'Nguyen Son Lam' },
      message: 'Cho anh 2 túi 5 lít rượu ngô men lá về Khối 4, thị trấn Quỳ Hợp, huyện Quỳ Hợp, Nghệ An, 0965378868'
    },
    {
      id: 'repeat-order',
      created_time: '2026-07-23T13:55:10Z',
      from: { id: customerId, name: 'Nguyen Son Lam' },
      message: 'Cho anh 4 can 5L rượu tam giác mạch này nữa nhé về địa chỉ cũ'
    }
  ];

  const order = __test.detectRepeatCustomerOrder(pageId, customerId, { name: 'Nguyen Son Lam' }, messages, {
    sourceAt: Date.parse('2026-07-23T13:55:10Z'),
    sourceMessageId: 'repeat-order'
  });
  assert.equal(order.phone, '0965378868');
  assert.match(order.address, /Khối 4.*Quỳ Hợp.*Nghệ An/i);
  assert.equal(order.product, 'rượu tam giác mạch - 04 can 5L');
  assert.equal(order.totalAmount, 1320000);
  const reply = __test.buildOrderDetailsConfirmationReply(order, { name: 'Nguyen Son Lam' });
  assert.match(reply, /SĐT: 0965378868/i);
  assert.match(reply, /Địa chỉ:.*Khối 4/is);
  assert.match(reply, /Tổng tiền: 1\.320\.000đ/i);
});

test('customer contact details after order quote are detected as an order', () => {
  const pageId = '560889237118933';
  const customerId = '36844049428575012';
  const messages = [
    {
      created_time: '2026-07-15T08:32:00+00:00',
      from: { id: pageId },
      message: [
        'Dạ vâng Anh Đông, em lên đơn 1 túi 5L rượu tam giác mạch cho mình ạ.',
        '',
        'Đơn 1 túi là 330.000đ, phí ship 20.000đ, tổng 350.000đ ạ.',
        '',
        'Anh Đông cho em xin số điện thoại và địa chỉ nhận hàng cụ thể gồm số nhà/thôn xóm, xã/phường, huyện/quận, tỉnh/thành phố để bên em lên đơn chính xác, tránh thất lạc và giao nhanh nhất ạ.'
      ].join('\n')
    },
    {
      created_time: '2026-07-15T08:33:00+00:00',
      from: { id: customerId, name: 'Hoàng Đông' },
      message: '203/2 nguyên tri phương, Thanh Khê, Đà Nẵng'
    },
    {
      created_time: '2026-07-15T08:33:05+00:00',
      from: { id: customerId, name: 'Hoàng Đông' },
      message: 'Đông: 0906641984'
    }
  ];

  const order = __test.detectNewOrderForNotification(pageId, customerId, { name: 'Hoàng Đông' }, messages, {
    sourceAt: Date.parse('2026-07-15T08:33:05+00:00')
  });
  assert.equal(order.product, 'rượu tam giác mạch - 01 túi 5L');
  assert.equal(order.address, '203/2 nguyên tri phương, Thanh Khê, Đà Nẵng');
  assert.equal(order.phone, '0906641984');
  assert.equal(order.totalAmount, 350000);
  assert.equal(__test.shouldConfirmOrderDetailsFromCustomer('203/2 nguyên tri phương, Thanh Khê, Đà Nẵng\nĐông: 0906641984', messages, pageId), true);

  const reply = __test.buildOrderDetailsConfirmationReply(order, { name: 'Hoàng Đông' });
  assert.match(reply, /chốt đơn/i);
  assert.match(reply, /203\/2 nguyên tri phương/i);
  assert.match(reply, /vận chuyển xa.*thời tiết nắng nóng.*rượu bị sốc/is);
  assert.match(reply, /thoáng mát.*3-4 ngày/is);
  assert.match(reply, /ngăn mát tủ lạnh.*3-4 tiếng/is);
  assert.doesNotMatch(reply, /cần hỏi giá, xem sản phẩm hay đặt/i);
});

test('order notification waits for bot confirmation and ignores advice as product', () => {
  const pageId = '625538103984936';
  const customerId = '36961432536837967';
  const customerAt = Date.parse('2026-07-15T10:50:00+00:00');
  const messagesBeforeConfirm = [
    {
      created_time: '2026-07-15T10:48:00+00:00',
      from: { id: customerId, name: 'Thanh Tùng' },
      message: 'tam giac mach di em'
    },
    {
      created_time: '2026-07-15T10:49:00+00:00',
      from: { id: pageId },
      message: 'Dạ em lên đơn 2 túi 5L rượu tam giác mạch cho mình ạ. Tổng 660.000đ ạ.'
    },
    {
      created_time: '2026-07-15T10:50:00+00:00',
      from: { id: customerId, name: 'Thanh Tùng' },
      message: 'C12. 2 Cụm Công Nghiệp Nhị Xuân, đường Nguyễn Văn Bứa, Xã Xuân Thới Sơn, Thành phố Hồ Chí Minh, Việt Nam\n0934582333'
    }
  ];
  const confirmationReply = [
    'Dạ em nhận được thông tin của Anh Tùng rồi ạ.',
    '',
    '• Sản phẩm: rượu tam giác mạch - 02 túi 5L',
    '• SĐT: 0934582333',
    '• Địa chỉ: C12. 2 Cụm Công Nghiệp Nhị Xuân, đường Nguyễn Văn Bứa, Xã Xuân Thới Sơn, Thành phố Hồ Chí Minh, Việt Nam',
    '• Tổng tiền: 660.000đ',
    '',
    'Em chốt đơn và chuyển bộ phận đóng hàng/giao hàng cho mình nhé.'
  ].join('\n');
  const messagesAfterConfirm = [
    ...messagesBeforeConfirm,
    {
      created_time: '2026-07-15T10:53:00+00:00',
      from: { id: pageId },
      message: confirmationReply
    },
    {
      created_time: '2026-07-15T10:53:05+00:00',
      from: { id: pageId },
      message: 'Em lưu ý thêm để mình thưởng thức rượu ngon nhất ạ: do quá trình vận chuyển xa và thời tiết nắng nóng có thể làm rượu bị sốc, khi nhận hàng Anh Tùng chưa nên dùng ngay.'
    }
  ];

  assert.equal(__test.hasConfirmedOrderMessageAfterCustomer(messagesBeforeConfirm, pageId, customerAt), false);
  assert.ok(__test.hasConfirmedOrderMessageAfterCustomer(messagesAfterConfirm, pageId, customerAt));
  assert.equal(__test.extractOrderNotifyProduct(messagesAfterConfirm.map((message) => message.message).join('\n')), 'rượu tam giác mạch - 02 túi 5L');
  assert.equal(__test.isOrderConfirmationPageMessage(confirmationReply), true);

  const order = __test.detectNewOrderForNotification(pageId, customerId, { name: 'Thanh Tùng' }, messagesAfterConfirm, {
    sourceAt: customerAt
  });
  const sameContactDifferentProduct = {
    ...order,
    product: 'Em lưu ý thêm để mình thưởng thức rượu ngon nhất ạ'
  };
  assert.equal(
    __test.getOrderNotificationContactKey(order),
    __test.getOrderNotificationContactKey(sameContactDifferentProduct)
  );
});

test('order notification preserves mixed product quantities from confirmed product block', () => {
  const pageId = '625538103984936';
  const customerId = '36961432536837967';
  const customerAt = Date.parse('2026-07-15T10:53:02+00:00');
  const messages = [
    {
      created_time: '2026-07-15T10:46:14+00:00',
      from: { id: customerId, name: 'Thanh Tùng' },
      message: 'a lấy 2 túi'
    },
    {
      created_time: '2026-07-15T10:46:21+00:00',
      from: { id: customerId, name: 'Thanh Tùng' },
      message: 'loai 5l'
    },
    {
      created_time: '2026-07-15T10:49:03+00:00',
      from: { id: customerId, name: 'Thanh Tùng' },
      message: 'tam giac mạch đi em'
    },
    {
      created_time: '2026-07-15T10:50:13+00:00',
      from: { id: customerId, name: 'Thanh Tùng' },
      message: '0934582333'
    },
    {
      created_time: '2026-07-15T10:50:49+00:00',
      from: { id: customerId, name: 'Thanh Tùng' },
      message: 'a đổi lại lây mỗi loại 1 túi'
    },
    {
      created_time: '2026-07-15T10:51:40+00:00',
      from: { id: customerId, name: 'Thanh Tùng' },
      message: 'C12.2 Cụm Công Nghiệp Nhị Xuân, đường Nguyễn Văn Bứa, Xã Xuân Thới Sơn, Thành phố Hồ Chí Minh, Việt Nam'
    },
    {
      created_time: '2026-07-15T10:51:56+00:00',
      from: { id: customerId, name: 'Thanh Tùng' },
      message: '0934582333 A Tùng'
    },
    {
      created_time: '2026-07-15T10:52:00+00:00',
      from: { id: pageId },
      message: [
        'Dạ Anh Tùng, em cập nhật lại đơn của mình: mỗi loại 1 túi 5L ạ.',
        '',
        'Em xin xác nhận:',
        '',
        '- 1 túi 5L rượu Tam Giác Mạch: 330.000đ',
        '- 1 túi 5L rượu Ngô Men Lá: 330.000đ',
        '- Tổng: 660.000đ',
        '- Miễn phí vận chuyển toàn quốc',
        '',
        'Địa chỉ giao hàng: C12.2 Cụm Công Nghiệp Nhị Xuân, đường Nguyễn Văn Bứa, Xã Xuân Thới Sơn, TP.HCM',
        'Số điện thoại: 0934582333'
      ].join('\n')
    },
    {
      created_time: '2026-07-15T10:53:02+00:00',
      from: { id: customerId, name: 'Thanh Tùng' },
      message: 'ok em'
    },
    {
      created_time: '2026-07-15T10:54:11+00:00',
      from: { id: pageId },
      message: [
        'Dạ em đã nhận được xác nhận của Anh Tùng rồi ạ. Em xin chốt lại đơn hàng của mình như sau:',
        '',
        'Khách hàng: Anh Tùng',
        'Sản phẩm:',
        '- 1 túi 5L rượu Tam Giác Mạch: 330.000đ',
        '- 1 túi 5L rượu Ngô Men Lá: 330.000đ',
        'Tổng tiền: 660.000đ',
        'Địa chỉ giao hàng: C12.2 Cụm Công Nghiệp Nhị Xuân, đường Nguyễn Văn Bứa, Xã Xuân Thới Sơn, TP.HCM',
        'Số điện thoại: 0934582333'
      ].join('\n')
    }
  ];

  const allText = messages.map((message) => message.message).join('\n');
  assert.equal(
    __test.extractOrderNotifyProduct(allText),
    'rượu tam giác mạch - 01 túi 5L; rượu ngô men lá - 01 túi 5L'
  );

  const order = __test.detectNewOrderForNotification(pageId, customerId, { name: 'Thanh Tùng' }, messages, {
    sourceAt: customerAt
  });
  assert.equal(order.product, 'rượu tam giác mạch - 01 túi 5L; rượu ngô men lá - 01 túi 5L');
  assert.equal(order.productAmount, 660000);
  assert.equal(order.shippingAmount, 0);
  assert.equal(order.totalAmount, 660000);
});

test('a Page private reply before the latest customer message must not pause the bot', () => {
  const pageId = '625538103984936';
  const customerId = '27493564816987972';
  const customerAt = Date.parse('2026-07-23T14:20:20Z');
  const messages = [
    {
      created_time: '2026-07-23T14:19:46Z',
      from: { id: pageId },
      message: 'Em chào anh Quân, không biết anh Quân quan tâm tới sản phẩm nào bên em ạ?'
    },
    {
      created_time: '2026-07-23T14:20:20Z',
      from: { id: customerId },
      message: 'R tam giác mạch'
    }
  ];
  assert.equal(__test.getLastManualPageMessageAt(pageId, customerId, messages, customerAt), 0);
  assert.equal(__test.isAdminPauseRelevantToCustomerMessage(Date.parse('2026-07-23T14:19:46Z'), customerAt), false);
  assert.equal(__test.isAdminPauseRelevantToCustomerMessage(Date.parse('2026-07-23T14:20:30Z'), customerAt), true);
});

test('meta ad auto answers do not count as manual page replies', () => {
  assert.equal(__test.isMetaAutoPageMessage('Chào Tôi, bạn đang tìm Rượu Tam Giác Mạch Hà Giang chuẩn vị?'), true);
  assert.equal(__test.isMetaAutoPageMessage('Chào Công Ứng! Chúng tôi có thể giúp gì cho bạn?'), true);
  assert.equal(__test.isMetaAutoPageMessage('Xin chào Công Ứng! Bạn có thắc mắc nào cần trao đổi thêm với chúng tôi không?'), true);
  assert.equal(__test.isMetaAutoPageMessage('Your AI agent transferred this chat to you.'), true);
  assert.equal(__test.isMetaAutoPageMessage('Tác nhân AI đã chuyển đoạn chat này cho bạn.'), true);
  assert.equal(__test.isMetaAutoPageMessage('Rượu Tam Giác Mạch men lá có nồng độ từ 25-28 độ.'), true);
  assert.equal(__test.isMetaAutoPageMessage('Rượu được nấu từ hạt tam giác mạch trồng trên cao nguyên đá, ủ bằng men lá rừng truyền thống và chưng cất thủ công từng mẻ nhỏ.'), true);
});

test('poll distinguishes the bot reply from a later manual Page reply', () => {
  const botSentAt = new Date('2026-07-23T10:03:18Z').getTime();
  assert.equal(
    __test.isRecordedBotPageMessageAt(new Date('2026-07-23T10:03:17Z').getTime(), botSentAt),
    true
  );
  assert.equal(
    __test.isRecordedBotPageMessageAt(new Date('2026-07-23T10:04:00Z').getTime(), botSentAt),
    false
  );
});

test('emergency reply treats deferred purchase as follow-up instead of order details request', () => {
  for (const text of [
    'A lưu thông tin bên em để tết mua',
    'Giờ a chưa lấy đâu e',
    'Khi nào lấy rượu a cho địa chỉ sau'
  ]) {
    const reply = __test.buildEmergencySalesReply(text);
    assert.match(reply, /lưu ý thông tin|khi nào mình cần lấy/i);
    assert.doesNotMatch(reply, /Tên người nhận|Số điện thoại|Sản phẩm và số lượng|Địa chỉ nhận hàng cụ thể/i);
  }
});

test('emergency quantity plus contact asks wine type instead of repeating price', () => {
  const reply = __test.buildEmergencySalesReply('Cho anh thử trước 2 túi 5lit nhé\nSĐT 0371234567\nĐịa chỉ: thôn 3, xã Minh Tân, huyện Bắc Quang, Hà Giang');
  assert.match(reply, /muốn chọn loại nào|rượu ngô men lá|rượu tam giác mạch/i);
  assert.doesNotMatch(reply, /giá rượu|Túi 5L: 330\.000đ|Can 20L: 1\.200\.000đ/i);
});

test('emergency tam giac mach product reply uses clear bullet format', () => {
  const reply = __test.buildEmergencySalesReply('rượu tam giác mạch');
  assert.match(reply, /Nồng độ:/i);
  assert.match(reply, /Nguyên liệu:/i);
  assert.match(reply, /Hương vị:/i);
  assert.match(reply, /Phù hợp:/i);
  assert.doesNotMatch(reply, /độ khoảng 25-28 độ, vị thanh nhẹ, hậu ngọt/i);
});
