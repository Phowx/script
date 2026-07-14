# V2EX Surge Attendance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an independently maintained, Surge-only V2EX daily attendance script that reports success only after the mission page confirms the reward was claimed.

**Architecture:** A single Surge script has capture and cron entry paths. The cron path models the mission page as `claimed`, `ready`, `invalid`, or `unknown`, performs redemption with the mission page as Referer, then re-fetches the mission page as the sole success authority. The balance page only enriches an already-confirmed result.

**Tech Stack:** Surge JavaScript runtime APIs, Surge module syntax, Node.js built-in `assert`, `fs/promises`, and `vm` for offline tests.

## Global Constraints

- Support Surge only and one V2EX account.
- Store Cookie and User-Agent, never username or password.
- Require the post-redemption mission page to contain `每日登录奖励已领取` before reporting `签到成功`.
- Never use HTTP status, a reachable balance page, a streak value, or a non-throwing redemption request as standalone success evidence.
- Retry at most three times and fetch a fresh mission page and `once` value for every retry.
- Redact Cookie values and `once` values from debug output and notifications.
- Do not add third-party dependencies or modify existing NodeSeek and Tekqart behavior.

---

### Task 1: Capture Mode and Confirmed Happy Paths

**Files:**
- Create: `tests/test_v2ex.mjs`
- Create: `scripts/v2ex/v2ex.js`

**Interfaces:**
- Consumes: Surge globals `$request`, `$argument`, `$persistentStore`, `$notification`, `$httpClient`, and `$done`.
- Produces: persistent keys `v2ex_cookie`, `v2ex_ua`, and `v2ex_debug`; functions `captureCookie()`, `attend()`, `parseMissionPage(html, status)`, `parseBalancePage(html, dateKey)`, and `request(url, headers)` inside the Surge script.

- [x] **Step 1: Write the failing capture test**

Create a Node `vm` harness that records persistent writes, notifications, request calls, logs, and `$done`. Add a test named `capture mode stores the full Cookie and User-Agent` using `A2=COOKIE_SECRET; V2EX_LANG=zhcn` and `Surge Test UA`. Assert the two persistent values and one `Cookie 获取成功` notification.

- [x] **Step 2: Run the capture test and verify RED**

Run:

```powershell
& $NODE --input-type=module -e "import('./tests/test_v2ex.mjs').then(async m => console.log(await m.runTests()))"
```

Expected: FAIL because `scripts/v2ex/v2ex.js` does not exist or does not store `v2ex_cookie`.

- [x] **Step 3: Implement the minimal capture entry path**

Add `Env`, constants, `lowerCaseKeys`, and `captureCookie`. The entry path must call `captureCookie()` when `$request` exists and always finish exactly once through `.finally(() => $.done())`.

- [x] **Step 4: Verify capture GREEN, then add the unchanged-Cookie test**

Add `capture mode refreshes stored values without duplicate notification` and assert the Cookie and UA are written while no capture notification is produced. Run the test command and expect both tests to pass.

- [x] **Step 5: Add failing tests for already-claimed and successful redemption**

Use these response sequences:

```js
// Already claimed: mission, then optional balance enrichment.
[
  { body: missionClaimed({ days: 1262 }) },
  { body: balancePage({ reward: 5 }) },
]

// New claim: mission ready, redeem, confirmed mission, then balance.
[
  { body: missionReady({ once: "11111", days: 1261 }) },
  { status: 302, body: "" },
  { body: missionClaimed({ days: 1262 }) },
  { body: balancePage({ reward: 5 }) },
]
```

Assert that the already-claimed path never calls a redeem URL and reports `今日已签到`. Assert that the new-claim path calls `/redeem?once=11111` with `Referer: https://www.v2ex.com/mission/daily`, reports `签到成功`, and includes the final streak, reward, and balance.

- [x] **Step 6: Implement confirmed cron paths**

Implement `request`, `makeHeaders`, `parseMissionPage`, `fetchBalanceDetail`, `parseBalancePage`, `formatDetail`, and the initial `attend` loop. `parseMissionPage` must return:

```js
{ state: "claimed", days }
{ state: "ready", days, once, redeemUrl }
{ state: "invalid", days: "" }
{ state: "unknown", days }
```

The balance parser may only add metadata after the mission state is already confirmed.

- [x] **Step 7: Run all V2EX tests and verify GREEN**

Expected: capture, duplicate, and confirmed-success tests all pass with no warnings.

- [x] **Step 8: Commit the independently testable core**

```powershell
git add tests/test_v2ex.mjs scripts/v2ex/v2ex.js
git commit -m "feat: add verified V2EX Surge attendance"
```

### Task 2: False-Positive Regression, Retry, and Error Classification

**Files:**
- Modify: `tests/test_v2ex.mjs`
- Modify: `scripts/v2ex/v2ex.js`

