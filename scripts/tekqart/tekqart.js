/**
 * Tekqart daily attendance for Surge.
 *
 * Request mode:
 *   Log in to https://www.tekqart.com, then open the zqlj_sign page. The
 *   script stores the authenticated Discuz cookie and User-Agent.
 *
 * Cron mode:
 *   Load the sign page, extract its current sign token, and submit the
 *   attendance request. Account credentials are never stored.
 */

const $ = new Env("Tekqart");

const VERSION = "2026.07.13";
const SIGN_PAGE_URL = "https://www.tekqart.com/plugin.php?id=zqlj_sign";
const MY_RECORD_URL = `${SIGN_PAGE_URL}&tb=my`;
const CK_KEY = "tekqart_cookie";
const UA_KEY = "tekqart_ua";
const DEBUG_KEY = "tekqart_debug";
const UA_FALLBACK = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";

(async () => {
  $.log(`[INFO] Tekqart script ${VERSION}`);

  if (typeof $request !== "undefined") {
    captureCookie();
    return;
  }

  await attend();
})()
  .catch((error) => {
    const detail = String(error && error.message ? error.message : error);
    $.msg("Tekqart", "签到异常", redactSensitive(detail));
  })
  .finally(() => $.done());

function captureCookie() {
  if ($request.method === "OPTIONS") return;

  const headers = lowerCaseKeys($request.headers || {});
  const cookie = String(headers.cookie || "").trim();
  const auth = getDiscuzAuth(cookie);
  if (!auth) {
    $.log("[INFO] No authenticated Discuz cookie in this request, skipped.");
    return;
  }

  const ua = String(headers["user-agent"] || "").trim();
  const oldAuth = getDiscuzAuth($.getdata(CK_KEY) || "");

  $.setdata(cookie, CK_KEY);
  if (ua) $.setdata(ua, UA_KEY);

  if (oldAuth === auth) {
    $.log("[INFO] Discuz auth cookie unchanged; stored the latest cookie set.");
    return;
  }

  $.msg("Tekqart", "Cookie 获取成功", "已保存登录 Cookie，可等待定时签到。");
}

async function attend() {
  const hasDebugArgument = typeof $argument !== "undefined" && String($argument).trim() !== "";
  const debug = hasDebugArgument
    ? readBoolValue($argument, false)
    : readBool(DEBUG_KEY, false);
  if (hasDebugArgument) $.setdata(debug ? "true" : "false", DEBUG_KEY);

  const cookie = $.getdata(CK_KEY) || "";
  if (!cookie || !getDiscuzAuth(cookie)) {
    notifyInvalidCookie("请登录 www.tekqart.com 后打开“天天打卡”页面重新抓取。");
    return;
  }

  const ua = $.getdata(UA_KEY) || UA_FALLBACK;
  const headers = makeHeaders(cookie, ua, SIGN_PAGE_URL);

  const page = await request(SIGN_PAGE_URL, headers);
  debugResponse("sign-page", page, debug);
  if (!handleRequestFailure(page, "签到页")) return;

  const uid = parseDiscuzUid(page.body);
  if (uid === 0) {
    notifyInvalidCookie("站点返回未登录状态，请重新登录并打开“天天打卡”页面。");
    return;
  }
  if (uid == null) {
    $.msg("Tekqart", "签到页结构变化", "未找到 Discuz 登录状态，未执行签到。");
    return;
  }

  const serverDate = parseServerDate(page.body);
  const token = parseSignToken(page.body);
  if (!token) {
    const record = await checkTodayRecord({ cookie, ua, serverDate, debug });
    handleMissingToken(record);
    return;
  }

  const signUrl = `${SIGN_PAGE_URL}&sign=${encodeURIComponent(token)}`;
  const result = await request(signUrl, makeHeaders(cookie, ua, SIGN_PAGE_URL));
  debugResponse("sign-submit", result, debug);

  if (result.error) {
    $.msg("Tekqart", "签到请求失败", redactSensitive(result.error));
    return;
  }
  if (isCloudflareBlocked(result)) {
    notifyCloudflare(result.status);
    return;
  }

  const state = classifySignResponse(result.body, result.status);
  const message = extractResultMessage(result.body);
  if (state === "success") {
    $.msg("Tekqart", "签到成功", message || "站点已确认本次打卡。");
    return;
  }
  if (state === "already") {
    $.msg("Tekqart", "今日已打卡", message || "站点已确认今日打卡记录。");
    return;
  }
  if (state === "invalid") {
    notifyInvalidCookie(message || "登录状态已失效，请重新抓取 Cookie。");
    return;
  }

  const record = await checkTodayRecord({ cookie, ua, serverDate, debug });
  if (record.state === "present") {
    $.msg("Tekqart", "签到成功", "签到响应不明确，但站内今日记录已确认。");
  } else if (record.state === "invalid") {
    notifyInvalidCookie("查询签到记录时发现登录状态已失效。");
  } else if (record.state === "blocked") {
    notifyCloudflare(record.status);
  } else if (record.state === "error") {
    $.msg("Tekqart", "签到未确认", `签到响应无法识别，记录查询失败：${record.detail}`);
  } else {
    $.msg("Tekqart", "签到未确认", message || `HTTP ${result.status || "unknown"}，且未找到今日记录。`);
  }
}

