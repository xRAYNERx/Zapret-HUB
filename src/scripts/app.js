const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const HELP_TEXTS = {
  'game-filter': {
    title: 'Игровой фильтр',
    body: `
      <p>Расширяет обход блокировок на <strong>игровой трафик</strong> (порты TCP/UDP 1024–65535). Полезно, если сайты открываются, а онлайн-игры — нет.</p>
      <p>Если Zapret уже работает, после включения нужно <strong>выключить и снова включить</strong> обход.</p>
    `
  },
  'ipset-filter': {
    title: 'IPSet фильтр',
    body: `
      <p>Управляет списком IP-адресов (<code>ipset-all.txt</code>), к которым применяется обход.</p>
      <p><strong>Загружен</strong> — используется актуальный список IP (рекомендуется).<br>
      <strong>Отключён</strong> — список IP не применяется.<br>
      <strong>Любые IP</strong> — обход без фильтрации по списку.</p>
      <p><strong>Где настроить:</strong> раздел <strong>Сервис</strong> → блок «IPSet фильтр».</p>
      <p>Обновить сам список IP можно в папке Zapret: <code>service.bat</code> → пункт 7 «Update IPSet List».</p>
    `
  },
  'autostart-zapret': {
    title: 'Автозапуск обхода',
    body: `
      <p>При загрузке Windows Zapret HUB запускается в трее и автоматически включает обход по последней стратегии.</p>
      <p>Кнопка «Включить/Выключить» останавливает обход сейчас, но автозапуск остаётся для следующей загрузки.</p>
      <p>Права администратора для переключателя <strong>не нужны</strong>. При первом автозапуске обхода после перезагрузки Windows может один раз запросить UAC — это нормально для драйвера WinDivert.</p>
    `
  },
  'autostart-tg': {
    title: 'Автозапуск TG Proxy',
    body: `
      <p>При загрузке Windows Zapret HUB запускается в трее и автоматически включает TG Proxy.</p>
      <p>Кнопка на карточке «Прокси для Telegram» останавливает прокси сейчас, но автозапуск остаётся для следующей загрузки.</p>
      <p>Права администратора <strong>не нужны</strong>. Можно включить только TG Proxy, только обход или оба — переключатели работают независимо.</p>
    `
  }
};

let state = {
  running: false,
  strategies: [],
  sites: [],
  sitesSearchQuery: '',
  sitesExpanded: true,
  sitesSaving: false,
  customLists: { lists: [], activeId: null },
  customSites: [],
  customSitesSearchQuery: '',
  customListEditing: null,
  customSitesExpanded: true,
  customSitesSaving: false,
  busy: false,
  pendingUpdate: null,
  pendingStartupUpdates: null,
  updating: false,
  hubUpdating: false,
  startupUpdating: false,
  updateContext: 'manual',
  pendingStartStrategy: null,
  autoCheckUpdates: true,
  closeBehavior: null,
  lastStrategyProbe: null,
  onboardingCompleted: true,
  tgProxy: { running: false, installed: false, busy: false },
  lastAllUpdates: null,
  tgUpdateFromService: false
};

const ONBOARDING_STEPS = [
  {
    title: 'Добро пожаловать в Zapret HUB',
    text: 'Панель для обхода блокировок YouTube, Discord и прокси Telegram. Пройдём быструю настройку.',
    body: '<ul class="onboarding-step-list"><li>Подберём рабочую стратегию под ваш провайдер</li><li>Включим обход одним переключателем</li><li>При желании — TG Proxy и автозапуск</li></ul>'
  },
  {
    title: 'Шаг 1 — подбор стратегии',
    text: 'Стратегии отличаются способом обхода DPI. Лучше проверить, какая работает на вашем ПК.',
    action: 'probe'
  },
  {
    title: 'Шаг 2 — включите обход',
    text: 'После подбора примените лучшую стратегию и включите переключатель «ВКЛ» на главной.',
    action: 'power'
  },
  {
    title: 'Шаг 3 — TG Proxy (по желанию)',
    text: 'Локальный прокси для Telegram. При включении откроется Telegram с настройками — останется нажать «Применить».',
    action: 'tg'
  },
  {
    title: 'Шаг 4 — автозапуск (по желанию)',
    text: 'Можно включить автозапуск обхода и/или TG Proxy — программа стартует свёрнутой в трей.',
    action: 'autostart'
  },
  {
    title: 'Готово',
    text: 'Настройка завершена. Обновления HUB, движка и TG Proxy проверяются при каждом запуске.',
    action: 'done'
  }
];

let onboardingStep = 0;

let suppressStrategyChange = false;
let strategyProbeRunning = false;
let strategyProbeResult = null;

function getStrategyProbeStatus(row) {
  if (row.error) return { label: 'Ошибка', className: 'failed' };
  if (row.working) return { label: 'Работает', className: 'working' };
  if (row.httpOk > 0 || row.pingOk > 0) return { label: 'Частично', className: 'partial' };
  return { label: 'Не работает', className: 'failed' };
}

function formatStrategyProbeMeta(row) {
  const parts = [];
  parts.push(`HTTP ✓ ${row.httpOk}`);
  if (row.httpError > 0) parts.push(`HTTP ✗ ${row.httpError}`);
  if (row.httpUnsup > 0) parts.push(`неподдерж. ${row.httpUnsup}`);
  parts.push(`ping ✓ ${row.pingOk}`);
  if (row.pingFail > 0) parts.push(`ping ✗ ${row.pingFail}`);
  if (row.error) parts.push(row.error);
  return parts.join(' · ');
}

async function api(method, ...args) {
  const fn = window.zapretAPI?.[method];
  if (!fn) throw new Error('API недоступен');
  const result = await fn(...args);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

const NOTIFY_DISPLAY_MS = 4000;
const NOTIFY_FADE_MS = 300;
const NOTIFY_MAX_STACK = 4;

function formatEngineVersion(version) {
  if (!version || version === '—' || version === 'unknown') return '—';
  const normalized = String(version).trim().replace(/^\uFEFF/, '');
  const match = normalized.match(/^(\d+\.\d+\.\d+[a-z]*)$/i);
  return match ? match[1] : '—';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatUpdateVersion(version) {
  const normalized = String(version || '').trim().replace(/^\uFEFF/, '');
  const match = normalized.match(/^(\d+\.\d+\.\d+[a-z]*)$/i);
  if (match) return match[1];
  if (!normalized || normalized === 'unknown' || normalized === 'не установлен') return normalized || '—';
  return null;
}

const TOAST_OFF_MESSAGES = new Set([
  'Выключение обхода',
  'TG Proxy выключен'
]);

function toastKindForMessage(message, kind = 'success') {
  if (kind === 'off') return 'off';
  if (kind !== 'success' || !message) return kind;
  if (TOAST_OFF_MESSAGES.has(message)) return 'off';
  return kind;
}

function toast(message, kind = 'success') {
  const container = $('#toastContainer');
  if (!container || !message) return;

  while (container.children.length >= NOTIFY_MAX_STACK) {
    container.firstElementChild?.remove();
  }

  const resolvedKind = toastKindForMessage(message, kind);
  const el = document.createElement('div');
  el.className = `toast${resolvedKind && resolvedKind !== 'success' ? ` toast-${resolvedKind}` : ''}`;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.textContent = message;
  container.appendChild(el);

  const hide = () => {
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), NOTIFY_FADE_MS);
  };

  setTimeout(hide, NOTIFY_DISPLAY_MS);
}

function showTgDownloadProgress(percent, message) {
  const block = $('#tgProxyDownloadBlock');
  const fill = $('#tgProxyDownloadFill');
  const label = $('#tgProxyDownloadLabel');
  if (!block || !fill || !label) return;

  block.classList.remove('hidden');
  fill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  if (message) label.textContent = message;
}

function hideTgDownloadProgress() {
  const block = $('#tgProxyDownloadBlock');
  const fill = $('#tgProxyDownloadFill');
  if (!block || !fill) return;

  block.classList.add('hidden');
  fill.style.width = '0';
  $('#tgProxyDownloadLabel').textContent = 'Скачивание…';
}

function renderTgUpdateProgressInService(progress) {
  const el = $('#updateResult');
  if (!el) return;
  const percent = Math.max(0, Math.min(100, progress.percent || 0));
  el.innerHTML = `
    <div class="update-progress">
      <div class="update-progress-bar">
        <div class="update-progress-fill" style="width:${percent}%"></div>
      </div>
      <p class="update-progress-label">${escapeHtml(progress.message || 'Обновление TG Proxy...')}</p>
    </div>`;
}

async function refreshTgProxyState() {
  try {
    const status = await api('getTgProxyStatus');
    updateTgProxyUI(status);
    return status;
  } catch {
    return null;
  }
}

async function refreshServiceUpdateResults() {
  try {
    const all = await api('checkAllUpdates', { force: true });
    state.lastAllUpdates = all;
    const el = $('#updateResult');
    if (el && el.innerHTML.trim()) {
      renderUpdateCheckResults(all);
    }
    return all;
  } catch {
    return null;
  }
}

