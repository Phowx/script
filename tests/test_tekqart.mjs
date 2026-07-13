import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const SCRIPT_URL = new URL("../scripts/tekqart/tekqart.js", import.meta.url);
const SCRIPT_SOURCE = await readFile(SCRIPT_URL, "utf8");
const SIGN_PAGE_URL = "https://www.tekqart.com/plugin.php?id=zqlj_sign";
const AUTH_COOKIE = "XnMp_2132_auth=COOKIE_SECRET; XnMp_2132_sid=session-id";

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function signPage({ uid = 42, date = "2026年7月13日", token = "a1b2c3d4" } = {}) {
  const link = token
    ? `<a href="plugin.php?id=zqlj_sign&amp;sign=${token}">点击打卡</a>`
    : "";
  return `<script>var discuz_uid = '${uid}';</script><div>${date}</div>${link}`;
}

function recordPage({ uid = 42, date = "2026年7月13日", recordDate = "2026-07-13" } = {}) {
  const record = recordDate ? `<li>${recordDate}</li>` : "<li>2026-07-12</li>";
  return `<script>var discuz_uid = '${uid}';</script><div>${date}</div>`
    + `<div id="tblist">${record}</div><div class="sd">sidebar</div>`;
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
            { status: response.status ?? 200, headers: response.headers || {} },
            response.body || "",
          );
        });
      },
    },
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

test("capture mode stores the full authenticated Cookie and User-Agent", async () => {
  const result = await runSurge({
    request: {
      method: "GET",
      headers: { Cookie: AUTH_COOKIE, "User-Agent": "Surge Test UA" },
    },
  });

  assert.equal(result.values.get("tekqart_cookie"), AUTH_COOKIE);
  assert.equal(result.values.get("tekqart_ua"), "Surge Test UA");
  assert.ok(notification(result, "Cookie 获取成功"));
  assert.equal(result.calls.length, 0);
});

test("capture mode ignores requests without an _auth cookie", async () => {
  const result = await runSurge({
    request: { method: "GET", headers: { Cookie: "XnMp_2132_sid=guest" } },
  });

  assert.equal(result.values.has("tekqart_cookie"), false);
  assert.equal(result.notifications.length, 0);
});

test("cron extracts an HTML-encoded dynamic sign token and signs once", async () => {
  const result = await runSurge({
    store: { tekqart_cookie: AUTH_COOKIE, tekqart_ua: "Surge Test UA" },
    responses: [
      { body: signPage({ token: "token_9876" }) },
      { body: "<div>恭喜您，打卡成功！奖励 3 金币。</div>" },
    ],
  });

  assert.deepEqual(result.calls.map((call) => call.url), [
    SIGN_PAGE_URL,
    `${SIGN_PAGE_URL}&sign=token_9876`,
  ]);
  assert.equal(result.calls[1].headers.Cookie, AUTH_COOKIE);
  assert.equal(result.calls[1].headers.Referer, SIGN_PAGE_URL);
  assert.equal(result.calls[1].headers["User-Agent"], "Surge Test UA");
  assert.ok(notification(result, "签到成功"));
});

test("cron stops before signing when Discuz reports uid zero", async () => {
  const result = await runSurge({
    store: { tekqart_cookie: AUTH_COOKIE },
    responses: [{ body: signPage({ uid: 0 }) }],
  });

  assert.equal(result.calls.length, 1);
  assert.ok(notification(result, "Cookie 失效"));
});

test("cron classifies an already-signed response", async () => {
  const result = await runSurge({
    store: { tekqart_cookie: AUTH_COOKIE },
    responses: [
      { body: signPage() },
      { body: "<p>您今天已经打过卡了，请勿重复操作！</p>" },
    ],
  });

  assert.equal(result.calls.length, 2);
  assert.ok(notification(result, "今日已打卡"));
});

test("cron recognizes a Discuz success message inside a script callback", async () => {
  const result = await runSurge({
    store: { tekqart_cookie: AUTH_COOKIE },
    responses: [
      { body: signPage() },
      { body: "<script>showDialog('恭喜您，打卡成功！奖励 3 金币。');</script>" },
    ],
  });

  assert.equal(result.calls.length, 2);
  assert.ok(notification(result, "签到成功"));
});