async function checkTodayRecord({ cookie, ua, serverDate, debug }) {
  const result = await request(MY_RECORD_URL, makeHeaders(cookie, ua, SIGN_PAGE_URL));
  debugResponse("my-record", result, debug);

  if (result.error) return { state: "error", detail: result.error };
  if (isCloudflareBlocked(result)) return { state: "blocked", status: result.status };

  const uid = parseDiscuzUid(result.body);
  if (uid === 0) return { state: "invalid" };
  if (uid == null) return { state: "error", detail: "未找到 Discuz 登录状态" };

  const date = serverDate || parseServerDate(result.body);
  if (!date) return { state: "error", detail: "未找到站点日期" };
  return { state: hasTodayRecord(result.body, date) ? "present" : "absent" };
}

function handleMissingToken(record) {
  if (record.state === "present") {
    $.msg("Tekqart", "今日已打卡", "站内已存在今日打卡记录。");
  } else if (record.state === "invalid") {
    notifyInvalidCookie("查询签到记录时发现登录状态已失效。");
  } else if (record.state === "blocked") {
    notifyCloudflare(record.status);
  } else if (record.state === "error") {
    $.msg("Tekqart", "签到页结构变化", `未找到动态 sign 参数；${record.detail}。`);
  } else {
    $.msg("Tekqart", "签到页结构变化", "未找到动态 sign 参数，且站内没有今日记录，未执行签到。");
  }
}

function handleRequestFailure(result, label) {
  if (result.error) {
    $.msg("Tekqart", `${label}请求失败`, redactSensitive(result.error));
    return false;
  }
  if (isCloudflareBlocked(result)) {
    notifyCloudflare(result.status);
    return false;
  }
  if (result.status && (result.status < 200 || result.status >= 400)) {
    $.msg("Tekqart", `${label}请求失败`, `HTTP ${result.status}`);
    return false;
  }
  return true;
}

function notifyInvalidCookie(detail) {
  $.msg("Tekqart", "Cookie 失效", detail);
}

function notifyCloudflare(status) {
  $.msg("Tekqart", "访问被 Cloudflare 拦截", `HTTP ${status || "unknown"}，请先在 Surge 中正常打开网站后重试。`);
}

function makeHeaders(cookie, ua, referer) {
  return {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh-Hans;q=0.9,en;q=0.8",
    "Cookie": cookie,
    "Referer": referer,
    "User-Agent": ua,
  };
}

function request(url, headers) {
  return new Promise((resolve) => {
    $.get({ url, headers }, (error, response, body) => {
      const status = response && (response.status || response.statusCode);
      resolve({
        error: error ? String(error) : "",
        status,
        headers: response && response.headers,
        body: body == null ? "" : String(body),
      });
    });
  });
}

