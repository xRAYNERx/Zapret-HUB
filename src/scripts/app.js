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
  sitesExpanded: true,
  sitesSaving: false,
  customLists: { lists: [], activeId: null },
  customSites: [],
  customListEditing: null,
  customSitesExpanded: true,
  customSitesSaving: false,
  busy: false,
  pendingUpdate: null,
  updating: false,
  updateContext: 'manual',
  pendingStartStrategy: null,
  autoCheckUpdates: true,
  tgProxy: { running: false, installed: false, busy: false }
};

let strategyShuffleQueue = [];
let suppressStrategyChange = false;

function shuffleStrategyFiles(files) {
  const arr = [...files];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function resetStrategyShuffleQueue() {
  strategyShuffleQueue = [];
}

function ensureStrategyShuffleQueue(currentFile) {
  if (strategyShuffleQueue.length > 0) return;

  const all = state.strategies.map((s) => s.file);
  if (all.length <= 1) return;

  let queue = shuffleStrategyFiles(all);
  if (queue[0] === currentFile) {
    const swap = 1 + Math.floor(Math.random() * (queue.length - 1));
    [queue[0], queue[swap]] = [queue[swap], queue[0]];
  }
  strategyShuffleQueue = queue;
}

function getNextShuffleStrategy(currentFile) {
  if (state.strategies.length <= 1) return currentFile;

  ensureStrategyShuffleQueue(currentFile);
  if (!strategyShuffleQueue.length) return currentFile;

  let next = strategyShuffleQueue.shift();
  if (next === currentFile && strategyShuffleQueue.length) {
    next = strategyShuffleQueue.shift();
  }
  return next || currentFile;
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

function toast(message) {
  const container = $('#toastContainer');
  if (!container || !message) return;

  while (container.children.length >= NOTIFY_MAX_STACK) {
    container.firstElementChild?.remove();
  }

  const el = document.createElement('div');
  el.className = 'toast';
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
  updateStrategyShuffleButton();
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
  if (engineVersion) engineVersion.textContent = status.version || '—';

  state.autoCheckUpdates = status.autoUpdate?.enabled !== false;
  updateHomeControls(status);
  updateIpsetToggles(status);
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

  resetStrategyShuffleQueue();
  updateStrategyShuffleButton();
}

function updateStrategyShuffleButton() {
  const btn = $('#btnStrategyShuffle');
  if (!btn) return;
  btn.disabled = state.busy || state.strategies.length <= 1;
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

function renderSiteItems({ sites, listEl, emptyEl, countEl, onRemove, allowEmpty = false }) {
  if (!listEl) return;

  listEl.innerHTML = '';

  if (sites.length === 0) {
    if (emptyEl) emptyEl.hidden = false;
  } else {
    if (emptyEl) emptyEl.hidden = true;
    for (const site of sites) {
      const item = document.createElement('div');
      item.className = 'site-item';
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

  if (countEl) countEl.textContent = String(sites.length);
}

function renderSites(sites) {
  state.sites = [...sites];
  renderSiteItems({
    sites,
    listEl: $('#sitesList'),
    emptyEl: $('#sitesEmpty'),
    countEl: $('#sitesCount'),
    onRemove: removeSite,
    allowEmpty: true
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
    allowEmpty: true
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
  if (!confirm(`Удалить список «${id}»?`)) return;

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
    const cls = r.ok ? 'diag-ok' : 'diag-fail';
    const icon = r.ok ? '✓' : '✗';
    item.innerHTML = `<span class="${cls}">${icon}</span><span>${r.name}: ${r.message}</span>`;
    container.appendChild(item);
  }
}

function showUpdateModal(info, options = {}) {
  state.pendingUpdate = info;
  state.updateContext = options.context || 'manual';
  state.pendingStartStrategy = options.strategy || null;

  const beforeStart = state.updateContext === 'beforeStart';
  $('#updateModalText').textContent = beforeStart
    ? `Перед запуском рекомендуем обновить Zapret: доступна версия ${info.remote} (у вас ${info.local}).`
    : `Доступна версия ${info.remote}. У вас установлена ${info.local}. Обновить автоматически?`;

  $('#btnUpdateLater').textContent = beforeStart ? 'Запустить без обновления' : 'Позже';
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
  setupCloseModals();

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
  } catch (e) {
    toast(e.message, 'error');
  }

  $('#strategySelect').addEventListener('change', async () => {
    if (state.busy || suppressStrategyChange) return;
    resetStrategyShuffleQueue();
    await applyStrategy($('#strategySelect').value);
  });

  $('#btnStrategyShuffle')?.addEventListener('click', async () => {
    if (state.busy || state.strategies.length <= 1) return;

    const btn = $('#btnStrategyShuffle');
    btn.classList.add('spinning');
    setTimeout(() => btn.classList.remove('spinning'), 550);

    const current = $('#strategySelect').value;
    const next = getNextShuffleStrategy(current);
    if (next === current) return;

    suppressStrategyChange = true;
    $('#strategySelect').value = next;
    suppressStrategyChange = false;
    await applyStrategy(next);
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

  $('#btnTests').addEventListener('click', async () => {
    try {
      await api('runTests');
      toast('Подтвердите UAC — откроется окно тестов', 'info');
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  $('#btnCheckUpdates').addEventListener('click', async () => {
    $('#btnCheckUpdates').disabled = true;
    const el = $('#updateResult');
    el.innerHTML = '<span style="color:var(--text-muted)">Проверяем...</span>';
    try {
      const info = await api('checkUpdates');
      if (info.error) {
        el.innerHTML = `<span class="diag-warn">Не удалось проверить: ${info.error}</span>`;
      } else if (info.updateAvailable) {
        el.innerHTML = `<span class="diag-warn">Доступна версия ${info.remote} (у вас ${info.local})</span>
          <button class="btn btn-primary" id="openUpdate" type="button" style="margin-top:8px;width:fit-content">Обновить автоматически</button>`;
        $('#openUpdate')?.addEventListener('click', () => showUpdateModal(info));
      } else {
        el.innerHTML = `<span class="diag-ok">✓ Установлена актуальная версия (${info.local})</span>`;
      }
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
      } else {
        const status = await api('startTgProxy');
        updateTgProxyUI(status);
        if (!status.running) {
          toast('Не удалось запустить прокси', 'error');
        } else if (status.installed) {
          toast('TG Proxy включён', 'success');
        }
      }
    } catch (e) {
      hideTgDownloadProgress();
      toast(e.message, 'error');
    } finally {
      setTgProxyBusy(false);
    }
  });

  $('#btnTgProxyUpdate')?.addEventListener('click', async () => {
    if (state.tgProxy.busy) return;
    setTgProxyBusy(true);
    try {
      const result = await api('applyTgProxyUpdate');
      const status = await api('getTgProxyStatus');
      updateTgProxyUI(status);
      if (!result.updated) {
        toast('Уже актуальная версия', 'success');
      }
      if (result.wasRunning) {
        toast('Перезапустите прокси, если он был активен', 'info');
      }
    } catch (e) {
      hideTgDownloadProgress();
      toast(e.message, 'error');
    } finally {
      setTgProxyBusy(false);
    }
  });

  window.zapretAPI.onTgProxyProgress((progress) => {
    if (!progress) return;

    if (progress.percent >= 100) {
      hideTgDownloadProgress();
      toast('TG WS Proxy скачан — можно включать', 'success');
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
}

document.addEventListener('DOMContentLoaded', init);