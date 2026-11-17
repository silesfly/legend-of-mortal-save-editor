(function () {
  'use strict';

  const C = window.LomEditorCore;
  const Cat = window.LomCatalog || {};
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function toast(msg, kind) {
    const host = $('#toast-host');
    if (!host) return;
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, 2200);
  }

  const state = {
    session: null,
    bytes: null,
    fileName: null,
    kind: null,
    dirty: false,
    activeTab: 'summary',
    serverPath: null,
    serverSha: null,
    slotList: []
  };

  function setDirty(v) {
    state.dirty = (v === undefined) ? true : !!v;
    const b = $('#dirty-badge');
    if (b) b.classList.toggle('hidden', !state.dirty);
  }

  function setStatus(txt, kind) {
    const b = $('#status-badge');
    if (!b) return;
    b.textContent = txt;
    b.classList.remove('ok', 'warn', 'error');
    if (kind) b.classList.add(kind);
  }

  function setKind(kind) {
    state.kind = kind || null;
    const b = $('#kind-badge');
    if (b) b.textContent = kind ? kindLabel(kind) : '없음';
  }

  function kindLabel(k) {
    return ({ GameSave: '일반 세이브', AutoGameSave: '자동 세이브', LegendSave: '전설 세이브', UniverseSave: '우주 세이브' })[k] || k;
  }

  function setText(sel, v) {
    const el = $(sel);
    if (!el) return;
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') el.value = v == null ? '' : v;
    else el.textContent = v == null ? '' : String(v);
  }

  function bytesToB64(u8) {
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < u8.length; i += chunk) {
      s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + chunk, u8.length)));
    }
    return btoa(s);
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function loadBytes(bytes, fileName) {
    try {
      const session = C.loadSaveBuffer(bytes, fileName || '');
      state.session = session;
      state.bytes = bytes;
      state.fileName = fileName || null;
      state.dirty = false;
      setDirty(false);
      setKind(session.kind);
      setStatus('불러옴', 'ok');
      renderAll();
      toast('세이브를 불러왔습니다.', 'ok');
      return session;
    } catch (e) {
      console.error('[LomEditor] 불러오기 실패', e);
      setStatus('불러오기 실패', 'error');
      toast('세이브를 불러오지 못했습니다: ' + (e && e.message ? e.message : e), 'error');
      throw e;
    }
  }

  function loadDemoKind(kind) {
    try {
      const bytes = C.createDemoSaveBytes(kind);
      return loadBytes(bytes, 'demo-' + kind + '.dat');
    } catch (e) {
      console.error(e);
      toast('데모 세이브 생성에 실패했습니다.', 'error');
    }
  }

  function loadFromFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try { loadBytes(new Uint8Array(reader.result), file.name); } catch (_) { /* 토스트 처리됨 */ }
    };
    reader.onerror = () => toast('파일을 읽지 못했습니다.', 'error');
    reader.readAsArrayBuffer(file);
  }

  function renderAll() {
    renderSummary();
    renderStats();
    renderRelationships();
    renderBooks();
    renderTalents();
    renderSkills();
    renderInventory();
    renderFlags();
    renderLibrary();
    renderLegend();
    renderDiff();
  }

  const MARTIAL_HINTS = ['martial', 'internal', 'external', 'sword', 'fist', 'palm', 'blade', 'scholar', 'skill', 'realm', 'qi', 'neigong', 'attack', 'defense'];
  const SECT_HINTS = ['tang', 'sect', 'asset', 'fame', 'contrib', 'battle', 'money', 'gold', 'reputation', 'faction', 'guild'];

  function categorizeStat(stat) {
    const k = String(stat.key || '').toLowerCase();
    const n = String(stat.name || '');
    if (MARTIAL_HINTS.some(h => k.includes(h))) return 'martial';
    if (SECT_HINTS.some(h => k.includes(h))) return 'sect';
    if (n.includes('무') || n.includes('학')) return 'martial';
    if (n.includes('당') || n.includes('명성') || n.includes('공헌') || n.includes('재산')) return 'sect';
    return 'base';
  }

  // ---------- 요약 ----------
  function renderSummary() {
    const s = state.session;
    if (!s) return;
    const m = s.meta || {};
    setText('#f-version', m.version);
    setText('#f-year', m.currentYear);
    setText('#f-month', m.currentMonth);
    setText('#f-stage', m.currentStage);
    setText('#f-env', m.currentDayEnvironment);
    setText('#f-scene', m.currentScene);
    const demoEl = $('#f-is-demo'); if (demoEl) demoEl.checked = !!m.isDemo;
    const ngpEl = $('#f-ngp'); if (ngpEl) ngpEl.checked = !!m.newGamePlus;
    renderDerived();
  }

  function renderDerived() {
    const grid = $('#derived-grid');
    if (!grid || !state.session) return;
    let d = {};
    try { d = C.computeDerivedStats(state.session) || {}; } catch (_) { d = {}; }
    const items = [
      ['심리 단계', d.mentalStage],
      ['예상 최대 생명', d.expectedMaxLife],
      ['무학 총합', d.martialTotal],
      ['독서 등급', d.readingGrade],
      ['학자 총합', d.scholarTotal]
    ];
    grid.innerHTML = items.map(([k, v]) => (
      '<div class="derived-item"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v == null ? '-' : v) + '</div></div>'
    )).join('');
  }

  // ---------- 능력치 ----------
  let statFilter = 'all';
  let statSearch = '';

  function renderStats() {
    const list = $('#stats-list');
    if (!list || !state.session || !state.session.stats) { if (list) list.innerHTML = ''; return; }
    const q = statSearch.trim().toLowerCase();
    const rows = state.session.stats.filter(st => {
      if (statFilter !== 'all' && categorizeStat(st) !== statFilter) return false;
      if (!q) return true;
      return String(st.key).toLowerCase().includes(q) || String(st.name || '').toLowerCase().includes(q);
    });
    list.innerHTML = rows.map(st => (
      '<div class="row" data-stat-row="' + esc(st.key) + '">' +
      '<label class="lbl" title="' + esc(st.key) + '">' + esc(st.name || st.key) + '</label>' +
      '<input type="number" data-stat="' + esc(st.key) + '" value="' + esc(st.value) + '" min="' + esc(st.min) + '" max="' + esc(st.max) + '">' +
      '<span class="range">' + esc(st.min) + ' ~ ' + esc(st.max) + '</span>' +
      '</div>'
    )).join('') || '<div class="empty">해당하는 능력치가 없습니다.</div>';
  }

  // ---------- 인연 ----------
  let relSearch = '';
  function renderRelationships() {
    const list = $('#rels-list');
    if (!list || !state.session || !state.session.relationships) { if (list) list.innerHTML = ''; return; }
    const q = relSearch.trim().toLowerCase();
    const rows = state.session.relationships.filter(r => !q ||
      String(r.key).toLowerCase().includes(q) || String(r.name || '').toLowerCase().includes(q));
    list.innerHTML = rows.map(r => (
      '<div class="row">' +
      '<label class="lbl">' + esc(r.name || r.key) + (r.title ? ' <span class="sub">(' + esc(r.title) + ')</span>' : '') + '</label>' +
      '<input type="number" data-rel="' + esc(r.key) + '" value="' + esc(r.value) + '" max="' + esc(r.max) + '">' +
      '<label class="chk"><input type="checkbox" data-rel-active="' + esc(r.key) + '"' + (r.active ? ' checked' : '') + '> 활성</label>' +
      '</div>'
    )).join('') || '<div class="empty">해당하는 인연이 없습니다.</div>';
  }

  // ---------- 서적 ----------
  function renderBooks() {
    const list = $('#books-list');
    if (list) {
      if (!state.session || !state.session.books) list.innerHTML = '';
      else list.innerHTML = state.session.books.map((b, i) => (
        '<div class="row">' +
        '<label class="lbl">' + esc(b.name || b.id) + '</label>' +
        '<input type="number" data-book-count="' + i + '" value="' + esc(b.count) + '">' +
        '<span class="range">' + esc(b.currentLevelPoints) + ' / Lv.' + esc(b.martialLevel) + ' / ' + esc(b.maxLevel) + '</span>' +
        '</div>'
      )).join('') || '<div class="empty">서적이 없습니다.</div>';
    }
    const sel = $('#add-book-select');
    if (sel && Cat.books) {
      sel.innerHTML = '<option value="">서적 선택</option>' + Cat.books.map(b =>
        '<option value="' + esc(b.id || b.key) + '">' + esc(b.name || b.id) + '</option>'
      ).join('');
    }
  }

  // ---------- 재능 ----------
  function renderTalents() {
    const list = $('#talents-list');
    if (list) {
      if (!state.session || !state.session.talents) list.innerHTML = '';
      else list.innerHTML = state.session.talents.map((t, i) => (
        '<div class="row">' +
        '<label class="lbl">' + esc(t.name || t.id) + '</label>' +
        '<input type="number" data-talent-level="' + i + '" value="' + esc(t.level) + '" min="0" max="' + esc(t.maxLevel) + '">' +
        '<span class="range">최대 ' + esc(t.maxLevel) + '</span>' +
        '</div>'
      )).join('') || '<div class="empty">재능이 없습니다.</div>';
    }
    const sel = $('#add-talent-select');
    if (sel && Cat.talents) {
      sel.innerHTML = '<option value="">재능 선택</option>' + Cat.talents.map(t =>
        '<option value="' + esc(t.id || t.key) + '">' + esc(t.name || t.id) + '</option>'
      ).join('');
    }
  }

  // ---------- 무공 ----------
  function renderSkills() {
    const list = $('#skills-list');
    if (list) {
      if (!state.session || !state.session.battleSkills) list.innerHTML = '';
      else list.innerHTML = state.session.battleSkills.map((sk, i) => (
        '<div class="row">' +
        '<label class="lbl">' + esc(sk.name || sk.key) + '</label>' +
        '<input type="number" data-skill-level="' + i + '" value="' + esc(sk.level) + '">' +
        '<label class="chk"><input type="checkbox" data-skill-active="' + i + '"' + (sk.active ? ' checked' : '') + '> 활성</label>' +
        '</div>'
      )).join('') || '<div class="empty">무공이 없습니다.</div>';
    }
    const eq = state.session && state.session.meta && state.session.meta.battleSkillsEquipped;
    for (let i = 1; i <= 4; i++) {
      const sel = $('#eq-skill-' + i);
      if (!sel) continue;
      const cur = eq ? eq[i - 1] : '';
      const opts = (state.session && state.session.battleSkills ? state.session.battleSkills : [])
        .map(sk => '<option value="' + esc(sk.key) + '">' + esc(sk.name || sk.key) + '</option>').join('');
      sel.innerHTML = '<option value="">-</option>' + opts;
      if (cur) sel.value = cur;
    }
  }

  // ---------- 소지품 ----------
  function renderInventory() {
    const miscList = $('#miscs-list');
    if (miscList) {
      if (!state.session || !state.session.miscs) miscList.innerHTML = '';
      else miscList.innerHTML = state.session.miscs.map((m, i) => (
        '<div class="row">' +
        '<label class="lbl">' + esc(m.name || m.id) + '</label>' +
        '<input type="number" data-misc-count="' + i + '" value="' + esc(m.count) + '">' +
        '</div>'
      )).join('') || '<div class="empty">소지품이 없습니다.</div>';
    }
    const specialList = $('#specials-list');
    if (specialList) {
      if (!state.session || !state.session.specialItems) specialList.innerHTML = '';
      else specialList.innerHTML = state.session.specialItems.map((m, i) => (
        '<div class="row">' +
        '<label class="lbl">' + esc(m.name || m.id) + '</label>' +
        '<input type="number" data-special-count="' + i + '" value="' + esc(m.count) + '">' +
        '</div>'
      )).join('') || '<div class="empty">특수 아이템이 없습니다.</div>';
    }
    renderUpgrades('#poison-upgrades-list', state.session && state.session.poisonUpgrades, 'poison');
    renderUpgrades('#weapon-upgrades-list', state.session && state.session.weaponUpgrades, 'weapon');

    const miscSel = $('#add-misc-select');
    if (miscSel && Cat.miscs) {
      miscSel.innerHTML = '<option value="">소지품 선택</option>' + Cat.miscs.map(m =>
        '<option value="' + esc(m.id || m.key) + '">' + esc(m.name || m.id) + '</option>'
      ).join('');
    }
    const spSel = $('#add-special-select');
    if (spSel && Cat.specialItems) {
      spSel.innerHTML = '<option value="">특수 아이템 선택</option>' + Cat.specialItems.map(m =>
        '<option value="' + esc(m.id || m.key) + '">' + esc(m.name || m.id) + '</option>'
      ).join('');
    }
  }

  function renderUpgrades(sel, arr, kind) {
    const list = $(sel);
    if (!list) return;
    if (!arr) { list.innerHTML = ''; return; }
    list.innerHTML = arr.map((u, i) => (
      '<div class="row">' +
      '<label class="lbl">' + esc(u.name || u.key) + '</label>' +
      '<input type="number" data-upgrade-level="' + i + '" data-upgrade-kind="' + kind + '" value="' + esc(u.currentLevel) + '" max="' + esc(u.maxLevel) + '">' +
      '<input type="number" data-upgrade-points="' + i + '" data-upgrade-kind="' + kind + '" value="' + esc(u.currentPoints) + '">' +
      '</div>'
    )).join('') || '<div class="empty">강화 정보가 없습니다.</div>';
  }

  // ---------- 플래그 ----------
  let flagSearch = '';
  function renderFlags() {
    const et = $('#enemy-teams-list');
    if (et) {
      if (!state.session || !state.session.enemyTeams) et.innerHTML = '';
      else et.innerHTML = state.session.enemyTeams.map((e, i) => (
        '<div class="row">' +
        '<label class="lbl">' + esc(e.name || e.id) + '</label>' +
        '<input type="number" data-team-level="' + i + '" value="' + esc(e.level) + '">' +
        '<span class="range">인원 ' + esc(e.people) + ' / 체력 ' + esc(e.defaultBattleHP) + '</span>' +
        '</div>'
      )).join('') || '<div class="empty">적 팀이 없습니다.</div>';
    }
    const fl = $('#flags-list');
    if (fl) {
      if (!state.session || !state.session.eventFlags) fl.innerHTML = '';
      else {
        const q = flagSearch.trim().toLowerCase();
        const rows = state.session.eventFlags.filter(f => !q ||
          String(f.name).toLowerCase().includes(q) || String(f.label || '').toLowerCase().includes(q));
        fl.innerHTML = rows.map((f) => (
          '<div class="row">' +
          '<label class="lbl" title="' + esc(f.name) + '">' + esc(f.label || f.name) + '</label>' +
          '<label class="chk"><input type="checkbox" data-flag="' + esc(f.name) + '"' + (f.state ? ' checked' : '') + '> 활성</label>' +
          '</div>'
        )).join('') || '<div class="empty">플래그가 없습니다.</div>';
      }
    }
  }

  // ---------- 도서관 ----------
  let libSearch = '';
  function renderLibrary() {
    const cats = { death: 1, ending: 2, achievement: 3, cg: 4 };
    const lib = state.session && state.session.universe;
    const allLib = [];
    if (lib) {
      ['library1', 'library2', 'library3', 'library4'].forEach(k => {
        if (Array.isArray(lib[k])) lib[k].forEach(item => allLib.push(item));
      });
    }
    Object.keys(cats).forEach(cat => {
      const el = $('[data-lib-cat="' + cat + '"]');
      if (!el) return;
      const arr = lib && lib['library' + cats[cat]] ? lib['library' + cats[cat]] : [];
      const unlocked = arr.filter(a => a && a.count > 0).length;
      el.textContent = unlocked + ' / ' + arr.length;
    });
    const list = $('#library-list');
    if (list) {
      const q = libSearch.trim().toLowerCase();
      const rows = allLib.filter(a => !q || String(a.name || '').toLowerCase().includes(q) ||
        String(a.title || '').toLowerCase().includes(q));
      list.innerHTML = rows.map(a => (
        '<div class="row">' +
        '<label class="lbl">' + esc(a.title || a.name) + '</label>' +
        '<span class="range">분류 ' + esc(a.category) + ' / 개수 ' + esc(a.count) + '</span>' +
        '</div>'
      )).join('') || '<div class="empty">도서관 항목이 없습니다.</div>';
    }
  }

  function catLabel(k) {
    return ({ death: '죽음', ending: '엔딩', achievement: '업적', cg: '그림' })[k] || k;
  }

  function renderLegend() {
    const l = state.session && state.session.legend;
    const keyEl = $('#legend-end-key');
    const cntEl = $('#legend-story-count');
    if (keyEl) keyEl.value = l ? (l.endKey || '') : '';
    if (cntEl) cntEl.value = l ? (l.storyCount || 0) : '';
  }

  // ---------- 차이/검증 ----------
  function renderDiff() {
    const box = $('#validation-box');
    const list = $('#diff-list');
    const count = $('#diff-count');
    if (!state.session) {
      if (box) box.className = 'validation-box';
      if (list) list.innerHTML = '';
      if (count) count.textContent = '0';
      return;
    }
    let v;
    try { v = C.validate(state.session); } catch (_) { v = { ok: true, errors: [], warnings: [] }; }
    if (box) {
      box.classList.remove('ok', 'warn', 'error');
      if (v.errors && v.errors.length) box.classList.add('error');
      else if (v.warnings && v.warnings.length) box.classList.add('warn');
      else box.classList.add('ok');
      const items = [];
      (v.errors || []).forEach(e => items.push('<div class="err">오류: ' + esc(e) + '</div>'));
      (v.warnings || []).forEach(w => items.push('<div class="warn">경고: ' + esc(w) + '</div>'));
      if (!items.length) items.push('<div class="ok">검증 통과</div>');
      box.innerHTML = items.join('');
    }
    let diffs = [];
    try { diffs = C.computeDiff(state.session) || []; } catch (_) { diffs = []; }
    if (count) count.textContent = String(diffs.length);
    if (list) {
      if (!diffs.length) {
        list.innerHTML = '<tr><td colspan="3" class="empty">변경 사항이 없습니다.</td></tr>';
      } else {
        list.innerHTML = diffs.map(d => (
          '<tr><td>' + esc(d.label || (d.section + '.' + d.key)) + '</td><td>' + esc(d.before) + '</td><td>' + esc(d.after) + '</td></tr>'
        )).join('');
      }
    }
    setDirty(diffs.length > 0);
  }

  // ---------- 프리셋 ----------
  function applyPresetId(id) {
    if (!state.session) { toast('먼저 세이브를 불러오세요.', 'warn'); return false; }
    try {
      if (C.applyPreset(state.session, id)) {
        toast('프리셋을 적용했습니다: ' + id, 'ok');
        renderAll();
        return true;
      }
      toast('프리셋을 적용할 수 없습니다.', 'warn');
    } catch (e) {
      console.error(e);
      toast('프리셋 적용 중 오류가 발생했습니다.', 'error');
    }
    return false;
  }

  function bindPresets() {
    const host = $('#preset-chips');
    if (!host) return;
    const presets = C.PRESETS || [];
    host.innerHTML = presets.map(p => (
      '<button type="button" class="chip" data-preset="' + esc(p.id) + '" title="' + esc(p.desc || '') + '">' + esc(p.name || p.id) + '</button>'
    )).join('');
    host.addEventListener('click', (e) => {
      const b = e.target.closest('[data-preset]');
      if (!b) return;
      applyPresetId(b.dataset.preset);
    });
  }

  // ---------- 탭 ----------
  function switchTab(name) {
    state.activeTab = name;
    const tabs = $$('.tab[role="tab"]');
    tabs.forEach(t => {
      const on = t.id === 'tab-' + name;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
    });
    $$('.panel[role="tabpanel"]').forEach(p => {
      p.classList.toggle('active', p.id === 'panel-' + name);
    });
  }

  function bindTabs() {
    const tabs = $$('.tab[role="tab"]');
    tabs.forEach(t => {
      t.addEventListener('click', () => switchTab(t.id.replace('tab-', '')));
      t.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const idx = tabs.indexOf(t);
        const next = e.key === 'ArrowRight' ? (idx + 1) % tabs.length : (idx - 1 + tabs.length) % tabs.length;
        tabs[next].focus();
        switchTab(tabs[next].id.replace('tab-', ''));
      });
    });
  }

  // ---------- 이벤트 입력 바인딩 ----------
  function bindInputs() {
    const on = (root, sel, ev, fn) => {
      const el = $(root);
      if (!el) return;
      el.addEventListener(ev, (e) => {
        const t = e.target.closest(sel);
        if (!t) return;
        fn(t, e);
      });
    };
    on('#stats-list', '[data-stat]', 'input', (t) => {
      if (!state.session || !state.session.stats) return;
      const st = state.session.stats.find(s => s.key === t.dataset.stat);
      if (!st) return;
      st.value = Number(t.value);
      renderDerived(); renderDiff();
    });
    on('#rels-list', '[data-rel]', 'input', (t) => {
      const r = state.session && state.session.relationships && state.session.relationships.find(x => x.key === t.dataset.rel);
      if (!r) return;
      r.value = Number(t.value);
      renderDiff();
    });
    on('#rels-list', '[data-rel-active]', 'change', (t) => {
      const r = state.session && state.session.relationships && state.session.relationships.find(x => x.key === t.dataset.relActive);
      if (!r) return;
      r.active = !!t.checked;
      renderDiff();
    });
    $('#stat-search')?.addEventListener('input', (e) => { statSearch = e.target.value; renderStats(); });
    $('#rel-search')?.addEventListener('input', (e) => { relSearch = e.target.value; renderRelationships(); });
    $('#flag-search')?.addEventListener('input', (e) => { flagSearch = e.target.value; renderFlags(); });
    $('#lib-search')?.addEventListener('input', (e) => { libSearch = e.target.value; renderLibrary(); });
    on('#stat-filters', '[data-filter]', 'click', (t) => {
      $$('#stat-filters [data-filter]').forEach(x => x.classList.toggle('active', x === t));
      statFilter = t.dataset.filter || 'all';
      renderStats();
    });
    $('#btn-apply-summary')?.addEventListener('click', () => {
      if (!state.session || !state.session.meta) return;
      const m = state.session.meta;
      m.currentYear = Number($('#f-year').value);
      m.currentMonth = Number($('#f-month').value);
      m.currentStage = Number($('#f-stage').value);
      m.currentDayEnvironment = Number($('#f-env').value);
      m.isDemo = !!$('#f-is-demo')?.checked;
      m.newGamePlus = !!$('#f-ngp')?.checked;
      renderDerived();
      renderDiff();
      toast('기본 정보를 적용했습니다.', 'ok');
    });
    function addCatalogItem(selectSel, catList, targetArr, maker, rerender) {
      if (!state.session || !Array.isArray(targetArr)) return;
      const sel = $(selectSel);
      const id = sel ? sel.value : '';
      if (!id) return;
      const c = (Array.isArray(catList) ? catList : []).find(x => (x.id || x.key) === id) || { id: id, name: id };
      if (!targetArr.find(x => x.id === id)) {
        targetArr.push(maker(id, c));
        rerender();
        renderDiff();
      }
    }
    $('#btn-add-book')?.addEventListener('click', () => addCatalogItem(
      '#add-book-select', Cat.books, state.session && state.session.books,
      (id, c) => ({ id: id, count: 1, martialLevel: 0, currentLevelPoints: 0, name: c.name || id, maxLevel: c.maxLevel || 10 }),
      renderBooks
    ));
    on('#books-list', '[data-book-count]', 'input', (t) => {
      const b = state.session && state.session.books && state.session.books[+t.dataset.bookCount];
      if (b) { b.count = Number(t.value); renderDiff(); }
    });
    $('#btn-add-talent')?.addEventListener('click', () => addCatalogItem(
      '#add-talent-select', Cat.talents, state.session && state.session.talents,
      (id, c) => ({ id: id, level: 1, name: c.name || id, maxLevel: c.maxLevel || 9 }),
      renderTalents
    ));
    on('#talents-list', '[data-talent-level]', 'input', (t) => {
      const item = state.session && state.session.talents && state.session.talents[+t.dataset.talentLevel];
      if (item) { item.level = Number(t.value); renderDiff(); }
    });
    on('#skills-list', '[data-skill-level]', 'input', (t) => {
      const item = state.session && state.session.battleSkills && state.session.battleSkills[+t.dataset.skillLevel];
      if (item) { item.level = Number(t.value); renderDiff(); }
    });
    on('#skills-list', '[data-skill-active]', 'change', (t) => {
      const item = state.session && state.session.battleSkills && state.session.battleSkills[+t.dataset.skillActive];
      if (item) { item.active = !!t.checked; renderDiff(); }
    });
    for (let i = 1; i <= 4; i++) {
      $('#eq-skill-' + i)?.addEventListener('change', (e) => {
        if (!state.session || !state.session.meta) return;
        state.session.meta.battleSkillsEquipped[i - 1] = e.target.value;
        renderDiff();
      });
    }
    $('#btn-add-misc')?.addEventListener('click', () => addCatalogItem(
      '#add-misc-select', Cat.miscs, state.session && state.session.miscs,
      (id, c) => ({ id: id, count: 1, name: c.name || id }),
      renderInventory
    ));
    on('#miscs-list', '[data-misc-count]', 'input', (t) => {
      const item = state.session && state.session.miscs && state.session.miscs[+t.dataset.miscCount];
      if (item) { item.count = Number(t.value); renderDiff(); }
    });
    $('#btn-add-special')?.addEventListener('click', () => addCatalogItem(
      '#add-special-select', Cat.specialItems, state.session && state.session.specialItems,
      (id, c) => ({ id: id, count: 1, name: c.name || id }),
      renderInventory
    ));
    on('#specials-list', '[data-special-count]', 'input', (t) => {
      const item = state.session && state.session.specialItems && state.session.specialItems[+t.dataset.specialCount];
      if (item) { item.count = Number(t.value); renderDiff(); }
    });
    ['poison', 'weapon'].forEach((kind) => {
      const rootSel = kind === 'poison' ? '#poison-upgrades-list' : '#weapon-upgrades-list';
      const arrKey = kind === 'poison' ? 'poisonUpgrades' : 'weaponUpgrades';
      on(rootSel, '[data-upgrade-level]', 'input', (t) => {
        const item = state.session && state.session[arrKey] && state.session[arrKey][+t.dataset.upgradeLevel];
        if (item) { item.currentLevel = Number(t.value); renderDiff(); }
      });
      on(rootSel, '[data-upgrade-points]', 'input', (t) => {
        const item = state.session && state.session[arrKey] && state.session[arrKey][+t.dataset.upgradePoints];
        if (item) { item.currentPoints = Number(t.value); renderDiff(); }
      });
    });
    on('#enemy-teams-list', '[data-team-level]', 'input', (t) => {
      const item = state.session && state.session.enemyTeams && state.session.enemyTeams[+t.dataset.teamLevel];
      if (item) { item.level = Number(t.value); renderDiff(); }
    });
    on('#flags-list', '[data-flag]', 'change', (t) => {
      const f = state.session && state.session.eventFlags && state.session.eventFlags.find(x => x.name === t.dataset.flag);
      if (f) { f.state = t.checked ? 1 : 0; renderDiff(); }
    });
    $('#btn-unlock-all-lib')?.addEventListener('click', () => applyPresetId('unlock_all_library'));
    $('#btn-apply-legend')?.addEventListener('click', () => {
      if (!state.session || !state.session.legend) { toast('전설 세이브가 아닙니다.', 'warn'); return; }
      state.session.legend.endKey = $('#legend-end-key').value.trim();
      renderDiff();
      toast('결말 정보를 적용했습니다.', 'ok');
    });
  }

  // ---------- 3모드 I/O (A: 오프라인 / B: 로컬 HTTP / C: WebView2) ----------
  const isModeC = !!(window.chrome && window.chrome.webview);
  let hostSeq = 0;
  const hostPending = new Map();

  function hostCall(method, params) {
    return new Promise((resolve, reject) => {
      if (!isModeC || !window.chrome.webview.postMessage) {
        reject(new Error('호스트 브리지를 사용할 수 없습니다.'));
        return;
      }
      const id = 'lom-' + (++hostSeq);
      hostPending.set(id, { resolve, reject });
      window.chrome.webview.postMessage({ id: id, method: method, params: params || {} });
    });
  }

  if (isModeC) {
    window.__LOM_HOST__ = {
      receive(msg) {
        if (!msg || !msg.id) return;
        const p = hostPending.get(msg.id);
        if (!p) return;
        hostPending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error));
        else p.resolve(msg.result);
      }
    };
  }

  function serverCfg() {
    if (window.__LOM_SERVER__ && window.__LOM_SERVER__.token) return window.__LOM_SERVER__;
    const m = document.querySelector('meta[name="lom-token"]');
    return m && m.content ? { token: m.content, baseUrl: '' } : null;
  }

  async function serverFetch(path, opts) {
    const cfg = serverCfg();
    const o = Object.assign({}, opts || {});
    o.headers = Object.assign({}, o.headers || {}, { 'X-Lom-Token': cfg ? cfg.token : '' });
    const res = await fetch(path, o);
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || ('요청 실패 (' + res.status + ')'));
    return data;
  }

  function populateSlots(slots, currentPath) {
    state.slotList = slots || [];
    const sel = $('#slot-select');
    const wrap = $('#slot-wrap');
    if (!sel || !wrap) return;
    sel.innerHTML = '';
    if (!state.slotList.length) { wrap.classList.add('hidden'); return; }
    state.slotList.forEach(s => {
      const o = document.createElement('option');
      o.value = s.path;
      o.textContent = (s.name || s.path) + (s.kind ? ' (' + kindLabel(s.kind) + ')' : '');
      sel.appendChild(o);
    });
    if (currentPath) sel.value = currentPath;
    wrap.classList.remove('hidden');
  }

  async function loadSlot(path) {
    const res = isModeC
      ? await hostCall('loadSave', { path: path })
      : await serverFetch('/api/load?path=' + encodeURIComponent(path));
    state.serverPath = res.path || path;
    state.serverSha = res.sha256 || null;
    await loadBytes(b64ToBytes(res.data), res.path || path);
  }

  async function saveCurrent(saveAs) {
    if (!state.session) { toast('먼저 세이브를 불러오세요.', 'warn'); return; }
    const v = C.validate(state.session);
    if (!v.ok) {
      toast('검증 오류가 있어 저장할 수 없습니다.', 'error');
      renderDiff();
      switchTab('diff');
      return;
    }
    const bytes = C.exportSave(state.session);
    const suggested = (state.fileName ? state.fileName.split(/[\\/]/).pop() : null) || 'Save_001.dat';
    const dataB64 = bytesToB64(bytes);
    try {
      if (isModeC) {
        const res = await hostCall(saveAs ? 'saveAsDialog' : 'saveFile', {
          path: state.serverPath,
          expectedSha256: state.serverSha,
          suggestedName: suggested,
          dataBase64: dataB64
        });
        if (res && res.canceled) return;
        if (res && res.path) state.serverPath = res.path;
        if (res && res.sha256) state.serverSha = res.sha256;
      } else if (!saveAs && state.serverPath && serverCfg()) {
        const res = await serverFetch('/api/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: state.serverPath, expectedSha256: state.serverSha, data: dataB64 })
        });
        state.serverSha = res.sha256;
      } else if (saveAs && typeof window.showSaveFilePicker === 'function') {
        const h = await window.showSaveFilePicker({
          suggestedName: suggested,
          types: [{ description: '활협전 세이브', accept: { 'application/octet-stream': ['.dat'] } }]
        });
        const w = await h.createWritable();
        await w.write(bytes);
        await w.close();
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
        a.download = suggested;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(a.href), 1500);
      }
      state.bytes = bytes;
      state.session.snapshot = JSON.parse(JSON.stringify(C.loadSaveBuffer(bytes, suggested).snapshot));
      setDirty(false);
      renderDiff();
      setStatus('저장 완료', 'ok');
      toast('저장을 완료했습니다.', 'ok');
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      toast('저장 실패: ' + (e && e.message ? e.message : e), 'error');
    }
  }

  async function init() {
    bindTabs();
    bindPresets();
    bindInputs();
    renderAll();

    $('#btn-open-file')?.addEventListener('click', async () => {
      if (isModeC) {
        try {
          const res = await hostCall('openFileDialog', {});
          if (res && !res.canceled && res.data) {
            state.serverPath = res.path || null;
            state.serverSha = res.sha256 || null;
            await loadBytes(b64ToBytes(res.data), res.path || 'Save_001.dat');
          }
        } catch (e) { toast('열기 실패: ' + (e && e.message ? e.message : e), 'error'); }
        return;
      }
      $('#file-input')?.click();
    });
    $('#file-input')?.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) { state.serverPath = null; state.serverSha = null; loadFromFile(f); }
      e.target.value = '';
    });
    $('#btn-load-demo')?.addEventListener('click', () => { state.serverPath = null; state.serverSha = null; loadDemoKind('GameSave'); });
    $('#btn-load-demo-univ')?.addEventListener('click', () => { state.serverPath = null; state.serverSha = null; loadDemoKind('UniverseSave'); });
    $('#btn-save')?.addEventListener('click', () => saveCurrent(false));
    $('#btn-save-as')?.addEventListener('click', () => saveCurrent(true));
    $('#btn-theme')?.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme');
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('lom-theme', next); } catch (_) {}
    });
    $('#slot-select')?.addEventListener('change', (e) => {
      const p = e.target.value;
      if (p) loadSlot(p).catch(err => toast('슬롯 불러오기 실패: ' + (err && err.message ? err.message : err), 'error'));
    });

    ['dragenter', 'dragover'].forEach(ev => document.addEventListener(ev, (e) => {
      e.preventDefault();
      $('#drop-veil')?.classList.add('show');
    }));
    ['dragleave', 'drop'].forEach(ev => document.addEventListener(ev, (e) => {
      e.preventDefault();
      if (ev === 'dragleave' && e.relatedTarget) return;
      $('#drop-veil')?.classList.remove('show');
    }));
    document.addEventListener('drop', (e) => {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) { state.serverPath = null; state.serverSha = null; loadFromFile(f); }
    });

    if (isModeC) {
      try {
        const res = await hostCall('discoverSaves', {});
        const slots = (res && res.slots) || [];
        populateSlots(slots, slots[0] && slots[0].path);
        if (slots[0]) await loadSlot(slots[0].path);
      } catch (e) { toast('세이브 탐색 실패: ' + (e && e.message ? e.message : e), 'warn'); }
    } else if (serverCfg()) {
      try {
        const res = await serverFetch('/api/discover');
        const slots = (res && res.slots) || [];
        populateSlots(slots, slots[0] && slots[0].path);
        if (slots[0]) await loadSlot(slots[0].path);
      } catch (e) { toast('서버 탐색 실패: ' + (e && e.message ? e.message : e), 'warn'); }
    }
  }

  window.LomUi = {
    loadDemo: loadDemoKind,
    loadBytes: loadBytes,
    applyPresetId: applyPresetId,
    switchTab: switchTab,
    getState: () => state
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
