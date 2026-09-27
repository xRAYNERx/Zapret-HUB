// =========================================================================
// Zapret HUB v2.0 - Elevated Slate Engine Script
// =========================================================================

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// Unified State
let state = {
  activeTab: 'home',
  zapret: {
    running: false,
    activeStrategy: 'general.bat',
    strategies: [],
    busy: false
  },
  vpn: {
    running: false,
    activeServerIndex: -1,
    activeServer: null,
    servers: [],
    subscriptionUrl: '',
    subUrl: '',
    subService: 'DedVPN Private',
    daysLeft: null,
    systemProxy: true,
    autoFallback: true,
    testingAll: false
  },
  tg: {
    running: false,
    installed: false,
    host: '127.0.0.1',
    port: 1443,
    proxyUrl: null,
    busy: false
  },
  sites: {
    main: [],
    searchQuery: '',
    customLists: [],
    activeListId: null,
    customSites: [],
    customSearchQuery: ''
  },
  settings: {
    closeBehavior: 'tray', // 'ask' | 'tray' | 'quit'
    startMinimized: false,
    autostartZapret: false,
    autostartTg: false,
    autoUpdates: true,
    ipsetMode: 'loaded' // 'loaded' | 'none' | 'any'
  }
};

// ─── IPC Wrapper ───
async function api(method, ...args) {
  const fn = window.zapretAPI?.[method];
  if (!fn) throw new Error('API недоступен');
  const result = await fn(...args);
  if (result && typeof result === 'object' && 'ok' in result) {
    if (!result.ok) throw new Error(result.error || 'Ошибка вызова API');
    return result.data;
  }
  return result;
}

// ─── Toast System ───
function toast(message, kind = 'success') {
  const container = $('#toastContainer');
  if (!container || !message) return;

  const toastEl = document.createElement('div');
  const borderCol = kind === 'error' ? 'border-rose-500/40 bg-rose-950/80 text-rose-200' :
                    kind === 'info' ? 'border-teal-500/40 bg-slate-900/90 text-teal-200' :
                    'border-emerald-500/40 bg-slate-900/90 text-emerald-200';

  toastEl.className = `px-4 py-2.5 rounded-2xl text-xs font-semibold border shadow-lg backdrop-blur-md transition-all duration-300 pointer-events-auto flex items-center gap-2 ${borderCol}`;
  toastEl.innerText = message;

  container.appendChild(toastEl);
  setTimeout(() => {
    toastEl.style.opacity = '0';
    toastEl.style.transform = 'translateY(10px)';
    setTimeout(() => toastEl.remove(), 300);
  }, 3500);
}

// ─── Navigation Tabs ───
function selectNavTab(el) {
  const targetPage = el.getAttribute('data-page');
  navigateTo(targetPage);
}

function navigateTo(pageId) {
  state.activeTab = pageId;

  // Update nav buttons
  $$('.app-nav-item').forEach(btn => {
    if (btn.getAttribute('data-page') === pageId) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  // Switch pages
  const pages = ['home', 'vpn', 'sites', 'settings'];
  pages.forEach(p => {
    const pageEl = $(`#page-${p}`);
    if (pageEl) {
      if (p === pageId) {
        pageEl.classList.remove('hidden');
      } else {
        pageEl.classList.add('hidden');
      }
    }
  });
}

// ─── Mutual Exclusion Conflict Modal ───
let pendingConflictAction = null;
let suppressConflictModal = false;
try {
  suppressConflictModal = localStorage.getItem('zapret_suppress_conflict_modal') === 'true';
} catch(e) {}

function showConflictModal(title, text, action, fromService, toService) {
  pendingConflictAction = action;
  const modal = $('#conflict-modal-backdrop');
  const titleEl = $('#conflict-modal-title');
  const textEl = $('#conflict-modal-text');
  const fromEl = $('#conflict-from-service');
  const toEl = $('#conflict-to-service');
  const checkEl = $('#conflict-dont-show');

  if (titleEl) titleEl.innerText = title;
  if (textEl) textEl.innerText = text;
  if (fromEl) fromEl.innerText = fromService;
  if (toEl) toEl.innerText = toService;
  if (checkEl) checkEl.checked = false;
  if (modal) modal.classList.remove('hidden');
}

function cancelConflictSwitch() {
  pendingConflictAction = null;
  const modal = $('#conflict-modal-backdrop');
  if (modal) modal.classList.add('hidden');
}

function confirmConflictSwitch() {
  const checkEl = $('#conflict-dont-show');
  if (checkEl && checkEl.checked) {
    suppressConflictModal = true;
    try { localStorage.setItem('zapret_suppress_conflict_modal', 'true'); } catch(e){}
  }

  const modal = $('#conflict-modal-backdrop');
  if (modal) modal.classList.add('hidden');

  if (pendingConflictAction) {
    const act = pendingConflictAction;
    pendingConflictAction = null;
    act();
  }
}

// ─── Changelog Modal ───
let _changelogLoadedFromGithub = false;

function formatRussianDate(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return '';
  const months = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

function parseMarkdownToHtml(md) {
  if (!md) return '';
  const lines = md.split('\n');
  const result = [];
  let inList = false;

  for (let rawLine of lines) {
    let line = rawLine.trim();
    if (!line) {
      if (inList) {
        result.push('</ul>');
        inList = false;
      }
      continue;
    }

    if (line.startsWith('### ') || line.startsWith('## ')) {
      if (inList) {
        result.push('</ul>');
        inList = false;
      }
      const title = line.replace(/^#+\s*/, '');
      result.push(`<div class="text-[11px] font-bold text-slate-300 uppercase tracking-wider pt-2 pb-0.5">${title}</div>`);
      continue;
    }

    if (line.startsWith('- ') || line.startsWith('* ')) {
      if (!inList) {
        result.push('<ul class="text-xs text-slate-300 space-y-1.5 leading-relaxed">');
        inList = true;
      }
      let content = line.substring(2);
      content = content.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
      let icon = '<span class="text-emerald-400 font-bold flex-shrink-0 mt-0.5">+</span>';
      if (content.toLowerCase().includes('исправлен') || content.toLowerCase().includes('устранен')) {
        icon = '<span class="text-slate-400 font-bold flex-shrink-0 mt-0.5">•</span>';
      } else if (content.toLowerCase().includes('улучшен') || content.toLowerCase().includes('интерфейс')) {
        icon = '<span class="text-sky-400 font-bold flex-shrink-0 mt-0.5">★</span>';
      }
      result.push(`<li class="flex items-start gap-2">${icon}<span>${content}</span></li>`);
      continue;
    }

    if (line.startsWith('---') || line.toLowerCase().includes('установка:')) {
      if (inList) {
        result.push('</ul>');
        inList = false;
      }
      break;
    }
  }

  if (inList) result.push('</ul>');
  return result.join('\n');
}

async function loadChangelogFromGithub() {
  if (_changelogLoadedFromGithub) return;
  try {
    const releases = await window.zapretAPI?.getGithubReleases();
    if (!Array.isArray(releases) || releases.length === 0) return;

    const container = $('#changelog-container');
    if (!container) return;

    const currentAppVersion = (state.version || '2.0.0').replace(/^v/i, '');

    const blocks = releases.map((rel, idx) => {
      const tag = (rel.tag_name || '').replace(/^v/i, '');
      const isCurrent = tag === currentAppVersion || (idx === 0 && !tag.includes('1.'));
      const dateStr = formatRussianDate(rel.published_at || rel.created_at);
      const bodyHtml = parseMarkdownToHtml(rel.body);

      const badge = isCurrent
        ? '<span class="px-2 py-0.5 rounded-full text-[9px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">Текущая версия</span>'
        : '<span class="px-2 py-0.5 rounded-full text-[9px] font-bold bg-white/10 text-slate-400 border border-white/10">Релиз</span>';

      const opacityClass = isCurrent ? 'border-white/10' : 'border-white/8 opacity-85 hover:opacity-100 transition-opacity';

      return `
        <div class="inner-panel rounded-2xl p-4 border ${opacityClass} space-y-2.5 bg-[#171e2c]">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <span class="text-xs font-bold text-white font-mono">${rel.tag_name || 'v2.0'}</span>
              ${badge}
            </div>
            <span class="text-[11px] text-slate-400 font-mono">${dateStr}</span>
          </div>
          <div class="space-y-1.5">
            ${bodyHtml}
          </div>
        </div>
      `;
    });

    if (blocks.length > 0) {
      container.innerHTML = blocks.join('\n');
      _changelogLoadedFromGithub = true;
    }
  } catch (err) {
    console.warn('[Changelog] Failed to load releases from GitHub:', err);
  }
}

let _pendingHubUpdate = null;
window._hubUpdateDownloading = false;

function updateChangelogInstallButton() {
  const btn = $('#btn-changelog-install-update');
  const text = $('#btn-changelog-install-text');
  if (!btn) return;
  if (_pendingHubUpdate && _pendingHubUpdate.updateAvailable) {
    btn.classList.remove('hidden');
    if (text) text.innerText = `Обновить до v${(_pendingHubUpdate.remote || '2.0.1').replace(/^v/i, '')}`;
  } else {
    btn.classList.add('hidden');
  }
}

function startUpdateFromChangelog() {
  closeChangelogModal();
  if (_pendingHubUpdate) {
    showHubUpdateModal(_pendingHubUpdate);
  } else {
    checkAllUpdatesSim();
  }
}

function showHubUpdateModal(updateInfo) {
  _pendingHubUpdate = updateInfo;
  const modal = $('#hub-update-modal-backdrop');
  if (!modal) return;

  const currentVerEl = $('#update-modal-current-ver');
  const remoteVerEl = $('#update-modal-remote-ver');
  const descEl = $('#update-modal-desc');
  const actionsEl = $('#update-modal-actions');
  const progressEl = $('#update-progress-section');
  const closeBtn = $('#btn-close-update-modal');

  const local = (updateInfo?.local || state.version || '2.0.0').replace(/^v/i, '');
  const remote = (updateInfo?.remote || '2.0.1').replace(/^v/i, '');

  if (currentVerEl) currentVerEl.innerText = `v${local}`;
  if (remoteVerEl) remoteVerEl.innerText = `v${remote}`;
  if (descEl) {
    descEl.innerText = `Вышла новая версия Zapret HUB v${remote} с важными исправлениями и обновлениями. Хотите скачать и установить обновление сейчас? Приложение автоматически загрузит установщик и перезапустится.`;
  }

  if (actionsEl) actionsEl.classList.remove('hidden');
  if (progressEl) progressEl.classList.add('hidden');
  if (closeBtn) closeBtn.classList.remove('hidden');
  window._hubUpdateDownloading = false;

  modal.classList.remove('hidden');
}

function closeHubUpdateModal() {
  if (window._hubUpdateDownloading) return;
  const modal = $('#hub-update-modal-backdrop');
  if (modal) modal.classList.add('hidden');
}

async function executeHubUpdate() {
  if (window._hubUpdateDownloading) return;
  window._hubUpdateDownloading = true;

  const actionsEl = $('#update-modal-actions');
  const progressEl = $('#update-progress-section');
  const closeBtn = $('#btn-close-update-modal');
  const bar = $('#update-progress-bar');
  const pctText = $('#update-progress-pct');
  const label = $('#update-progress-label');

  if (actionsEl) actionsEl.classList.add('hidden');
  if (progressEl) progressEl.classList.remove('hidden');
  if (closeBtn) closeBtn.classList.add('hidden');

  if (bar) bar.style.width = '0%';
  if (pctText) pctText.innerText = '0%';
  if (label) label.innerText = 'Подключение к GitHub…';

  try {
    toast('Загрузка обновления Zapret HUB...', 'info');
    await api('applyHubUpdate');
  } catch (err) {
    console.error('Update failed:', err);
    window._hubUpdateDownloading = false;
    toast(`Ошибка обновления: ${err.message}`, 'error');
    if (label) label.innerText = `Ошибка: ${err.message}`;
    if (actionsEl) actionsEl.classList.remove('hidden');
    if (closeBtn) closeBtn.classList.remove('hidden');
  }
}

function openChangelogModal() {
  const modal = $('#changelog-modal-backdrop');
  if (modal) modal.classList.remove('hidden');
  updateChangelogInstallButton();
  loadChangelogFromGithub().catch(() => {});
}

function closeChangelogModal() {
  const modal = $('#changelog-modal-backdrop');
  if (modal) modal.classList.add('hidden');
}

window.openChangelogModal = openChangelogModal;
window.closeChangelogModal = closeChangelogModal;
window.showHubUpdateModal = showHubUpdateModal;
window.closeHubUpdateModal = closeHubUpdateModal;
window.executeHubUpdate = executeHubUpdate;
window.startUpdateFromChangelog = startUpdateFromChangelog;


// ─── Strategy Selector Dropdown ───
function renderStrategyDropdown() {
  const container = $('#strategy-dropdown-items');
  const countEl = $('#strategy-dropdown-count');
  if (!state.zapret.strategies || state.zapret.strategies.length === 0) return;

  if (countEl) countEl.innerText = `${state.zapret.strategies.length}`;

  if (container) {
    container.innerHTML = state.zapret.strategies.map(s => {
      const fileName = typeof s === 'string' ? s : (s.file || s.name || '');
      const displayName = typeof s === 'string' ? s.replace(/\.bat$/i, '') : (s.name || s.file || '').replace(/\.bat$/i, '');
      const isActive = state.zapret.activeStrategy === fileName;
      return `
        <button data-strategy="${encodeURIComponent(fileName)}" class="w-full text-left px-2.5 py-1.5 rounded-lg text-xs font-mono ${isActive ? 'text-emerald-400 bg-emerald-500/15 font-bold border border-emerald-500/25 active-strat-btn' : 'text-slate-200 hover:text-white hover:bg-white/10'} flex items-center justify-between cursor-pointer transition-colors">
          <span class="truncate pointer-events-none">${displayName}</span>
          ${isActive ? '<span class="text-[9px] font-sans font-bold px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 ml-1.5 flex-shrink-0 pointer-events-none">Активна</span>' : ''}
        </button>
      `;
    }).join('');

    if (!container._hasDelegatedListener) {
      container._hasDelegatedListener = true;
      container.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-strategy]');
        if (btn && btn.dataset.strategy) {
          selectStrategy(decodeURIComponent(btn.dataset.strategy));
        }
      });
    }
  }
}

function toggleStrategyMenu(e) {
  e.stopPropagation();
  const dropdown = $('#strategy-dropdown');
  if (dropdown) {
    const isHidden = dropdown.classList.contains('hidden');
    dropdown.classList.toggle('hidden');
    if (isHidden) {
      setTimeout(() => {
        const activeBtn = dropdown.querySelector('.active-strat-btn');
        if (activeBtn) activeBtn.scrollIntoView({ block: 'nearest' });
      }, 30);
    }
  }
}

window.addEventListener('click', () => {
  const dropdown = $('#strategy-dropdown');
  if (dropdown && !dropdown.classList.contains('hidden')) {
    dropdown.classList.add('hidden');
  }
});

// Intercept all external links and open in default OS browser
document.addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (a && a.href && (a.href.startsWith('http://') || a.href.startsWith('https://') || a.href.startsWith('tg://'))) {
    e.preventDefault();
    if (window.zapretAPI?.openExternal) {
      window.zapretAPI.openExternal(a.href);
    } else {
      window.open(a.href);
    }
  }
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    cancelConflictSwitch();
    closeChangelogModal();
    const dropdown = $('#strategy-dropdown');
    if (dropdown) dropdown.classList.add('hidden');
    $('#closeChoiceModal')?.classList.add('hidden');
    $('#appRestartModal')?.classList.add('hidden');
    dismissFirstLaunchProbeModal();
  }
});