function parseDiscuzUid(html) {
  const match = String(html || "").match(/\bdiscuz_uid\s*=\s*['"](\d+)['"]/i);
  return match ? Number(match[1]) : null;
}

function parseServerDate(html) {
  const match = String(html || "").match(/(20\d{2})年(\d{1,2})月(\d{1,2})日/);
  if (!match) return "";
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function parseSignToken(html) {
  const source = String(html || "");
  const hrefPattern = /href\s*=\s*['"]([^'"]*plugin\.php\?[^'"]*)['"]/gi;
  let match;
  while ((match = hrefPattern.exec(source)) !== null) {
    const href = decodeHtmlEntities(match[1]);
    if (!/(?:^|[?&])id=zqlj_sign(?:&|$)/i.test(href)) continue;
    const sign = href.match(/(?:^|[?&])sign=([^&#]+)/i);
    if (!sign) continue;
    const token = safeDecodeURIComponent(sign[1]).trim();
    if (/^[a-z0-9_-]{4,128}$/i.test(token)) return token;
  }
  return "";
}

function hasTodayRecord(html, date) {
  const source = String(html || "");
  const start = source.search(/id\s*=\s*['"]tblist['"]/i);
  if (start < 0) return false;

  let section = source.slice(start);
  const end = section.search(/<div\s+class\s*=\s*['"][^'"]*\bsd\b[^'"]*['"]/i);
  if (end > 0) section = section.slice(0, end);

  const parts = String(date || "").match(/^(20\d{2})-(\d{2})-(\d{2})$/);
  if (!parts) return false;
  const year = parts[1];
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const pattern = new RegExp(
    `(?:^|[^0-9])${year}(?:-|/|年)0?${month}(?:-|/|月)0?${day}(?:日)?(?=$|[^0-9])`,
  );
  return pattern.test(section);
}

function classifySignResponse(body, status) {
  const text = htmlToText(body);
  if (/恭喜您[，,]?\s*打卡成功|打卡成功！/i.test(text)) return "success";
  if (/今天已经打过卡|已经打过卡了|请勿重复操作/i.test(text)) return "already";
  if (/需要先登录|请先登录|尚未登录|登录后才能/i.test(text)) return "invalid";
  if (status === 401) return "invalid";
  return "unknown";
}

function extractResultMessage(body) {
  const text = htmlToText(body);
  const patterns = [
    /(恭喜您[，,]?\s*打卡成功[^。！\n]*(?:[。！]|$))/i,
    /(您?今天已经打过卡了[^。！\n]*(?:[。！]|$))/i,
    /(请勿重复操作[^。！\n]*(?:[。！]|$))/i,
    /((?:需要先登录|请先登录|尚未登录)[^。！\n]*(?:[。！]|$))/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].trim();
  }
  return "";
}

function htmlToText(value) {
  return decodeHtmlEntities(String(value || "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, number) => String.fromCharCode(Number(number)))
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ");
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch (_) {
    return value;
  }
}

function getDiscuzAuth(cookie) {
  for (const item of String(cookie || "").split(";")) {
    const part = item.trim();
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    if (/_auth$/i.test(key)) return part.slice(index + 1).trim();
  }
  return "";
}

function isCloudflareBlocked(result) {
  const status = Number(result && result.status || 0);
  const body = String(result && result.body || "");
  return status === 403 || status === 503 || /Just a moment|cf-chl-|challenge-platform|Attention Required[^<]*Cloudflare/i.test(body);
}

function debugResponse(label, result, enabled) {
  if (!enabled) return;
  $.log(`[DEBUG] ${label} status=${result.status || "unknown"}`);
  $.log(`[DEBUG] ${label} body=${redactSensitive(result.body).slice(0, 800)}`);
}

function redactSensitive(value) {
  return String(value || "")
    .replace(/([^=;\s]*_auth=)[^;\s"'<]+/gi, "$1[REDACTED]")
    .replace(/([?&](?:amp;)?sign=)[^&\s"'<]+/gi, "$1[REDACTED]");
}

function readBool(key, fallback) {
  return readBoolValue($.getdata(key), fallback);
}

function readBoolValue(value, fallback) {
  if (value == null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function lowerCaseKeys(object) {
  return Object.keys(object || {}).reduce((acc, key) => {
    acc[key.toLowerCase()] = object[key];
    return acc;
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