test("a missing token checks today's record without submitting a sign request", async () => {
  const result = await runSurge({
    store: { tekqart_cookie: AUTH_COOKIE },
    responses: [
      { body: signPage({ token: "" }) },
      { body: recordPage() },
    ],
  });

  assert.deepEqual(result.calls.map((call) => call.url), [
    SIGN_PAGE_URL,
    `${SIGN_PAGE_URL}&tb=my`,
  ]);
  assert.ok(notification(result, "今日已打卡"));
});

test("record lookup uses the server date and only searches the record list", async () => {
  const result = await runSurge({
    store: { tekqart_cookie: AUTH_COOKIE },
    responses: [
      { body: signPage({ token: "" }) },
      { body: recordPage({ recordDate: "" }) },
    ],
  });

  assert.ok(notification(result, "签到页结构变化"));
  assert.equal(notification(result, "今日已打卡"), undefined);
});

test("record lookup accepts a non-padded date from the plugin", async () => {
  const result = await runSurge({
    store: { tekqart_cookie: AUTH_COOKIE },
    responses: [
      { body: signPage({ token: "" }) },
      { body: recordPage({ recordDate: "2026-7-13" }) },
    ],
  });

  assert.ok(notification(result, "今日已打卡"));
});

test("an unclear sign response is confirmed through today's record", async () => {
  const result = await runSurge({
    store: { tekqart_cookie: AUTH_COOKIE },
    responses: [
      { body: signPage() },
      { body: "<div>操作完成</div>" },
      { body: recordPage() },
    ],
  });

  assert.equal(result.calls.length, 3);
  assert.ok(notification(result, "签到成功"));
});

test("network errors produce a request failure notification", async () => {
  const result = await runSurge({
    store: { tekqart_cookie: AUTH_COOKIE },
    responses: [{ error: "The request timed out" }],
  });

  assert.equal(result.calls.length, 1);
  assert.ok(notification(result, "签到页请求失败"));
});

test("sign request errors redact the dynamic authentication token", async () => {
  const result = await runSurge({
    store: { tekqart_cookie: AUTH_COOKIE },
    responses: [
      { body: signPage({ token: "PRIVATE_SIGN_TOKEN" }) },
      { error: `Failed to load ${SIGN_PAGE_URL}&sign=PRIVATE_SIGN_TOKEN` },
    ],
  });

  const notice = notification(result, "签到请求失败");
  assert.ok(notice);
  assert.doesNotMatch(`${notice.body}\n${result.logs.join("\n")}`, /PRIVATE_SIGN_TOKEN/);
  assert.match(notice.body, /\[REDACTED\]/);
});

for (const status of [403, 503]) {
  test(`HTTP ${status} is classified as a Cloudflare block`, async () => {
    const result = await runSurge({
      store: { tekqart_cookie: AUTH_COOKIE },
      responses: [{ status, body: "<title>Just a moment...</title>" }],
    });

    assert.equal(result.calls.length, 1);
    assert.ok(notification(result, "访问被 Cloudflare 拦截"));
  });
}

test("an invalid sign response asks the user to capture Cookie again", async () => {
  const result = await runSurge({
    store: { tekqart_cookie: AUTH_COOKIE },
    responses: [
      { body: signPage() },
      { status: 401, body: "请先登录后才能打卡。" },
    ],
  });

  assert.ok(notification(result, "Cookie 失效"));
});

test("DEBUG output redacts Cookie authentication values and sign tokens", async () => {
  const result = await runSurge({
    store: { tekqart_cookie: AUTH_COOKIE },
    argument: "true",
    responses: [
      {
        body: signPage({ token: "SIGN_TOKEN_SECRET" })
          + "<div>XnMp_2132_auth=AUTH_VALUE_SECRET</div>",
      },
      { body: "<p>您今天已经打过卡了，请勿重复操作！</p>" },
    ],
  });

  const output = result.logs.join("\n");
  assert.doesNotMatch(output, /COOKIE_SECRET|AUTH_VALUE_SECRET|SIGN_TOKEN_SECRET/);
  assert.match(output, /\[REDACTED\]/);
  assert.equal(result.values.get("tekqart_debug"), "true");
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
  return `${tests.length}/${tests.length} Tekqart tests passed`;
}