async function selectStrategy(name) {
  const dropdown = $('#strategy-dropdown');
  if (dropdown) dropdown.classList.add('hidden');

  try {
    state.zapret.activeStrategy = name;
    $('#active-strategy-name').innerText = name.replace(/\.bat$/i, '');
    renderStrategyDropdown();

    if (state.zapret.running) {
      toast(`Перезапуск с «${name.replace(/\.bat$/i, '')}»...`, 'info');
      await api('restart', name);
    } else {
      await api('setStrategy', name);
      toast(`Выбрана стратегия «${name.replace(/\.bat$/i, '')}»`, 'success');
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ─── Power Button Helpers (Pure Circular Spinner) ───
const SPINNER_CIRCLE_HTML = '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" stroke-dasharray="36" stroke-dashoffset="10" stroke-linecap="round" fill="none"/>';
const POWER_ICON_HTML = '<path d="M18.36 6.64a9 9 0 1 1-12.73 0M12 2v10"/>';

function setPowerBtnLoading(btnId, iconId, textId, loadingText) {
  const btn = $(`#${btnId}`);
  const icon = $(`#${iconId}`);
  const text = $(`#${textId}`);
  if (btn) btn.disabled = true;
  if (icon) {
    icon.innerHTML = SPINNER_CIRCLE_HTML;
    icon.classList.add('animate-spin');
  }
  if (text && loadingText) text.innerText = loadingText;
}

function clearPowerBtnLoading(btnId, iconId) {
  const btn = $(`#${btnId}`);
  const icon = $(`#${iconId}`);
  if (btn) btn.disabled = false;
  if (icon) {
    icon.innerHTML = POWER_ICON_HTML;
    icon.classList.remove('animate-spin');
  }
}

// ─── Zapret Power Toggle ───
async function toggleZapret() {
  if (state.zapret.busy) return;

  if (!state.zapret.running) {
    // Turning Zapret ON: Check if VPN is running
    if (state.vpn.running) {
      if (!suppressConflictModal) {
        showConflictModal(
          'Переключение на Обход',
          'При включении Обхода закроется подключение VPN (VLESS Reality), чтобы не возникало конфликтов сетевых шлюзов.',
          async () => {
            await doStopVpn();
            await doStartZapret();
          },
          'VPN (VLESS Reality)',
          'Обход (Zapret DPI)'
        );
        return;
      } else {
        await doStopVpn();
      }
    }
    await doStartZapret();
  } else {
    // Turning Zapret OFF
    await doStopZapret();
  }
}

async function doStartZapret() {
  try {
    state.zapret.busy = true;
    setPowerBtnLoading('btn-zapret-power', 'zapret-power-icon', 'zapret-power-text', 'ВКЛЮЧЕНИЕ...');
    toast('Включение обхода...', 'info');
    await api('start', state.zapret.activeStrategy);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    state.zapret.busy = false;
    clearPowerBtnLoading('btn-zapret-power', 'zapret-power-icon');
    const status = await api('getStatus');
    updateZapretUI(status);
  }
}

async function doStopZapret() {
  try {
    state.zapret.busy = true;
    setPowerBtnLoading('btn-zapret-power', 'zapret-power-icon', 'zapret-power-text', 'ВЫКЛЮЧЕНИЕ...');
    toast('Выключение обхода...', 'info');
    await api('stop');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    state.zapret.busy = false;
    clearPowerBtnLoading('btn-zapret-power', 'zapret-power-icon');
    const status = await api('getStatus');
    updateZapretUI(status);
  }
}

// ─── Country Flags & Server Name Helpers ───
const COUNTRY_FLAGS = {
  PL: '<svg viewBox="0 0 640 480" class="w-full h-full object-cover"><path fill="#fff" d="M0 0h640v240H0z"/><path fill="#dc143c" d="M0 240h640v240H0z"/></svg>',
  NL: '<svg viewBox="0 0 640 480" class="w-full h-full object-cover"><path fill="#ae1c28" d="M0 0h640v160H0z"/><path fill="#fff" d="M0 160h640v160H0z"/><path fill="#21468b" d="M0 320h640v160H0z"/></svg>',
  DE: '<svg viewBox="0 0 640 480" class="w-full h-full object-cover"><path fill="#000" d="M0 0h640v160H0z"/><path fill="#d00" d="M0 160h640v160H0z"/><path fill="#ffce00" d="M0 320h640v160H0z"/></svg>',
  GB: '<svg viewBox="0 0 640 480" class="w-full h-full object-cover"><path fill="#012169" d="M0 0h640v480H0z"/><path stroke="#fff" stroke-width="60" d="m0 0 640 480M640 0 0 480"/><path stroke="#c8102e" stroke-width="40" d="m0 0 640 480M640 0 0 480"/><path stroke="#fff" stroke-width="100" d="M320 0v480M0 240h640"/><path stroke="#c8102e" stroke-width="60" d="M320 0v480M0 240h640"/></svg>',
  UK: '<svg viewBox="0 0 640 480" class="w-full h-full object-cover"><path fill="#012169" d="M0 0h640v480H0z"/><path stroke="#fff" stroke-width="60" d="m0 0 640 480M640 0 0 480"/><path stroke="#c8102e" stroke-width="40" d="m0 0 640 480M640 0 0 480"/><path stroke="#fff" stroke-width="100" d="M320 0v480M0 240h640"/><path stroke="#c8102e" stroke-width="60" d="M320 0v480M0 240h640"/></svg>',
  US: '<svg viewBox="0 0 640 480" class="w-full h-full object-cover"><path fill="#b22234" d="M0 0h640v480H0z"/><path stroke="#fff" stroke-width="37" stroke-dasharray="37" d="M0 55.4h640M0 129.2h640M0 203h640M0 276.9h640M0 350.8h640M0 424.6h640"/><path fill="#3c3b6e" d="M0 0h256v258.5H0z"/><circle cx="128" cy="129" r="60" fill="#fff" opacity="0.4"/></svg>',
  FR: '<svg viewBox="0 0 640 480" class="w-full h-full object-cover"><path fill="#002654" d="M0 0h213.3v480H0z"/><path fill="#fff" d="M213.3 0h213.4v480H213.3z"/><path fill="#ce1126" d="M426.7 0H640v480H426.7z"/></svg>',
  IT: '<svg viewBox="0 0 640 480" class="w-full h-full object-cover"><path fill="#009246" d="M0 0h213.3v480H0z"/><path fill="#fff" d="M213.3 0h213.4v480H213.3z"/><path fill="#ce2b37" d="M426.7 0H640v480H426.7z"/></svg>',
  KZ: '<svg viewBox="0 0 640 480" class="w-full h-full object-cover"><path fill="#00afca" d="M0 0h640v480H0z"/><circle cx="320" cy="240" r="65" fill="#fec50c"/><path d="M240 310c40-30 120-30 160 0-40-15-120-15-160 0z" fill="#fec50c"/></svg>',
  TR: '<svg viewBox="0 0 640 480" class="w-full h-full object-cover"><path fill="#e30a17" d="M0 0h640v480H0z"/><circle cx="260" cy="240" r="120" fill="#fff"/><circle cx="290" cy="240" r="96" fill="#e30a17"/><polygon points="380,240 435,258 401,211 401,269 435,222" fill="#fff"/></svg>',
  FI: '<svg viewBox="0 0 640 480" class="w-full h-full object-cover"><path fill="#fff" d="M0 0h640v480H0z"/><path fill="#002f6c" d="M175 0h90v480h-90z"/><path fill="#002f6c" d="M0 195h640v90H0z"/></svg>',
  SE: '<svg viewBox="0 0 640 480" class="w-full h-full object-cover"><path fill="#005293" d="M0 0h640v480H0z"/><path fill="#fecb00" d="M175 0h90v480h-90z"/><path fill="#fecb00" d="M0 195h640v90H0z"/></svg>',
  UA: '<svg viewBox="0 0 640 480" class="w-full h-full object-cover"><path fill="#005bbb" d="M0 0h640v240H0z"/><path fill="#ffd500" d="M0 240h640v240H0z"/></svg>',
  JP: '<svg viewBox="0 0 640 480" class="w-full h-full object-cover"><path fill="#fff" d="M0 0h640v480H0z"/><circle cx="320" cy="240" r="140" fill="#bc002d"/></svg>',
  SG: '<svg viewBox="0 0 640 480" class="w-full h-full object-cover"><path fill="#ed2939" d="M0 0h640v240H0z"/><path fill="#fff" d="M0 240h640v240H0z"/><circle cx="110" cy="120" r="65" fill="#fff"/><circle cx="128" cy="120" r="60" fill="#ed2939"/></svg>',
  HK: '<svg viewBox="0 0 640 480" class="w-full h-full object-cover"><path fill="#c8102e" d="M0 0h640v480H0z"/><circle cx="320" cy="240" r="80" fill="#fff" opacity="0.85"/></svg>',
  RU: '<svg viewBox="0 0 640 480" class="w-full h-full object-cover"><path fill="#fff" d="M0 0h640v160H0z"/><path fill="#0039a6" d="M0 160h640v160H0z"/><path fill="#d52b1e" d="M0 320h640v160H0z"/></svg>',
  ES: '<svg viewBox="0 0 640 480" class="w-full h-full object-cover"><path fill="#aa151b" d="M0 0h640v120H0z"/><path fill="#f1bf00" d="M0 120h640v240H0z"/><path fill="#aa151b" d="M0 360h640v120H0z"/></svg>',
  CH: '<svg viewBox="0 0 640 480" class="w-full h-full object-cover"><path fill="#d52b1e" d="M0 0h640v480H0z"/><path fill="#fff" d="M280 130h80v220h-80z"/><path fill="#fff" d="M210 200h220v80H210z"/></svg>',
  AT: '<svg viewBox="0 0 640 480" class="w-full h-full object-cover"><path fill="#c8102e" d="M0 0h640v160H0z"/><path fill="#fff" d="M0 160h640v160H0z"/><path fill="#c8102e" d="M0 320h640v160H0z"/></svg>',
  CZ: '<svg viewBox="0 0 640 480" class="w-full h-full object-cover"><path fill="#fff" d="M0 0h640v240H0z"/><path fill="#d7141a" d="M0 240h640v240H0z"/><polygon fill="#11457e" points="0,0 320,240 0,480"/></svg>',
  GLOBAL: '<svg viewBox="0 0 24 24" class="w-full h-full p-0.5 stroke-slate-300 stroke-2 fill-none"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>'
};

function getCountryFlagSvg(code = 'GLOBAL') {
  const c = String(code).toUpperCase();
  return COUNTRY_FLAGS[c] || COUNTRY_FLAGS['GLOBAL'];
}

function detectCountryCode(name = '') {
  const str = String(name || '').trim();
  const regMatch = str.match(/[\u{1F1E6}-\u{1F1FF}]{2}/u);
  if (regMatch) {
    const chars = [...regMatch[0]];
    const code = chars.map(c => String.fromCharCode(c.codePointAt(0) - 127397)).join('').toUpperCase();
    if (code && COUNTRY_FLAGS[code]) return code;
  }
  const lower = str.toLowerCase();
  if (/\bpl\b|польш|poland|warsaw/i.test(lower)) return 'PL';
  if (/\bnl\b|нидерланд|голландия|netherlands|amsterdam/i.test(lower)) return 'NL';
  if (/\bde\b|германи|deutschland|germany|frankfurt|berlin/i.test(lower)) return 'DE';
  if (/\bgb\b|\buk\b|великобритан|англия|united kingdom|london/i.test(lower)) return 'GB';
  if (/\bus\b|\busa\b|сша|америка|united states/i.test(lower)) return 'US';
  if (/\bfr\b|франци|france|paris/i.test(lower)) return 'FR';
  if (/\bkz\b|казахстан|kazakhstan|almaty|astana/i.test(lower)) return 'KZ';
  if (/\btr\b|турци|turkey|istanbul/i.test(lower)) return 'TR';
  if (/\bfi\b|финлянди|finland|helsinki/i.test(lower)) return 'FI';
  if (/\bse\b|швеци|sweden|stockholm/i.test(lower)) return 'SE';
  if (/\bua\b|украин|ukraine|kyiv/i.test(lower)) return 'UA';
  if (/\bjp\b|япони|japan|tokyo/i.test(lower)) return 'JP';
  if (/\bsg\b|сингапур|singapore/i.test(lower)) return 'SG';
  if (/\bhk\b|гонконг|hong kong/i.test(lower)) return 'HK';
  if (/\bru\b|росси|russia|moscow/i.test(lower)) return 'RU';
  if (/\bes\b|испани|spain|madrid/i.test(lower)) return 'ES';
  if (/\bit\b|итали|italy|rome|milan/i.test(lower)) return 'IT';
  if (/\bch\b|швейцари|switzerland|zurich/i.test(lower)) return 'CH';
  if (/\bat\b|австри|austria|vienna/i.test(lower)) return 'AT';
  if (/\bcz\b|чехи|czech|prague/i.test(lower)) return 'CZ';

  const m = str.match(/^([A-Za-z]{2})[\s\-_]/);
  if (m && COUNTRY_FLAGS[m[1].toUpperCase()]) return m[1].toUpperCase();

  return 'GLOBAL';
}

function cleanServerName(name = '') {
  let cleaned = String(name || '');
  cleaned = cleaned.replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '');
  cleaned = cleaned.replace(/\p{Extended_Pictographic}/gu, '');
  cleaned = cleaned.trim();
  cleaned = cleaned.replace(/^[A-Za-z]{2}\s*[-–—:\s]\s*([А-Яа-яA-Za-z])/u, '$1');
  cleaned = cleaned.trim();
  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }
  return cleaned || name;
}

function pluralizeDays(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod100 >= 11 && mod100 <= 19) return 'дней';
  if (mod10 === 1) return 'день';
  if (mod10 >= 2 && mod10 <= 4) return 'дня';
  return 'дней';
}

