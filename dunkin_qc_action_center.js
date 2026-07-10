/* =========================================================
   던킨 QC 시스템 — 재고 작업 액션센터 + 운영 대시보드 (부가 스크립트)
   ---------------------------------------------------------
   이 파일은 기존 dunkin_qc.html을 "수정"하지 않고, 그 안에 이미
   선언된 전역 함수/변수(ZONES, DB, BASIS, LocationTransition,
   receiveQueue, fetchPriorityAlerts, renderHome, renderProductList,
   computeSafeDate, safeStatus, computeContainerDue, todayDiscardList,
   todayExpireList, persist, persistEntry, consumeProduct,
   discardProduct, toast, nowLocalInputValue, productsForZone,
   inferStorageMethod 등)를 그대로 재사용합니다.

   같은 HTML 문서 안의 <script> 태그들은 let/const 최상위 선언을
   서로 공유하므로(모듈이 아닌 일반 스크립트 기준), 이 파일을
   </body> 바로 앞에 <script src="dunkin_qc_action_center.js"></script>
   한 줄만 추가하면 원본 코드를 한 글자도 건드리지 않고 아래 기능이
   그대로 켜집니다.

   적용 방법
   ---------------------------------------------------------
   1) 이 파일을 dunkin_qc.html과 같은 폴더에 저장합니다.
   2) dunkin_qc.html 맨 아래 </body> 바로 위에 딱 한 줄만 추가:

        <script src="dunkin_qc_action_center.js"></script>

      (기존 <script> ... </script> 블록이 끝난 뒤, </body> 앞이면 됩니다)

   추가되는 기능
   ---------------------------------------------------------
   ① 각 품목 행에 "🔀 재고 작업" 버튼 → 입고/이동/해동/소분/사용/폐기
      6개 액션을 프롬프트 없이 터치 UI로 처리 (기존 LocationTransition 사용)
   ② 홈 화면 상단에 운영 요약 카드(안전보관 임박/통교체/소비기한/입고대기)
   ③ "오늘 처리해야 할 작업" 패널 (서버 alerts 연동, 실패 시 로컬 계산으로 대체)
   ④ 위치별 재고 현황 카드
   ⑤ 입고 대기 목록 패널
   ⑥ 60초마다 홈 화면 자동 새로고침

   ---------------------------------------------------------
   [수정 내역] 입고(receive) 액션 버그 수정
   ---------------------------------------------------------
   - 기존에는 입고 모달에 소비기한 입력 필드가 없었고, 확인을 눌러도
     entry.lots에 실제로 반영되지 않아 화면/시트 수량이 갱신되지 않는
     문제가 있었습니다.
   - 이번 수정에서:
     1) 입고(receive) 액션에도 소비기한 입력 필드를 노출합니다.
     2) 재고관리(stockTracking) 품목은 원본 openQuickReceiveModal과
        동일하게 entry.lots에 로트를 합산/추가합니다.
     3) 재고관리 대상이 아닌 일반 품목은 entry.qty를 누적하고
        entry.expiry를 갱신해 화면(재고 목록)에도 즉시 반영되도록
        분기 처리했습니다.
     4) LocationTransition.receive 호출 시 expiryDate를 함께 전달해
        서버(INVENTORY) 쪽에도 소비기한이 정확히 반영되도록 했습니다.
   ========================================================= */
