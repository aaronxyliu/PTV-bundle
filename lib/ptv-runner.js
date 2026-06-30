const { installScriptInterceptor, makeEmptyStats } = require("./script-interceptor.js");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function classifyPageState(page) {
  return await page.evaluate(() => {
    const text = document.body ? document.body.innerText.slice(0, 5000).toLowerCase() : "";
    return {
      hasPasswordField: Boolean(document.querySelector('input[type="password"]')),
      hasCaptcha:
        text.includes("captcha") ||
        text.includes("verify you are human") ||
        text.includes("安全验证") ||
        Boolean(document.querySelector('iframe[src*="captcha"], iframe[src*="recaptcha"], iframe[src*="turnstile"]')),
      hasConsentText:
        text.includes("cookie") ||
        text.includes("consent") ||
        text.includes("privacy preferences"),
    };
  }).catch((error) => ({ error: error.message }));
}

async function handleConsent(page, policy) {
  if (policy === "none") return { attempted: false, clicked: false, label: "" };
  const labels =
    policy === "privacy-preserving"
      ? ["reject all", "reject", "necessary only", "essential only", "accept all", "agree", "i accept", "accept"]
      : ["accept all", "agree", "i accept", "accept", "continue"];

  return await page.evaluate((candidateLabels) => {
    const buttons = Array.from(document.querySelectorAll("button, [role='button'], input[type='button'], input[type='submit'], a"));
    for (const label of candidateLabels) {
      const target = buttons.find((button) => {
        const text = (
          button.innerText ||
          button.value ||
          button.getAttribute("aria-label") ||
          button.getAttribute("title") ||
          ""
        ).trim().toLowerCase();
        if (!text || text.length > 80) return false;
        return text === label || text.includes(label);
      });
      if (target) {
        target.click();
        return { attempted: true, clicked: true, label };
      }
    }
    return { attempted: true, clicked: false, label: "" };
  }, labels).catch((error) => ({
    attempted: policy !== "none",
    clicked: false,
    label: "",
    error: error.message,
  }));
}

async function simpleScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let steps = 0;
      const timer = setInterval(() => {
        window.scrollBy(0, Math.max(300, window.innerHeight * 0.8));
        steps += 1;
        if (steps >= 3) {
          clearInterval(timer);
          resolve();
        }
      }, 250);
    });
  }).catch(() => {});
}

async function waitForPtvResult(page, timeoutMs) {
  await page.waitForFunction(
    () => {
      const result = document.getElementById("lib-detect-result");
      return Boolean(result && result.getAttribute("content"));
    },
    { timeout: timeoutMs, polling: 100 },
  );

  return await page.evaluate(() => {
    const result = document.getElementById("lib-detect-result");
    const time = document.getElementById("lib-detect-time");
    const resultText = result ? result.getAttribute("content") : "";
    let detected = [];
    try {
      detected = JSON.parse(resultText || "[]");
    } catch (error) {
      detected = [{ parse_error: error.message, raw: resultText || "" }];
    }

    return {
      ok: true,
      detect_time_ms: Number(time ? time.getAttribute("content") || 0 : 0),
      detected,
      has_result_meta: Boolean(result),
      has_time_meta: Boolean(time),
    };
  });
}

async function forcePtvDetect(page) {
  await page.evaluate(() => {
    const result = document.getElementById("lib-detect-result");
    if (result) result.setAttribute("content", "");
    const time = document.getElementById("lib-detect-time");
    if (time) time.setAttribute("content", "");
    const script = Array.from(document.scripts).find((item) => item.src && item.src.includes("/content_scripts/detect.js"));
    if (!script || !script.src.startsWith("chrome-extension://")) return false;
    const baseUrl = script.src.split("/content_scripts/detect.js")[0] + "/data";
    window.postMessage({ type: "detect", url: baseUrl }, "*");
    return true;
  }).catch(() => false);
}

async function collectPtv(page, timeoutMs) {
  try {
    return await waitForPtvResult(page, timeoutMs);
  } catch (firstError) {
    await forcePtvDetect(page);
    try {
      return await waitForPtvResult(page, Math.max(5000, Math.floor(timeoutMs / 2)));
    } catch (secondError) {
      return {
        ok: false,
        status: "timeout",
        error: secondError.message || firstError.message,
        detect_time_ms: 0,
        detected: [],
      };
    }
  }
}

async function crawlVariant(browser, target, args, instrument) {
  const page = await browser.newPage();
  await page.setBypassCSP(true);
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149 Safari/537.36",
  );
  page.setDefaultTimeout(args.timeoutMs);
  page.setDefaultNavigationTimeout(args.timeoutMs);

  const stats = makeEmptyStats();
  const result = {
    final_url: "",
    status: "",
    navigation_status: "",
    detect_time_ms: 0,
    detected: [],
    error: "",
    diagnostics: {},
  };

  try {
    if (instrument) await installScriptInterceptor(page, stats);
    const response = await page.goto(target.url, {
      waitUntil: "domcontentloaded",
      timeout: args.timeoutMs,
    });
    result.navigation_status = response ? String(response.status()) : "no-response";
    result.final_url = page.url();
    await delay(args.settleMs);
    const pageState = await classifyPageState(page);
    const consent = await handleConsent(page, args.consentPolicy);
    if (args.scroll) {
      await simpleScroll(page);
      await delay(1000);
    }
    const ptv = await collectPtv(page, args.detectTimeoutMs);
    result.status = ptv.ok ? "ok" : (ptv.status || "ptv_error");
    result.detect_time_ms = ptv.detect_time_ms || 0;
    result.detected = ptv.detected || [];
    result.error = ptv.error || "";
    result.diagnostics = {
      page_state: pageState,
      consent,
      has_result_meta: ptv.has_result_meta,
      has_time_meta: ptv.has_time_meta,
    };
  } catch (error) {
    result.status = "error";
    result.error = error.message;
    result.final_url = page.url();
  } finally {
    await page.close().catch(() => {});
  }

  return { result, stats };
}

module.exports = {
  delay,
  classifyPageState,
  handleConsent,
  simpleScroll,
  waitForPtvResult,
  forcePtvDetect,
  collectPtv,
  crawlVariant,
};