// ─── VPN Power Toggle ───
async function toggleVpn() {
  if (!state.vpn.running) {
    // Turning VPN ON: Check if Zapret is running
    if (state.zapret.running) {
      if (!suppressConflictModal) {
        showConflictModal(
          'Переключение на VPN',
          'При включении VPN закроется подключение Обхода YouTube и Discord, чтобы избежать конфликта маршрутизации.',
          async () => {
            await doStopZapret();
            await doConnectVpnBestOrFirst();
          },
          'Обход (Zapret DPI)',
          'VPN (VLESS Reality)'
        );
        return;
      } else {
        await doStopZapret();
      }
    }
    await doConnectVpnBestOrFirst();
  } else {
    // Turning VPN OFF
    await doStopVpn();
  }
}

async function doStopVpn() {
  try {
    setPowerBtnLoading('btn-vpn-power', 'vpn-power-icon', 'vpn-power-text', 'ОТКЛЮЧЕНИЕ...');
    const status = await api('vlessDisconnect');
    updateVpnUI(status);
    toast('VPN отключён', 'info');
  } catch (e) {
    toast(e.message || 'Ошибка отключения', 'error');
    const status = await api('vlessGetStatus');
    updateVpnUI(status);
  } finally {
    clearPowerBtnLoading('btn-vpn-power', 'vpn-power-icon');
  }
}

async function doConnectVpnBestOrFirst() {
  try {
    if (state.vpn.servers.length === 0) {
      toast('Список серверов пуст — обновите подписку', 'error');
      navigateTo('vpn');
      return;
    }

    // 1. Try to find the last active connected server
    const lastName = localStorage.getItem('vpn_last_active_server_name');
    let targetIdx = -1;

    if (lastName) {
      targetIdx = state.vpn.servers.findIndex(s => s.name === lastName);
    }

    if (targetIdx < 0 && typeof state.vpn.activeServerIndex === 'number' && state.vpn.activeServerIndex >= 0 && state.vpn.activeServerIndex < state.vpn.servers.length) {
      targetIdx = state.vpn.activeServerIndex;
    }

    // 2. If previously connected server is in the current subscription list: connect to it
    if (targetIdx >= 0) {
      await doConnectServer(targetIdx);
      return;
    }

    // 3. If there was NO prior connection: connect to the BEST server
    toast('Подключение к лучшему серверу...', 'info');
    await vpnSmartConnect();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function connectServer(serverIdx) {
  if (state.zapret.running) {
    if (!suppressConflictModal) {
      showConflictModal(
        'Переключение на VPN',
        'При включении VPN закроется подключение Обхода YouTube и Discord, чтобы избежать конфликта маршрутизации.',
        async () => {
          await doStopZapret();
          await doConnectServer(serverIdx);
        },
        'Обход (Zapret DPI)',
        'VPN (VLESS Reality)'
      );
      return;
    } else {
      await doStopZapret();
    }
  }

  await doConnectServer(serverIdx);
}

async function doConnectServer(serverIdx) {
  setPowerBtnLoading('btn-vpn-power', 'vpn-power-icon', 'vpn-power-text', 'ПОДКЛЮЧЕНИЕ...');

  const srv = state.vpn.servers[serverIdx];
  const srvName = cleanServerName(srv?.name || `Сервер #${serverIdx + 1}`);
  toast(`Подключение к ${srvName}...`, 'info');

  try {
    const status = await api('vlessConnect', serverIdx);
    if (srv?.name) {
      localStorage.setItem('vpn_last_active_server_name', srv.name);
    } else if (status.activeServer?.name) {
      localStorage.setItem('vpn_last_active_server_name', status.activeServer.name);
    }
    updateVpnUI(status);
    toast(`Подключено: ${cleanServerName(status.activeServer?.name || srvName)}`, 'success');
  } catch (e) {
    toast(e.message || 'Ошибка подключения к серверу', 'error');
    const status = await api('vlessGetStatus');
    updateVpnUI(status);
  } finally {
    clearPowerBtnLoading('btn-vpn-power', 'vpn-power-icon');
  }
}

async function vpnSmartConnect() {
  if (state.vpn.servers.length === 0) {
    toast('Список серверов пуст — обновите подписку', 'error');
    return;
  }

  const btnText = $('#vpn-smart-text');
  const pingBadge = $('#vpn-smart-ping-badge');

  // Check if we already have measured working servers
  let working = (state.vpn.servers || [])
    .map((s, idx) => ({ ...s, idx }))
    .filter(s => s.status === 'ok' && typeof s.ping === 'number' && s.ping > 0)
    .sort((a, b) => (a.ping - b.ping));

  if (working.length > 0) {
    const best = working[0];
    if (pingBadge && best.ping) {
      pingBadge.innerText = `${best.ping} мс`;
    }
    toast(`Лучший узел: ${cleanServerName(best.name)} (${best.ping} мс)`, 'info');
    await connectServer(best.idx);
    return;
  }

  // If no servers have measured pings yet, run measurement test
  setPowerBtnLoading('btn-vpn-power', 'vpn-power-icon', 'vpn-power-text', 'ПОДКЛЮЧЕНИЕ...');
  if (btnText) btnText.innerText = 'Замер пинга...';
  if (pingBadge) pingBadge.innerText = 'Тест...';
  toast('Замер пинга и поиск лучшего узла...', 'info');

  try {
    // 1. Sync subscription first to ensure we test the latest servers
    if (state.vpn.subUrl && /^https?:\/\//i.test(state.vpn.subUrl)) {
      try {
        await api('vlessUpdateSubscription');
      } catch {}
    }

    // 2. Run ping test across all servers
    await api('vlessTestAll');
    const status = await api('vlessGetStatus');
    updateVpnUI(status);
    const servers = status.servers || [];

    // 3. Strictly filter servers that are ok and have real ping > 0
    working = servers
      .map((s, idx) => ({ ...s, idx }))
      .filter(s => s.status === 'ok' && typeof s.ping === 'number' && s.ping > 0)
      .sort((a, b) => (a.ping - b.ping));

    if (working.length === 0) {
      toast('Все серверы подписки заблокированы ТСПУ', 'error');
      return;
    }

    const best = working[0];
    if (pingBadge && best.ping) {
      pingBadge.innerText = `${best.ping} мс`;
    }

    toast(`Лучший узел: ${cleanServerName(best.name)} (${best.ping} мс)`, 'success');
    await connectServer(best.idx);
  } catch (e) {
    toast(e.message || 'Ошибка поиска лучшего узла', 'error');
  } finally {
    if (btnText) btnText.innerText = 'Подключить лучший';
    clearPowerBtnLoading('btn-vpn-power', 'vpn-power-icon');
  }
}
window.vpnSmartConnect = vpnSmartConnect;

function toggleSubVisibility(e) {
  if (e) e.stopPropagation();
  const input = $('#vpn-sub-input');
  const icon = $('#icon-sub-eye');
  if (!input) return;
  if (input.type === 'password') {
    input.type = 'text';
    if (icon) {
      icon.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
    }
  } else {
    input.type = 'password';
    if (icon) {
      icon.innerHTML = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24M1 1l22 22"/>';
    }
  }
}
window.toggleSubBlur = toggleSubVisibility;
window.toggleSubVisibility = toggleSubVisibility;

async function copySubUrl(e) {
  if (e) e.stopPropagation();
  const input = $('#vpn-sub-input');
  const val = (input ? input.value : '').trim();
  if (!val) {
    toast('Ссылка пуста', 'error');
    return;
  }
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(val);
    }
    const btn = $('#btn-copy-sub');
    if (btn) {
      const orig = btn.innerHTML;
      btn.innerHTML = '<svg class="w-3.5 h-3.5 stroke-emerald-400 stroke-2 fill-none" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>';
      setTimeout(() => { btn.innerHTML = orig; }, 1500);
    }
    toast('Ссылка скопирована', 'info');
  } catch (err) {
    toast('Не удалось скопировать', 'error');
  }
}
window.copySubUrl = copySubUrl;

