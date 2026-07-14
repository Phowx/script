import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const SCRIPT_URL = new URL("../scripts/v2ex/v2ex.js", import.meta.url);
const SCRIPT_SOURCE = await readFile(SCRIPT_URL, "utf8").catch(() => "");
const MISSION_URL = "https://www.v2ex.com/mission/daily";
const BALANCE_URL = "https://www.v2ex.com/balance";

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

async function runSurge({ store = {}, request, argument, responses = [] } = {}) {
  const values = new Map(Object.entries(store));
  const calls = [];
  const notifications = [];
  const logs = [];
  const pending = [...responses];
  let finish;
  const completed = new Promise((resolve) => {
    finish = resolve;
  });

  const context = {
    console: {
      log: (...items) => logs.push(items.map(String).join(" ")),
    },
    $persistentStore: {
      read: (key) => values.get(key) ?? null,
      write: (value, key) => {
        values.set(key, value);
        return true;
      },
    },
    $notification: {
      post: (title, subtitle, body) => notifications.push({ title, subtitle, body }),
    },
    $httpClient: {
      get: (options, callback) => {
        calls.push(options);
        const response = pending.shift();
        queueMicrotask(() => {
          if (!response) {
            callback("Unexpected request", null, null);
            return;
          }
          if (response.error) {
            callback(response.error, response.response || null, response.body || null);
            return;
          }
          callback(
            null,
            {
              status: response.status ?? 200,
              statusCode: response.status ?? 200,
              headers: response.headers || {},
            },
            response.body || "",
          );
        });
      },
    },
    setTimeout: (callback) => queueMicrotask(callback),
    $done: (value) => finish(value),
  };

  if (request) context.$request = request;
  if (argument !== undefined) context.$argument = argument;

  vm.createContext(context);
  vm.runInContext(SCRIPT_SOURCE, context, { filename: SCRIPT_URL.pathname });
  await completed;

  return { values, calls, notifications, logs, remainingResponses: pending };
}

function notification(result, subtitle) {
  return result.notifications.find((item) => item.subtitle === subtitle);
}

function missionClaimed({ days = 1262 } = {}) {
  return `<html><h1>每日登录奖励已领取</h1><p>已连续登录 ${days} 天</p></html>`;
}

function missionReady({ once = "11111", days = 1261 } = {}) {
  return `<html><p>已连续登录 ${days} 天</p>`
    + `<input value="领取奖励" onclick="location.href = '/mission/daily/redeem?once=${once}';"></html>`;
}

function localDateKey(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

function balancePage({ reward = 5 } = {}) {
  return `<html><div class="balance_area bigger">3 <img alt="G"> 56 <img alt="B"></div>`
    + `<table><tr><td>${localDateKey()} 的每日登录奖励 ${reward} 铜币</td></tr></table></html>`;
}

test("capture mode stores the full Cookie and User-Agent", async () => {
  assert.notEqual(SCRIPT_SOURCE, "", "V2EX Surge script must exist");

  const cookie = "A2=COOKIE_SECRET; V2EX_LANG=zhcn";
  const result = await runSurge({
    request: {
      method: "GET",
      headers: { Cookie: cookie, "User-Agent": "Surge Test UA" },
    },
  });

  assert.equal(result.values.get("v2ex_cookie"), cookie);
  assert.equal(result.values.get("v2ex_ua"), "Surge Test UA");
  assert.ok(notification(result, "Cookie 获取成功"));
  assert.equal(result.calls.length, 0);
});

test("capture mode refreshes stored values without duplicate notification", async () => {
  const cookie = "A2=COOKIE_SECRET; V2EX_LANG=zhcn";
  const result = await runSurge({
    store: { v2ex_cookie: cookie, v2ex_ua: "Old UA" },
    request: {
      method: "GET",
      headers: { Cookie: cookie, "User-Agent": "New UA" },
    },
  });

  assert.equal(result.values.get("v2ex_cookie"), cookie);
  assert.equal(result.values.get("v2ex_ua"), "New UA");
  assert.equal(notification(result, "Cookie 获取成功"), undefined);
  assert.equal(result.calls.length, 0);
});

test("an already-claimed mission does not redeem again", async () => {
  const result = await runSurge({
    store: { v2ex_cookie: "A2=COOKIE_SECRET", v2ex_ua: "Surge Test UA" },
    responses: [
      { body: missionClaimed({ days: 1262 }) },
      { body: balancePage() },
    ],
  });

  assert.deepEqual(result.calls.map((call) => call.url), [MISSION_URL, BALANCE_URL]);
  assert.ok(notification(result, "今日已签到"));
  assert.equal(result.calls.some((call) => /\/redeem\?/.test(call.url)), false);
});

test("a redemption is successful only after the mission page confirms it", async () => {
  const result = await runSurge({
    store: { v2ex_cookie: "A2=COOKIE_SECRET", v2ex_ua: "Surge Test UA" },
    responses: [
      { body: missionReady({ once: "11111", days: 1261 }) },
      { status: 302, headers: { Location: MISSION_URL }, body: "" },
      { body: missionClaimed({ days: 1262 }) },
      { body: balancePage({ reward: 5 }) },
    ],
  });

  assert.deepEqual(result.calls.map((call) => call.url), [
    MISSION_URL,
    `${MISSION_URL}/redeem?once=11111`,
    MISSION_URL,
    BALANCE_URL,
  ]);
  assert.equal(result.calls[1].headers.Referer, MISSION_URL);
  const notice = notification(result, "签到成功");
  assert.ok(notice);
  assert.match(notice.body, /连续 1262 天/);
  assert.match(notice.body, /奖励 5 铜币/);
  assert.match(notice.body, /余额 3 金币, 56 铜币/);
});

export async function runTests() {
  const failures = [];
  for (const { name, fn } of tests) {
    try {
      await fn();
    } catch (error) {
      failures.push(`${name}: ${error.stack || error}`);
    }
  }

  if (failures.length) {
    throw new Error(`${failures.length}/${tests.length} tests failed\n${failures.join("\n\n")}`);
  }
  return `${tests.length}/${tests.length} V2EX tests passed`;
}