async function runTgProxyUpdateFlow(options = {}) {
  const { fromService = false, silent = false } = options;
  if (state.tgProxy.busy) return null;

  state.tgUpdateFromService = fromService;
  setTgProxyBusy(true);

  try {
    const result = await api('applyTgProxyUpdate');
    const status = await refreshTgProxyState();

    if (result.updated) {
      if (!silent) {
        toast(`TG Proxy обновлён до ${result.local || status?.local || 'новой версии'}`, 'success');
      }
      if (result.wasRunning) {
        toast('Перезапустите прокси, если он был активен', 'info');
      }
    } else if (!silent) {
      toast('Уже актуальная версия', 'success');
    }

    await refreshServiceUpdateResults();
    return { result, status };
  } catch (e) {
    hideTgDownloadProgress();
    toast(e.message, 'error');
    throw e;
  } finally {
    state.tgUpdateFromService = false;
    setTgProxyBusy(false);
  }
}

function showCloseChoiceModal() {
  $('#closeChoiceModal')?.classList.remove('hidden');
}

function hideCloseChoiceModal() {
  $('#closeChoiceModal')?.classList.add('hidden');
}

function showCloseRememberModal() {
  $('#closeRememberModal')?.classList.remove('hidden');
}

function hideCloseRememberModal() {
  $('#closeRememberModal')?.classList.add('hidden');
}

let confirmResolver = null;

function hideConfirmModal() {
  $('#confirmModal')?.classList.add('hidden');
}

function showConfirmModal({ title, text, confirmLabel = 'Удалить' }) {
  return new Promise((resolve) => {
    confirmResolver = resolve;
    $('#confirmModalTitle').textContent = title || 'Подтверждение';
    $('#confirmModalText').textContent = text || '';
    $('#btnConfirmOk').textContent = confirmLabel;
    $('#confirmModal')?.classList.remove('hidden');
  });
}

function resolveConfirmModal(confirmed) {
  if (!confirmResolver) return;
  const resolve = confirmResolver;
  confirmResolver = null;
  hideConfirmModal();
  resolve(confirmed);
}

function setupConfirmModal() {
  $('#btnConfirmCancel')?.addEventListener('click', () => resolveConfirmModal(false));
  $('#btnConfirmOk')?.addEventListener('click', () => resolveConfirmModal(true));
  $('#confirmModal')?.addEventListener('click', (e) => {
    if (e.target === $('#confirmModal')) resolveConfirmModal(false);
  });
}

function setupCloseModals() {
  const sendChoice = (choice) => {
    hideCloseChoiceModal();
    hideCloseRememberModal();
    window.zapretAPI.windowCloseChoice(choice);
  };

  $('#btnCloseToTray')?.addEventListener('click', () => sendChoice('tray'));

  $('#btnCloseQuit')?.addEventListener('click', () => {
    hideCloseChoiceModal();
    showCloseRememberModal();
  });

  $('#btnCloseRememberNo')?.addEventListener('click', () => sendChoice('quit'));
  $('#btnCloseRememberYes')?.addEventListener('click', () => sendChoice('quit-remember'));

  $('#closeChoiceModal')?.addEventListener('click', (e) => {
    if (e.target === $('#closeChoiceModal')) sendChoice('cancel');
  });

  $('#closeRememberModal')?.addEventListener('click', (e) => {
    if (e.target === $('#closeRememberModal')) {
      hideCloseRememberModal();
      showCloseChoiceModal();
    }
  });

  window.zapretAPI.onShowCloseDialog(() => {
    hideCloseRememberModal();
    showCloseChoiceModal();
  });
}

function setBusy(busy) {
  state.busy = busy;
  $('#btnPower').disabled = busy;
  updateStrategyProbeButton();
}

function playStatusAnimation(wasRunning, isRunning) {
  if (wasRunning === isRunning) return;
  const hero = $('#heroCard');
  hero.classList.remove('toggling-on', 'toggling-off');
  void hero.offsetWidth;
  hero.classList.add(isRunning ? 'toggling-on' : 'toggling-off');
  setTimeout(() => hero.classList.remove('toggling-on', 'toggling-off'), 1200);
}

function updateUI(status) {
  const wasRunning = state.running;
  state.running = status.running;

  const hero = $('#heroCard');
  const title = $('#statusTitle');
  const desc = $('#statusDesc');
  const mini = $('#statusMini');

  playStatusAnimation(wasRunning, status.running);

  if (status.running) {
    hero.classList.add('running');
    title.textContent = 'Работает';
    desc.textContent = 'Обход блокировок YouTube и Discord активен';
    mini.innerHTML = '<span class="status-dot on"></span><span>Работает</span>';
  } else {
    hero.classList.remove('running');
    title.textContent = 'Выключено';
    desc.textContent = 'Переключите переключатель, чтобы включить обход блокировок YouTube и Discord';
    mini.innerHTML = '<span class="status-dot off"></span><span>Выключено</span>';
  }

  $('#infoVersion').textContent = status.appVersion ? `v${status.appVersion}` : '—';
  const engineVersion = $('#engineVersion');
  if (engineVersion) engineVersion.textContent = formatEngineVersion(status.version);

  state.autoCheckUpdates = status.autoUpdate?.enabled !== false;
  state.closeBehavior = status.closeBehavior ?? null;
  state.lastStrategyProbe = status.lastStrategyProbe || null;
  state.onboardingCompleted = Boolean(status.onboardingCompleted);
  updateHomeControls(status);
  updateIpsetToggles(status);
  updateCloseBehaviorToggles(status.closeBehavior);
  updateAutoCheckUpdatesToggle(status);
  updateStrategyProbeBadge();
}

function updateHomeControls(status) {
  const gameToggle = $('#gameFilterToggle');
  const autostartZapretToggle = $('#autostartZapretToggle');
  const autostartTgToggle = $('#autostartTgToggle');
  if (gameToggle && !gameToggle.dataset.busy) {
    gameToggle.checked = Boolean(status.gameFilter?.enabled);
  }
  if (autostartZapretToggle && !autostartZapretToggle.dataset.busy) {
    autostartZapretToggle.checked = Boolean(status.autostartZapretEnabled);
  }
  if (autostartTgToggle && !autostartTgToggle.dataset.busy) {
    autostartTgToggle.checked = Boolean(status.autostartTgProxyEnabled);
  }
}

function updateIpsetToggles(status) {
  const ip = status.ipset?.status || 'loaded';
  $$('#ipsetGroup .toggle-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === ip);
  });
}

function updateShellForPage(page) {
  const isHome = page === 'home';
  $('.shell')?.classList.toggle('shell--home', isHome);
  document.body.classList.toggle('page-home', isHome);
}

function navigateTo(page) {
  $$('.nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.page === page);
  });
  $$('.page').forEach((p) => p.classList.remove('active'));
  $(`#page-${page}`)?.classList.add('active');
  updateShellForPage(page);
  hideHelpPopover();

  if (page === 'home') {
    refreshTgProxyState();
  }
}

function showRestartModal(message) {
  $('#restartModalText').textContent = message;
  $('#restartModal').classList.remove('hidden');
}

function hideRestartModal() {
  $('#restartModal').classList.add('hidden');
}

function notifyIfRestartNeeded(wasRunning, message) {
  if (wasRunning) {
    showRestartModal(message);
  } else {
    toast('Настройка сохранена', 'success');
  }
}

function sitesChangeNeedsAppRestart() {
  return state.running;
}

function showAppRestartModal() {
  $('#appRestartModal')?.classList.remove('hidden');
}

function hideAppRestartModal() {
  $('#appRestartModal')?.classList.add('hidden');
}

function notifySitesRestartIfNeeded() {
  if (sitesChangeNeedsAppRestart()) {
    showAppRestartModal();
  }
}

function renderStrategies(strategies, selectedFile) {
  const select = $('#strategySelect');
  select.innerHTML = '';

  for (const s of strategies) {
    const opt = document.createElement('option');
    opt.value = s.file;
    opt.textContent = s.name;
    if (s.file === selectedFile) opt.selected = true;
    select.appendChild(opt);
  }

  updateStrategyProbeButton();
  updateStrategyProbeBadge();
}

function updateStrategyProbeBadge() {
  const badge = $('#strategyProbeBadge');
  if (!badge) return;

  const probe = state.lastStrategyProbe;
  if (!probe?.strategyName) {
    badge.classList.add('hidden');
    badge.textContent = '';
    return;
  }

  const sitesPart = probe.sitesTotal
    ? `${probe.sitesOk}/${probe.sitesTotal} сайтов`
    : 'проверено';
  badge.textContent = `Рекомендовано: ${probe.strategyName}, ${sitesPart}`;
  badge.classList.toggle('partial', !probe.working);
  badge.classList.remove('hidden');
}

function updateStrategyProbeButton() {
  const btn = $('#btnStrategyProbe');
  const label = $('#btnStrategyProbeLabel');
  if (!btn) return;
  btn.disabled = state.busy || strategyProbeRunning || state.strategies.length <= 1;
  btn.classList.toggle('loading', strategyProbeRunning);
  if (label) {
    label.textContent = strategyProbeRunning
      ? 'Проверка стратегий…'
      : 'Подбор рабочей стратегии';
  }
}

let strategyProbeChoiceResolver = null;
let strategyProbePickResolver = null;

