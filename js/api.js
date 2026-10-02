const REPORT_FETCH_TIMEOUT = 20000;
const REPORT_FETCH_RETRY_DELAYS = [1500, 5000];

const ACCESS_VERIFY_TIMEOUTS = [12000, 25000];

async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = REPORT_FETCH_TIMEOUT
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      cache: "no-store"
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function wait(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
}

async function loadReportsOnce() {
  const requestRole = accessRole;
  const requestPassword = accessPassword;

  let res;

  if (
    requestRole === "private" ||
    requestRole === "admin"
  ) {
    res = await fetchWithTimeout(
      CONFIG.API_URL,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "text/plain;charset=utf-8"
        },
        body: JSON.stringify({
          action: "list",
          accessPassword:
            requestPassword
        })
      },
      REPORT_FETCH_TIMEOUT
    );

  } else {
    res = await fetchWithTimeout(
      `${CONFIG.PUBLIC_API_URL}/data?ts=${Date.now()}`,
      {},
      REPORT_FETCH_TIMEOUT
    );
  }

  if (!res.ok) {
    throw new Error(
      `HTTP ${res.status}`
    );
  }

  const data = await res.json();

  if (!data.success) {
    if (
      (
        requestRole === "private" ||
        requestRole === "admin"
      ) &&
      data.code === "INVALID_ACCESS"
    ) {
      clearAccessSession();
      setAccessMode("public");
      restoreReportsSnapshot(
        "public"
      );

      showToast(
        "登入已失效，已切回公開模式"
      );

      return await loadReports();
    }

    throw new Error(
      data.message ||
      "讀取資料失敗"
    );
  }

  if (
    requestRole !== accessRole
  ) {
    return false;
  }

  reports =
    Array.isArray(data.reports)
      ? data.reports
      : [];

  withers =
    requestRole === "admin" &&
    Array.isArray(data.withers)
      ? data.withers
      : [];

  if (
    data.dataVersion != null
  ) {
    currentDataVersion =
      String(data.dataVersion);
  }

  saveReportsSnapshot(
    requestRole,
    reports
  );

  hasDisplayedReportSnapshot =
    true;

  return true;
}

async function loadReports() {
  let lastError = null;

  const totalAttempts =
    REPORT_FETCH_RETRY_DELAYS.length + 1;

  for (
    let attempt = 0;
    attempt < totalAttempts;
    attempt++
  ) {
    try {
      const success =
        await loadReportsOnce();

      if (success) {
        if (attempt > 0) {
          console.log(
            `公告資料第 ${attempt + 1} 次嘗試成功`
          );
        }

        return true;
      }

      return false;

    } catch (error) {
      lastError = error;

      const timedOut =
        error &&
        error.name === "AbortError";

      console.debug(
        timedOut
          ? `公告資料第 ${attempt + 1} 次讀取逾時`
          : `公告資料第 ${attempt + 1} 次讀取失敗`,
        error
      );

      if (
        attempt <
        REPORT_FETCH_RETRY_DELAYS.length
      ) {
        const delay =
          REPORT_FETCH_RETRY_DELAYS[
            attempt
          ];

        if (
          !hasDisplayedReportSnapshot
        ) {
          const loading =
            document.getElementById(
              "loadingMessage"
            );

          if (loading) {
            loading.textContent =
              `🌱 花田資料連線較慢，正在重新嘗試（${attempt + 2}/${totalAttempts}）…`;
          }
        }

        await wait(delay);
      }
    }
  }

  const timedOut =
    lastError &&
    lastError.name === "AbortError";

  const hasFallback =
    hasDisplayedReportSnapshot ||
    restoreReportsSnapshot(
      accessRole
    );

  if (hasFallback) {
    showToast(
      timedOut
        ? "連線較慢，目前先顯示上次成功資料"
        : "暫時無法更新，目前先顯示上次成功資料"
    );

  } else {
    showToast(
      timedOut
        ? "花田資料暫時無法載入，稍後會再嘗試"
        : "暫時無法讀取花田資料"
    );
  }

  console.error(
    "公告資料多次讀取失敗：",
    lastError
  );

  return false;
}

