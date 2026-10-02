		  
    // 網站網址由目前實際開啟的頁面自動取得。
    // 之後 GitHub Pages 網址改名時，不需要再修改 HTML。
    const SITE_URL = new URL("./", window.location.href).href;

    const ogUrlMeta = document.querySelector('meta[property="og:url"]');
    if (ogUrlMeta) ogUrlMeta.setAttribute("content", SITE_URL);

    let reports = [];
    let withers = [];
    let editingId = null;

    // Private 模式仍使用該分頁內的私田密碼；
    // Admin 模式改用 Apps Script 發出的短效 Token，不保存管理密碼。
    let accessPassword = sessionStorage.getItem("pikminAccessPassword") || "";
    let adminToken = sessionStorage.getItem("pikminAdminToken") || "";
    let adminTokenExpiresAt = sessionStorage.getItem("pikminAdminTokenExpiresAt") || "";

    let accessRole = "public"; // public | private | admin
    let isAdmin = false;
    let toastTimer = null;
	let reportTransitionTimer = null;

    const $ = (id) => document.getElementById(id);

    // 不使用人工版本號：直接檢查 GitHub Pages 目前發布檔案是否已改變。
    const SITE_UPDATE_CHECK_INTERVAL = CONFIG.SITE_UPDATE_CHECK_INTERVAL;
    let publishedPageFingerprint = null;
    let siteUpdateTimer = null;
    let siteUpdateDetected = false;

    // 前端最後成功資料備援。
    // 公開田可安全持久保存；私田 / Admin 含私密座標，只保存於目前分頁 session。
    const PUBLIC_REPORT_CACHE_KEY = "pikminReportsPublicCacheV1";
    const PROTECTED_REPORT_CACHE_KEY = "pikminReportsProtectedCacheV1";
    const FRONTEND_CACHE_MAX_AGE = CONFIG.FRONTEND_CACHE_MAX_AGE;
    let hasDisplayedReportSnapshot = false;
    let lastSuccessfulDataLoadAt = 0;
    let isShowingFallbackData = false;

    // 公告即時性：前景每 12 秒只檢查極小的資料版本值。
    // 版本有變才重新抓完整公告，避免高頻讀取 Spreadsheet。
    const DATA_VERSION_CHECK_INTERVAL = CONFIG.DATA_VERSION_CHECK_INTERVAL;
    let currentDataVersion = null;
    let dataVersionTimer = null;
    let isCheckingDataVersion = false;

    function hashText(text) {
      let hash = 2166136261;
      for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(16);
    }

    async function getPublishedPageFingerprint() {
      // 只比較實際 HTML 內容，不使用 ETag / Last-Modified 等可能受 CDN 影響的 Header。
      const url = new URL(window.location.origin + window.location.pathname);
      url.searchParams.set("_updateCheck", Date.now());

      const response = await fetch(url.toString(), {
        method: "GET",
        cache: "no-store"
      });

      if (!response.ok) throw new Error(`版本檢查 HTTP ${response.status}`);
      return hashText(await response.text());
    }

    function showSiteUpdateBanner() {
      if (siteUpdateDetected) return;
      siteUpdateDetected = true;
      const banner = $("siteUpdateBanner");
      if (banner) banner.classList.add("active");
    }

    async function checkForSiteUpdate({ initialize = false } = {}) {
      if (siteUpdateDetected) return;
      if (!initialize && document.visibilityState !== "visible") return;

      try {
        const fingerprint = await getPublishedPageFingerprint();

        if (!publishedPageFingerprint || initialize) {
          publishedPageFingerprint = fingerprint;
          return;
        }

        if (fingerprint === publishedPageFingerprint) return;

        // 第一次發現內容不同先不提示；3 秒後再次確認。
        // 只有兩次都取得相同的新內容 hash，才認定 GitHub Pages 已正式更新。
        await new Promise(resolve => setTimeout(resolve, 3000));
        if (document.visibilityState !== "visible" || siteUpdateDetected) return;

        const confirmFingerprint = await getPublishedPageFingerprint();
        if (confirmFingerprint === fingerprint && confirmFingerprint !== publishedPageFingerprint) {
          showSiteUpdateBanner();
        }
      } catch (error) {
        // 版本檢查失敗不影響公告本身，下一輪再試。
        console.debug("網站版本檢查失敗", error);
      }
    }

    function stopSiteUpdateTimer() {
      if (siteUpdateTimer !== null) {
        clearInterval(siteUpdateTimer);
        siteUpdateTimer = null;
      }
    }

    function startSiteUpdateTimer() {
      stopSiteUpdateTimer();
      if (document.visibilityState !== "visible" || siteUpdateDetected) return;

      siteUpdateTimer = setInterval(() => {
        checkForSiteUpdate();
      }, SITE_UPDATE_CHECK_INTERVAL);
    }


    function getFrontendReportStorage(role = accessRole) {
      return role === "public" ? localStorage : sessionStorage;
    }

    function getFrontendReportCacheKey(role = accessRole) {
      return role === "public" ? PUBLIC_REPORT_CACHE_KEY : PROTECTED_REPORT_CACHE_KEY;
    }

    function saveReportsSnapshot(role, reportList) {
      try {
        const storage = getFrontendReportStorage(role);
        const key = getFrontendReportCacheKey(role);
        storage.setItem(key, JSON.stringify({
          savedAt: Date.now(),
          role: role === "public" ? "public" : "protected",
          reports: Array.isArray(reportList) ? reportList : []
        }));
      } catch (error) {
        console.debug("保存前端公告備援失敗", error);
      }
    }

    function restoreReportsSnapshot(role = accessRole) {
      try {
        const storage = getFrontendReportStorage(role);
        const key = getFrontendReportCacheKey(role);
        const raw = storage.getItem(key);
        if (!raw) return false;

        const snapshot = JSON.parse(raw);
        if (!snapshot || !Array.isArray(snapshot.reports) || !Number.isFinite(Number(snapshot.savedAt))) {
          storage.removeItem(key);
          return false;
        }

        if (Date.now() - Number(snapshot.savedAt) > FRONTEND_CACHE_MAX_AGE) {
          storage.removeItem(key);
          return false;
        }

        reports = snapshot.reports;
        hasDisplayedReportSnapshot = true;
        lastSuccessfulDataLoadAt = Number(snapshot.savedAt);
        isShowingFallbackData = true;
        updateDataStatusDisplay();
        renderReports();
        return true;
      } catch (error) {
        console.debug("讀取前端公告備援失敗", error);
        return false;
      }
    }

    function clearProtectedReportsSnapshot() {
      try {
        sessionStorage.removeItem(PROTECTED_REPORT_CACHE_KEY);
      } catch (error) {
        console.debug("清除私田備援失敗", error);
      }
    }

    function showToast(message) {
      const toast = $("toast");
      toast.textContent = message;
      toast.classList.add("active");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove("active"), 1600);
    }

    function formatStatusTime(timestamp) {
      const value = Number(timestamp || 0);
      if (!value) return "尚未同步";

      return new Intl.DateTimeFormat(
        "zh-TW",
        {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false
        }
      ).format(new Date(value));
    }

    function formatAdminSessionExpiry() {
      if (!adminTokenExpiresAt) return "未登入";

      const date = new Date(adminTokenExpiresAt);
      if (Number.isNaN(date.getTime())) {
        return "已登入";
      }

      return new Intl.DateTimeFormat(
        "zh-TW",
        {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false
        }
      ).format(date);
    }

    function updateDataStatusDisplay() {
      const publicStatus = $("lastUpdatedStatus");

      if (publicStatus) {
        const prefix =
          isShowingFallbackData
            ? "⚠ 目前顯示上次成功資料 · "
            : "";

        publicStatus.textContent =
          `${prefix}最後更新：${formatStatusTime(lastSuccessfulDataLoadAt)}`;
      }

      const connection =
        $("systemConnectionStatus");
      const sync =
        $("systemLastSync");
      const version =
        $("systemDataVersion");
      const wither =
        $("systemWitherCount");
      const session =
        $("systemAdminSession");

      if (connection) {
        connection.textContent =
          isShowingFallbackData
            ? "備援資料"
            : lastSuccessfulDataLoadAt
              ? "正常"
              : "尚未同步";
      }

      if (sync) {
        sync.textContent =
          formatStatusTime(
            lastSuccessfulDataLoadAt
          );
      }

      if (version) {
        version.textContent =
          currentDataVersion || "尚未取得";
      }

      if (wither) {
        wither.textContent =
          `${Array.isArray(withers) ? withers.length : 0} 筆`;
      }

      if (session) {
        session.textContent =
          isAdmin
            ? `有效至 ${formatAdminSessionExpiry()}`
            : "未登入";
      }
    }


    function fillOptions() {
      for (const color of COLORS) {
        $("colorInput").append(new Option(color, color));
        $("colorFilter").append(new Option(color, color));
      }

      for (const flower of FLOWERS) {
        $("flowerInputList").append(new Option(flower, flower));
        $("flowerFilterList").append(new Option(flower, flower));
      }
    }

    function setAdminPanelCollapsed(collapsed) {
      const panel = $("adminPanel");
      panel.classList.toggle("collapsed", collapsed);
      $("adminPanelHeader").setAttribute("aria-expanded", collapsed ? "false" : "true");
      $("adminCollapseBtn").textContent = collapsed ? "▼" : "▲";
      sessionStorage.setItem("pikminAdminPanelCollapsed", collapsed ? "true" : "false");
    }

    function clearAccessSession() {
      accessPassword = "";
      adminToken = "";
      adminTokenExpiresAt = "";

      sessionStorage.removeItem("pikminAccessPassword");
      sessionStorage.removeItem("pikminAdminToken");
      sessionStorage.removeItem("pikminAdminTokenExpiresAt");

      // 清掉舊版曾使用的登入狀態。
      sessionStorage.removeItem("pikminAdminPassword");
      sessionStorage.removeItem("pikminAdmin");

      clearProtectedReportsSnapshot();
      updateDataStatusDisplay();
    }

    function setAccessMode(role) {
      accessRole = ["private", "admin"].includes(role) ? role : "public";
      isAdmin = accessRole === "admin";

      if (isAdmin && adminToken) {
        updateSiteUrlOnServer(
          SITE_URL
        );
      }

      document.body.classList.toggle("admin-on", isAdmin);
      $("adminPanel").classList.toggle("active", isAdmin);
      $("adminLoginBtn").style.display = accessRole === "public" ? "inline-block" : "none";
      $("logoutBtn").style.display = accessRole === "public" ? "none" : "inline-block";
      $("logoutBtn").textContent = isAdmin ? "管理員登出" : "私田登出";

      if (isAdmin) {
        setAdminPanelCollapsed(sessionStorage.getItem("pikminAdminPanelCollapsed") === "true");
      }

      updateDataStatusDisplay();
      renderReports();
    }

    // 保留舊函式名稱，避免其他既有程式若有呼叫時失效。
    function setAdminMode(value) {
      setAccessMode(value ? "admin" : "public");
    }

    const COPY_NOTICE_TEXT = [
      "收果提醒",
      "✗ 請勿轉傳 & 請勿偷田",
      "✗ 請勿踩踏沒有提供的座標",
      "✗ 收果後請刪檔避免開錯檔誤踩",
      "✓ 開花後僅第𝟏小時會有果實",
      "✓ 花瓣不夠可只派𝟏皮種花",
      SITE_URL
    ].join("\n");