**Interfaces:**
- Consumes: Task 1 `parseMissionPage`, request wrapper, and notification formatting.
- Produces: `classifyFailure(result)`, `isBlocked(result)`, `debugResponse(label, result, enabled)`, `redactSensitive(value)`, and a three-attempt state machine.

- [x] **Step 1: Write the false-positive regression test**

Provide three cycles of `missionReady -> redeem ordinary/error page -> missionReady`, using once values `11111`, `22222`, and `33333`. Include an accessible balance response in the pending queue to prove it is never used as success evidence. Assert:

```js
assert.equal(notification(result, "签到成功"), undefined);
assert.ok(notification(result, "签到未确认"));
assert.deepEqual(redeemOnceValues(result.calls), ["11111", "22222", "33333"]);
```

- [x] **Step 2: Run the regression test and verify RED**

Expected: FAIL because Task 1 does not yet implement all retry and final failure rules.

- [x] **Step 3: Implement fresh-token retry and final unconfirmed state**

Each iteration must start with a new mission request. Never retain `once` across iterations. After the third unconfirmed confirmation page, notify `签到未确认` with a concise reason and stop without querying balance.

- [x] **Step 4: Verify the regression test GREEN**

Expected: no success notification, exactly three distinct redeem URLs, and one final unconfirmed notification.

- [x] **Step 5: Add failing error-classification tests**

Add separate tests for:

- Login-required HTML and HTTP 401 -> `Cookie 失效`, no redeem call.
- HTTP 403, 429, 503 and `Just a moment...` challenge HTML -> retry, then `访问受限`.
- Three network callback errors -> `请求失败`.
- Missing optional streak/reward/balance after a confirmed mission -> still `签到成功`.
- Debug mode -> logs contain `[REDACTED]` and do not contain `COOKIE_SECRET`, `11111`, or another supplied `once` value.

- [x] **Step 6: Implement error classification and redacted diagnostics**

`isBlocked` recognizes statuses 403, 429, and 503 plus `Just a moment`, `cf-chl-`, `challenge-platform`, `访问过于频繁`, and `请求过于频繁`. `redactSensitive` replaces Cookie assignments and every `once` query or HTML value. `debugResponse` logs only label, status, body length, and the first 800 redacted characters.

- [x] **Step 7: Run all V2EX tests and verify GREEN**

Expected: every V2EX test passes, including the original false-success scenario.

- [x] **Step 8: Commit reliability behavior**

```powershell
git add tests/test_v2ex.mjs scripts/v2ex/v2ex.js
git commit -m "test: harden V2EX attendance verification"
```

### Task 3: Surge Module and Repository Verification

**Files:**
- Create: `modules/v2ex.sgmodule`
- Modify: `docs/superpowers/plans/2026-07-14-v2ex-surge-attendance.md`

**Interfaces:**
- Consumes: `scripts/v2ex/v2ex.js` persistent keys and `$argument` debug behavior.
- Produces: module arguments `SCRIPT_URL`, `CRON`, and `DEBUG`; capture and cron entries for Surge.

- [x] **Step 1: Add a failing module-contract test**

Read `modules/v2ex.sgmodule` and assert it contains:

```text
SCRIPT_URL=https%3A%2F%2Fraw.githubusercontent.com%2FPhowx%2Fscript%2Fmain%2Fscripts%2Fv2ex%2Fv2ex.js
CRON=0%209%20*%20*%20*
DEBUG=false
hostname = %APPEND% www.v2ex.com
```

Also assert the capture pattern is restricted to `/member/<name>` and `/mission/daily`, and that the cron line passes `%DEBUG%` as its argument.

- [x] **Step 2: Run the module-contract test and verify RED**

Expected: FAIL because `modules/v2ex.sgmodule` does not exist.

- [x] **Step 3: Implement the Surge module**

Create a module matching the existing NodeSeek and Tekqart metadata style. Use a 10-second capture timeout, 90-second cron timeout, no request body, and MITM only for `www.v2ex.com`.

- [x] **Step 4: Run V2EX and existing Tekqart tests**

Run:

```powershell
& $NODE --input-type=module -e "Promise.all([import('./tests/test_v2ex.mjs').then(m => m.runTests()), import('./tests/test_tekqart.mjs').then(m => m.runTests())]).then(results => console.log(results.join('`n')))"
```

Expected: both suites report all tests passed.

- [x] **Step 5: Perform static and diff verification**

Run:

```powershell
git diff --check
git status --short
git diff --stat HEAD
rg -n "COOKIE_SECRET|11111|22222|33333" scripts modules
```

Expected: no whitespace errors, only planned files changed, and no test secrets in production or module files.

- [x] **Step 6: Mark this plan complete and commit the module and documentation**

```powershell
git add modules/v2ex.sgmodule docs/superpowers/plans/2026-07-14-v2ex-surge-attendance.md
git commit -m "docs: add V2EX Surge module"
```