(function () {
  'use strict';

  /* ---------------------------------------------------------
     0. 필수 전역이 아직 로드되지 않았으면 조용히 종료
        (스크립트 삽입 위치가 잘못된 경우를 대비한 방어 코드)
     --------------------------------------------------------- */
  if (typeof ZONES === 'undefined' || typeof DB === 'undefined') {
    console.error('[action-center] 이 스크립트는 dunkin_qc.html의 메인 <script> 아래(</body> 앞)에 있어야 합니다.');
    return;
  }

  /* ---------------------------------------------------------
     1. 스타일 — 기존 다크 테마 CSS 변수(--panel, --mint, --orange,
        --red, --pink 등)를 그대로 사용해 이질감 없이 붙습니다.
     --------------------------------------------------------- */
  const style = document.createElement('style');
  style.textContent = `
    .dashboard-summary{
      display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr));
      gap:10px; max-width:760px; margin-bottom:16px;
    }
    .summary-card{
      background:var(--panel); border:1px solid var(--line);
      border-radius:14px; padding:14px;
    }
    .summary-card .title{ font-size:0.78rem; color:var(--muted); }
    .summary-card .value{ margin-top:6px; font-size:1.6rem; font-weight:800; color:var(--cream); }
    .summary-card.safe .value{ color:var(--red); }
    .summary-card.container .value{ color:var(--orange); }
    .summary-card.expiry .value{ color:var(--pink); }
    .summary-card.receive .value{ color:var(--mint); }

    .today-panel, .location-panel, .receive-panel{ max-width:760px; }
    .today-task{
      background:var(--panel2); border:1px solid var(--line);
      border-radius:10px; padding:10px 12px; margin-bottom:8px; font-size:0.85rem;
    }
    .today-task strong{ display:block; margin-bottom:2px; }

    .location-grid{
      display:grid; grid-template-columns:repeat(auto-fit,minmax(100px,1fr)); gap:8px;
    }
    .location-grid div{
      background:var(--panel2); border:1px solid var(--line);
      border-radius:10px; padding:8px 10px; font-size:0.8rem; text-align:center;
    }
    .receive-queue-item{
      background:var(--panel2); border:1px solid var(--line);
      border-radius:10px; padding:8px 12px; margin-bottom:6px; font-size:0.85rem;
    }

    .action-grid{
      display:grid; grid-template-columns:repeat(2,1fr); gap:10px; margin-top:6px;
    }
    .action-grid button{ height:60px; font-size:0.95rem; }

    .invtask-btn{ margin-top:6px; width:100%; }

    @media (max-width:700px){
      .dashboard-summary{ grid-template-columns:repeat(2,1fr); }
      .summary-card .value{ font-size:1.35rem; }
    }
  `;
  document.head.appendChild(style);

  /* ---------------------------------------------------------
     2. 공통 유틸 — 기존 .overlay/.sheet 패턴을 그대로 재사용
     --------------------------------------------------------- */
  function makeOverlay(innerHTML) {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = `<div class="sheet">${innerHTML}</div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    return overlay;
  }

  function actionLabel(action) {
    return { receive: '입고', move: '위치이동', thaw: '해동', subdivide: '소분', use: '사용', discard: '폐기' }[action] || action;
  }

  let currentInventoryProduct = null;
  let currentAction = '';

  /* ---------------------------------------------------------
     3. STEP 4 — 재고 작업 액션 시트 (입고/이동/해동/소분/사용/폐기)
     --------------------------------------------------------- */
  function openInventoryActionSheet(product) {
    currentInventoryProduct = product;
    const overlay = makeOverlay(`
      <h3>${product.name} · 재고 작업</h3>
      <div class="action-grid">
        <button type="button" data-act="receive">📥 입고</button>
        <button type="button" data-act="move">🔄 위치이동</button>
        <button type="button" data-act="thaw">❄️ 해동</button>
        <button type="button" data-act="subdivide">🥣 소분</button>
        <button type="button" data-act="use">✅ 사용</button>
        <button type="button" data-act="discard">🗑️ 폐기</button>
      </div>
      <button type="button" class="ghost" id="invaction-close" style="width:100%;margin-top:14px;">닫기</button>
    `);
    overlay.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', () => { overlay.remove(); openInventoryInputModal(btn.dataset.act, product); });
    });
    overlay.querySelector('#invaction-close').addEventListener('click', () => overlay.remove());
  }

  /* ---------------------------------------------------------
     4. STEP 5 — prompt() 없는 전용 입력 모달 (수량/위치/날짜/사유)
        [수정] 소비기한 입력 필드를 'receive'(입고) 액션에도 노출.
        - subdivide: 식품 소비기한(통 교체일과는 별개) 라벨 사용
        - receive : 일반적인 "소비기한" 라벨 사용
     --------------------------------------------------------- */
  function openInventoryInputModal(action, product) {
    currentAction = action;
    currentInventoryProduct = product;

    const zoneOptions = ZONES
      .map(z => `<option value="${z.key}" ${z.key === product.zone ? 'disabled' : ''}>${z.label}</option>`)
      .join('');

    const showLocation = action === 'move';
    const showExpiry = action === 'subdivide' || action === 'receive';
    const showReason = action === 'discard';

    const expiryLabel = action === 'receive'
      ? '소비기한'
      : '식품 소비기한 <span style="color:var(--muted); font-weight:400;">(통 교체일과는 별개로 관리됩니다)</span>';

    const overlay = makeOverlay(`
      <h3>${product.name} · ${actionLabel(action)}</h3>
      <label>수량</label>
      <input type="number" id="inv-qty" min="1" value="1">
      <div id="inv-location-field" style="${showLocation ? '' : 'display:none;'}">
        <label>이동할 위치</label>
        <select id="inv-location">${zoneOptions}</select>
      </div>
      <div id="inv-expiry-field" style="${showExpiry ? '' : 'display:none;'}">
        <label>${expiryLabel}</label>
        <input type="date" id="inv-expiry">
      </div>
      <div id="inv-reason-field" style="${showReason ? '' : 'display:none;'}">
        <label>폐기 사유</label>
        <select id="inv-reason">
          <option value="expiry">소비기한</option>
          <option value="container">통교체</option>
          <option value="safe">안전보관</option>
        </select>
      </div>
      <div class="actions" style="margin-top:16px;">
        <button class="ghost" id="inv-cancel">취소</button>
        <button class="primary" id="inv-confirm">저장</button>
      </div>
    `);

    overlay.querySelector('#inv-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#inv-confirm').addEventListener('click', async () => {
      const btn = overlay.querySelector('#inv-confirm');
      btn.disabled = true;
      btn.textContent = '처리중...';
      await submitInventoryAction(overlay);
      overlay.remove();
    });
  }

  /* ---------------------------------------------------------
     5. STEP 5-7 — 저장: 기존 LocationTransition(서버 반영)과
        기존 로컬 저장 흐름(persist/persistEntry/consumeProduct/
        discardProduct)을 그대로 사용해, 화면이 즉시 갱신되도록 처리.

        [수정] receive 케이스:
        - 재고관리(stockTracking) 품목: 원본 openQuickReceiveModal과
          동일하게 같은 소비기한의 로트가 있으면 수량만 합산, 없으면
          새 로트를 push.
        - 일반 품목(stockTracking:false): entry.qty를 누적하고
          entry.expiry를 갱신 → 구역 화면의 소비기한 입력창에도
          즉시 반영됨.
        - 두 경우 모두 LocationTransition.receive에 expiryDate를
          함께 전달해 서버(INVENTORY) 값도 정확히 반영.
     --------------------------------------------------------- */
  async function submitInventoryAction(overlay) {
    const product = currentInventoryProduct;
    if (!product) return;
    const qty = Number(overlay.querySelector('#inv-qty').value) || 1;
    const entry = DB.entries[product.id] || {};

    try {
      switch (currentAction) {
        case 'receive': {
          const expiryInput = overlay.querySelector('#inv-expiry');
          const expiry = expiryInput ? (expiryInput.value || null) : null;

          if (product.stockTracking) {
            // 재고관리 품목: 로트(수량+소비기한) 단위로 관리
            entry.lots = entry.lots || [];
            const existingLot = entry.lots.find(l => l.expiry === expiry);
            if (existingLot) {
              existingLot.qty = (existingLot.qty || 0) + qty;
            } else {
              entry.lots.push({ qty, expiry, opened: false, baseDate: nowLocalInputValue() });
            }
          } else {
            // 일반 품목: 단일 수량/소비기한 값을 직접 누적·갱신
            entry.qty = (entry.qty || 0) + qty;
            if (expiry) {
              entry.expiry = expiry;
              entry.expiryCleared = false; // 새 소비기한이 입력됐으니 폐기 표시 해제
            }
          }

          entry.status = entry.status || '정상';
          entry.updatedAt = new Date().toISOString();
          DB.entries[product.id] = entry;
          await persistEntry(product.id);
          await LocationTransition.receive({
            barcode: product.barcode, productName: product.name, category: product.category,
            zoneKey: product.zone, quantity: qty, expiryDate: expiry, operator: '관리자'
          });
          toast(`${product.name} ${qty}개 입고 처리`);
          break;
        }
        case 'move': {
          const toZone = overlay.querySelector('#inv-location').value;
          const fromZone = product.zone;
          await LocationTransition.move({ barcode: product.barcode, fromZoneKey: fromZone, toZoneKey: toZone, quantity: qty, operator: '관리자' });
          product.zone = toZone;
          product.storageMethod = inferStorageMethod(toZone);
          await persist();
          const toLabel = (ZONES.find(z => z.key === toZone) || {}).label || toZone;
          toast(`${product.name} → ${toLabel} 이동 처리`);
          break;
        }
        case 'thaw': {
          entry.baseDate = nowLocalInputValue();
          entry.status = '해동중';
          entry.expiryCleared = false;
          entry.updatedAt = new Date().toISOString();
          entry.safeUntil = computeSafeDate(product, entry);
          DB.entries[product.id] = entry;
          await persistEntry(product.id);
          await LocationTransition.thaw({ barcode: product.barcode, fromZoneKey: product.zone, quantity: qty, operator: '관리자' });
          toast(`${product.name} 해동 처리`);
          break;
        }
        case 'subdivide': {
          const foodExpiry = overlay.querySelector('#inv-expiry').value || null;
          entry.baseDate = nowLocalInputValue(); // 소분통 교체일 계산 기준
          entry.expiry = foodExpiry;             // 식품 자체 소비기한(통교체와 별개, Dual-Rule)
          entry.expiryCleared = false;
          entry.updatedAt = new Date().toISOString();
          DB.entries[product.id] = entry;
          await persistEntry(product.id);
          await LocationTransition.subdivide({ barcode: product.barcode, quantity: qty, foodExpiryDate: foodExpiry, operator: '관리자' });
          toast(`${product.name} 소분 처리`);
          break;
        }
        case 'use': {
          await LocationTransition.use({ barcode: product.barcode, quantity: qty, operator: '관리자' });
          // 재고관리(lots) 품목은 가장 앞 로트 기준으로 소진 처리(간이 처리 — 로트별 세밀 조정은
          // 구역 화면의 "재고" 섹션에서 직접 하시는 걸 권장합니다).
          if (product.stockTracking && Array.isArray(entry.lots) && entry.lots.length) {
            await consumeProduct(product.id, 0);
          } else {
            await consumeProduct(product.id);
          }
          break;
        }
        case 'discard': {
          const reason = overlay.querySelector('#inv-reason').value;
          await discardProduct(product.id, reason); // 내부에서 LocationTransition.discard까지 처리됨
          break;
        }
      }
    } catch (e) {
      console.error('[action-center] 처리 오류:', e);
      toast('처리 중 오류가 발생했습니다');
    }

    refreshCurrentView();
  }

  function refreshCurrentView() {
    const hash = location.hash.replace(/^#\/?/, '');
    if (hash.startsWith('zone/')) {
      const zoneKey = hash.split('/')[1];
      const searchInput = document.getElementById('searchInput');
      if (typeof renderProductList === 'function') renderProductList(zoneKey, searchInput ? searchInput.value.trim() : '');
    } else if (!hash) {
      if (typeof renderHome === 'function') renderHome();
    }
  }

  /* ---------------------------------------------------------
     6. 구역 화면의 각 품목 행에 "🔀 재고 작업" 버튼 추가
        (renderProductList를 감싸서, 렌더링이 끝난 뒤 버튼만 덧붙입니다 —
         원본 renderProductList 자체는 전혀 수정하지 않습니다)
     --------------------------------------------------------- */
  const originalRenderProductList = window.renderProductList;
  if (typeof originalRenderProductList === 'function') {
    window.renderProductList = function (zoneKey, filterText) {
      originalRenderProductList(zoneKey, filterText);
      const listEl = document.getElementById('productList');
      if (!listEl) return;
      listEl.querySelectorAll('.product-row').forEach(row => {
        if (row.querySelector('.invtask-btn')) return; // 중복 방지
        const pid = row.dataset.pid;
        const product = DB.products.find(p => p.id === pid);
        if (!product) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'small ghost invtask-btn';
        btn.textContent = '🔀 재고 작업 (입고·이동·해동·소분·사용·폐기)';
        btn.addEventListener('click', () => openInventoryActionSheet(product));
        row.appendChild(btn);
      });
    };
  }

  /* ---------------------------------------------------------
     7. STEP 6 — 운영 대시보드 (홈 화면 상단에 삽입)
     --------------------------------------------------------- */
  function computeDashboardCounts() {
    const safeCount = (typeof todayExpireList === 'function' ? todayExpireList() : []).length;

    let containerCount = 0;
    DB.products.forEach(p => {
      if (p.basis !== 'subdiv' || p.stockTracking) return;
      const entry = DB.entries[p.id];
      const due = computeContainerDue(p, entry);
      if (!due) return;
      const status = safeStatus(due, p.zone);
      if (status === 'warn' || status === 'danger' || status === 'priority-danger') containerCount++;
    });

    const expiryCount = (typeof todayDiscardList === 'function' ? todayDiscardList() : [])
      .filter(i => i.reason === 'expiry').length;

    const receiveCount = (typeof receiveQueue !== 'undefined') ? receiveQueue.length : 0;

    return { safeCount, containerCount, expiryCount, receiveCount };
  }

  function renderDashboardSummaryHTML() {
    const c = computeDashboardCounts();
    return `
      <div class="dashboard-summary">
        <div class="summary-card safe"><div class="title">안전보관 임박</div><div class="value">${c.safeCount}</div></div>
        <div class="summary-card container"><div class="title">통 교체</div><div class="value">${c.containerCount}</div></div>
        <div class="summary-card expiry"><div class="title">소비기한</div><div class="value">${c.expiryCount}</div></div>
        <div class="summary-card receive"><div class="title">입고대기</div><div class="value">${c.receiveCount}</div></div>
      </div>
    `;
  }

  function renderLocationSummaryHTML() {
    const cells = ZONES.map(z => `<div>${z.label}<br><strong>${productsForZone(z.key).length}</strong></div>`).join('');
    return `<div class="panel location-panel"><h3>📊 위치별 재고 현황</h3><div class="location-grid">${cells}</div></div>`;
  }

  function renderReceiveQueueHTML() {
    if (typeof receiveQueue === 'undefined' || !receiveQueue.length) {
      return `<div class="panel receive-panel"><h3>📦 입고 대기</h3><div class="empty">대기 중인 입고가 없습니다.</div></div>`;
    }
    const items = receiveQueue.map(p => {
      const zoneLabel = (ZONES.find(z => z.key === p.zone) || {}).label || '';
      return `<div class="receive-queue-item">${p.name} <span style="color:var(--muted); font-size:0.75rem;">(${zoneLabel})</span></div>`;
    }).join('');
    return `<div class="panel receive-panel"><h3>📦 입고 대기</h3>${items}</div>`;
  }

  async function renderTodayTasksHTML() {
    // 서버(Apps Script) alerts API가 연결돼 있으면 그 값을 우선 사용하고,
    // 실패/미연결 시 로컬 계산(todayDiscardList/todayExpireList)으로 대체합니다.
    let alerts = [];
    try {
      if (typeof fetchPriorityAlerts === 'function') alerts = await fetchPriorityAlerts();
    } catch (e) { alerts = []; }

    let items = [];
    if (Array.isArray(alerts) && alerts.length) {
      items = alerts.map(a => `<div class="today-task"><strong>${a.productName || a.name || ''}</strong><div>${a.message || ''}</div></div>`);
    } else {
      const discard = (typeof todayDiscardList === 'function' ? todayDiscardList() : []);
      const expire = (typeof todayExpireList === 'function' ? todayExpireList() : []);
      items = [
        ...discard.map(i => `<div class="today-task"><strong>${i.product.name}</strong><div>${i.reason === 'expiry' ? '오늘 소비기한 만료 · 폐기 필요' : '안전보관일 초과 · 폐기 필요'}</div></div>`),
        ...expire.map(i => `<div class="today-task"><strong>${i.product.name}</strong><div>오늘 안전보관일 만료</div></div>`)
      ];
    }
    if (!items.length) items = ['<div class="empty">오늘 처리할 작업이 없습니다.</div>'];
    return `<div class="panel today-panel"><h3>📋 오늘 처리해야 할 작업</h3>${items.join('')}</div>`;
  }

  async function buildDashboardExtrasHTML() {
    return renderDashboardSummaryHTML() + await renderTodayTasksHTML() + renderLocationSummaryHTML() + renderReceiveQueueHTML();
  }

  async function injectDashboardExtras() {
    if (location.hash.replace(/^#\/?/, '') !== '') return; // 홈 화면일 때만 표시
    const root = document.getElementById('viewRoot');
    if (!root) return;
    let wrap = document.getElementById('dashboardExtras');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'dashboardExtras';
      root.prepend(wrap);
    }
    wrap.innerHTML = await buildDashboardExtrasHTML();
  }

  const originalRenderHome = window.renderHome;
  if (typeof originalRenderHome === 'function') {
    window.renderHome = function () {
      originalRenderHome();          // renderHome()이 root.innerHTML을 새로 그리므로
      injectDashboardExtras();       // 그 위에 대시보드를 다시 붙여줍니다
    };
  }

  /* ---------------------------------------------------------
     8. STEP 6-7 — 60초마다 홈 화면 자동 새로고침
     --------------------------------------------------------- */
  setInterval(() => { injectDashboardExtras(); }, 60000);
  window.addEventListener('hashchange', () => { injectDashboardExtras(); });

  // 이 스크립트는 </body> 바로 앞, 원본 스크립트 뒤에 위치하므로
  // 원본의 DOMContentLoaded(loadDB → router)가 이미 예약되어 있습니다.
  // 그 처리가 끝난 뒤 대시보드를 붙이기 위해 약간의 지연을 둡니다.
  window.addEventListener('DOMContentLoaded', () => {
    setTimeout(injectDashboardExtras, 300);
  });
})();