/**
 * V2EX daily attendance for Surge.
 *
 * Request mode stores the current Cookie and User-Agent. Cron mode claims the
 * daily reward and only reports success after the mission page confirms it.
 */

const $ = new Env("V2EX");

const VERSION = "2026.07.14";
const COOKIE_KEY = "v2ex_cookie";
const UA_KEY = "v2ex_ua";
const DEBUG_KEY = "v2ex_debug";
const MISSION_URL = "https://www.v2ex.com/mission/daily";
const BALANCE_URL = "https://www.v2ex.com/balance";
const UA_FALLBACK = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";

(async () => {
  $.log(`[INFO] V2EX script ${VERSION}`);
  if (typeof $request !== "undefined") {
    captureCookie();
    return;
  }
  await attend();
})()
  .catch((error) => {
    $.msg("V2EX", "脚本异常", String(error && error.message ? error.message : error));
  })
  .finally(() => $.done());

function captureCookie() {
  if ($request.method === "OPTIONS") return;

  const headers = lowerCaseKeys($request.headers || {});
  const cookie = String(headers.cookie || "").trim();
  if (!cookie) {
    $.log("[INFO] No Cookie in this request; skipped.");
    return;
  }

  const ua = String(headers["user-agent"] || "").trim();
  const oldCookie = $.getdata(COOKIE_KEY) || "";
  $.setdata(cookie, COOKIE_KEY);
  if (ua) $.setdata(ua, UA_KEY);

  if (oldCookie === cookie) {
    $.log("[INFO] Cookie unchanged; refreshed stored request data.");
    return;
  }

  $.msg("V2EX", "Cookie 获取成功", "已保存登录状态，可等待定时签到。");
}

async function attend() {
  const cookie = $.getdata(COOKIE_KEY) || "";
  if (!cookie) return;

  const ua = $.getdata(UA_KEY) || UA_FALLBACK;
  const missionResult = await request(MISSION_URL, makeHeaders(cookie, ua, MISSION_URL));
  const mission = parseMissionPage(missionResult.body, missionResult.status);
  if (mission.state === "claimed") {
    const balance = await fetchBalanceDetail(cookie, ua);
    $.msg("V2EX", "今日已签到", formatDetail(mission.days, balance));
    return;
  }
  if (mission.state !== "ready") return;

  await request(mission.redeemUrl, makeHeaders(cookie, ua, MISSION_URL));
  const confirmResult = await request(MISSION_URL, makeHeaders(cookie, ua, MISSION_URL));
  const confirmed = parseMissionPage(confirmResult.body, confirmResult.status);
  if (confirmed.state !== "claimed") return;

  const balance = await fetchBalanceDetail(cookie, ua);
  $.msg("V2EX", "签到成功", formatDetail(confirmed.days, balance));
}

function parseMissionPage(html, status) {
  const source = String(html || "");
  const daysMatch = source.match(/已连续登录\s*(\d+)\s*天/);
  const days = daysMatch ? daysMatch[1] : "";
  if (Number(status) === 401 || /你要查看的页面需要先登录|需要先登录|请先登录/.test(source)) {
    return { state: "invalid", days: "" };
  }
  if (source.includes("每日登录奖励已领取")) return { state: "claimed", days };
  const redeemMatch = source.match(/(?:https:\/\/www\.v2ex\.com)?(\/mission\/daily\/redeem\?once=(\d+))/i);
  if (redeemMatch) {
    return {
      state: "ready",
      days,
      once: redeemMatch[2],
      redeemUrl: `https://www.v2ex.com${redeemMatch[1]}`,
    };
  }
  return { state: "unknown", days };
}

async function fetchBalanceDetail(cookie, ua) {
  const result = await request(BALANCE_URL, makeHeaders(cookie, ua, MISSION_URL));
  if (result.error || (result.status && (result.status < 200 || result.status >= 400))) return {};
  return parseBalancePage(result.body, localDateKey());
}

function parseBalancePage(html, dateKey) {
  const source = String(html || "");
  const detail = {};
  const balanceMatch = source.match(/balance_area bigger[^>]*>([\s\S]*?)<\/div>/i);
  if (balanceMatch) {
    const parts = [];
    const coinPattern = /(\d+)\s*<img[^>]+alt=["']([GSB])["']/gi;
    let coin;
    while ((coin = coinPattern.exec(balanceMatch[1])) !== null) {
      if (coin[2].toUpperCase() === "G") parts.push(`${coin[1]} 金币`);
      if (coin[2].toUpperCase() === "S") parts.push(`${coin[1]} 银币`);
      if (coin[2].toUpperCase() === "B") parts.push(`${coin[1]} 铜币`);
    }
    if (parts.length) detail.balance = parts.join(", ");
  }

  const rewardPattern = new RegExp(`${dateKey}\\s*的每日登录奖励\\s*([+-]?\\d+(?:\\.\\d+)?)\\s*铜币`);
  const rewardMatch = source.match(rewardPattern);
  if (rewardMatch) detail.reward = rewardMatch[1].replace(/\.0+$/, "");
  return detail;
}

function formatDetail(days, balance) {
  const parts = [];
  if (days) parts.push(`连续 ${days} 天`);
  if (balance && balance.reward) parts.push(`奖励 ${balance.reward} 铜币`);
  if (balance && balance.balance) parts.push(`余额 ${balance.balance}`);
  return parts.join(" | ") || "站点已确认今日奖励已领取。";
}

function localDateKey(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

function makeHeaders(cookie, ua, referer) {
  return {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh-Hans;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Cookie": cookie,
    "Referer": referer,
    "User-Agent": ua,
  };
}

function request(url, headers) {
  return new Promise((resolve) => {
    $.get({ url, headers }, (error, response, body) => {
      resolve({
        error: error ? String(error) : "",
        status: response && (response.status || response.statusCode),
        headers: response && response.headers,
        body: body == null ? "" : String(body),
      });
    });
  });
}

function lowerCaseKeys(object) {
  return Object.keys(object || {}).reduce((result, key) => {
    result[key.toLowerCase()] = object[key];
    return result;
  }, {});
}

function Env(name) {
  this.name = name;
  this.log = (...args) => console.log(args.join("\n"));
  this.msg = (title = this.name, subtitle = "", body = "") => {
    if (typeof $notification !== "undefined") $notification.post(title, subtitle, body);
    console.log(["", `==== ${title} ====`, subtitle, body].filter(Boolean).join("\n"));
  };
  this.getdata = (key) => typeof $persistentStore !== "undefined" ? $persistentStore.read(key) : null;
  this.setdata = (value, key) => typeof $persistentStore !== "undefined" && $persistentStore.write(value, key);
  this.get = (options, callback) => {
    if (typeof $httpClient === "undefined") {
      callback("Unsupported runtime", null, null);
      return;
    }
    $httpClient.get(options, callback);
  };
  this.done = (value = {}) => {
    if (typeof $done !== "undefined") $done(value);
  };
}
