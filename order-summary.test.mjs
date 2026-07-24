import { strict as assert } from "node:assert";
import { test } from "node:test";
import { cleanOrderField, extractConfirmationFields } from "./order-summary.mjs";

test("summary total stops before closing sentence", () => {
  const confirmation = [
    "Sản phẩm: rượu ngô men lá - 01 túi 5L; rượu tam giác mạch - 01 túi 5L",
    "Phí ship: 20.000đ",
    "Tổng tiền: 660.000đ Em chốt đơn và chuyển bộ phận đóng hàng/giao hàng cho mình nhé.",
    "Địa chỉ: Hà Nội",
    "SĐT: 0912345678"
  ].join("\n");

  const fields = extractConfirmationFields(confirmation);
  assert.equal(cleanOrderField(fields.total), "660.000đ");
});