async function pasteVpnSub(e) {
  if (e) e.stopPropagation();
  try {
    let text = '';
    if (typeof api === 'function') {
      try {
        text = await api('readClipboardText');
      } catch {}
    }
    if (!text && navigator.clipboard) {
      try {
        text = await navigator.clipboard.readText();
      } catch {}
    }
    const input = $('#vpn-sub-input');
    if (input && text && text.trim()) {
      input.value = text.trim();
      input.focus();
      toast('Ссылка вставлена. Нажмите «Обновить»', 'info');
    } else {
      toast('Буфер обмена пуст', 'error');
    }
  } catch (e) {
    toast('Не удалось прочитать буфер обмена', 'error');
  }
}
window.pasteVpnSub = pasteVpnSub;

async function updateVpnSub() {
  const input = $('#vpn-sub-input');
  const url = (input ? input.value : '').trim();
  if (!url) {
    toast('Введите ссылку на подписку VPN', 'error');
    return;
  }

  const btn = $('#btn-update-sub');
  const btnText = $('#btn-update-sub-text');
  const icon = $('#update-sub-icon');

  if (btn) btn.disabled = true;
  if (btnText) btnText.innerText = 'Загрузка...';
  if (icon) icon.classList.add('animate-spin');

  toast('Обновление серверов подписки...', 'info');
  try {
    const res = await api('vlessUpdateSubscription', url, true);
    const count = res.count || res.serverCount || (res.servers ? res.servers.length : 0);
    if (res && res.servers) {
      state.vpn.servers = res.servers;
      renderVpnServers();
    }
    toast(`Загружено серверов: ${count}. Замеряем пинг...`, 'info');
    if (btnText) btnText.innerText = 'Замер...';

    // Immediately test ping across fresh servers
    await api('vlessTestAll');
    const status = await api('vlessGetStatus');
    updateVpnUI(status);
    toast(`Подписка обновлена: ${count} узлов, пинг измерен`, 'success');
  } catch (e) {
    toast(e.message || 'Ошибка обновления подписки', 'error');
  } finally {
    if (btn) btn.disabled = false;
    if (btnText) btnText.innerText = 'Обновить';
    if (icon) icon.classList.remove('animate-spin');
  }
}
window.updateVpnSub = updateVpnSub;
window.vpnUpdateSub = updateVpnSub;

async function vpnTestAll() {
  const btn = $('#btn-test-servers');
  const btnText = $('#btn-test-servers-text');
  const dial = $('#test-servers-dial') || $('#test-servers-icon');

  if (btn) btn.disabled = true;
  if (btnText) btnText.innerText = 'Замер...';
  if (dial) dial.classList.add('animate-spin');

  toast('Замер пинга всех серверов...', 'info');
  try {
    const res = await api('vlessTestAll');
    const summary = res.summary || {};
    toast(`Тест: ${summary.ok || 0} доступно, ${summary.blocked || 0} блок`, 'info');
    const status = await api('vlessGetStatus');
    updateVpnUI(status);
  } catch (e) {
    toast(e.message || 'Ошибка замера пинга', 'error');
  } finally {
    if (btn) btn.disabled = false;
    if (btnText) btnText.innerText = 'Замерить пинг';
    if (dial) dial.classList.remove('animate-spin');
  }
}
window.vpnTestAll = vpnTestAll;
window.testAllServers = vpnTestAll;

// ─── Telegram Proxy Toggle ───
async function toggleTg() {
  if (state.tg.busy) return;
  state.tg.busy = true;

  try {
    if (state.tg.running) {
      setPowerBtnLoading('btn-tg-power', 'tg-power-icon', 'btn-tg-power-text', 'ВЫКЛЮЧЕНИЕ...');
      toast('Выключение TG Proxy...', 'info');
      await api('stopTgProxy');
    } else {
      setPowerBtnLoading('btn-tg-power', 'tg-power-icon', 'btn-tg-power-text', 'ПОДКЛЮЧЕНИЕ...');
      toast('Запуск TG Proxy...', 'info');
      await api('startTgProxy');
    }
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    state.tg.busy = false;
    clearPowerBtnLoading('btn-tg-power', 'tg-power-icon');
    const status = await api('getTgProxyStatus');
    updateTgProxyUI(status);
  }
}

async function openTg1Click() {
  try {
    await api('openTgProxyTelegram');
  } catch (e) {
    toast(e.message, 'error');
  }
}
window.openTg1Click = openTg1Click;

async function copyTgProxyLink() {
  try {
    const res = await api('copyTgProxyLink');
    let link = res?.link;
    if (!link) {
      const host = state.tg.host || '127.0.0.1';
      const port = state.tg.port || 1443;
      link = `tg://proxy?server=${host}&port=${port}&secret=ee000000000000000000000000000000007777772e636c6f7564666c6172652e636f6d`;
    }
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(link);
    }
    toast('Ссылка Telegram Proxy скопирована', 'success');
  } catch (err) {
    toast(err.message || 'Не удалось скопировать ссылку', 'error');
  }
}
window.copyTgProxyLink = copyTgProxyLink;

// ─── Strategy Probe ───
let probeTimerInterval = null;
let probeStartTime = 0;

async function runStrategyProbeFlow() {
  const modal = $('#strategyProbeProgressModal');
  const textEl = $('#strategyProbeProgressText');
  const fillEl = $('#strategyProbeProgressFill');
  const sumEl = $('#strategyProbeSummary');
  const timerEl = $('#strategyProbeTimer');
  const percentEl = $('#strategyProbePercent');

  if (modal) modal.classList.remove('hidden');
  if (textEl) textEl.innerText = 'Подготовка к тестированию...';
  if (fillEl) fillEl.style.width = '0%';
  if (percentEl) percentEl.innerText = '0%';
  if (sumEl) sumEl.innerText = 'Запуск быстрого подбора стратегий...';
  if (timerEl) timerEl.innerText = '00:00';

  probeStartTime = Date.now();
  if (probeTimerInterval) clearInterval(probeTimerInterval);
  probeTimerInterval = setInterval(() => {
    const elapsedSec = Math.floor((Date.now() - probeStartTime) / 1000);
    const mins = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
    const secs = String(elapsedSec % 60).padStart(2, '0');
    if (timerEl) timerEl.innerText = `${mins}:${secs}`;
  }, 500);


  try {
    const result = await api('runStrategyProbe');
    if (probeTimerInterval) {
      clearInterval(probeTimerInterval);
      probeTimerInterval = null;
    }

    if (modal) modal.classList.add('hidden');

    if (result && result.top3 && result.top3.length > 0) {
      const elapsed = result.totalTimeSec || Math.max(1, Math.round((Date.now() - probeStartTime) / 1000));
      renderStrategyProbeResults(result.top3, elapsed);
      const resModal = $('#strategyProbeResultsModal');
      if (resModal) resModal.classList.remove('hidden');
    } else {
      toast('Не удалось подобрать стратегии или проверка была прервана', 'error');
    }
  } catch (e) {
    if (probeTimerInterval) {
      clearInterval(probeTimerInterval);
      probeTimerInterval = null;
    }
    if (modal) modal.classList.add('hidden');
    toast(e.message || 'Ошибка проверки стратегий', 'error');
  }
}
window.runStrategyProbeFlow = runStrategyProbeFlow;
window.runStrategyProbeSim = runStrategyProbeFlow; // Backward compatibility alias

