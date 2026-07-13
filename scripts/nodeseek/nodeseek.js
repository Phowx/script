/**
 * NodeSeek daily attendance for Surge/Loon/Quantumult X.
 *
 * Request mode:
 *   Open https://www.nodeseek.com after login. The script stores the pjwt
 *   cookie and User-Agent in persistent storage.
 *
 * Cron mode:
 *   POST https://www.nodeseek.com/api/attendance using the Surge script
 *   argument when provided. Otherwise, nodeseek_random is used as fallback.
 *
 * Optional relay fallback:
 *   Set nodeseek_relay_url and nodeseek_relay_key to call your own relay
 *   instead of posting directly to NodeSeek. The relay should accept
 *   { cookie, ua, random, rid } and return NodeSeek-like JSON.
 */

const $ = new Env("NodeSeek");

const VERSION = "2026.07.13";
const CK_KEY = "nodeseek_cookie";
const UA_KEY = "nodeseek_ua";
const RANDOM_KEY = "nodeseek_random";
const RELAY_URL_KEY = "nodeseek_relay_url";
const RELAY_KEY_KEY = "nodeseek_relay_key";
const DEBUG_KEY = "nodeseek_debug";
const UA_FALLBACK = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";

(async () => {
  $.log(`[INFO] NodeSeek script ${VERSION}`);

  if (typeof $request !== "undefined") {
    captureCookie();
    return;
  }

  await attend();
})()
  .catch((error) => {
    $.msg("NodeSeek", "签到异常", String(error && error.message ? error.message : error));
  })
  .finally(() => $.done());

function captureCookie() {
  if ($request.method === "OPTIONS") return;

  const headers = lowerCaseKeys($request.headers || {});
  const cookie = String(headers.cookie || "").trim();
  if (!cookie || !cookie.includes("pjwt")) {
    $.log("[INFO] No pjwt cookie in this request, skipped.");
    return;
  }

  const ua = String(headers["user-agent"] || "").trim();
  const oldCookie = $.getdata(CK_KEY) || "";
  const oldPjwt = getCookieValue(oldCookie, "pjwt");
  const newPjwt = getCookieValue(cookie, "pjwt");

  if (ua) $.setdata(ua, UA_KEY);
  if (oldPjwt && oldPjwt === newPjwt) {
    $.log("[INFO] pjwt unchanged, skipped notification.");
    return;
  }

  $.setdata(cookie, CK_KEY);
  $.msg("NodeSeek", "Cookie 获取成功", "已保存 pjwt，可等待定时签到。");
}

async function attend() {
  const cookie = $.getdata(CK_KEY) || "";
  if (!cookie) {
    $.msg("NodeSeek", "缺少 Cookie", "请先登录并打开 www.nodeseek.com 触发抓包。");
    return;
  }
  if (!cookie.includes("pjwt")) {
    $.msg("NodeSeek", "Cookie 无效", "未找到 pjwt，请重新抓取。");
    return;
  }

  const ua = $.getdata(UA_KEY) || UA_FALLBACK;
  const randomArgument = typeof $argument !== "undefined" ? $argument : "";
  const random = readBoolValue(randomArgument, readBool(RANDOM_KEY, false)) ? "true" : "false";
  const relayUrl = normalizeRelayUrl($.getdata(RELAY_URL_KEY) || "");
  const relayKey = $.getdata(RELAY_KEY_KEY) || "";
  const debug = readBool(DEBUG_KEY, false);
  const rid = makeRequestId();

  $.log(`[INFO] random=${random}`);
  $.log(`[INFO] cookie keys=${cookieKeys(cookie)}`);

  if (relayUrl) {
    if (!relayKey) {
      $.msg("NodeSeek", "中继配置不完整", "已设置 nodeseek_relay_url，但缺少 nodeseek_relay_key。");
      return;
    }
    await attendByRelay({ cookie, ua, random, relayUrl, relayKey, debug, rid });
    return;
  }

  await attendDirect({ cookie, ua, random, debug });
}

async function attendDirect({ cookie, ua, random, debug }) {
  const url = `https://www.nodeseek.com/api/attendance?random=${encodeURIComponent(random)}`;
  const result = await request("POST", {
    url,
    headers: {
      "Accept": "*/*",
      "Accept-Language": "zh-CN,zh-Hans;q=0.9,en;q=0.8",
      "Content-Type": "application/json",
      "Cookie": cookie,
      "Origin": "https://www.nodeseek.com",
      "Referer": "https://www.nodeseek.com/board",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "User-Agent": ua,
    },
    body: "",
  });

  if (result.error) {
    $.msg("NodeSeek", "请求失败", result.error);
    return;
  }

  const status = result.status;
  const data = parseJson(result.body);
  if (debug) {
    $.log(`[DEBUG] direct status=${status}`);
    $.log(`[DEBUG] direct body=${String(result.body).slice(0, 800)}`);
  }

  handleAttendanceResult(data, status, "direct");
}

async function attendByRelay({ cookie, ua, random, relayUrl, relayKey, debug, rid }) {
  const result = await request("POST", {
    url: relayUrl,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": relayKey,
    },
    body: JSON.stringify({ cookie, ua, random: random === "true", rid }),
  });

  if (result.error) {
    $.msg("NodeSeek", "中继请求失败", result.error);
    return;
  }

  let data = parseJson(result.body);
  if (!data) data = parseJson(decodeBase64Utf8(String(result.body || "")));
  normalizeRelayMessage(data);

  if (debug) {
    $.log(`[DEBUG] relay status=${result.status}`);
    $.log(`[DEBUG] relay body=${String(result.body).slice(0, 800)}`);
  }

  handleAttendanceResult(data, result.status, "relay");
}