function buildCopyContent(report) {
  const flowerText =
    `${report.color || ""}` +
    `${report.flower || ""}` +
    `${report.amount ? report.amount + "株" : ""}`;

  const timeText =
    formatDisplayTime(report.time);

  const message = [
    report.place || "未命名花田",
    `🌸${flowerText}`,
    `⏰${timeText}`,
    `📝${report.note || ""}`,
    "",
    COPY_NOTICE_TEXT
  ];

  return message.join("\n");
}

    function buildDisplayText(report) {
      if (report.raw) {
        const coordCount = report.coords ? report.coords.split("\n").filter(Boolean).length : Number(report.amount || 0);
        return report.raw.replace(/(🌸[^\n]*?)(\d+)\s*株/, `$1${coordCount}株`);
      }
      return `${report.place}\n🌸${report.color}${report.flower}${report.amount ? report.amount + "株" : ""}\n⏰${formatDisplayTime(report.time)}\n📝${report.note}`.trim();
    }

    async function copyCoords(id) {
      const report = reports.find(item => item.id === id);
      const coords = report && report.coords ? report.coords : "";
      if (!coords) {
        showToast("這筆公告沒有座標可以複製");
        return;
      }

      try {
        await navigator.clipboard.writeText(coords);
        showToast("已複製座標");
      } catch (error) {
        const temp = document.createElement("textarea");
        temp.value = coords;
        document.body.appendChild(temp);
        temp.select();
        document.execCommand("copy");
        temp.remove();
        showToast("已複製座標");
      }
    }

    async function copyContent(id) {
      const report = reports.find(item => item.id === id);
      const content = report ? buildCopyContent(report) : "";
      if (!content) {
        showToast("這筆公告沒有內文可以複製");
        return;
      }

      try {
        await navigator.clipboard.writeText(content);
        showToast("已複製內文");
      } catch (error) {
        const temp = document.createElement("textarea");
        temp.value = content;
        document.body.appendChild(temp);
        temp.select();
        document.execCommand("copy");
        temp.remove();
        showToast("已複製內文");
      }
    }

	function scheduleNextReportTransition() {
  if (reportTransitionTimer !== null) {
    clearTimeout(reportTransitionTimer);
    reportTransitionTimer = null;
  }

  const now = Date.now();
  const transitionTimes = [];

  reports.forEach(report => {
    const openedAt =
      parseOpeningDate(report.time);

    if (!openedAt) return;

    const openedMs =
      openedAt.getTime();

    const readyMs =
      openedMs +
      getPreviewCompleteMinutes(report) *
      60 *
      1000;

    const expiredMs =
      openedMs +
      CONFIG.FRUIT_AVAILABLE_MINUTES *
      60 *
      1000;

    if (readyMs > now) {
      transitionTimes.push(readyMs);
    }

    if (expiredMs > now) {
      transitionTimes.push(expiredMs);
    }
  });

  if (!transitionTimes.length) {
    return;
  }

  const nextTransition =
    Math.min(...transitionTimes);

  const delay =
    Math.max(
      100,
      nextTransition - Date.now() + 200
    );

  reportTransitionTimer =
    setTimeout(() => {
      renderReports();
      scheduleNextReportTransition();
    }, delay);
}


    function formatWitherTime(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return "";

      const month = date.getMonth() + 1;
      const day = date.getDate();
      const hour = String(date.getHours()).padStart(2, "0");
      const minute = String(date.getMinutes()).padStart(2, "0");

      return `${month}/${day} ${hour}:${minute}`;
    }

    function formatWitherRemaining(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return "";

      const minutes = Math.max(
        0,
        Math.ceil((date.getTime() - Date.now()) / 60000)
      );

      if (minutes <= 0) return "即將凋謝";

      const hours = Math.floor(minutes / 60);
      const remainMinutes = minutes % 60;

      if (hours <= 0) return `剩餘 ${remainMinutes} 分鐘`;
      if (remainMinutes === 0) return `剩餘 ${hours} 小時`;

      return `剩餘 ${hours} 小時 ${remainMinutes} 分`;
    }

    function renderAdminWitherList() {
      const section = $("adminWitherSection");
      const listElement = $("adminWitherList");
      const countElement = $("adminWitherCount");

      if (!section || !listElement || !countElement) return;

      section.style.display = isAdmin ? "block" : "none";

      if (!isAdmin) return;

      const now = Date.now();

      const upcoming = (Array.isArray(withers) ? withers : [])
        .filter(item => {
          const witherAt = new Date(item && item.witherAt);
          return (
            !Number.isNaN(witherAt.getTime()) &&
            witherAt.getTime() > now
          );
        })
        .sort(
          (a, b) =>
            new Date(a.witherAt).getTime() -
            new Date(b.witherAt).getTime()
        );

      countElement.textContent = String(upcoming.length);

      if (!upcoming.length) {
        listElement.innerHTML =
          '<div class="admin-wither-empty">目前沒有即將凋謝的花田。</div>';
        return;
      }

      listElement.innerHTML = upcoming.map(item => {
        const communityText =
          String(item.isCommunityDay || "").toUpperCase() === "TRUE" ||
          item.isCommunityDay === true
            ? " · 社群日"
            : "";

        return `
          <div class="admin-wither-item">
            <div class="admin-wither-place">
              ${escapeHtml(item.place || "未命名花田")}${communityText}
            </div>
            <div class="admin-wither-time">
              ⏰ ${escapeHtml(formatWitherTime(item.witherAt))}
            </div>
            <div class="admin-wither-left">
              ${escapeHtml(formatWitherRemaining(item.witherAt))}
            </div>
          </div>
        `;
      }).join("");
    }


    function renderReports() {
      renderAdminWitherList();

      const keyword = $("keyword").value.trim().toLowerCase();
      const color = $("colorFilter").value;
      const flower = $("flowerFilter").value.trim().toLowerCase();

      const filtered = reports.filter(report => {
        const combined = JSON.stringify(report).toLowerCase();
        return (!keyword || combined.includes(keyword)) &&
          (!color || report.color === color) &&
          (!flower || String(report.flower || "").toLowerCase().includes(flower));
      });

      if (!filtered.length) {
 		 $("cards").innerHTML = "";
	     $("empty").style.display = "block";

  		if (reportTransitionTimer !== null) {
    	  clearTimeout(reportTransitionTimer);
    	  reportTransitionTimer = null;
  		}

  return;
}

      const previewReports = filtered.filter(report => isUpcomingReport(report));
      const activeReports = filtered.filter(report => !isUpcomingReport(report) && !isExpiredReport(report));
      const expiredReports = filtered.filter(report => isExpiredReport(report));

      function renderPreviewTable(list) {
        if (!list.length) return "";

        return `
          <div class="result-section-title">開花預報（${list.length}） <span class="sub">目前正處於未開花 / 開花中，暫不提供座標，開花完畢後會轉移到可收果區域</span></div>
          <div class="result-table preview-table">
            <div class="result-row result-header preview-row">
              <div class="result-cell">花朵</div>
              <div class="result-cell">預計開花時間</div>
              <div class="result-cell">預計完成時間</div>
              <div class="result-cell">操作</div>
            </div>
            ${list.map(report => {
              const flowerText = `${report.color || "未填花色"}${report.flower || "未填花種"}${report.amount ? report.amount + "株" : ""}`;
              const previewStatus = getPreviewStatus(report);
              const previewCompleteTime = getPreviewCompleteTime(report);
              return `
                <div class="result-row preview-row">
                  <div class="result-cell result-flower"><span class="mobile-label">花朵</span>🌸 ${escapeHtml(flowerText)}</div>
                  <div class="result-cell"><span class="mobile-label">開花</span>⏰ ${escapeHtml(formatDisplayTime(report.time) || "未填時間")}</div>
                  <div class="result-cell"><span class="mobile-label">完成</span>✅ ${escapeHtml(previewCompleteTime)}</div>
                  <div class="result-cell">
                    <div class="row-actions">
                      <span class="preview-status">${escapeHtml(previewStatus)}</span>
                      <span class="admin-actions">
                        <button class="green" onclick="editReport('${report.id}')">編輯</button>
                        <button class="danger" onclick="deleteReport('${report.id}')">刪除</button>
                      </span>
                    </div>
                  </div>
                </div>
              `;
            }).join("")}
          </div>
        `;
      }

      function renderActiveTable(list) {
        if (!list.length) return "";

        return `
          <div class="result-section-title">可收果區域（${list.length}） <span class="sub">預計開花時間後 1 小時內提供座標</span></div>
          <div class="result-table active-table">
            <div class="result-row result-header">
              <div class="result-cell">花田名稱</div>
              <div class="result-cell">花朵</div>
              <div class="result-cell">開花時間</div>
              <div class="result-cell">備註</div>
              <div class="result-cell result-count">座標數</div>
              <div class="result-cell">操作</div>
            </div>
            ${list.map(report => {
              const coordCount = report.coords ? report.coords.split("\n").filter(Boolean).length : 0;
              const flowerText = `${report.color || "未填花色"}${report.flower || "未填花種"}${report.amount ? report.amount + "株" : ""}`;
              return `
                <div class="result-row">
                  <div class="result-cell result-place"><span class="mobile-label">花田</span>${escapeHtml(report.place || "未命名花田")}</div>
                  <div class="result-cell result-flower"><span class="mobile-label">花朵</span>🌸 ${escapeHtml(flowerText)}</div>
                  <div class="result-cell"><span class="mobile-label">時間</span>⏰ ${escapeHtml(formatDisplayTime(report.time) || "未填時間")}</div>
                  <div class="result-cell"><span class="mobile-label">備註</span>📝 ${escapeHtml(report.note || "無備註")}</div>
                  <div class="result-cell result-count"><span class="mobile-label">座標</span>${coordCount}</div>
                  <div class="result-cell">
                    <div class="row-actions">
                      <button class="green" onclick="copyCoords('${report.id}')">複製座標</button>
                      <button class="secondary" onclick="arJumpHarvest('${report.id}')">AR跳收</button>
                      <button class="download" onclick="downloadFruitGpx('${report.id}')">下載GPX</button>
                      <span class="admin-actions">
					    <button onclick="copyContent('${report.id}')">複製內文</button>
                        <button class="green" onclick="editReport('${report.id}')">編輯</button>
                        <button class="danger" onclick="deleteReport('${report.id}')">刪除</button>
                      </span>
                    </div>
                  </div>
                </div>
              `;
            }).join("")}
          </div>
        `;
      }

      function renderExpiredTable(list) {
        if (!list.length) return "";

        return `
          <details class="expired-section">
            <summary class="result-section-title">
              過期區域（${list.length}）
              <span class="sub">預計開花時間超過 1 小時，不提供座標</span>
            </summary>
            <div class="result-table expired-table">
              <div class="result-row result-header expired-row">
                <div class="result-cell">花田名稱</div>
                <div class="result-cell">花朵</div>
                <div class="result-cell">開花時間</div>
                <div class="result-cell">備註</div>
                <div class="result-cell">狀態 / 操作</div>
              </div>
              ${list.map(report => {
                const flowerText = `${report.color || "未填花色"}${report.flower || "未填花種"}${report.amount ? report.amount + "株" : ""}`;
                return `
                  <div class="result-row expired-row">
                    <div class="result-cell result-place"><span class="mobile-label">花田</span>${escapeHtml(report.place || "未命名花田")}</div>
                    <div class="result-cell result-flower"><span class="mobile-label">花朵</span>🌸 ${escapeHtml(flowerText)}</div>
                    <div class="result-cell"><span class="mobile-label">時間</span>⏰ ${escapeHtml(formatDisplayTime(report.time) || "未填時間")}</div>
                    <div class="result-cell"><span class="mobile-label">備註</span>📝 ${escapeHtml(report.note || "無備註")}</div>
                    <div class="result-cell">
                      <div class="row-actions">
                        <span class="expired-status">已過期</span>
                        <span class="admin-actions">
                          <button class="green" onclick="editReport('${report.id}')">編輯</button>
                          <button class="danger" onclick="deleteReport('${report.id}')">刪除</button>
                        </span>
                      </div>
                    </div>
                  </div>
                `;
              }).join("")}
            </div>
          </details>
        `;
      }

      $("cards").innerHTML = renderPreviewTable(previewReports) + renderActiveTable(activeReports) + renderExpiredTable(expiredReports);
      $("empty").style.display = "none";

	  scheduleNextReportTransition();
    }


    function editReport(id) {
      const report = reports.find(item => item.id === id);
      if (report) setFormData(report);
    }

    async function deleteReport(id) {
      if (!confirm("確定要刪除此公告嗎？")) return;

      const success = await deleteReportFromSheet(id);
      if (!success) return;

      await loadReports();
      renderReports();
      showToast("已刪除公告");
    }

    window.copyCoords = copyCoords;
    window.arJumpHarvest = arJumpHarvest;
    window.downloadFruitGpx = downloadFruitGpx;
    window.copyContent = copyContent;
    window.editReport = editReport;
    window.deleteReport = deleteReport;

