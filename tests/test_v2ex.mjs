import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const SCRIPT_URL = new URL("../scripts/v2ex/v2ex.js", import.meta.url);
const SCRIPT_SOURCE = await readFile(SCRIPT_URL, "utf8").catch(() => "");
const MODULE_URL = new URL("../modules/v2ex.sgmodule", import.meta.url);
const MODULE_SOURCE = await readFile(MODULE_URL, "utf8").catch(() => "");
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

function redeemOnceValues(calls) {
  return calls
    .map((call) => String(call.url).match(/\/redeem\?once=(\d+)/))
    .filter(Boolean)
    .map((match) => match[1]);
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

test("cron mode reports a missing Cookie before making requests", async () => {
  const result = await runSurge();

  assert.ok(notification(result, "缺少 Cookie"));
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
      { body: balancePage({ reward: "5.0" }) },
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

test("missing optional detail fields do not downgrade a confirmed success", async () => {
  const result = await runSurge({
    store: { v2ex_cookie: "A2=COOKIE_SECRET" },
    responses: [
      { body: missionReady({ once: "11111", days: "" }) },
      { status: 302, body: "" },
      { body: missionClaimed({ days: "" }) },
      { body: "<html><div>余额结构暂不可识别</div></html>" },
    ],
  });

  const notice = notification(result, "签到成功");
  assert.ok(notice);
  assert.equal(notice.body, "站点已确认今日奖励已领取。");
});

test("an unconfirmed redemption never becomes success and retries with fresh once values", async () => {
  const result = await runSurge({
    store: { v2ex_cookie: "A2=COOKIE_SECRET", v2ex_ua: "Surge Test UA" },
    responses: [
      { body: missionReady({ once: "11111" }) },
      { body: "<div>请重新点击一次以领取每日登录奖励</div>" },
      { body: missionReady({ once: "11111" }) },
      { body: missionReady({ once: "22222" }) },
      { body: "<div>操作未确认</div>" },
      { body: missionReady({ once: "22222" }) },
      { body: missionReady({ once: "33333" }) },
      { body: "<div>操作未确认</div>" },
      { body: missionReady({ once: "33333" }) },
      { body: balancePage({ reward: 5 }) },
    ],
  });

  assert.equal(notification(result, "签到成功"), undefined);
  assert.ok(notification(result, "签到未确认"));
  assert.deepEqual(redeemOnceValues(result.calls), ["11111", "22222", "33333"]);
  assert.equal(result.calls.some((call) => call.url === BALANCE_URL), false);
  assert.equal(result.remainingResponses.length, 1);
});

test("a login-required mission page reports an invalid Cookie", async () => {
  const result = await runSurge({
    store: { v2ex_cookie: "A2=COOKIE_SECRET" },
    responses: [{ body: "<html>你要查看的页面需要先登录</html>" }],
  });

  assert.ok(notification(result, "Cookie 失效"));
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls.some((call) => /\/redeem\?/.test(call.url)), false);
});

test("HTTP 401 reports an invalid Cookie", async () => {
  const result = await runSurge({
    store: { v2ex_cookie: "A2=COOKIE_SECRET" },
    responses: [{ status: 401, body: "" }],
  });

  assert.ok(notification(result, "Cookie 失效"));
  assert.equal(result.calls.length, 1);
});

for (const status of [403, 429, 503]) {
  test(`HTTP ${status} retries and then reports access restricted`, async () => {
    const result = await runSurge({
      store: { v2ex_cookie: "A2=COOKIE_SECRET" },
      responses: Array.from({ length: 3 }, () => ({ status, body: "<html>Access denied</html>" })),
    });

    assert.ok(notification(result, "访问受限"));
    assert.equal(result.calls.length, 3);
  });
}

test("a challenge page retries and then reports access restricted", async () => {
  const result = await runSurge({
    store: { v2ex_cookie: "A2=COOKIE_SECRET" },
    responses: Array.from({ length: 3 }, () => ({ body: "<title>Just a moment...</title><div id=\"cf-chl-widget\"></div>" })),
  });

  assert.ok(notification(result, "访问受限"));
  assert.equal(result.calls.length, 3);
});

test("blocked redemption responses remain classified as access restricted", async () => {
  const responses = [];
  for (const once of ["11111", "22222", "33333"]) {
    responses.push(
      { body: missionReady({ once }) },
      { status: 403, body: "<html>Access denied</html>" },
      { body: missionReady({ once }) },
    );
  }
  const result = await runSurge({
    store: { v2ex_cookie: "A2=COOKIE_SECRET" },
    responses,
  });

  assert.ok(notification(result, "访问受限"));
  assert.equal(notification(result, "签到未确认"), undefined);
});

test("three network errors report a request failure", async () => {
  const result = await runSurge({
    store: { v2ex_cookie: "A2=COOKIE_SECRET" },
    responses: Array.from({ length: 3 }, () => ({ error: "The request timed out" })),
  });

  assert.ok(notification(result, "请求失败"));
  assert.equal(result.calls.length, 3);
});

test("debug output redacts Cookie and once values", async () => {
  const result = await runSurge({
    store: { v2ex_cookie: "A2=COOKIE_SECRET", v2ex_ua: "Surge Test UA" },
    argument: "true",
    responses: [
      { body: missionReady({ once: "11111" }) + "<div>A2=COOKIE_SECRET</div>" },
      { body: "<a href=\"/mission/daily/redeem?once=11111\">继续</a>" },
      { body: missionClaimed({ days: 1262 }) + "<p>once=22222</p>" },
      { body: balancePage({ reward: 5 }) },
    ],
  });

  const output = result.logs.join("\n");
  assert.equal(result.values.get("v2ex_debug"), "true");
  assert.match(output, /\[REDACTED\]/);
  assert.doesNotMatch(output, /COOKIE_SECRET|11111|22222/);
});

test("the Surge module exposes the expected arguments and restricted capture pattern", () => {
  assert.notEqual(MODULE_SOURCE, "", "V2EX Surge module must exist");
  assert.match(
    MODULE_SOURCE,
    /SCRIPT_URL=https%3A%2F%2Fraw\.githubusercontent\.com%2FPhowx%2Fscript%2Fmain%2Fscripts%2Fv2ex%2Fv2ex\.js/,
  );
  assert.match(MODULE_SOURCE, /CRON=0%209%20\*%20\*%20\*/);
  assert.match(MODULE_SOURCE, /DEBUG=false/);
  assert.ok(MODULE_SOURCE.includes(
    "pattern=^https://www\\.v2ex\\.com/(?:member/[^/?#]+|mission/daily)(?:[/?#].*)?$",
  ));
  assert.match(MODULE_SOURCE, /type=cron[^\r\n]+argument=%DEBUG%[^\r\n]+timeout=90/);
  assert.match(MODULE_SOURCE, /hostname = %APPEND% www\.v2ex\.com/);
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