function hideStrategyProbeChoiceModal() {
  $('#strategyProbeChoiceModal')?.classList.add('hidden');
}

function showStrategyProbeChoiceModal() {
  return new Promise((resolve) => {
    strategyProbeChoiceResolver = resolve;
    $('#strategyProbeChoiceModal')?.classList.remove('hidden');
  });
}

function resolveStrategyProbeChoice(value) {
  if (!strategyProbeChoiceResolver) return;
  const resolve = strategyProbeChoiceResolver;
  strategyProbeChoiceResolver = null;
  hideStrategyProbeChoiceModal();
  resolve(value);
}

function hideStrategyProbePickModal() {
  $('#strategyProbePickModal')?.classList.add('hidden');
}

function showStrategyProbePickModal() {
  const list = $('#strategyProbePickList');
  if (!list) return Promise.resolve(null);

  list.innerHTML = '';
  for (const strategy of state.strategies) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'strategy-probe-pick-item';
    btn.innerHTML = `
      <span class="strategy-probe-pick-name">${strategy.name}</span>
      <span class="strategy-probe-pick-file">${strategy.file}</span>
    `;
    btn.addEventListener('click', () => resolveStrategyProbePick(strategy.file));
    list.appendChild(btn);
  }

  return new Promise((resolve) => {
    strategyProbePickResolver = resolve;
    $('#strategyProbePickModal')?.classList.remove('hidden');
  });
}

function resolveStrategyProbePick(file) {
  if (!strategyProbePickResolver) return;
  const resolve = strategyProbePickResolver;
  strategyProbePickResolver = null;
  hideStrategyProbePickModal();
  resolve(file);
}

function showStrategyProbeProgressModal() {
  updateStrategyProbeProgress({
    phase: 'start',
    message: 'Подготовка к проверке стратегий...',
    current: 0,
    total: 0,
    percent: 0
  });
  $('#strategyProbeProgressModal')?.classList.remove('hidden');
}

function hideStrategyProbeProgressModal() {
  $('#strategyProbeProgressModal')?.classList.add('hidden');
}

function updateStrategyProbeProgress(progress = {}) {
  const text = $('#strategyProbeProgressText');
  const fill = $('#strategyProbeProgressFill');
  const meta = $('#strategyProbeProgressMeta');
  const bar = $('#strategyProbeProgressBar');
  const spinner = $('#strategyProbeSpinner');
  const isDone = progress.phase === 'done';
  let percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
  if (!isDone) {
    percent = Math.min(percent, 99);
  }

  if (text) {
    text.textContent = progress.message || 'Проверяем стратегии...';
  }
  if (fill) {
    fill.style.width = `${percent}%`;
  }
  if (bar) {
    bar.classList.toggle('is-active', !isDone);
  }
  if (spinner) {
    spinner.classList.toggle('hidden', isDone);
  }
  if (meta) {
    if (progress.total > 0) {
      const stage = isDone ? progress.total : Math.min(progress.current || 0, progress.total);
      meta.textContent = `Этап ${stage} из ${progress.total}${progress.config ? ` · ${progress.config}` : ''}`;
    } else if (progress.config) {
      meta.textContent = progress.config;
    } else {
      meta.textContent = '';
    }
  }
}

function hideStrategyProbeModal() {
  $('#strategyProbeModal')?.classList.add('hidden');
}

function showStrategyProbeModal(result) {
  strategyProbeResult = result;
  const working = result.strategies.filter((row) => row.working);
  const summary = $('#strategyProbeSummary');
  const list = $('#strategyProbeList');
  const applyBtn = $('#btnStrategyProbeApply');
  const title = $('#strategyProbeResultTitle');
  const isSingle = result.mode === 'single' && result.strategies.length === 1;

  if (title) {
    title.textContent = isSingle ? 'Результат проверки' : 'Результаты проверки';
  }

  if (summary) {
    if (result.cancelled) {
      const checked = result.strategies.length;
      summary.textContent = checked
        ? `Проверка прервана. Показаны результаты ${checked} ${checked === 1 ? 'стратегии' : 'стратегий'}.`
        : 'Проверка прервана до получения результатов.';
    } else if (isSingle) {
      const row = result.strategies[0];
      const status = getStrategyProbeStatus(row);
      summary.textContent = row.error
        ? `${row.name}: ${row.error}`
        : status.className === 'working'
          ? `${row.name} подходит для вашего ПК.`
          : status.className === 'partial'
            ? `${row.name} работает частично — попробуйте другую стратегию.`
            : `${row.name} не прошла проверку. Попробуйте другую стратегию или обновите движок.`;
    } else if (working.length) {
      const best = result.strategies.find((row) => row.file === result.bestStrategy);
      summary.textContent = best
        ? `На вашем ПК подходят ${working.length} из ${result.strategies.length} стратегий. Лучший вариант: ${best.name}.`
        : `На вашем ПК подходят ${working.length} из ${result.strategies.length} стратегий.`;
    } else {
      summary.textContent = 'Ни одна стратегия не прошла проверку полностью. Попробуйте повторить тест или обновить движок.';
    }
  }

  if (list) {
    list.innerHTML = '';
    for (const row of result.strategies) {
      const status = getStrategyProbeStatus(row);
      const item = document.createElement('div');
      item.className = `strategy-probe-item ${status.className}${row.file === result.bestStrategy ? ' best' : ''}`;
      item.innerHTML = `
        <div>
          <div class="strategy-probe-name">${row.name}</div>
          <div class="strategy-probe-meta">${formatStrategyProbeMeta(row)}</div>
        </div>
        <div class="strategy-probe-status">${status.label}</div>
      `;
      list.appendChild(item);
    }
  }

  if (applyBtn) {
    applyBtn.disabled = !result.bestStrategy || !working.some((row) => row.file === result.bestStrategy);
  }

  $('#strategyProbeModal')?.classList.remove('hidden');
}