$("parseBtn").addEventListener("click", () => {
  const rawText =
    cleanSpreadsheetText(
      $("rawInput").value
    );

  const coordsText =
    cleanCoordsText(
      $("coordsInput").value
    );

  // 只有「內容」有資料：
  // 只清除頭尾多餘的 "，不進行完整解析，
  // 也不跳出需要按確認的 alert。
  if (rawText && !coordsText) {
    $("rawInput").value = rawText;

    showToast("已整理內容格式");

    return;
  }

  // 完全沒有內容
  if (!rawText) {
    alert("請先填入公告內容。");
    return;
  }

  // 有內容也有座標 → 正常完整解析
  const parsed =
    parseReportText(rawText);

  const coordCount =
    getCoordCount(coordsText);

  $("rawInput").value =
    parsed.raw;

  $("coordsInput").value =
    coordsText;

  $("placeInput").value =
    parsed.place;

  if (parsed.color) {
    $("colorInput").value =
      parsed.color;
  }

  if (parsed.flower) {
    $("flowerInput").value =
      parsed.flower;
  }

  $("amountInput").value =
    coordCount;

  $("timeInput").value =
    parsed.time;

  $("noteInput").value =
    parsed.note;

  showToast(
    `已解析，株數已套用座標數量：${coordCount}`
  );
});

    $("saveBtn").addEventListener("click", async () => {
      const rawText = cleanSpreadsheetText($("rawInput").value);
      const coordsText = cleanCoordsText($("coordsInput").value);

      if (!rawText || !coordsText) {
        alert("請先填入「內容」與「座標」兩個欄位，再儲存公告，避免資料缺漏。");
        return;
      }

      $("rawInput").value = rawText;
      $("coordsInput").value = coordsText;
      syncAmountWithCoords();

      // 最後一道強制驗證：未列於 FLOWERS 清單的內容絕不送往 Google Apps Script。
      if (!validateFlowerInput(true)) return;

      const data = getFormData();
      if (!getCanonicalFlowerName(data.flower)) {
        alert("花朵種類驗證失敗，請重新從清單選擇。");
        $("flowerInput").focus();
        return;
      }
      if (!data.place) {
        alert("請至少填寫地點 / 花田名稱。若已貼上公告文字，可先按「從公告文字自動解析」。");
        return;
      }

      const success = await saveReportToSheet(data);
      if (!success) return;

      await loadReports();
      clearForm();
      renderReports();
      showToast("已儲存公告");
    });

    $("clearFormBtn").addEventListener("click", clearForm);

    $("flowerInput").addEventListener("input", () => {
      // 輸入過程即同步有效性；仍可繼續打字搜尋，但無效名稱不能儲存。
      validateFlowerInput(false);
    });
    $("flowerInput").addEventListener("change", () => validateFlowerInput(false));
    $("flowerInput").addEventListener("blur", () => validateFlowerInput(false));

    function toggleAdminPanel() {
      setAdminPanelCollapsed(!$("adminPanel").classList.contains("collapsed"));
    }

    $("adminPanelHeader").addEventListener("click", toggleAdminPanel);
    $("adminPanelHeader").addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleAdminPanel();
      }
    });

    $("coordsInput").addEventListener("input", syncAmountWithCoords);
    $("keyword").addEventListener("input", renderReports);
    $("colorFilter").addEventListener("change", renderReports);
    $("flowerFilter").addEventListener("input", renderReports);
    $("flowerFilter").addEventListener("change", renderReports);

    $("adminLoginBtn").addEventListener("click", () => $("loginDialog").showModal());
    $("closeLoginBtn").addEventListener("click", () => $("loginDialog").close());
    $("passwordInput").addEventListener("keydown", event => {
      if (event.key === "Enter") $("confirmLoginBtn").click();
    });
    $("confirmLoginBtn").addEventListener("click", async () => {
      const inputPassword = $("passwordInput").value;

      if (!inputPassword) {
        alert("請輸入密碼。");
        return;
      }

      const loginBtn = $("confirmLoginBtn");
      const originalLoginText = loginBtn.textContent;
      loginBtn.disabled = true;
      loginBtn.textContent = "驗證中…";

      let result;
      try {
        result = await verifyAccessPassword(inputPassword);
      } finally {
        loginBtn.disabled = false;
        loginBtn.textContent = originalLoginText;
      }

      if (!result.success || !["private", "admin"].includes(result.role)) {
        alert(result.message || "密碼錯誤。");
        return;
      }

      accessPassword = inputPassword;
      sessionStorage.setItem("pikminAccessPassword", inputPassword);
      $("passwordInput").value = "";
      $("loginDialog").close();
      setAccessMode(result.role);

		// 密碼驗證成功後，立即進入對應權限模式。
		// Reports / 私田資料改在背景載入，不阻塞 Admin 介面顯示。
		
		const restoredProtected =
		  restoreReportsSnapshot(result.role);
		
		// 先立即告知登入成功。
		showToast(
		  result.role === "admin"
		    ? "已進入 Admin 管理模式"
		    : "已進入私田模式"
		);
		
		// 背景載入最新 Admin / 私田資料。
		// 不使用 await，避免 Google Apps Script 較慢時卡住登入畫面。
		refreshReports({
		  force: true,
		  showLoading: !restoredProtected
		});
    });

    $("logoutBtn").addEventListener("click", () => {
      const wasAdmin = isAdmin;
      clearForm();

      // 登出瞬間先在記憶體中移除所有私田，絕不等待 API 回應。
      // 這樣即使 Google Apps Script 很慢，私田也不會繼續留在畫面上。
      const publicOnlyReports = reports.filter(report =>
        !String(report && report.place || "").includes("私")
      );

      clearProtectedReportsSnapshot();
      clearAccessSession();
      accessRole = "public";
      reports = publicOnlyReports;
      hasDisplayedReportSnapshot = true;
      saveReportsSnapshot("public", reports);
      setAccessMode("public");
      renderReports();

      showToast(wasAdmin ? "已離開 Admin 管理模式" : "已離開私田模式");

      // 背景再向後端同步最新公開田，不阻塞登出。
      refreshReports({ force: true, showLoading: false });
    });



    $("reloadLatestBtn").addEventListener("click", () => {
      // 加上一次性參數，避免瀏覽器直接沿用舊 HTML 快取。
      const url = new URL(window.location.href);
      url.searchParams.set("_latest", Date.now());
      window.location.replace(url.toString());
    });

    async function checkDataVersion() {
      if (document.visibilityState !== "visible" || isCheckingDataVersion || isLoadingReports) return;

      isCheckingDataVersion = true;
      try {
        const res = await fetchWithTimeout(
          `${CONFIG.PUBLIC_API_URL}/version?ts=${Date.now()}`,
          {},
          8000
        );
        if (!res.ok) return;

        const data = await res.json();
        if (!data.success || data.dataVersion == null) return;

        const serverVersion = String(data.dataVersion);
		  
        if (currentDataVersion === null) {
  			currentDataVersion = serverVersion;
			
		  // 如果目前完全沒有成功載入過公告，
		  // 代表首次完整載入可能失敗。
		  // 此時 version check 成功後，再嘗試抓一次完整公告。
		  if (!hasDisplayedReportSnapshot) {
		    await refreshReports({
		      force: true,
		      showLoading: true
		    });
		  }

  return;
}

        if (serverVersion !== currentDataVersion) {
          // 不先覆蓋 currentDataVersion；完整讀取成功時 loadReports() 會同步版本。
          // 若這次更新失敗，12 秒後會再嘗試，不會漏掉更新。
          await refreshReports({ force: true, showLoading: false });
        }
      } catch (error) {
        // 輕量版本檢查失敗不影響目前資料，下一輪再試。
        console.debug("公告資料版本檢查失敗", error);
      } finally {
        isCheckingDataVersion = false;
      }
    }

    function stopDataVersionTimer() {
      if (dataVersionTimer !== null) {
        clearInterval(dataVersionTimer);
        dataVersionTimer = null;
      }
    }

    function startDataVersionTimer() {
      stopDataVersionTimer();
      if (document.visibilityState !== "visible") return;
      dataVersionTimer = setInterval(checkDataVersion, DATA_VERSION_CHECK_INTERVAL);
    }

    let isLoadingReports = false;

    async function refreshReports({ force = false, showLoading = null } = {}) {
      if (!force && document.visibilityState !== "visible") return;
      if (isLoadingReports) return;

      isLoadingReports = true;

      const loading = $("loadingMessage");
      const shouldShowLoading = showLoading === null ? !hasDisplayedReportSnapshot : showLoading;
      const loadingBaseText = "🌱 皮克敏正在搬運花田資料，請稍後";
      let loadingDotStep = 1;
      let loadingAnimationTimer = null;

      if (loading && shouldShowLoading) {
        loading.style.display = "block";
        loading.textContent = `${loadingBaseText}.`;

        loadingAnimationTimer = setInterval(() => {
          loadingDotStep = loadingDotStep % 3 + 1;
          loading.textContent = `${loadingBaseText}${".".repeat(loadingDotStep)}`;
        }, 450);
      }

      try {
        const success = await loadReports();

        if (success) {
          renderReports();
        }
      } finally {
        if (loadingAnimationTimer !== null) {
          clearInterval(loadingAnimationTimer);
        }

        if (loading) {
          loading.style.display = "none";
        }

        isLoadingReports = false;
      }
    }