function renderStrategyProbeResults(top3, durationSec) {
  const container = $('#strategyProbeCardsList');
  if (!container) return;

  const durationEl = $('#strategyProbeDurationText');
  if (durationEl) {
    durationEl.innerText = `Проверено ${top3.length} лучших стратегий за ${durationSec} сек`;
  }

  container.innerHTML = top3.map((strat, idx) => {
    const isFirst = idx === 0;
    const badgeBg = isFirst
      ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/35'
      : (idx === 1 ? 'bg-teal-500/20 text-teal-300 border-teal-500/35' : 'bg-slate-500/20 text-slate-300 border-slate-500/30');

    const cardBorder = isFirst
      ? 'border-emerald-500/50 bg-[#141b25] shadow-[0_0_16px_rgba(16,185,129,0.12)] ring-1 ring-emerald-500/30'
      : 'border-white/10 bg-[#131720]/80 hover:border-white/20';

    const btnStyle = isFirst
      ? 'bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-white font-bold shadow-[0_2px_10px_rgba(16,185,129,0.3)]'
      : 'bg-white/10 hover:bg-white/15 text-slate-200 hover:text-white font-semibold border border-white/10';

    const ytBadge = strat.ytOk
      ? '<span class="text-[11px] font-medium text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">YouTube: OK</span>'
      : '<span class="text-[11px] font-medium text-slate-500 bg-white/[0.03] px-2 py-0.5 rounded border border-white/5">YouTube: —</span>';

    const dcBadge = strat.dcOk
      ? '<span class="text-[11px] font-medium text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">Discord: OK</span>'
      : '<span class="text-[11px] font-medium text-slate-500 bg-white/[0.03] px-2 py-0.5 rounded border border-white/5">Discord: —</span>';

    const pingText = strat.avgPing ? `${strat.avgPing} мс` : '—';

    return `
      <div class="inner-panel rounded-2xl p-3.5 border transition-all ${cardBorder}">
        <div class="flex items-center justify-between gap-3">
          <div class="flex items-center gap-2.5 min-w-0">
            <span class="px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider border ${badgeBg}">
              ${strat.badge}
            </span>
            <span class="text-sm font-bold text-white truncate" title="${strat.name}">${strat.name}</span>
          </div>
          <button onclick="applyProbedStrategy('${strat.file}')" class="h-8 px-4 rounded-xl text-xs flex-shrink-0 cursor-pointer active:scale-95 transition-all ${btnStyle}">
            Применить
          </button>
        </div>

        <p class="text-xs text-slate-400 mt-1.5 line-clamp-1" title="${strat.desc || ''}">${strat.desc || 'Оптимизированный профиль обхода блокировок'}</p>

        <div class="mt-2.5 pt-2 border-t border-white/5 flex items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            ${ytBadge}
            ${dcBadge}
          </div>
          <div class="flex items-center gap-1.5 text-xs text-slate-400 font-mono">
            <span>Пинг:</span>
            <span class="text-emerald-400 font-bold">${pingText}</span>
          </div>
        </div>
      </div>
    `;
  }).join('');
}
window.renderStrategyProbeResults = renderStrategyProbeResults;

async function applyProbedStrategy(stratFile) {
  closeStrategyProbeResults();
  await selectStrategy(stratFile);
  toast(`Применена стратегия: ${stratFile.replace(/\.bat$/i, '')}`, 'success');
}
window.applyProbedStrategy = applyProbedStrategy;

function closeStrategyProbeResults() {
  $('#strategyProbeResultsModal')?.classList.add('hidden');
}
window.closeStrategyProbeResults = closeStrategyProbeResults;

async function cancelStrategyProbe() {
  if (probeTimerInterval) {
    clearInterval(probeTimerInterval);
    probeTimerInterval = null;
  }
  $('#strategyProbeProgressModal')?.classList.add('hidden');
  try {
    await api('cancelStrategyProbe');
  } catch {}
  toast('Подбор стратегий отменён', 'info');
}
window.cancelStrategyProbe = cancelStrategyProbe;

// ─── First Launch Strategy Probe Offer ───
async function dismissFirstLaunchProbeModal() {
  $('#firstLaunchProbeModal')?.classList.add('hidden');
  try {
    localStorage.setItem('zapret_first_probe_dismissed', 'true');
  } catch {}
  try {
    await api('setFirstProbeDismissed');
  } catch {}
}
window.dismissFirstLaunchProbeModal = dismissFirstLaunchProbeModal;

async function startFirstLaunchProbe() {
  await dismissFirstLaunchProbeModal();
  runStrategyProbeFlow();
}
window.startFirstLaunchProbe = startFirstLaunchProbe;