function setupStrategyProbeModal() {
  $('#btnStrategyProbeClose')?.addEventListener('click', hideStrategyProbeModal);
  $('#strategyProbeModal')?.addEventListener('click', (e) => {
    if (e.target === $('#strategyProbeModal')) hideStrategyProbeModal();
  });
  $('#btnStrategyProbeApply')?.addEventListener('click', async () => {
    if (!strategyProbeResult?.bestStrategy) return;
    hideStrategyProbeModal();
    suppressStrategyChange = true;
    $('#strategySelect').value = strategyProbeResult.bestStrategy;
    suppressStrategyChange = false;
    await applyStrategy(strategyProbeResult.bestStrategy);
  });

  $('#btnStrategyProbeAll')?.addEventListener('click', () => resolveStrategyProbeChoice('all'));
  $('#btnStrategyProbeCurrent')?.addEventListener('click', () => resolveStrategyProbeChoice('current'));
  $('#btnStrategyProbeOne')?.addEventListener('click', () => resolveStrategyProbeChoice('single'));
  $('#btnStrategyProbeChoiceCancel')?.addEventListener('click', () => resolveStrategyProbeChoice(null));
  $('#strategyProbeChoiceModal')?.addEventListener('click', (e) => {
    if (e.target === $('#strategyProbeChoiceModal')) resolveStrategyProbeChoice(null);
  });

  $('#btnStrategyProbePickCancel')?.addEventListener('click', () => resolveStrategyProbePick(null));
  $('#strategyProbePickModal')?.addEventListener('click', (e) => {
    if (e.target === $('#strategyProbePickModal')) resolveStrategyProbePick(null);
  });

  $('#btnStrategyProbeCancel')?.addEventListener('click', async () => {
    const btn = $('#btnStrategyProbeCancel');
    if (!strategyProbeRunning || !btn) return;
    btn.disabled = true;
    btn.textContent = 'Останавливаем…';
    try {
      await api('cancelStrategyProbe');
    } catch (e) {
      toast(e.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Прервать проверку';
    }
  });
}

async function runStrategyProbeFlow() {
  if (state.busy || strategyProbeRunning || state.strategies.length <= 1) return false;

  const choice = await showStrategyProbeChoiceModal();
  if (!choice) return false;

  const options = { mode: 'single' };
  if (choice === 'all') {
    options.mode = 'all';
    const confirmed = await showConfirmModal({
      title: 'Проверка всех стратегий',
      text: 'Будут проверены все доступные конфиги. Это может занять несколько минут. Продолжить?',
      confirmLabel: 'Начать проверку'
    });
    if (!confirmed) return false;
  } else if (choice === 'current') {
    const strategyFile = $('#strategySelect')?.value;
    if (!strategyFile) {
      toast('Сначала выберите стратегию', 'error');
      return false;
    }
    options.strategyFile = strategyFile;
  } else {
    const strategyFile = await showStrategyProbePickModal();
    if (!strategyFile) return false;
    options.strategyFile = strategyFile;
  }

  strategyProbeRunning = true;
  updateStrategyProbeButton();
  showStrategyProbeProgressModal();
  const cancelBtn = $('#btnStrategyProbeCancel');
  if (cancelBtn) {
    cancelBtn.disabled = false;
    cancelBtn.textContent = 'Прервать проверку';
  }

  try {
    const result = await api('runStrategyProbe', options);
    const status = await api('getStatus');
    state.lastStrategyProbe = status.lastStrategyProbe || null;
    updateUI(status);
    updateStrategyProbeBadge();
    hideStrategyProbeProgressModal();
    showStrategyProbeModal(result);
    if (result.cancelled) {
      toast('Проверка прервана', 'info');
    }
    return true;
  } catch (e) {
    hideStrategyProbeProgressModal();
    toast(e.message, 'error');
    return false;
  } finally {
    strategyProbeRunning = false;
    updateStrategyProbeButton();
  }
}

function updateTgProxyUI(status) {
  if (!status) return;
  state.tgProxy = { ...state.tgProxy, ...status };

  const badge = $('#tgProxyBadge');
  const toggle = $('#btnTgProxyToggle');
  const address = $('#tgProxyAddress');
  const version = $('#tgProxyVersion');
  const updateBlock = $('#tgProxyUpdateBlock');
  const updateText = $('#tgProxyUpdateText');

  if (status.running) {
    badge.textContent = 'Работает';
    badge.className = 'tg-proxy-badge on';
    toggle.textContent = 'Выключить прокси';
    toggle.classList.add('btn-danger');
  } else {
    badge.textContent = 'Выключен';
    badge.className = 'tg-proxy-badge off';
    toggle.textContent = status.installed ? 'Включить прокси' : 'Скачать и включить';
    toggle.classList.remove('btn-danger');
  }

  address.textContent = `${status.host || '127.0.0.1'}:${status.port || 1443}`;
  version.textContent = status.local
    ? (status.remote && status.updateAvailable ? `${status.local} → ${status.remote}` : status.local)
    : 'не установлен';

  toggle.disabled = state.tgProxy.busy;

  if (status.updateAvailable && status.remote) {
    updateBlock.classList.remove('hidden');
    updateText.textContent = `Доступна версия ${status.remote}`;
  } else {
    updateBlock.classList.add('hidden');
  }
}

function setTgProxyBusy(busy) {
  state.tgProxy.busy = busy;
  updateTgProxyUI(state.tgProxy);
}

async function applyStrategy(strategy, options = {}) {
  if (!strategy) return;

  try {
    await api('setStrategy', strategy);
    if (state.running) {
      setBusy(true);
      await api('restart', strategy);
      const status = await api('getStatus');
      updateUI(status);
      if (!options.silent) toast('Стратегия переключена', 'success');
      setBusy(false);
    } else if (!options.silent) {
      toast('Стратегия выбрана', 'success');
    }
  } catch (e) {
    toast(e.message, 'error');
    setBusy(false);
  }
}

function normalizeSiteInput(raw) {
  return raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

function updateSitesAccordion(accordionId, expanded) {
  const accordion = $(accordionId);
  const toggle = $(`${accordionId}Toggle`);
  if (!accordion || !toggle) return;

  accordion.classList.toggle('collapsed', !expanded);
  toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
}

function renderSiteItems({ sites, listEl, emptyEl, countEl, onRemove, allowEmpty = false, searchQuery = '' }) {
  if (!listEl) return;

  listEl.innerHTML = '';
  const query = String(searchQuery || '').trim().toLowerCase();
  const visibleSites = query
    ? sites.filter((site) => site.toLowerCase().includes(query))
    : sites;

  if (sites.length === 0) {
    if (emptyEl) emptyEl.hidden = false;
  } else {
    if (emptyEl) emptyEl.hidden = visibleSites.length > 0;
    for (const site of sites) {
      const item = document.createElement('div');
      item.className = 'site-item';
      if (query && !site.toLowerCase().includes(query)) {
        item.classList.add('hidden-by-search');
      }
      item.innerHTML = `
        <svg class="site-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <circle cx="12" cy="12" r="10"/>
          <path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/>
        </svg>
        <button class="site-item-remove" type="button">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>
            <path d="M10 11v6M14 11v6"/>
          </svg>
        </button>
      `;
      const domain = document.createElement('span');
      domain.className = 'site-item-domain';
      domain.title = site;
      domain.textContent = site;
      const removeBtn = item.querySelector('.site-item-remove');
      removeBtn.title = `Удалить ${site}`;
      removeBtn.setAttribute('aria-label', `Удалить ${site}`);
      item.insertBefore(domain, removeBtn);
      removeBtn.addEventListener('click', () => onRemove(site, item, allowEmpty));
      listEl.appendChild(item);
    }
  }

  if (countEl) {
    countEl.textContent = query ? `${visibleSites.length}/${sites.length}` : String(sites.length);
  }
}

function renderSites(sites) {
  state.sites = [...sites];
  renderSiteItems({
    sites,
    listEl: $('#sitesList'),
    emptyEl: $('#sitesEmpty'),
    countEl: $('#sitesCount'),
    onRemove: removeSite,
    allowEmpty: true,
    searchQuery: state.sitesSearchQuery
  });
  updateSitesAccordion('#sitesAccordion', state.sitesExpanded);
}

function renderCustomSites(sites) {
  state.customSites = [...sites];
  renderSiteItems({
    sites,
    listEl: $('#customSitesList'),
    emptyEl: $('#customSitesEmpty'),
    countEl: $('#customSitesCount'),
    onRemove: removeCustomSite,
    allowEmpty: true,
    searchQuery: state.customSitesSearchQuery
  });
  updateSitesAccordion('#customSitesAccordion', state.customSitesExpanded);
}

function renderCustomListUI() {
  const select = $('#customListSelect');
  const editor = $('#customListEditor');
  const placeholder = $('#customListPlaceholder');
  const deleteBtn = $('#btnDeleteCustomList');
  const createForm = $('#customListCreateForm');
  if (!select) return;

  const { lists, activeId } = state.customLists;
  const prevValue = state.customListEditing || select.value || '';

  select.innerHTML = '<option value="">Не использовать</option>';
  for (const list of lists) {
    const opt = document.createElement('option');
    opt.value = list.id;
    opt.textContent = `${list.name} (${list.count})`;
    select.appendChild(opt);
  }

  const activeValue = activeId || '';
  select.value = lists.some((l) => l.id === prevValue) ? prevValue : activeValue;
  state.customListEditing = select.value || null;

  const hasSelection = Boolean(state.customListEditing);
  if (editor) editor.hidden = !hasSelection;
  if (placeholder) {
    placeholder.hidden = hasSelection;
    placeholder.textContent = lists.length
      ? 'Выберите список в выпадающем меню или создайте новый'
      : 'Создайте список или выберите существующий';
  }
  if (deleteBtn) deleteBtn.hidden = !hasSelection;
  if (createForm) createForm.hidden = true;

  const label = $('#customSitesAccordionLabel');
  if (label && state.customListEditing) {
    label.textContent = `Домены: ${state.customListEditing}`;
  }
}

async function persistSites(options = {}) {
  if (state.sitesSaving) return state.sites;
  state.sitesSaving = true;

  try {
    const saved = await api('saveSites', state.sites);
    renderSites(saved);
    if (!options.silent) toast('Основной список сохранён', 'success');
    notifySitesRestartIfNeeded();
    return saved;
  } catch (e) {
    toast(e.message, 'error');
    throw e;
  } finally {
    state.sitesSaving = false;
  }
}

async function persistCustomSites(options = {}) {
  if (!state.customListEditing) return state.customSites;
  if (state.customSitesSaving) return state.customSites;
  state.customSitesSaving = true;

  try {
    const saved = await api('saveCustomListSites', state.customListEditing, state.customSites);
    renderCustomSites(saved);
    const meta = await api('getCustomLists');
    state.customLists = meta;
    renderCustomListUI();
    if (!options.silent) toast('Дополнительный список сохранён', 'success');
    notifySitesRestartIfNeeded();
    return saved;
  } catch (e) {
    toast(e.message, 'error');
    throw e;
  } finally {
    state.customSitesSaving = false;
  }
}

async function loadCustomLists() {
  const meta = await api('getCustomLists');
  state.customLists = meta;
  renderCustomListUI();

  if (state.customListEditing) {
    const sites = await api('getCustomListSites', state.customListEditing);
    renderCustomSites(sites);
  } else {
    renderCustomSites([]);
  }
}

async function addSite() {
  const input = $('#siteInput');
  const val = normalizeSiteInput(input.value);
  if (!val) return toast('Введите домен', 'error');
  if (state.sites.includes(val)) return toast('Уже в списке', 'info');

  state.sites.push(val);
  renderSites(state.sites);
  input.value = '';
  state.sitesExpanded = true;
  updateSitesAccordion('#sitesAccordion', state.sitesExpanded);

  try {
    await persistSites({ silent: true });
    toast(`Добавлен ${val}`, 'success');
  } catch {
    // persistSites already toasts error
  }
}

async function removeSite(site, itemEl) {
  if (state.sitesSaving) return;
  itemEl?.classList.add('removing');

  const next = state.sites.filter((s) => s !== site);
  state.sites = next;
  renderSites(state.sites);

  try {
    await persistSites({ silent: true });
    toast(`Удалён ${site}`, 'success');
  } catch {
    try {
      const sites = await api('getSites');
      renderSites(sites);
    } catch {
      // ignore
    }
  }
}

async function addCustomSite() {
  if (!state.customListEditing) return toast('Выберите список', 'error');
  const input = $('#customSiteInput');
  const val = normalizeSiteInput(input.value);
  if (!val) return toast('Введите домен', 'error');
  if (state.customSites.includes(val)) return toast('Уже в списке', 'info');

  state.customSites.push(val);
  renderCustomSites(state.customSites);
  input.value = '';
  state.customSitesExpanded = true;
  updateSitesAccordion('#customSitesAccordion', state.customSitesExpanded);

  try {
    await persistCustomSites({ silent: true });
    toast(`Добавлен ${val}`, 'success');
  } catch {
    // persistCustomSites already toasts error
  }
}

async function removeCustomSite(site, itemEl) {
  if (!state.customListEditing || state.customSitesSaving) return;
  itemEl?.classList.add('removing');

  state.customSites = state.customSites.filter((s) => s !== site);
  renderCustomSites(state.customSites);

  try {
    await persistCustomSites({ silent: true });
    toast(`Удалён ${site}`, 'success');
  } catch {
    try {
      const sites = await api('getCustomListSites', state.customListEditing);
      renderCustomSites(sites);
    } catch {
      // ignore
    }
  }
}

function showCustomListCreateForm(show) {
  const form = $('#customListCreateForm');
  const input = $('#customListNameInput');
  if (!form) return;
  form.hidden = !show;
  if (show) {
    input.value = '';
    input.focus();
  }
}

async function createCustomList(name) {
  const trimmed = name.trim();
  if (!trimmed) return toast('Введите название списка', 'error');

  const meta = await api('createCustomList', trimmed);
  state.customLists = { lists: meta.lists, activeId: meta.activeId };
  state.customListEditing = meta.createdId || null;

  renderCustomListUI();
  if (state.customListEditing) {
    $('#customListSelect').value = state.customListEditing;
    const sites = await api('getCustomListSites', state.customListEditing);
    renderCustomSites(sites);
  }
  toast(`Список «${trimmed}» создан`, 'success');
  notifySitesRestartIfNeeded();
}

async function onCustomListSelectChange() {
  const select = $('#customListSelect');
  const listId = select.value || null;
  state.customListEditing = listId;

  try {
    const meta = await api('setActiveCustomList', listId);
    state.customLists = meta;
    renderCustomListUI();

    if (listId) {
      const sites = await api('getCustomListSites', listId);
      renderCustomSites(sites);
      notifySitesRestartIfNeeded();
    } else {
      renderCustomSites([]);
    }
  } catch (e) {
    toast(e.message, 'error');
    await loadCustomLists();
  }
}

async function deleteSelectedCustomList() {
  if (!state.customListEditing) return;
  const id = state.customListEditing;
  const confirmed = await showConfirmModal({
    title: 'Удалить список?',
    text: `Список «${id}» и все его домены будут удалены без возможности восстановления.`,
    confirmLabel: 'Удалить'
  });
  if (!confirmed) return;

  try {
    const meta = await api('deleteCustomList', id);
    state.customLists = meta;
    state.customListEditing = null;
    renderCustomSites([]);
    renderCustomListUI();
    toast('Список удалён', 'success');
    notifySitesRestartIfNeeded();
  } catch (e) {
    toast(e.message, 'error');
  }
}

function renderDiagnostics(results) {
  const container = $('#diagResults');
  container.innerHTML = '';

  for (const r of results) {
    const item = document.createElement('div');
    item.className = 'diag-item';
    const severity = r.severity || (r.ok ? 'ok' : 'fail');
    const cls = severity === 'ok' ? 'diag-ok' : severity === 'warn' ? 'diag-warn' : 'diag-fail';
    const icon = severity === 'ok' ? '✓' : severity === 'warn' ? '!' : '✗';
    item.innerHTML = `<span class="${cls}">${icon}</span><span>${r.name}: ${r.message}</span>`;
    container.appendChild(item);
  }
}

function renderUpdateCheckResults(all) {
  const el = $('#updateResult');
  if (!el) return;

  state.lastAllUpdates = all;
  const rows = [all.hub, all.zapret, all.tg].filter(Boolean);
  el.innerHTML = rows.map((info) => {
    const label = escapeHtml(info.label || info.product || 'Компонент');
    if (info.error) {
      return `<div class="update-row"><span class="update-row-label">${label}</span><span class="diag-warn">Ошибка: ${escapeHtml(info.error)}</span></div>`;
    }
    const local = formatUpdateVersion(info.local) || 'неизвестно';
    const remote = formatUpdateVersion(info.remote);
    if (info.updateAvailable && remote) {
      const action = info.product === 'hub'
        ? `<button class="btn btn-ghost btn-sm update-row-action" type="button" data-update="hub">Обновить</button>`
        : info.product === 'zapret'
          ? `<button class="btn btn-ghost btn-sm update-row-action" type="button" data-update="zapret">Обновить</button>`
          : `<button class="btn btn-ghost btn-sm update-row-action" type="button" data-update="tg">Обновить</button>`;
      return `<div class="update-row"><span class="update-row-label">${label}</span><span class="diag-warn">Доступна ${escapeHtml(remote)} (у вас ${escapeHtml(local)})</span>${action}</div>`;
    }
    if (info.updateAvailable && !remote) {
      return `<div class="update-row"><span class="update-row-label">${label}</span><span class="diag-warn">Доступно обновление, но версия не распознана</span></div>`;
    }
    return `<div class="update-row"><span class="update-row-label">${label}</span><span class="diag-ok">✓ Актуально (${escapeHtml(local)})</span></div>`;
  }).join('');

  el.querySelector('[data-update="hub"]')?.addEventListener('click', () => {
    runHubUpdate(all.hub);
  });

  el.querySelector('[data-update="zapret"]')?.addEventListener('click', () => {
    showUpdateModal(all.zapret);
  });

  el.querySelector('[data-update="tg"]')?.addEventListener('click', () => {
    runTgProxyUpdateFlow({ fromService: true });
  });
}

function renderHubUpdateProgress(progress) {
  const el = $('#updateResult');
  if (!el) return;
  const percent = Math.max(0, Math.min(100, progress.percent || 0));
  el.innerHTML = `
    <div class="update-progress">
      <div class="update-progress-bar">
        <div class="update-progress-fill" style="width:${percent}%"></div>
      </div>
      <p class="update-progress-label">${escapeHtml(progress.message || 'Обновление Zapret HUB...')}</p>
    </div>`;
}

async function runHubUpdate(info) {
  if (!info || state.hubUpdating) return;
  state.hubUpdating = true;
  renderHubUpdateProgress({ percent: 0, message: 'Подготовка к обновлению HUB...' });

  try {
    await api('applyHubUpdate');
  } catch (e) {
    state.hubUpdating = false;
    toast(e.message, 'error');
    try {
      renderUpdateCheckResults(await api('checkAllUpdates', { force: true }));
    } catch {
      // ignore
    }
  }
}

function getPendingUpdateItems(all) {
  if (!all) return [];
  return [all.hub, all.zapret, all.tg].filter((info) => info?.updateAvailable && !info?.error);
}

function renderStartupUpdatesList(all) {
  const el = $('#startupUpdatesList');
  if (!el) return;

  const rows = getPendingUpdateItems(all);
  el.innerHTML = rows.map((info) => {
    const label = info.label || info.product || 'Компонент';
    return `<div class="update-row">
      <span class="update-row-label">${label}</span>
      <span class="diag-warn">${info.local} → ${info.remote}</span>
    </div>`;
  }).join('');
}

function setStartupUpdatesProgress(progress) {
  $('#startupUpdatesProgress')?.classList.remove('hidden');
  $('#startupUpdatesActions')?.classList.add('hidden');
  const percent = Math.max(0, Math.min(100, progress.percent || 0));
  const fill = $('#startupUpdatesProgressFill');
  if (fill) fill.style.width = `${percent}%`;
  const label = $('#startupUpdatesProgressLabel');
  if (label) label.textContent = progress.message || 'Обновление...';
}

function hideStartupUpdatesModal() {
  $('#startupUpdatesModal')?.classList.add('hidden');
  $('#startupUpdatesProgress')?.classList.add('hidden');
  $('#startupUpdatesActions')?.classList.remove('hidden');
  const fill = $('#startupUpdatesProgressFill');
  if (fill) fill.style.width = '0%';
  state.pendingStartupUpdates = null;
  state.startupUpdating = false;
}

function showStartupUpdatesModal(all) {
  const rows = getPendingUpdateItems(all);
  if (!rows.length) return;

  state.pendingStartupUpdates = all;
  renderStartupUpdatesList(all);

  const hasHub = Boolean(all.hub?.updateAvailable && !all.hub?.error);
  const hasAuto = Boolean(
    (all.zapret?.updateAvailable && !all.zapret?.error)
    || (all.tg?.updateAvailable && !all.tg?.error)
  );
  const btnAll = $('#btnStartupUpdateAll');
  if (btnAll) {
    if (hasHub && hasAuto) btnAll.textContent = 'Обновить всё';
    else if (hasHub) btnAll.textContent = 'Обновить HUB';
    else btnAll.textContent = 'Обновить автоматически';
  }

  $('#startupUpdatesText').textContent = rows.length === 1
    ? 'При запуске найдена новая версия одного компонента.'
    : `При запуске найдены новые версии ${rows.length} компонентов.`;

  $('#startupUpdatesProgress')?.classList.add('hidden');
  $('#startupUpdatesActions')?.classList.remove('hidden');
  $('#startupUpdatesModal')?.classList.remove('hidden');
}

async function runStartupUpdateAll(all) {
  if (!all || state.startupUpdating) return;
  state.startupUpdating = true;
  setStartupUpdatesProgress({ percent: 0, message: 'Подготовка к обновлению...' });

  try {
    if (all.zapret?.updateAvailable && !all.zapret?.error) {
      setStartupUpdatesProgress({ percent: 10, message: `Обновление движка до ${all.zapret.remote}...` });
      const result = await api('applyUpdate', all.zapret.remote);
      const status = await api('getStatus');
      updateUI(status);
      state.strategies = await api('getStrategies');
      renderStrategies(state.strategies, status.lastStrategy || 'general.bat');
      toast(`Движок обновлён до ${result.local}`, 'success');
    }

    if (all.tg?.updateAvailable && !all.tg?.error) {
      setStartupUpdatesProgress({ percent: 55, message: `Обновление TG Proxy до ${all.tg.remote}...` });
      const tgResult = await runTgProxyUpdateFlow({ silent: true });
      if (tgResult?.result?.updated) {
        toast(`TG Proxy обновлён до ${tgResult.result.local || all.tg.remote}`, 'success');
      }
    }

    if (all.hub?.updateAvailable && !all.hub?.error) {
      setStartupUpdatesProgress({ percent: 85, message: `Обновление Zapret HUB до ${all.hub.remote}...` });
      await api('applyHubUpdate');
    }

    hideStartupUpdatesModal();
    const el = $('#updateResult');
    if (el) {
      try {
        renderUpdateCheckResults(await api('checkAllUpdates', { force: true }));
      } catch {
        el.innerHTML = '<span class="diag-ok">✓ Обновления установлены</span>';
      }
    }
  } catch (e) {
    state.startupUpdating = false;
    $('#startupUpdatesActions')?.classList.remove('hidden');
    toast(e.message, 'error');
  }
}

function setupStartupUpdatesModal() {
  $('#btnStartupUpdateLater')?.addEventListener('click', hideStartupUpdatesModal);
  $('#btnStartupUpdateAll')?.addEventListener('click', () => {
    if (state.pendingStartupUpdates) {
      runStartupUpdateAll(state.pendingStartupUpdates);
    }
  });
  $('#startupUpdatesModal')?.addEventListener('click', (e) => {
    if (e.target === $('#startupUpdatesModal') && !state.startupUpdating) {
      hideStartupUpdatesModal();
    }
  });

  window.zapretAPI.onHubUpdateProgress?.((progress) => {
    if (state.startupUpdating) {
      setStartupUpdatesProgress(progress);
      return;
    }
    if (state.hubUpdating) {
      renderHubUpdateProgress(progress);
    }
  });
}

function showUpdateModal(info, options = {}) {
  state.pendingUpdate = info;
  state.updateContext = options.context || 'manual';
  state.pendingStartStrategy = options.strategy || null;

  const beforeStart = state.updateContext === 'beforeStart';
  const onStartup = state.updateContext === 'startup';
  $('#updateModalText').textContent = beforeStart
    ? `Перед запуском рекомендуем обновить Zapret: доступна версия ${info.remote} (у вас ${info.local}).`
    : `Доступна версия ${info.remote}. У вас установлена ${info.local}. Обновить автоматически?`;

  $('#btnUpdateLater').textContent = beforeStart ? 'Запустить без обновления' : 'Позже';
  if (onStartup) {
    $('#updateModalText').textContent =
      `Вышла новая версия ${info.remote}. У вас установлена ${info.local}. Обновить автоматически?`;
  }
  $('#btnUpdateNow').textContent = 'Обновить';
  $('#updateProgressBlock').classList.add('hidden');
  $('#updateModalActions').classList.remove('hidden');
  $('#updateProgressFill').style.width = '0%';
  $('#updateProgressLabel').textContent = 'Подготовка...';
  $('#updateModal').classList.remove('hidden');
}

function hideUpdateModal() {
  $('#updateModal').classList.add('hidden');
  state.pendingUpdate = null;
  state.updating = false;
  state.updateContext = 'manual';
  state.pendingStartStrategy = null;
}

function setUpdateProgress(progress) {
  $('#updateProgressBlock').classList.remove('hidden');
  $('#updateModalActions').classList.add('hidden');
  const percent = Math.max(0, Math.min(100, progress.percent || 0));
  $('#updateProgressFill').style.width = `${percent}%`;
  $('#updateProgressLabel').textContent = progress.message || 'Обновление...';
}

async function runUpdate(info) {
  if (!info?.remote || state.updating) return;
  state.updating = true;
  setUpdateProgress({ percent: 0, message: 'Подготовка к обновлению...' });

  try {
    const result = await api('applyUpdate', info.remote);
    const status = await api('getStatus');
    updateUI(status);
    state.strategies = await api('getStrategies');
    renderStrategies(state.strategies, status.lastStrategy || 'general.bat');
    hideUpdateModal();
    toast(`Zapret обновлён до ${result.local}`, 'success');
    const el = $('#updateResult');
    if (el) {
      el.innerHTML = `<span class="diag-ok">✓ Установлена актуальная версия (${result.local})</span>`;
    }
  } catch (e) {
    state.updating = false;
    $('#updateModalActions').classList.remove('hidden');
    toast(e.message, 'error');
  }
}

async function startZapret(strategy) {
  await api('start', strategy);
  const status = await api('getStatus');
  updateUI(status);
}

function setupRestartModal() {
  $('#btnRestartOk')?.addEventListener('click', hideRestartModal);
  $('#restartModal')?.addEventListener('click', (e) => {
    if (e.target === $('#restartModal')) hideRestartModal();
  });
}

function setupAppRestartModal() {
  $('#btnAppRestartLater')?.addEventListener('click', hideAppRestartModal);
  $('#btnAppRestartNow')?.addEventListener('click', async () => {
    hideAppRestartModal();
    try {
      await api('relaunchApp');
    } catch (e) {
      toast(e.message, 'error');
    }
  });
  $('#appRestartModal')?.addEventListener('click', (e) => {
    if (e.target === $('#appRestartModal')) hideAppRestartModal();
  });
}

function setupUpdateModal() {
  $('#btnUpdateLater')?.addEventListener('click', async () => {
    const strategy = state.pendingStartStrategy;
    const beforeStart = state.updateContext === 'beforeStart';
    hideUpdateModal();
    if (!beforeStart || !strategy) return;

    setBusy(true);
    try {
      await startZapret(strategy);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  });

  $('#btnUpdateNow')?.addEventListener('click', () => {
    if (state.pendingUpdate) runUpdate(state.pendingUpdate);
  });

  window.zapretAPI.onUpdateProgress((progress) => {
    if (progress.phase === 'done') {
      setTimeout(hideUpdateModal, 500);
      return;
    }

    if ($('#updateModal').classList.contains('hidden')) {
      $('#updateModalText').textContent = 'Устанавливаем обновление Zapret...';
      $('#updateModal').classList.remove('hidden');
      $('#updateModalActions').classList.add('hidden');
      $('#updateProgressBlock').classList.remove('hidden');
    }
    setUpdateProgress(progress);
  });
}

function setupNavigation() {
  $$('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      navigateTo(btn.dataset.page);
    });
  });
}