function handleAttendanceResult(data, httpStatus, mode) {
  if (!data || typeof data !== "object") {
    const hint = httpStatus === 403 || httpStatus === 503
      ? "可能被 Cloudflare 拦截；可改用 nodeseek_relay_url 中继。"
      : "未收到可解析的 JSON 响应。";
    $.msg("NodeSeek", "签到未确认", `HTTP ${httpStatus || "unknown"} (${mode})\n${hint}`);
    return;
  }

  const message = String(data.message || data.msg || "");
  const state = classify(data, httpStatus);

  if (state === "success") {
    $.msg("NodeSeek", "签到成功", formatDetail(data, message));
  } else if (state === "already") {
    $.msg("NodeSeek", "今日已签到", message || "NodeSeek 返回重复签到。");
  } else if (state === "invalid") {
    $.msg("NodeSeek", "Cookie 失效", message || "请重新登录并抓取 Cookie。");
  } else {
    $.msg("NodeSeek", "签到失败", message || `HTTP ${httpStatus || "unknown"}`);
  }
}

function classify(data, httpStatus) {
  const message = String(data.message || data.msg || "");
  if (/已完成签到|已签到|重复|already|duplicate|repeat/i.test(message)) return "already";
  if (data.state === "success" || data.success === true) return "success";
  if (/鸡腿/.test(message) && !/失败|错误|失效|登录/.test(message)) return "success";
  if (data.status === 404 || httpStatus === 401 || /登录|cookie|unauth|invalid|forbidden/i.test(message)) return "invalid";
  return "failed";
}

function formatDetail(data, message) {
  const parts = [];
  if (message) parts.push(message);
  if (data.gain != null) parts.push(`鸡腿+${data.gain}`);
  if (data.current != null) parts.push(`当前${data.current}`);
  return parts.join("\n");
}

function request(method, options) {
  return new Promise((resolve) => {
    const done = (error, response, body) => {
      const status = response && (response.status || response.statusCode);
      resolve({ error: error ? String(error) : "", status, headers: response && response.headers, body });
    };

    if (method === "POST") $.post(options, done);
    else $.get(options, done);
  });
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

function normalizeRelayMessage(data) {
  if (!data || typeof data !== "object" || !data.message_b64) return;
  const message = decodeBase64Utf8(data.message_b64);
  if (message) data.message = message;
}

function decodeBase64Utf8(value) {
  if (!value || typeof atob === "undefined") return "";
  try {
    const binary = atob(value);
    const escaped = Array.prototype.map.call(binary, (ch) => {
      const hex = ch.charCodeAt(0).toString(16).padStart(2, "0");
      return `%${hex}`;
    }).join("");
    return decodeURIComponent(escaped);
  } catch (_) {
    try {
      return atob(value);
    } catch (_2) {
      return "";
    }
  }
}

function normalizeRelayUrl(raw) {
  let url = String(raw || "").trim();
  if (!url) return "";
  url = url.replace(/\/+$/, "");
  if (/^https?:\/\/[^/?#]+$/i.test(url)) return `${url}/attend`;
  return url;
}

function readBool(key, fallback) {
  return readBoolValue($.getdata(key), fallback);
}

function readBoolValue(value, fallback) {
  if (value == null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function getCookieValue(cookie, key) {
  const match = String(cookie || "").match(new RegExp(`(?:^|;\\s*)${key}=([^;]+)`));
  return match ? match[1] : "";
}

function cookieKeys(cookie) {
  return String(cookie || "")
    .split(";")
    .map((item) => item.trim().split("=")[0])
    .filter(Boolean)
    .join(", ");
}

function makeRequestId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function lowerCaseKeys(object) {
  return Object.keys(object || {}).reduce((acc, key) => {
    acc[key.toLowerCase()] = object[key];
    return acc;
  }, {});
}

function Env(name) {
  this.name = name;
  this.isSurge = () => typeof $httpClient !== "undefined";
  this.isQuanX = () => typeof $task !== "undefined";
  this.isLoon = () => typeof $loon !== "undefined";
  this.log = (...args) => console.log(args.join("\n"));
  this.msg = (title = this.name, subtitle = "", body = "") => {
    if (this.isSurge() || this.isLoon()) $notification.post(title, subtitle, body);
    else if (this.isQuanX()) $notify(title, subtitle, body);
    console.log(["", `==== ${title} ====`, subtitle, body].filter(Boolean).join("\n"));
  };
  this.getdata = (key) => {
    if (this.isSurge() || this.isLoon()) return $persistentStore.read(key);
    if (this.isQuanX()) return $prefs.valueForKey(key);
    return null;
  };
  this.setdata = (value, key) => {
    if (this.isSurge() || this.isLoon()) return $persistentStore.write(value, key);
    if (this.isQuanX()) return $prefs.setValueForKey(value, key);
    return false;
  };
  this.get = (options, callback) => this.send(options, "GET", callback);
  this.post = (options, callback) => this.send(options, "POST", callback);
  this.send = (options, method, callback) => {
    if (this.isSurge() || this.isLoon()) {
      const client = method === "POST" ? $httpClient.post : $httpClient.get;
      client(options, (error, response, body) => {
        if (response) {
          response.body = body;
          response.statusCode = response.status || response.statusCode;
        }
        callback(error, response, body);
      });
    } else if (this.isQuanX()) {
      options.method = method;
      $task.fetch(options).then(
        (response) => callback(null, { ...response, status: response.statusCode }, response.body),
        (error) => callback(error && (error.error || error.message) || error, null, null),
      );
    } else {
      callback("Unsupported runtime", null, null);
    }
  };
  this.done = (value = {}) => {
    if (typeof $done !== "undefined") $done(value);
  };
}