async function verifyAccessPasswordOnce(
  password,
  timeoutMs
) {
  const res =
    await fetchWithTimeout(
      CONFIG.API_URL,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "text/plain;charset=utf-8"
        },
        body: JSON.stringify({
          action: "verify",
          accessPassword: password
        })
      },
      timeoutMs
    );

  if (!res.ok) {
    throw new Error(
      `HTTP ${res.status}`
    );
  }

  const data = await res.json();

  return {
    success: !!data.success,
    role: data.role || "public",
    reports:
      Array.isArray(data.reports)
        ? data.reports
        : null,
    dataVersion:
      data.dataVersion != null
        ? String(data.dataVersion)
        : null,
    message: data.message || ""
  };
}

async function verifyAccessPassword(
  password
) {
  let lastError = null;

  for (
    let attempt = 0;
    attempt <
    ACCESS_VERIFY_TIMEOUTS.length;
    attempt++
  ) {
    try {
      return await verifyAccessPasswordOnce(
        password,
        ACCESS_VERIFY_TIMEOUTS[
          attempt
        ]
      );

    } catch (error) {
      lastError = error;

      console.warn(
        `登入驗證第 ${attempt + 1} 次失敗`,
        error
      );

      if (
        attempt <
        ACCESS_VERIFY_TIMEOUTS.length -
        1
      ) {
        await wait(600);
      }
    }
  }

  const timedOut =
    lastError &&
    lastError.name === "AbortError";

  return {
    success: false,
    role: "public",
    message: timedOut
      ? "驗證逾時，Google Apps Script 暫時回應較慢，請稍後再試。"
      : "暫時無法連線驗證，請稍後再試。"
  };
}

async function saveReportToSheet(
  report
) {
  try {
    const res = await fetch(
      CONFIG.API_URL,
      {
        method: "POST",
        body: JSON.stringify({
          action: "save",
          adminPassword,
          report
        })
      }
    );

    const data = await res.json();

    if (!data.success) {
      alert(
        data.message ||
        "儲存失敗"
      );

      return false;
    }

    return true;

  } catch (error) {
    console.error(error);

    alert(
      "儲存失敗，請確認 Apps Script 已部署為 Web App，且存取權限為任何人。"
    );

    return false;
  }
}

async function deleteReportFromSheet(
  id
) {
  try {
    const res = await fetch(
      CONFIG.API_URL,
      {
        method: "POST",
        body: JSON.stringify({
          action: "delete",
          adminPassword,
          id
        })
      }
    );

    const data = await res.json();

    if (!data.success) {
      alert(
        data.message ||
        "刪除失敗"
      );

      return false;
    }

    return true;

  } catch (error) {
    console.error(error);

    alert(
      "刪除失敗，請確認 Apps Script 已部署為 Web App，且存取權限為任何人。"
    );

    return false;
  }
}

async function updateSiteUrlOnServer(siteUrl) {
  if (!adminPassword || !siteUrl) {
    console.warn(
      "網站網址未同步：目前不是 Admin 或網址不存在"
    );
    return false;
  }

  try {
    console.log(
      "開始同步網站網址：" + siteUrl
    );

    const res = await fetch(
      CONFIG.API_URL,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "text/plain;charset=utf-8"
        },
        body: JSON.stringify({
          action: "updateSiteUrl",
          adminPassword,
          siteUrl
        }),
        cache: "no-store"
      }
    );

    if (!res.ok) {
      throw new Error(
        `HTTP ${res.status}`
      );
    }

    const data = await res.json();

    if (!data.success) {
      console.warn(
        "網站網址同步失敗：" +
        (data.message || "未知錯誤")
      );

      return false;
    }

    console.log(
      "網站網址已同步：" +
      data.siteUrl
    );

    return true;

  } catch (error) {
    console.error(
      "網站網址同步失敗：",
      error
    );

    return false;
  }
}