let activeHelpBtn = null;

function hideHelpPopover() {
  const popover = $('#helpPopover');
  popover.classList.add('hidden');
  if (activeHelpBtn) {
    activeHelpBtn.classList.remove('active');
    activeHelpBtn = null;
  }
}

function showHelpPopover(key, anchor) {
  const help = HELP_TEXTS[key];
  if (!help) return;

  if (activeHelpBtn && activeHelpBtn !== anchor) {
    activeHelpBtn.classList.remove('active');
  }

  const popover = $('#helpPopover');
  $('#helpPopoverTitle').textContent = help.title;
  $('#helpPopoverBody').innerHTML = help.body;

  popover.classList.remove('hidden');

  const rect = anchor.getBoundingClientRect();
  const popRect = popover.getBoundingClientRect();
  const margin = 12;
  let top = rect.bottom + 8;
  let left = rect.left + rect.width / 2 - popRect.width / 2;

  if (left < margin) left = margin;
  if (left + popRect.width > window.innerWidth - margin) {
    left = window.innerWidth - popRect.width - margin;
  }
  if (top + popRect.height > window.innerHeight - margin) {
    top = rect.top - popRect.height - 8;
  }

  popover.style.top = `${Math.max(margin, top)}px`;
  popover.style.left = `${left}px`;

  anchor.classList.add('active');
  activeHelpBtn = anchor;
}

