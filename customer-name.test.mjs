import { strict as assert } from "node:assert";
import { test } from "node:test";
import { extractCustomerShortName, mergeStructuredCustomerProfile } from "./customer-name.mjs";

test("Facebook reversed Vietnamese name uses given name before trailing surname", () => {
  assert.equal(extractCustomerShortName({ name: "Hoàng Long Lê" }), "Long");
});

test("Meta first_name is preferred when available", () => {
  assert.equal(extractCustomerShortName({ name: "Hoàng Long Lê", firstName: "Long" }), "Long");
});

test("normal Vietnamese family-name-first profile keeps final given name", () => {
  assert.equal(extractCustomerShortName({ name: "Lê Hoàng Long" }), "Long");
});

test("two-part Vietnamese name keeps final given name", () => {
  assert.equal(extractCustomerShortName({ name: "Nguyễn Thuý" }), "Thuý");
});

test("single name remains unchanged", () => {
  assert.equal(extractCustomerShortName({ name: "Long" }), "Long");
});

test("structured Facebook first_name overrides any display-name position", () => {
  const profile = mergeStructuredCustomerProfile(
    { id: "customer-1", name: "Hoàng Long Lê", firstName: "", lastName: "" },
    { id: "customer-1", name: "Long Lê", firstName: "Long", lastName: "Lê" }
  );
  assert.equal(profile.firstName, "Long");
  assert.equal(profile.lastName, "Lê");
  assert.equal(extractCustomerShortName(profile), "Long");
});