// ─── Sites Management ───
function sanitizeDomain(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let str = raw.trim().toLowerCase();
  str = str.replace(/^[a-z]+:\/\//i, '');
  str = str.replace(/[/?#].*$/, '');
  str = str.replace(/:\d+$/, '');
  str = str.replace(/^[*@.]+/g, '');
  str = str.replace(/\.+$/g, '');
  if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(str)) {
    return str;
  }
  if (str.includes('.') && !str.includes(' ') && str.length >= 3) {
    return str;
  }
  return '';
}

async function handleSitesAdd(e) {
  if (e) e.preventDefault();
  const input = $('#sites-new-input');
  if (!input) return;
  const val = sanitizeDomain(input.value);
  if (!val) {
    toast('Введите корректный домен (например, notion.so)', 'error');
    return;
  }

  if (state.sites.main.includes(val)) {
    toast('Домен уже есть в списке', 'error');
    input.value = '';
    return;
  }

  const next = [val, ...state.sites.main];
  try {
    await api('saveSites', next);
    state.sites.main = next;
    input.value = '';
    renderSites();
    toast(`Домен ${val} добавлен в список`, 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}
window.handleSitesAdd = handleSitesAdd;

async function quickAddDomain(rawDomain) {
  const domain = sanitizeDomain(rawDomain);
  if (!domain) return;
  if (state.sites.main.includes(domain)) {
    toast(`Домен ${domain} уже в списке`, 'info');
    return;
  }
  const next = [domain, ...state.sites.main];
  try {
    await api('saveSites', next);
    state.sites.main = next;
    renderSites();
    toast(`Домен ${domain} добавлен`, 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}
window.quickAddDomain = quickAddDomain;

async function handleSitesPaste() {
  try {
    let text = '';
    if (typeof api === 'function') {
      try { text = await api('readClipboardText'); } catch {}
    }
    if (!text && navigator.clipboard) {
      try { text = await navigator.clipboard.readText(); } catch {}
    }
    if (!text || !text.trim()) {
      toast('Буфер обмена пуст', 'error');
      return;
    }
    const lines = text.split(/[\r\n,;\s]+/);
    const candidates = lines.map(sanitizeDomain).filter(Boolean);
    if (candidates.length === 0) {
      toast('В буфере обмена не найдено доменов', 'error');
      return;
    }
    const existing = new Set(state.sites.main);
    const added = [];
    for (const c of candidates) {
      if (!existing.has(c)) {
        existing.add(c);
        added.push(c);
      }
    }
    if (added.length === 0) {
      toast('Все домены из буфера уже есть в списке', 'info');
      return;
    }
    const next = [...added, ...state.sites.main];
    await api('saveSites', next);
    state.sites.main = next;
    renderSites();
    toast(`Добавлено новых доменов: ${added.length}`, 'success');
  } catch (err) {
    toast(err.message || 'Ошибка вставки', 'error');
  }
}
window.handleSitesPaste = handleSitesPaste;

async function handleSitesExport() {
  try {
    const res = await api('exportSitesDialog', { defaultName: 'list-general.txt' });
    if (res && res.saved) {
      toast(`Список сохранён: ${res.count || 0} доменов`, 'success');
    }
  } catch (err) {
    toast(err.message || 'Ошибка экспорта', 'error');
  }
}
window.handleSitesExport = handleSitesExport;

async function handleSitesImport() {
  try {
    const res = await api('importSitesDialog', { mode: 'merge' });
    if (res && res.imported && Array.isArray(res.sites)) {
      state.sites.main = res.sites;
      renderSites();
      toast(`Импортировано. Всего в списке: ${res.sites.length}`, 'success');
    }
  } catch (err) {
    toast(err.message || 'Ошибка импорта', 'error');
  }
}
window.handleSitesImport = handleSitesImport;

function handleSitesSearch(val) {
  state.sites.searchQuery = (val || '').trim();
  renderSites();
}
window.handleSitesSearch = handleSitesSearch;

// ─── Custom Domain Lists ───
async function loadCustomLists() {
  try {
    const res = await api('getCustomLists').catch(() => null);
    if (!res) return;
    state.sites.customLists = res.lists || [];
    state.sites.activeListId = res.activeListId || null;
    renderCustomLists();
  } catch {}
}

function renderCustomLists() {
  const select = $('#custom-list-select');
  const badge = $('#custom-list-active-badge');
  if (!select) return;

  const html = [];
  (state.sites.customLists || []).forEach(l => {
    const isSel = l.id === state.sites.activeListId ? 'selected' : '';
    const countStr = typeof l.count === 'number' ? ` (${l.count})` : '';
    html.push(`<option value="${l.id}" ${isSel}>${l.name || l.id}.txt${countStr}</option>`);
  });
  html.push(`<option value="" ${!state.sites.activeListId ? 'selected' : ''}>Не использовать</option>`);
  select.innerHTML = html.join('');

  if (badge) {
    if (state.sites.activeListId) {
      badge.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30';
      badge.innerText = 'Активен';
    } else {
      badge.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold bg-white/10 text-slate-400 border border-white/10';
      badge.innerText = 'Отключён';
    }
  }
}

async function handleCustomListChange(listId) {
  try {
    const res = await api('setActiveCustomList', listId || null);
    state.sites.activeListId = listId || null;
    if (res && res.lists) state.sites.customLists = res.lists;
    renderCustomLists();
    toast(listId ? 'Дополнительный список активирован' : 'Дополнительный список отключён', 'info');
  } catch (err) {
    toast(err.message, 'error');
  }
}
window.handleCustomListChange = handleCustomListChange;

async function handleCreateCustomList() {
  const name = prompt('Введите имя нового списка (например: work-sites):');
  if (!name || !name.trim()) return;
  try {
    const res = await api('createCustomList', name.trim());
    if (res && res.lists) {
      state.sites.customLists = res.lists;
      state.sites.activeListId = res.createdId || res.activeListId;
      renderCustomLists();
      toast(`Список «${name.trim()}» создан и подключён`, 'success');
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}
window.handleCreateCustomList = handleCreateCustomList;

async function handleDeleteCustomList() {
  const curId = state.sites.activeListId;
  if (!curId) {
    toast('Выберите дополнительный список для удаления', 'info');
    return;
  }
  const item = state.sites.customLists.find(l => l.id === curId);
  const displayName = item ? item.name : curId;
  if (!confirm(`Удалить список «${displayName}»?`)) return;

  try {
    const res = await api('deleteCustomList', curId);
    if (res && res.lists) {
      state.sites.customLists = res.lists;
      state.sites.activeListId = res.activeListId || null;
      renderCustomLists();
      toast(`Список «${displayName}» удалён`, 'info');
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}
window.handleDeleteCustomList = handleDeleteCustomList;

function toggleIpsetHelp() {
  toast('IPSet фильтрация: перехватывает запросы только к заблокированным IP-адресам (ipset-all.txt), снижая нагрузку. Рекомендуется «Загружен».', 'info');
}
window.toggleIpsetHelp = toggleIpsetHelp;

async function deleteSite(site) {
  const next = state.sites.main.filter(s => s !== site);
  try {
    await api('saveSites', next);
    state.sites.main = next;
    renderSites();
    toast(`Домен ${site} удалён`, 'info');
  } catch (err) {
    toast(err.message, 'error');
  }
}
window.deleteSite = deleteSite;

function renderSites() {
  const container = $('#sites-list-container');
  const countPill = $('#sites-count-pill');
  if (!container) return;

  const query = (state.sites.searchQuery || '').toLowerCase();
  const filtered = state.sites.main.filter(s => s.toLowerCase().includes(query));

  if (countPill) countPill.innerText = `${state.sites.main.length} доменов`;

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="h-32 flex flex-col items-center justify-center text-slate-500 text-xs">
        ${query ? 'Ничего не найдено' : 'Список доменов пуст'}
      </div>`;
    return;
  }

  container.innerHTML = filtered.map(site => `
    <div class="inner-panel rounded-xl px-3 py-2 flex items-center justify-between gap-2 group hover:border-white/20 transition-all">
      <span class="text-xs font-mono text-slate-200 truncate select-text">${site}</span>
      <button data-site="${encodeURIComponent(site)}" class="text-slate-500 hover:text-rose-400 p-1 rounded-md transition-colors cursor-pointer" title="Удалить домен">
        <svg class="w-3.5 h-3.5 stroke-current stroke-2 fill-none pointer-events-none" viewBox="0 0 24 24"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/></svg>
      </button>
    </div>
  `).join('');

  if (!container._hasDelegatedListener) {
    container._hasDelegatedListener = true;
    container.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-site]');
      if (btn && btn.dataset.site) {
        deleteSite(decodeURIComponent(btn.dataset.site));
      }
    });
  }
}

// ─── Settings Controls ───
async function setCloseBehavior(mode) {
  state.settings.closeBehavior = mode;
  ['ask', 'tray', 'quit'].forEach(m => {
    const btn = $(`#btn-close-${m}`);
    if (btn) {
      if (m === mode) {
        btn.className = 'h-7 rounded-lg text-xs font-semibold text-emerald-400 bg-white/10 border border-emerald-500/30 transition-all cursor-pointer flex items-center justify-center';
      } else {
        btn.className = 'h-7 rounded-lg text-xs font-semibold text-slate-400 hover:text-white border border-transparent transition-all cursor-pointer flex items-center justify-center';
      }
    }
  });
  try {
    await api('setCloseBehavior', mode);
    toast(`Режим закрытия: ${mode === 'tray' ? 'В трей' : mode === 'ask' ? 'Спрашивать' : 'Закрывать'}`, 'info');
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function toggleSetting(key, checked) {
  try {
    if (key === 'startMinimized') {
      state.settings.startMinimized = checked;
      await api('setStartMinimized', checked);
    } else if (key === 'autostartZapret') {
      state.settings.autostartZapret = checked;
      await api('setAutostartZapret', checked);
    } else if (key === 'autostartTg') {
      state.settings.autostartTg = checked;
      await api('setAutostartTg', checked);
    } else if (key === 'autoUpdates') {
      state.settings.autoUpdates = checked;
      await api('setAutoUpdate', checked);
    }
  } catch (e) {
    toast(e.message, 'error');
  }
}

function renderIpsetButtons(modeRaw) {
  const mode = (typeof modeRaw === 'object' && modeRaw?.status) ? modeRaw.status : (typeof modeRaw === 'string' ? modeRaw : 'loaded');
  state.settings.ipsetMode = mode;
  ['loaded', 'none', 'any'].forEach(m => {
    const btn = $(`#btn-ipset-${m}`);
    if (btn) {
      if (m === mode) {
        btn.className = 'h-7 rounded-lg text-xs font-semibold text-emerald-400 bg-white/10 border border-emerald-500/30 transition-all cursor-pointer flex items-center justify-center';
      } else {
        btn.className = 'h-7 rounded-lg text-xs font-semibold text-slate-400 hover:text-white border border-transparent transition-all cursor-pointer flex items-center justify-center';
      }
    }
  });
}
window.renderIpsetButtons = renderIpsetButtons;

async function setIpsetMode(modeRaw) {
  const mode = (typeof modeRaw === 'object' && modeRaw?.status) ? modeRaw.status : (typeof modeRaw === 'string' ? modeRaw : 'loaded');
  renderIpsetButtons(mode);
  try {
    const res = await api('setIpset', mode);
    if (res?.status) renderIpsetButtons(res.status);
    toast(`IPSet фильтр: ${mode === 'loaded' ? 'Загружен' : mode === 'none' ? 'Отключён' : 'Любые IP'}`, 'info');
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function checkAllUpdatesSim() {
  const btn = $('#btn-settings-update-text');
  const icon = $('#settings-update-icon');
  if (btn) btn.innerText = 'Проверка...';
  if (icon) icon.classList.add('animate-spin');

  try {
    const all = await api('checkAllUpdates');
    if (all?.hub?.updateAvailable) {
      _pendingHubUpdate = all.hub;
      updateChangelogInstallButton();
      showHubUpdateModal(all.hub);
    } else if (all?.zapret?.updateAvailable) {
      toast('Доступно обновление базы правил Zapret!', 'info');
      openChangelogModal();
    } else {
      const currentVer = (all?.hub?.local || state.version || '2.0.1').replace(/^v/i, '');
      toast(`У вас установлена последняя версия Zapret HUB (v${currentVer})`, 'success');
    }
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    if (btn) btn.innerText = 'Обновить';
    if (icon) icon.classList.remove('animate-spin');
  }
}

async function runDiagnosticsSim() {
  const btn = $('#btn-settings-diag-text');
  const icon = $('#settings-diag-icon');
  if (btn) btn.innerText = 'Проверка сети...';
  if (icon) icon.classList.add('animate-pulse');

  try {
    const diag = await api('runDiagnostics');
    const fails = Array.isArray(diag) ? diag.filter(r => r.severity === 'fail') : [];
    const warns = Array.isArray(diag) ? diag.filter(r => r.severity === 'warn') : [];

    if (fails.length > 0) {
      toast(`Диагностика: найдено проблем — ${fails.length}. Проверьте настройки и службы.`, 'error');
    } else if (warns.length > 0) {
      toast(`Диагностика: ${warns.length} предупреждений, критических ошибок нет`, 'info');
    } else {
      toast('Диагностика завершена: все компоненты в норме', 'success');
    }
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    if (btn) btn.innerText = 'Запустить проверку';
    if (icon) icon.classList.remove('animate-pulse');
  }
}

// ─── UI Renderers ───
function updateZapretUI(status) {
  state.zapret.running = Boolean(status?.running);
  if (status?.lastStrategy) {
    state.zapret.activeStrategy = status.lastStrategy;
    $('#active-strategy-name').innerText = status.lastStrategy.replace(/\.bat$/i, '');
    renderStrategyDropdown();
  }

  const card = $('#zapret-card');
  const dot = $('#zapret-dot');
  const title = $('#zapret-title');
  const desc = $('#zapret-desc');
  const btn = $('#btn-zapret-power');
  const btnText = $('#zapret-power-text');
  const zapretIcon = $('#zapret-power-icon');
  const ytBadge = $('#yt-status-badge');
  const discordBadge = $('#discord-status-badge');

  if (state.zapret.running) {
    if (card) {
      card.classList.add('slate-card-active');
    }
    if (dot) dot.className = 'w-3 h-3 rounded-full bg-emerald-400 flex-shrink-0';
    if (title) title.innerText = 'Обход включён';
    if (desc) desc.innerText = 'YouTube и Discord работают без замедления и ограничений';
    if (btn) {
      btn.className = 'btn-power-on';
    }
    if (btnText) btnText.innerText = 'ВЫКЛЮЧИТЬ';
    if (zapretIcon) {
      zapretIcon.innerHTML = POWER_ICON_HTML;
      zapretIcon.classList.remove('animate-spin');
      zapretIcon.className = 'w-5 h-5 stroke-white stroke-2 fill-none flex-shrink-0';
    }

    if (ytBadge) {
      ytBadge.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center gap-1';
      ytBadge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> Включён';
    }
    if (discordBadge) {
      discordBadge.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center gap-1';
      discordBadge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> Включён';
    }
  } else {
    if (card) {
      card.classList.remove('slate-card-active');
    }
    if (dot) dot.className = 'w-3 h-3 rounded-full bg-slate-500 flex-shrink-0';
    if (title) title.innerText = 'Обход выключен';
    if (desc) desc.innerText = 'Нажмите «Включить», чтобы запустить обход блокировок';
    if (btn) {
      btn.className = 'btn-power-off';
    }
    if (btnText) btnText.innerText = 'ВКЛЮЧИТЬ';
    if (zapretIcon) {
      zapretIcon.innerHTML = POWER_ICON_HTML;
      zapretIcon.classList.remove('animate-spin');
      zapretIcon.className = 'w-5 h-5 stroke-emerald-400 stroke-2 fill-none flex-shrink-0';
    }

    if (ytBadge) {
      ytBadge.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold bg-white/10 text-slate-400 border border-white/10 flex items-center gap-1';
      ytBadge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-slate-500"></span> Пауза';
    }
    if (discordBadge) {
      discordBadge.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold bg-white/10 text-slate-400 border border-white/10 flex items-center gap-1';
      discordBadge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-slate-500"></span> Пауза';
    }
  }
  updateFooterStatus();
}

function pluralizeNodes(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod100 >= 11 && mod100 <= 19) return 'узлов';
  if (mod10 === 1) return 'узел';
  if (mod10 >= 2 && mod10 <= 4) return 'узла';
  return 'узлов';
}

function updateVpnUI(status) {
  if (!status) return;
  state.vpn.running = Boolean(status.running);
  state.vpn.activeServerIndex = status.activeServerIndex ?? -1;
  state.vpn.servers = status.servers || [];
  state.vpn.activeServer = status.activeServer || null;
  if (status.subscriptionUrl) {
    state.vpn.subscriptionUrl = status.subscriptionUrl;
    state.vpn.subUrl = status.subscriptionUrl;
  }

  const card = $('#vpn-hero-card');
  const dot = $('#vpn-status-dot');
  const title = $('#vpn-status-title');
  const btn = $('#btn-vpn-power');
  const btnText = $('#vpn-power-text');
  const vpnIcon = $('#vpn-power-icon');
  const connBar = $('#vpn-connection-bar');
  const connDot = $('#vpn-active-dot');
  const connPing = $('#vpn-active-ping');
  const connIp = $('#vpn-active-ip');
  const activeNode = $('#vpn-active-node');
  const activeIndicator = $('#vpn-active-indicator');

  // Subscription service name and days left
  const subInfo = status.subscriptionInfo || {};
  const serviceNameEl = $('#sub-service-name');
  if (serviceNameEl) {
    serviceNameEl.innerText = subInfo.serviceName || status.serviceName || 'DedVPN Private';
  }
  const daysLeftEl = $('#sub-days-left');
  if (daysLeftEl) {
    const days = typeof status.daysLeft === 'number'
      ? status.daysLeft
      : (typeof subInfo.daysLeft === 'number' ? subInfo.daysLeft : null);
    if (typeof days === 'number') {
      daysLeftEl.innerText = `Осталось ${days} ${pluralizeDays(days)}`;
    } else {
      daysLeftEl.innerText = 'Подписка активна';
    }
  }

  // Populate subscription URL into input if input is currently empty
  const subInput = $('#vpn-sub-input');
  if (subInput && !subInput.value.trim() && (status.subscriptionUrl || status.subUrl)) {
    subInput.value = status.subscriptionUrl || status.subUrl;
  }

  const total = state.vpn.servers.length;
  const okCount = state.vpn.servers.filter(s => s.status === 'ok').length;
  const blockedCount = state.vpn.servers.filter(s => s.status === 'blocked').length;

  // Update smart ping badge with lowest ping among working servers
  const workingServers = (state.vpn.servers || []).filter(s => s.status === 'ok' && typeof s.ping === 'number' && s.ping > 0);
  const bestPing = workingServers.length > 0 ? Math.min(...workingServers.map(s => s.ping)) : null;
  const smartPingBadge = $('#vpn-smart-ping-badge');
  if (smartPingBadge) {
    smartPingBadge.innerText = bestPing !== null ? `${bestPing} мс` : '—';
  }

  // Update nodes count badge
  const badge = $('#sub-nodes-badge');
  if (badge) {
    if (blockedCount > 0) {
      badge.innerHTML = `<span class="text-emerald-400 font-bold">${okCount}</span>/${total} активны`;
    } else {
      badge.innerText = `${total} ${pluralizeNodes(total)}`;
    }
  }

  // Update sync status text
  const syncStatus = $('#sub-sync-status');
  if (syncStatus) {
    if (total > 0) {
      if (blockedCount > 0) {
        syncStatus.innerHTML = `Доступно: <span class="text-emerald-400 font-semibold">${okCount}</span>, в блоке: <span class="text-rose-400 font-semibold">${blockedCount}</span>`;
      } else {
        syncStatus.innerText = `Узлов в базе: ${total}`;
      }
    } else {
      syncStatus.innerText = 'Подписка не загружена';
    }
  }

  // Update bottom summary in right card
  const bottomSummary = $('#sub-bottom-summary');
  if (bottomSummary) {
    if (total > 0) {
      if (blockedCount > 0 && okCount > 0) {
        bottomSummary.innerHTML = `<span class="text-emerald-400 font-semibold">${okCount}</span> из ${total} ${pluralizeNodes(total)} готовы к работе <span class="text-rose-400/90 font-medium">(${blockedCount} в блоке)</span>`;
      } else if (blockedCount > 0 && okCount === 0) {
        bottomSummary.innerHTML = `<span class="text-rose-400 font-semibold">Все узлы (${blockedCount}) заблокированы ТСПУ</span>`;
      } else if (okCount > 0 && blockedCount === 0) {
        bottomSummary.innerHTML = `Все <span class="text-emerald-400 font-semibold">${total}</span> ${pluralizeNodes(total)} готовы к работе`;
      } else {
        bottomSummary.innerText = `В базе ${total} ${pluralizeNodes(total)} (замерьте пинг)`;
      }
    } else {
      bottomSummary.innerText = 'Вставьте ссылку на подписку';
    }
  }

  const flagContainer = $('#vpn-active-flag');

  if (state.vpn.running) {
    if (card) card.classList.add('slate-card-active');
    if (dot) dot.className = 'w-3 h-3 rounded-full bg-emerald-400 flex-shrink-0';
    if (title) title.innerText = 'VPN подключение';
    if (btn) {
      btn.className = 'w-full h-[48px] rounded-2xl font-bold text-sm bg-gradient-to-b from-[#059669] to-[#047857] hover:from-[#10b981] hover:to-[#059669] text-white border border-emerald-500/30 shadow-[0_2px_8px_rgba(5,150,105,0.25)] hover:shadow-[0_4px_14px_rgba(5,150,105,0.35)] active:scale-95 flex items-center justify-center gap-2.5 cursor-pointer transition-all';
    }
    if (btnText) btnText.innerText = 'ВЫКЛЮЧИТЬ';
    if (vpnIcon) {
      vpnIcon.innerHTML = POWER_ICON_HTML;
      vpnIcon.classList.remove('animate-spin');
      vpnIcon.className = 'w-5 h-5 stroke-white stroke-2 fill-none flex-shrink-0';
    }
    if (connBar) {
      connBar.classList.remove('opacity-50');
      connBar.style.borderColor = 'rgba(16, 185, 129, 0.45)';
    }
    if (connDot) connDot.className = 'w-1.5 h-1.5 rounded-full bg-emerald-400';
    if (activeIndicator) {
      activeIndicator.classList.add('active');
      activeIndicator.title = 'Подключено';
    }

    const currentServer = state.vpn.servers[state.vpn.activeServerIndex] || status.activeServer;
    if (currentServer) {
      if (currentServer.name) {
        localStorage.setItem('vpn_last_active_server_name', currentServer.name);
      }
      const cCode = detectCountryCode(currentServer.name || '');
      if (flagContainer) {
        flagContainer.innerHTML = `<div class="w-6 h-4 rounded-[3px] overflow-hidden shadow-sm flex-shrink-0 border border-white/15 select-none">${getCountryFlagSvg(cCode)}</div>`;
      }
      if (activeNode) activeNode.innerText = cleanServerName(currentServer.name || 'VLESS Node');
      if (connPing) connPing.innerText = currentServer.ping ? `${currentServer.ping} мс` : '—';
      if (connIp) connIp.innerText = currentServer.ip || currentServer.address || currentServer.server || '127.0.0.1';
    }
  } else {
    if (card) card.classList.remove('slate-card-active');
    if (dot) dot.className = 'w-3.5 h-3.5 rounded-full bg-slate-500';
    if (title) title.innerText = 'VPN подключение (выкл)';
    if (btn) {
      btn.className = 'w-full h-[48px] rounded-2xl font-bold text-sm bg-[#333d52] hover:bg-[#3d4961] text-white border border-white/10 active:scale-95 flex items-center justify-center gap-2.5 cursor-pointer transition-all';
    }
    if (btnText) btnText.innerText = 'ВКЛЮЧИТЬ';
    if (vpnIcon) {
      vpnIcon.innerHTML = POWER_ICON_HTML;
      vpnIcon.classList.remove('animate-spin');
      vpnIcon.className = 'w-5 h-5 stroke-emerald-400 stroke-2 fill-none flex-shrink-0';
    }
    if (connBar) {
      connBar.classList.add('opacity-50');
      connBar.style.borderColor = '';
    }
    if (connDot) connDot.className = 'w-1.5 h-1.5 rounded-full bg-slate-500';
    if (activeIndicator) {
      activeIndicator.classList.remove('active');
      activeIndicator.title = 'Отключено';
    }
    if (flagContainer) {
      flagContainer.innerHTML = `<div class="w-6 h-4 rounded-[3px] overflow-hidden shadow-sm flex-shrink-0 border border-white/15 select-none">${getCountryFlagSvg('GLOBAL')}</div>`;
    }
    if (activeNode) activeNode.innerText = 'Не подключено';
    if (connPing) connPing.innerText = '—';
    if (connIp) connIp.innerText = '—';
  }

  renderVpnServers();
  updateFooterStatus();
}

function buildVpnPingBadge(srv) {
  if (srv.status === 'blocked') {
    return '<span class="text-[11px] font-mono text-rose-400 bg-rose-500/10 px-2 py-0.5 rounded-md border border-rose-500/20">Блок</span>';
  } else if (typeof srv.ping === 'number' && srv.ping > 0) {
    const pingCol = srv.ping < 80 ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' : (srv.ping < 160 ? 'text-amber-400 bg-amber-500/10 border-amber-500/20' : 'text-slate-400 bg-white/[0.04] border-white/5');
    return `<span class="text-xs font-mono font-medium ${pingCol} px-2 py-0.5 rounded-md border">${srv.ping} мс</span>`;
  }
  return '<span class="text-xs font-mono text-slate-400 bg-white/[0.04] px-2 py-0.5 rounded-md border border-white/5">—</span>';
}

function updateVpnServerCard(idx, srv) {
  const card = $(`#node-card-${idx}`);
  if (!card) return;
  const pingContainer = card.querySelector('[data-vpn-ping]');
  if (pingContainer) {
    pingContainer.innerHTML = buildVpnPingBadge(srv);
  }
}

function renderVpnServers() {
  const container = $('#vpn-servers-list') || $('#vpn-servers-scroll');
  if (!container) return;

  if (!state.vpn.servers || state.vpn.servers.length === 0) {
    container.innerHTML = `
      <div class="h-44 flex flex-col items-center justify-center text-center p-4 text-slate-500 text-xs">
        <svg class="w-8 h-8 stroke-slate-600 stroke-1.5 fill-none mb-2" viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>
        <span>Список серверов пуст</span>
        <span class="text-[11px] text-slate-600 mt-1">Вставьте ссылку на подписку и нажмите «Обновить»</span>
      </div>`;
    return;
  }

  // Targeted update if list count is unchanged
  const existingCards = container.querySelectorAll('[id^="node-card-"]');
  if (existingCards.length === state.vpn.servers.length) {
    state.vpn.servers.forEach((srv, idx) => {
      const card = $(`#node-card-${idx}`);
      if (!card) return;
      const isCurrent = state.vpn.running && state.vpn.activeServerIndex === idx;
      if (isCurrent) {
        card.className = 'inner-panel rounded-2xl p-3 flex items-center justify-between gap-3 border transition-all node-card-active cursor-default';
        card.removeAttribute('onclick');
      } else {
        card.className = 'inner-panel rounded-2xl p-3 flex items-center justify-between gap-3 border transition-all border-white/10 hover:border-white/20 bg-[#141923]/60 hover:bg-[#141923] cursor-pointer active:scale-[0.99]';
        card.setAttribute('onclick', `connectServer(${idx})`);
      }
      const pingContainer = card.querySelector('[data-vpn-ping]');
      if (pingContainer) pingContainer.innerHTML = buildVpnPingBadge(srv);
      const actionContainer = card.querySelector('[data-vpn-action]');
      if (actionContainer) {
        actionContainer.innerHTML = isCurrent
          ? '<button class="h-7 px-3 rounded-lg text-[11px] font-semibold text-emerald-400 bg-emerald-500/15 border border-emerald-500/30 cursor-default">Подключено</button>'
          : `<button onclick="event.stopPropagation(); connectServer(${idx})" class="h-7 px-3 rounded-lg text-[11px] font-medium text-slate-300 hover:text-white bg-white/10 hover:bg-white/15 border border-white/10 cursor-pointer active:scale-95 transition-all">Подключить</button>`;
      }
    });
    return;
  }

  container.innerHTML = state.vpn.servers.map((srv, idx) => {
    const isCurrent = state.vpn.running && state.vpn.activeServerIndex === idx;
    const pingBadge = buildVpnPingBadge(srv);

    const rawName = srv.name || `Сервер #${idx + 1}`;
    const cleanTitle = cleanServerName(rawName);
    const countryCode = detectCountryCode(rawName);
    const flagSvg = getCountryFlagSvg(countryCode);

    const protoText = `${(srv.protocol || 'VLESS').toUpperCase()} · ${(srv.security === 'reality' ? 'Reality' : (srv.security ? srv.security.toUpperCase() : 'TLS'))} · ${(srv.network || 'tcp').toUpperCase()}`;
    const hostPort = `${srv.address || srv.server || ''}:${srv.port || 443}`;

    const cardBg = isCurrent
      ? 'node-card-active'
      : 'border-white/10 hover:border-white/20 bg-[#141923]/60 hover:bg-[#141923]';

    const cardClickAttr = isCurrent ? '' : `onclick="connectServer(${idx})"`;
    const cardCursorClass = isCurrent ? 'cursor-default' : 'cursor-pointer active:scale-[0.99]';

    const btnHtml = isCurrent
      ? '<button class="h-7 px-3 rounded-lg text-[11px] font-semibold text-emerald-400 bg-emerald-500/15 border border-emerald-500/30 cursor-default">Подключено</button>'
      : `<button onclick="event.stopPropagation(); connectServer(${idx})" class="h-7 px-3 rounded-lg text-[11px] font-medium text-slate-300 hover:text-white bg-white/10 hover:bg-white/15 border border-white/10 cursor-pointer active:scale-95 transition-all">Подключить</button>`;

    return `
      <div id="node-card-${idx}" ${cardClickAttr} class="inner-panel rounded-2xl p-3 flex items-center justify-between gap-3 border transition-all ${cardBg} ${cardCursorClass}">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-6 h-4 rounded-[3px] overflow-hidden shadow-sm flex-shrink-0 border border-white/15 select-none">
            ${flagSvg}
          </div>
          <div class="min-w-0">
            <span class="text-xs font-bold text-white truncate block" title="${cleanTitle}">${cleanTitle}</span>
            <span class="text-[11px] text-slate-400 block mt-0.5 truncate" title="${protoText} · ${hostPort}">${protoText} · ${hostPort}</span>
          </div>
        </div>
        <div class="flex items-center gap-2.5 flex-shrink-0">
          <div data-vpn-ping>${pingBadge}</div>
          <div data-vpn-action>${btnHtml}</div>
        </div>
      </div>
    `;
  }).join('');
}

function updateTgProxyUI(status) {
  state.tg.running = Boolean(status?.running);
  state.tg.installed = Boolean(status?.installed);
  state.tg.proxyUrl = status?.proxyUrl || null;

  const card = $('#tg-card');
  const badge = $('#tg-status-badge');
  const clientDesc = $('#tg-client-desc');
  const btn = $('#btn-tg-power');
  const btnText = $('#btn-tg-power-text');
  const tgIcon = $('#tg-power-icon');

  if (state.tg.running) {
    if (card) card.classList.add('tg-card-active');
    if (badge) {
      badge.className = 'px-2.5 py-1 rounded-full text-[11px] font-bold bg-[#229ed9]/25 text-[#229ed9] border border-[#229ed9]/45 whitespace-nowrap flex-shrink-0';
      badge.innerText = 'В СЕТИ';
    }
    if (clientDesc) {
      clientDesc.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> Готов к работе';
      clientDesc.className = 'text-emerald-400 font-bold flex items-center gap-1.5';
    }
    if (btn) {
      btn.className = 'w-full h-[48px] rounded-2xl text-sm font-bold bg-gradient-to-b from-[#1a85b8] to-[#156d98] hover:from-[#229ed9] hover:to-[#1a85b8] text-white border border-sky-500/30 shadow-[0_2px_8px_rgba(34,158,217,0.25)] hover:shadow-[0_4px_14px_rgba(34,158,217,0.35)] active:scale-95 flex items-center justify-center gap-2.5 cursor-pointer transition-all';
    }
    if (btnText) btnText.innerText = 'ВЫКЛЮЧИТЬ';
    if (tgIcon) {
      tgIcon.innerHTML = POWER_ICON_HTML;
      tgIcon.classList.remove('animate-spin');
      tgIcon.className = 'w-5 h-5 stroke-white stroke-2 fill-none flex-shrink-0';
    }
    const pingEl = $('#tg-ping-val');
    if (pingEl) {
      pingEl.innerText = status?.pingMs ? `${status.pingMs} мс` : '< 10 мс';
      pingEl.className = 'text-emerald-400 font-mono font-semibold';
    }
  } else {
    if (card) card.classList.remove('tg-card-active');
    if (badge) {
      badge.className = 'px-2.5 py-1 rounded-full text-[11px] font-bold bg-[#2b3548] text-slate-400 border border-white/10 whitespace-nowrap flex-shrink-0';
      badge.innerText = 'ПАУЗА';
    }
    if (clientDesc) {
      clientDesc.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-slate-500"></span> Шлюз на паузе';
      clientDesc.className = 'text-slate-400 font-bold flex items-center gap-1.5';
    }
    if (btn) {
      btn.className = 'w-full h-[48px] rounded-2xl text-sm font-bold bg-[#333d52] hover:bg-[#3d4961] text-white border border-white/10 active:scale-95 flex items-center justify-center gap-2.5 cursor-pointer transition-all';
    }
    if (btnText) btnText.innerText = 'ВКЛЮЧИТЬ';
    if (tgIcon) {
      tgIcon.innerHTML = POWER_ICON_HTML;
      tgIcon.classList.remove('animate-spin');
      tgIcon.className = 'w-5 h-5 stroke-sky-400 stroke-2 fill-none flex-shrink-0';
    }
    const pingEl = $('#tg-ping-val');
    if (pingEl) {
      pingEl.innerText = '—';
      pingEl.className = 'text-slate-500 font-mono font-semibold';
    }
  }
}

function updateFooterStatus() {
  const dot = $('#footer-status-dot');
  const desc = $('#footer-status-desc');
  const pingEl = $('#footer-ping-text');

  let activePing = null;
  if (state.vpn.running) {
    const cur = state.vpn.servers[state.vpn.activeServerIndex] || state.vpn.activeServer;
    if (cur && cur.ping) activePing = `${cur.ping} мс`;
    else activePing = '36 мс';
  } else if (state.tg.running && state.tg.pingMs) {
    activePing = `${state.tg.pingMs} мс`;
  } else if (state.zapret.running) {
    activePing = '< 20 мс';
  }

  if (pingEl) {
    pingEl.innerText = activePing || '—';
  }

  if (state.zapret.running && state.vpn.running) {
    if (dot) dot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400 transition-colors';
    if (desc) desc.innerText = 'Zapret и VPN активны';
  } else if (state.zapret.running) {
    if (dot) dot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400 transition-colors';
    if (desc) desc.innerText = 'Обход Zapret DPI активен';
  } else if (state.vpn.running) {
    if (dot) dot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400 transition-colors';
    if (desc) desc.innerText = 'VPN VLESS Reality активен';
  } else {
    if (dot) dot.className = 'w-2.5 h-2.5 rounded-full bg-slate-500 transition-colors';
    if (desc) desc.innerText = 'Все сервисы остановлены';
  }
}

// ─── App Initialization ───
document.addEventListener('DOMContentLoaded', async () => {
  // Bind Window Controls
  $('#btnWinMinimize')?.addEventListener('click', () => api('windowMinimize'));
  $('#btnWinClose')?.addEventListener('click', () => api('windowClose'));

  // Close Choice Modal Actions
  $('#btnCloseToTray')?.addEventListener('click', () => {
    $('#closeChoiceModal')?.classList.add('hidden');
    api('windowCloseChoice', 'tray');
  });
  $('#btnCloseQuit')?.addEventListener('click', () => {
    $('#closeChoiceModal')?.classList.add('hidden');
    api('windowCloseChoice', 'quit');
  });

  // Changelog Modal Close Button
  $('#btn-close-changelog')?.addEventListener('click', closeChangelogModal);

  // Strategy Probe Cancel
  $('#btnStrategyProbeCancel')?.addEventListener('click', () => {
    api('cancelStrategyProbe');
    $('#strategyProbeProgressModal')?.classList.add('hidden');
  });

  // Sites Search
  $('#sites-search-input')?.addEventListener('input', (e) => {
    state.sites.searchQuery = e.target.value;
    renderSites();
  });

  // Initial Data Fetch
  try {
    const [status, strategies, sites, tgStatus, vlessStatus, settings] = await Promise.all([
      api('getStatus').catch(() => null),
      api('getStrategies').catch(() => []),
      api('getSites').catch(() => []),
      api('getTgProxyStatus').catch(() => null),
      api('vlessGetStatus').catch(() => null),
      api('getSettings').catch(() => null)
    ]);

    // Strategies
    if (strategies && strategies.length > 0) {
      state.zapret.strategies = strategies;
      renderStrategyDropdown();
    }

    // Statuses
    if (status) updateZapretUI(status);
    if (tgStatus) updateTgProxyUI(tgStatus);
    if (vlessStatus) updateVpnUI(vlessStatus);

    // Auto-sync VPN subscription in background on startup to guarantee fresh server list
    api('vlessUpdateSubscription', null, false)
      .then(res => {
        if (res && res.servers) {
          api('vlessGetStatus').then(s => updateVpnUI(s)).catch(() => {});
        }
      })
      .catch(() => {});

    // Sites
    if (Array.isArray(sites)) {
      state.sites.main = sites;
      renderSites();
    }

    // Settings
    if (settings) {
      if (settings.closeBehavior) setCloseBehavior(settings.closeBehavior);
      if (typeof settings.startMinimized === 'boolean') {
        const t = $('#toggle-start-minimized');
        if (t) t.checked = settings.startMinimized;
      }
      if (typeof settings.autostartZapret === 'boolean') {
        const t = $('#toggle-autostart-zapret');
        if (t) t.checked = settings.autostartZapret;
      }
      if (typeof settings.autostartTgProxy === 'boolean') {
        const t = $('#toggle-autostart-tg');
        if (t) t.checked = settings.autostartTgProxy;
      }
      if (typeof settings.autoCheckUpdates === 'boolean') {
        const t = $('#toggle-auto-updates');
        if (t) t.checked = settings.autoCheckUpdates;
      }
      renderIpsetButtons(settings.ipset || 'loaded');
    } else {
      renderIpsetButtons('loaded');
    }

    // Custom Lists
    loadCustomLists().catch(() => {});

    // First Launch Strategy Probe Check
    try {
      const cfg = await api('getConfig').catch(() => null);
      const isDismissedConfig = Boolean(cfg?.firstProbePromptDismissed);
      let isDismissedLocal = false;
      try {
        isDismissedLocal = localStorage.getItem('zapret_first_probe_dismissed') === 'true';
      } catch {}
      if (!isDismissedConfig && !isDismissedLocal) {
        setTimeout(() => {
          $('#firstLaunchProbeModal')?.classList.remove('hidden');
        }, 500);
      }
    } catch {}
  } catch (err) {
    console.error('Initialization error:', err);
  }

  // Footer Quick Navigation
  $('#footer-status-desc')?.parentElement?.classList.add('cursor-pointer', 'hover:opacity-80', 'transition-opacity');
  $('#footer-status-desc')?.parentElement?.addEventListener('click', () => {
    if (state.vpn.running) navigateTo('vpn');
    else navigateTo('home');
  });
  $('#footer-ping-text')?.parentElement?.classList.add('cursor-pointer', 'hover:opacity-80', 'transition-opacity');
  $('#footer-ping-text')?.parentElement?.addEventListener('click', () => {
    navigateTo('vpn');
  });

  // Register Backend Events
  window.zapretAPI?.onStatusChanged?.((newStatus) => updateZapretUI(newStatus));
  window.zapretAPI?.onTgProxyChanged?.((newTg) => updateTgProxyUI(newTg));
  window.zapretAPI?.onVlessStatusChanged?.((newVless) => updateVpnUI(newVless));
  window.zapretAPI?.onVlessTestProgress?.((data) => {
    if (!data) return;
    const btnText = $('#btn-update-sub-text');
    if (btnText && data.current && data.total) {
      btnText.innerText = `${data.current}/${data.total}`;
    }
    if (typeof data.index === 'number' && data.server) {
      if (state.vpn.servers && state.vpn.servers[data.index]) {
        Object.assign(state.vpn.servers[data.index], data.server);
      }
      updateVpnServerCard(data.index, data.server);
    }
  });
  window.zapretAPI?.onShowCloseDialog?.(() => {
    $('#closeChoiceModal')?.classList.remove('hidden');
  });
  window.zapretAPI?.onStartupUpdatesAvailable?.((all) => {
    if (all?.hub?.updateAvailable) {
      _pendingHubUpdate = all.hub;
      updateChangelogInstallButton();
      showHubUpdateModal(all.hub);
    } else if (all?.zapret?.updateAvailable) {
      openChangelogModal();
    }
  });
  window.zapretAPI?.onHubUpdateProgress?.((data) => {
    if (!data) return;
    const bar = $('#update-progress-bar');
    const pctText = $('#update-progress-pct');
    const label = $('#update-progress-label');
    const pct = Math.min(100, Math.max(0, data.percent || 0));

    if (bar) bar.style.width = `${pct}%`;
    if (pctText) pctText.innerText = `${pct}%`;
    if (label && data.message) label.innerText = data.message;
  });
  window.zapretAPI?.onStrategyProbeProgress?.((data) => {
    if (!data) return;
    const fillEl = $('#strategyProbeProgressFill');
    const percentEl = $('#strategyProbePercent');
    const textEl = $('#strategyProbeProgressText');
    const sumEl = $('#strategyProbeSummary');
    if (typeof data.percent === 'number' && fillEl) {
      fillEl.style.width = `${Math.min(100, Math.max(0, data.percent))}%`;
      if (percentEl) percentEl.innerText = `${data.percent}%`;
    }
    if (data.message && textEl) {
      textEl.innerText = data.message;
    }
    if (data.strategyName && sumEl) {
      sumEl.innerText = `Тестирование: ${data.strategyName} (YouTube / Discord / Web)`;
    }
  });
});