function updateCloseBehaviorToggles(mode) {
  const value = mode || 'ask';
  $$('#closeBehaviorGroup .toggle-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === value);
  });
}

function updateAutoCheckUpdatesToggle(status) {
  const toggle = $('#autoCheckUpdatesToggle');
  if (!toggle || toggle.dataset.busy) return;
  toggle.checked = status.autoUpdate?.enabled !== false;
}

async function importSitesFromDialog({ listId = null } = {}) {
  const mode = await showConfirmModal({
    title: 'Импорт доменов',
    text: 'Добавить домены к существующим или заменить список целиком?',
    confirmLabel: 'Заменить список'
  }) ? 'replace' : 'merge';

  const result = await api('importSitesDialog', { listId, mode });
  if (!result.imported) return;

  if (listId) {
    renderCustomSites(result.sites);
    const meta = await api('getCustomLists');
    state.customLists = meta;
    renderCustomListUI();
  } else {
    renderSites(result.sites);
  }

  notifySitesRestartIfNeeded();
  toast(`Импортировано ${result.sites.length} доменов`, 'success');
}

async function exportSitesToDialog({ listId = null, defaultName = 'list-general.txt' } = {}) {
  const result = await api('exportSitesDialog', { listId, defaultName });
  if (!result.saved) return;
  toast(`Экспортировано ${result.count} доменов`, 'success');
}