document.addEventListener(
  "visibilitychange",
  () => {
    if (
      document.visibilityState === "visible"
    ) {
      // 切回網站時：
      // 先更新花田目前應該顯示在哪個區域。
      renderReports();
      scheduleNextReportTransition();

      // 檢查網站本體是否有新版。
      checkForSiteUpdate();

      // 只檢查公告版本。
      // 版本有變時，checkDataVersion() 才會抓完整公告。
      checkDataVersion();

      // 重新啟動前景計時器。
      startDataVersionTimer();
      startSiteUpdateTimer();

    } else {
      // 離開分頁時暫停輪詢，減少不必要請求。
      stopDataVersionTimer();
      stopSiteUpdateTimer();
    }
  }
);

    function enableMobileNoticeDrag() {
      const notice = document.querySelector(".notice-float");
      if (!notice) return;

      const mobileMedia = window.matchMedia("(max-width: 1024px)");
      const storageKey = "pikminNoticeFloatPosition";
      let dragging = false;
      let pointerOffsetX = 0;
      let pointerOffsetY = 0;

      function clampPosition(left, top) {
        const margin = 8;
        const maxLeft = Math.max(margin, window.innerWidth - notice.offsetWidth - margin);
        const maxTop = Math.max(margin, window.innerHeight - notice.offsetHeight - margin);
        return {
          left: Math.min(Math.max(left, margin), maxLeft),
          top: Math.min(Math.max(top, margin), maxTop)
        };
      }

      function applyPosition(left, top, save = false) {
        if (!mobileMedia.matches) return;
        const position = clampPosition(left, top);
        notice.style.left = `${position.left}px`;
        notice.style.top = `${position.top}px`;
        notice.style.right = "auto";
        notice.style.bottom = "auto";

        if (save) {
          localStorage.setItem(storageKey, JSON.stringify(position));
        }
      }

      function restorePosition() {
        if (!mobileMedia.matches) {
          notice.style.left = "";
          notice.style.top = "";
          notice.style.right = "";
          notice.style.bottom = "";
          return;
        }

        try {
          const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
          if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
            applyPosition(saved.left, saved.top);
          }
        } catch (error) {
          localStorage.removeItem(storageKey);
        }
      }

      notice.addEventListener("pointerdown", event => {
        if (!mobileMedia.matches || event.button !== 0) return;

        const rect = notice.getBoundingClientRect();
        dragging = true;
        pointerOffsetX = event.clientX - rect.left;
        pointerOffsetY = event.clientY - rect.top;
        notice.classList.add("dragging");
        notice.setPointerCapture(event.pointerId);
        event.preventDefault();
      });

      notice.addEventListener("pointermove", event => {
        if (!dragging || !mobileMedia.matches) return;
        applyPosition(event.clientX - pointerOffsetX, event.clientY - pointerOffsetY);
        event.preventDefault();
      });

      function stopDragging(event) {
        if (!dragging) return;
        dragging = false;
        notice.classList.remove("dragging");

        const rect = notice.getBoundingClientRect();
        applyPosition(rect.left, rect.top, true);

        if (event && notice.hasPointerCapture(event.pointerId)) {
          notice.releasePointerCapture(event.pointerId);
        }
      }

      notice.addEventListener("pointerup", stopDragging);
      notice.addEventListener("pointercancel", stopDragging);

      window.addEventListener("resize", () => {
        if (!mobileMedia.matches) return;
        const rect = notice.getBoundingClientRect();
        applyPosition(rect.left, rect.top, true);
      });

      mobileMedia.addEventListener("change", restorePosition);
      requestAnimationFrame(restorePosition);
    }

    async function initializeAccessAndReports() {
      // 先記錄目前 GitHub Pages 的發布指紋，之後有更新就能通知仍開著舊頁面的使用者。
      await checkForSiteUpdate({ initialize: true });

      fillOptions();
      enableMobileNoticeDrag();

      // 沒有本分頁登入憑證時，不保留任何私田備援。
      if (!accessPassword) clearProtectedReportsSnapshot();

      if (accessPassword) {
        const result = await verifyAccessPassword(accessPassword);
        if (result.success && ["private", "admin"].includes(result.role)) {
          setAccessMode(result.role);
        } else {
          clearAccessSession();
          setAccessMode("public");
        }
      } else {
        setAccessMode("public");
      }

      hasDisplayedReportSnapshot = false;
      const restoredSnapshot = restoreReportsSnapshot(accessRole);
      await refreshReports({ force: true, showLoading: !restoredSnapshot });
      startDataVersionTimer();
	  startSiteUpdateTimer();
    }

    initializeAccessAndReports();