async function pasteSitesFromClipboard({ listId = null } = {}) {
  let text = '';
  try {
    text = await api('readClipboardText');
  } catch {
    if (navigator.clipboard?.readText) {
      text = await navigator.clipboard.readText();
    }
  }

  if (!text?.trim()) return toast('Буфер обмена пуст', 'info');

  const lines = text.trim().split(/\r?\n/).filter(Boolean).length;
  const mode = await showConfirmModal({
    title: 'Вставка из буфера',
    text: `Найдено ${lines} строк. Добавить к списку или заменить целиком?`,
    confirmLabel: 'Заменить список'
  }) ? 'replace' : 'merge';

  const result = await api('importSitesText', { text, listId, mode });
  if (listId) {
    renderCustomSites(result.sites);
    const meta = await api('getCustomLists');
    state.customLists = meta;
    renderCustomListUI();
  } else {
    renderSites(result.sites);
  }

  notifySitesRestartIfNeeded();
  toast(`Добавлено из буфера: ${result.sites.length} доменов`, 'success');
}

function showBypassDropModal(payload = {}) {
  const text = $('#bypassDropText');
  if (text) {
    const strategy = payload.lastStrategy || state.strategies.find((s) => s.file === payload.lastStrategy)?.name;
    text.textContent = strategy
      ? `Обход (${strategy}) неожиданно остановился. Включите снова или подберите другую стратегию.`
      : 'Процесс winws.exe завершился неожиданно. Попробуйте включить обход снова или сменить стратегию.';
  }
  $('#bypassDropModal')?.classList.remove('hidden');
}

function hideBypassDropModal() {
  $('#bypassDropModal')?.classList.add('hidden');
}

function setupBypassDropModal() {
  $('#btnBypassDropClose')?.addEventListener('click', hideBypassDropModal);
  $('#btnBypassDropRestart')?.addEventListener('click', async () => {
    hideBypassDropModal();
    $('#btnPower')?.click();
  });
  $('#bypassDropModal')?.addEventListener('click', (e) => {
    if (e.target === $('#bypassDropModal')) hideBypassDropModal();
  });
}

function renderOnboardingStep() {
  const step = ONBOARDING_STEPS[onboardingStep];
  if (!step) return;

  $('#onboardingTitle').textContent = step.title;
  $('#onboardingText').textContent = step.text;

  const body = $('#onboardingBody');
  if (body) {
    let html = step.body || '';
    if (step.action === 'probe') {
      html = '<div class="onboarding-highlight">Нажмите «Запустить подбор» — откроется проверка стратегий.</div>';
    } else if (step.action === 'power') {
      html = '<div class="onboarding-highlight">Переключатель ВКЛ/ВЫКЛ — в центре главной страницы.</div>';
    } else if (step.action === 'tg') {
      html = '<div class="onboarding-highlight">Карточка «Прокси для Telegram» на главной. Telegram откроется сам.</div>';
    } else if (step.action === 'autostart') {
      html = '<div class="onboarding-highlight">Тумблеры автозапуска — внизу главной страницы.</div>';
    }
    body.innerHTML = html;
  }

  const progress = $('#onboardingProgress');
  if (progress) {
    progress.innerHTML = ONBOARDING_STEPS.map((_, index) => {
      const cls = index === onboardingStep ? 'active' : index < onboardingStep ? 'done' : '';
      return `<span class="onboarding-dot ${cls}"></span>`;
    }).join('');
  }

  const nextBtn = $('#btnOnboardingNext');
  if (nextBtn) {
    if (step.action === 'probe') nextBtn.textContent = 'Запустить подбор';
    else if (step.action === 'done') nextBtn.textContent = 'Завершить';
    else nextBtn.textContent = 'Далее';
  }
}

function openOnboardingModal() {
  renderOnboardingStep();
  $('#onboardingModal')?.classList.remove('hidden');
}

function startOnboarding() {
  onboardingStep = 0;
  openOnboardingModal();
}

function hideOnboardingModal() {
  $('#onboardingModal')?.classList.add('hidden');
}

async function completeOnboarding() {
  await api('setOnboardingCompleted', true);
  state.onboardingCompleted = true;
  hideOnboardingModal();
}

function advanceOnboardingStep() {
  if (onboardingStep >= ONBOARDING_STEPS.length - 1) {
    completeOnboarding();
    return;
  }
  onboardingStep += 1;
  renderOnboardingStep();
}

function skipOnboardingStep() {
  advanceOnboardingStep();
}

async function handleOnboardingNext() {
  const step = ONBOARDING_STEPS[onboardingStep];
  if (!step) return;

  if (step.action === 'probe') {
    hideOnboardingModal();
    const completed = await runStrategyProbeFlow();
    if (completed) onboardingStep += 1;
    openOnboardingModal();
    return;
  }

  if (step.action === 'power') {
    hideOnboardingModal();
    navigateTo('home');
    $('#heroCard')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    onboardingStep += 1;
    setTimeout(openOnboardingModal, 400);
    return;
  }

  if (step.action === 'tg' || step.action === 'autostart') {
    hideOnboardingModal();
    navigateTo('home');
    onboardingStep += 1;
    setTimeout(openOnboardingModal, 300);
    return;
  }

  if (onboardingStep >= ONBOARDING_STEPS.length - 1) {
    await completeOnboarding();
    return;
  }

  onboardingStep += 1;
  renderOnboardingStep();
}

function setupOnboardingModal() {
  $('#btnOnboardingClose')?.addEventListener('click', () => completeOnboarding());
  $('#btnOnboardingSkip')?.addEventListener('click', () => skipOnboardingStep());
  $('#btnOnboardingNext')?.addEventListener('click', () => handleOnboardingNext());
}

function setupSitesTools() {
  $('#sitesSearch')?.addEventListener('input', (e) => {
    state.sitesSearchQuery = e.target.value;
    renderSites(state.sites);
  });

  $('#customSitesSearch')?.addEventListener('input', (e) => {
    state.customSitesSearchQuery = e.target.value;
    renderCustomSites(state.customSites);
  });

  $('#btnSitesImport')?.addEventListener('click', () => importSitesFromDialog());
  $('#btnSitesExport')?.addEventListener('click', () => exportSitesToDialog());
  $('#btnSitesPaste')?.addEventListener('click', () => pasteSitesFromClipboard());

  $('#btnCustomSitesImport')?.addEventListener('click', () => {
    if (!state.customListEditing) return toast('Выберите список', 'error');
    importSitesFromDialog({ listId: state.customListEditing });
  });
  $('#btnCustomSitesExport')?.addEventListener('click', () => {
    if (!state.customListEditing) return toast('Выберите список', 'error');
    exportSitesToDialog({
      listId: state.customListEditing,
      defaultName: `${state.customListEditing}.txt`
    });
  });
  $('#btnCustomSitesPaste')?.addEventListener('click', () => {
    if (!state.customListEditing) return toast('Выберите список', 'error');
    pasteSitesFromClipboard({ listId: state.customListEditing });
  });
}

function setupBehaviorSettings() {
  $$('#closeBehaviorGroup .toggle-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const value = btn.dataset.value;
      const mode = value === 'ask' ? null : value;
      try {
        const result = await api('setCloseBehavior', mode);
        state.closeBehavior = result.closeBehavior ?? null;
        updateCloseBehaviorToggles(state.closeBehavior);
        toast('Настройка сохранена', 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  });

  $('#autoCheckUpdatesToggle')?.addEventListener('change', async (e) => {
    const toggle = e.target;
    toggle.dataset.busy = '1';
    toggle.disabled = true;
    try {
      await api('setAutoUpdate', toggle.checked);
      const status = await api('getStatus');
      updateUI(status);
      toast(toggle.checked ? 'Автопроверка обновлений включена' : 'Автопроверка обновлений выключена', 'success');
    } catch (err) {
      toggle.checked = !toggle.checked;
      toast(err.message, 'error');
    } finally {
      delete toggle.dataset.busy;
      toggle.disabled = false;
    }
  });
}

function setupHelpTooltips() {
  $$('.help-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = btn.dataset.help;
      if (activeHelpBtn === btn && !$('#helpPopover').classList.contains('hidden')) {
        hideHelpPopover();
        return;
      }
      showHelpPopover(key, btn);
    });
  });

  $('#helpPopoverClose').addEventListener('click', hideHelpPopover);

  document.addEventListener('click', (e) => {
    if (e.target.closest('.help-btn') || e.target.closest('#helpPopover')) return;
    hideHelpPopover();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideHelpPopover();
  });
}

async function init() {
  updateShellForPage('home');
  setupNavigation();
  setupHelpTooltips();
  setupRestartModal();
  setupAppRestartModal();
  setupUpdateModal();
  setupStartupUpdatesModal();
  setupCloseModals();
  setupConfirmModal();
  setupStrategyProbeModal();
  setupBypassDropModal();
  setupOnboardingModal();
  setupSitesTools();
  setupBehaviorSettings();

  window.zapretAPI.onStrategyProbeProgress?.((progress) => {
    if (!strategyProbeRunning || !progress) return;
    updateStrategyProbeProgress(progress);
  });

  try {
    const pathCheck = await api('validatePath');
    if (!pathCheck.valid) {
      toast('Папка Zapret не найдена — проверьте установку движка', 'error');
    }

    state.strategies = await api('getStrategies');
    const status = await api('getStatus');
    const selected = status.lastStrategy || 'general.bat';
    renderStrategies(state.strategies, selected);
    updateUI(status);

    const sites = await api('getSites');
    renderSites(sites);
    await loadCustomLists();

    const tgStatus = await api('getTgProxyStatus');
    updateTgProxyUI(tgStatus);

    if (!status.onboardingCompleted) {
      setTimeout(startOnboarding, 600);
    }
  } catch (e) {
    toast(e.message, 'error');
  }

  $('#strategySelect').addEventListener('change', async () => {
    if (state.busy || suppressStrategyChange) return;
    await applyStrategy($('#strategySelect').value);
  });

  $('#btnStrategyProbe')?.addEventListener('click', () => {
    runStrategyProbeFlow();
  });

  $('#btnPower').addEventListener('click', async () => {
    if (state.busy) return;
    setBusy(true);
    try {
      if (state.running) {
        const status = await api('stop');
        updateUI(status);
        if (status.running) {
          toast('Не удалось выключить Zapret — проверьте права администратора', 'error');
        }
      } else {
        const strategy = $('#strategySelect').value;
        if (state.autoCheckUpdates) {
          const info = await api('checkUpdates');
          if (info.updateAvailable && !info.error) {
            setBusy(false);
            showUpdateModal(info, { context: 'beforeStart', strategy });
            return;
          }
        }
        await startZapret(strategy);
      }
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  });

  $('#sitesAddForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    addSite();
  });

  $('#sitesAccordionToggle')?.addEventListener('click', () => {
    state.sitesExpanded = !state.sitesExpanded;
    updateSitesAccordion('#sitesAccordion', state.sitesExpanded);
  });

  $('#customSitesAccordionToggle')?.addEventListener('click', () => {
    state.customSitesExpanded = !state.customSitesExpanded;
    updateSitesAccordion('#customSitesAccordion', state.customSitesExpanded);
  });

  $('#customListSelect')?.addEventListener('change', () => onCustomListSelectChange());

  $('#btnCreateCustomList')?.addEventListener('click', () => showCustomListCreateForm(true));

  $('#btnCancelCustomList')?.addEventListener('click', () => showCustomListCreateForm(false));

  $('#customListCreateForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await createCustomList($('#customListNameInput').value);
      showCustomListCreateForm(false);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#customSitesAddForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    addCustomSite();
  });

  $('#btnDeleteCustomList')?.addEventListener('click', () => deleteSelectedCustomList());

  $('#gameFilterToggle')?.addEventListener('change', async (e) => {
    const toggle = e.target;
    const mode = toggle.checked ? 'all' : 'disabled';
    const wasRunning = state.running;
    toggle.dataset.busy = '1';
    toggle.disabled = true;

    try {
      await api('setGameFilter', mode);
      const status = await api('getStatus');
      updateUI(status);
      notifyIfRestartNeeded(
        wasRunning,
        'Игровой фильтр изменён. Чтобы настройка вступила в силу, выключите и снова включите Zapret.'
      );
    } catch (err) {
      toggle.checked = !toggle.checked;
      toast(err.message, 'error');
    } finally {
      delete toggle.dataset.busy;
      toggle.disabled = false;
    }
  });

  function bindAutostartToggle(selector, apiMethod, onLabel, offLabel) {
    $(selector)?.addEventListener('change', async (e) => {
      const toggle = e.target;
      const enabled = toggle.checked;
      toggle.dataset.busy = '1';
      toggle.disabled = true;

      try {
        const status = await api(apiMethod, enabled);
        updateUI(status);
        toast(enabled ? onLabel : offLabel, 'success');
      } catch (err) {
        toggle.checked = !toggle.checked;
        toast(err.message, 'error');
      } finally {
        delete toggle.dataset.busy;
        toggle.disabled = false;
      }
    });
  }

  bindAutostartToggle(
    '#autostartZapretToggle',
    'setAutostartZapret',
    'Автозапуск обхода включён',
    'Автозапуск обхода выключен'
  );
  bindAutostartToggle(
    '#autostartTgToggle',
    'setAutostartTg',
    'Автозапуск TG Proxy включён',
    'Автозапуск TG Proxy выключен'
  );

  $$('#ipsetGroup .toggle-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const wasRunning = state.running;
      try {
        await api('setIpset', btn.dataset.value);
        const status = await api('getStatus');
        updateUI(status);
        notifyIfRestartNeeded(
          wasRunning,
          'IPSet изменён. Чтобы настройка вступила в силу, выключите и снова включите Zapret.'
        );
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });

  $('#btnDiagnostics').addEventListener('click', async () => {
    $('#btnDiagnostics').disabled = true;
    try {
      const results = await api('runDiagnostics');
      renderDiagnostics(results);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      $('#btnDiagnostics').disabled = false;
    }
  });

  $('#btnCheckUpdates').addEventListener('click', async () => {
    $('#btnCheckUpdates').disabled = true;
    const el = $('#updateResult');
    el.innerHTML = '<span style="color:var(--text-muted)">Проверяем Zapret HUB, движок и TG Proxy...</span>';
    try {
      const all = await api('checkAllUpdates', { force: true });
      renderUpdateCheckResults(all);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      $('#btnCheckUpdates').disabled = false;
    }
  });

  $('#linkGithub').addEventListener('click', (e) => {
    e.preventDefault();
    api('openExternal', 'https://github.com/Flowseal/zapret-discord-youtube');
  });

  $('#linkTgGithub')?.addEventListener('click', (e) => {
    e.preventDefault();
    api('openExternal', 'https://github.com/Flowseal/tg-ws-proxy');
  });

  $('#btnTgProxyToggle')?.addEventListener('click', async () => {
    if (state.tgProxy.busy) return;
    setTgProxyBusy(true);
    try {
      if (state.tgProxy.running) {
        const status = await api('stopTgProxy');
        updateTgProxyUI(status);
        if (!status.running) {
          toast('TG Proxy выключен', 'off');
        }
      } else {
        const status = await api('startTgProxy');
        updateTgProxyUI(status);
        await refreshServiceUpdateResults();
        if (!status.running) {
          toast('Не удалось запустить прокси', 'error');
        } else {
          try {
            await api('openTgProxyTelegram');
          } catch {
            // Telegram may be unavailable
          }
          toast('TG Proxy включён — примените настройки в Telegram', 'success');
        }
      }
    } catch (e) {
      hideTgDownloadProgress();
      toast(e.message, 'error');
    } finally {
      setTgProxyBusy(false);
    }
  });

  $('#btnTgProxyUpdate')?.addEventListener('click', () => {
    runTgProxyUpdateFlow();
  });

  window.zapretAPI.onTgProxyProgress((progress) => {
    if (!progress) return;

    if (state.tgUpdateFromService) {
      renderTgUpdateProgressInService(progress);
    }

    if (progress.percent >= 100) {
      hideTgDownloadProgress();
      if (!state.tgUpdateFromService) {
        toast('TG WS Proxy скачан — можно включать', 'success');
      }
      return;
    }

    const label = progress.message || `Скачивание… ${progress.percent}%`;
    showTgDownloadProgress(progress.percent, label);
  });

  $('#btnWinMinimize')?.addEventListener('click', () => {
    window.zapretAPI.windowMinimize();
  });

  $('#btnWinClose')?.addEventListener('click', () => {
    window.zapretAPI.windowClose();
  });

  window.zapretAPI.onStatusChanged((status) => updateUI(status));
  window.zapretAPI.onTgProxyChanged((status) => updateTgProxyUI(status));
  window.zapretAPI.onError((msg) => toast(msg));
  window.zapretAPI.onNotify((msg) => toast(msg));
  window.zapretAPI.onStartupUpdatesAvailable((all) => {
    if (getPendingUpdateItems(all).length) {
      showStartupUpdatesModal(all);
    }
  });

  window.zapretAPI.onBypassDropped?.(async (payload) => {
    try {
      const status = await api('getStatus');
      updateUI(status);
    } catch {
      state.running = false;
    }
    showBypassDropModal(payload);
    toast('Обход неожиданно остановился', 'error');
  });
}

document.addEventListener('DOMContentLoaded', init);