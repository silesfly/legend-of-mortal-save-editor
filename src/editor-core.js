/*!
 * 활협전(Legend of Mortal) 세이브 에디터 도메인 코어 — UMD 모듈 LomEditorCore
 * 의존: ./nrbf-codec.js (LomNrbfCodec), ./catalog-data.js (LomCatalog)
 * 모든 사용자 노출 문자열은 순수 한국어(한자/가나 0건, 외부 URL 0건).
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./nrbf-codec.js'), require('./catalog-data.js'));
  } else if (typeof define === 'function' && define.amd) {
    define(['./nrbf-codec.js', './catalog-data.js'], factory);
  } else {
    root.LomEditorCore = factory(root.LomNrbfCodec, root.LomCatalog);
  }
}(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function (NrbfCodec, Catalog) {
  'use strict';

  var INT32_MIN = -2147483648;
  var INT32_MAX = 2147483647;

  function isInt(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v; }
  function num(v, d) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))) return Number(v);
    return d !== undefined ? d : 0;
  }
  function str(v, d) { return (typeof v === 'string') ? v : (v != null ? String(v) : (d || '')); }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

  function indexArray(list, keyFields) {
    var map = {};
    if (!Array.isArray(list)) return map;
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (!it) continue;
      for (var j = 0; j < keyFields.length; j++) {
        var k = it[keyFields[j]];
        if (k !== undefined && k !== null && k !== '') {
          map[String(k)] = it;
          break;
        }
      }
    }
    return map;
  }

  var _CAT_IDX = null;
  function getCatalogIndex() {
    if (_CAT_IDX) return _CAT_IDX;
    var c = Catalog || {};
    _CAT_IDX = {
      stats: indexArray(c.stats, ['id', 'key']),
      relationships: indexArray(c.relationships, ['id', 'key']),
      books: indexArray(c.books, ['id']),
      miscs: indexArray(c.miscs, ['id']),
      specialItems: indexArray(c.specialItems, ['id']),
      talents: indexArray(c.talents, ['id']),
      battleSkills: indexArray(c.battleSkills, ['key', 'id']),
      upgrades: indexArray(c.upgrades, ['key', 'id']),
      library: indexArray(c.library, ['id']),
      enemyTeams: indexArray(c.enemyTeams, ['id']),
      flags: indexArray(c.flags, ['id', 'key']),
      raw: c
    };
    return _CAT_IDX;
  }

  var GAMESAVE_SCALARS = [
    'Version', 'TimeTick', 'IsDemo', 'NewGamePlus',
    'CurrentYear', 'CurrentMonth', 'CurrentStage', 'CurrentDayEnvironment',
    'CurrentScene', 'CurrentSceneKey', 'CurrentEnemyTeamId',
    'BattleSkill_1', 'BattleSkill_2', 'BattleSkill_3', 'BattleSkill_4',
    'CurrentUpgradePoison1', 'CurrentUpgradePoison2',
    'CurrentUpgradeWeapon1', 'CurrentUpgradeWeapon2', 'CurrentUpgradeWeapon3',
    'CurrentUpgradeWeapon4', 'CurrentUpgradeWeapon5'
  ];

  var LIST_SCHEMAS = {
    Stats: { cls: 'Mortal.Core.StatSave', key: 'Key', fields: ['Key', 'Value'] },
    Relationships: { cls: 'Mortal.Core.RelationshipSave', key: 'Key', fields: ['Key', 'Value', 'Active'] },
    Books: { cls: 'Mortal.Core.BookSave', key: 'Id', fields: ['Id', 'Count', 'MartialLevel', 'CurrentLevelPoints'] },
    Miscs: { cls: 'Mortal.Core.MiscSave', key: 'Id', fields: ['Id', 'Count'] },
    SpecialItems: { cls: 'Mortal.Core.SpecialItemSave', key: 'Id', fields: ['Id', 'Count'] },
    Talents: { cls: 'Mortal.Core.TalentSave', key: 'Id', fields: ['Id', 'Level'] },
    BattleSkills: { cls: 'Mortal.Core.BattleSkillSave', key: 'Key', fields: ['Key', 'Level', 'Active'] },
    PoisonUpgradeItem: { cls: 'Mortal.Core.UpgradeItemSave', key: 'Key', fields: ['Key', 'CurrentLevel', 'CurrentPoints', 'AlreadyDevelop'] },
    WeaponUpgradeItem: { cls: 'Mortal.Core.UpgradeItemSave', key: 'Key', fields: ['Key', 'CurrentLevel', 'CurrentPoints', 'AlreadyDevelop'] },
    EnemyTeams: { cls: 'Mortal.Core.EnemyTeamSave', key: 'Id', fields: ['Id', 'Level', 'People', 'Team', 'DefaultBattleHP'] },
    EventFlags: { cls: 'Mortal.Core.EventFlagSave', key: 'Name', fields: ['Name', 'State'] }
  };

  function readField(doc, rec, name) {
    if (!rec) return undefined;
    var v = NrbfCodec.getFieldJs(doc, rec, name);
    return v === undefined ? undefined : v;
  }

  function readListItems(doc, rec, listField) {
    var raw = readField(doc, rec, listField);
    if (!raw) return [];
    var listRec = NrbfCodec.resolveRef(doc, raw);
    if (!listRec) return [];
    return NrbfCodec.listGetItems(doc, listRec).filter(Boolean);
  }

  function flattenGameSave(doc, gsRec, rootRec, kind, cat) {
    var meta = {
      version: str(readField(doc, gsRec, 'Version'), ''),
      timeTick: str(readField(doc, gsRec, 'TimeTick'), '0'),
      isDemo: !!readField(doc, gsRec, 'IsDemo'),
      newGamePlus: !!readField(doc, gsRec, 'NewGamePlus'),
      currentYear: num(readField(doc, gsRec, 'CurrentYear'), 1),
      currentMonth: num(readField(doc, gsRec, 'CurrentMonth'), 1),
      currentStage: num(readField(doc, gsRec, 'CurrentStage'), 0),
      currentDayEnvironment: num(readField(doc, gsRec, 'CurrentDayEnvironment'), 0),
      currentScene: str(readField(doc, gsRec, 'CurrentScene'), ''),
      currentSceneKey: str(readField(doc, gsRec, 'CurrentSceneKey'), ''),
      currentEnemyTeamId: str(readField(doc, gsRec, 'CurrentEnemyTeamId'), ''),
      trailingBytesCount: doc.trailingBytesCount || 0,
      battleSkillsEquipped: [
        str(readField(doc, gsRec, 'BattleSkill_1'), ''),
        str(readField(doc, gsRec, 'BattleSkill_2'), ''),
        str(readField(doc, gsRec, 'BattleSkill_3'), ''),
        str(readField(doc, gsRec, 'BattleSkill_4'), '')
      ],
      upgradeEquipped: {
        poison1: str(readField(doc, gsRec, 'CurrentUpgradePoison1'), ''),
        poison2: str(readField(doc, gsRec, 'CurrentUpgradePoison2'), ''),
        weapon1: str(readField(doc, gsRec, 'CurrentUpgradeWeapon1'), ''),
        weapon2: str(readField(doc, gsRec, 'CurrentUpgradeWeapon2'), ''),
        weapon3: str(readField(doc, gsRec, 'CurrentUpgradeWeapon3'), ''),
        weapon4: str(readField(doc, gsRec, 'CurrentUpgradeWeapon4'), ''),
        weapon5: str(readField(doc, gsRec, 'CurrentUpgradeWeapon5'), '')
      }
    };
    if (kind === 'AutoGameSave' && rootRec) {
      meta.slot = str(readField(doc, rootRec, 'Slot'), '');
    }

    var stats = readListItems(doc, gsRec, 'Stats').map(function (r) {
      var key = str(readField(doc, r, 'Key'), '');
      var c = cat.stats[key] || {};
      return {
        key: key,
        value: num(readField(doc, r, 'Value'), 0),
        name: c.name || key,
        desc: c.desc || '',
        min: c.min !== undefined ? c.min : INT32_MIN,
        max: c.max !== undefined ? c.max : INT32_MAX
      };
    });

    var relationships = readListItems(doc, gsRec, 'Relationships').map(function (r) {
      var key = str(readField(doc, r, 'Key'), '');
      var c = cat.relationships[key] || {};
      return {
        key: key,
        value: num(readField(doc, r, 'Value'), 0),
        active: !!readField(doc, r, 'Active'),
        name: c.name || key,
        title: c.title || '',
        max: c.max !== undefined ? c.max : 100
      };
    });

    var books = readListItems(doc, gsRec, 'Books').map(function (r) {
      var id = str(readField(doc, r, 'Id'), '');
      var c = cat.books[id] || {};
      return {
        id: id,
        count: num(readField(doc, r, 'Count'), 0),
        martialLevel: num(readField(doc, r, 'MartialLevel'), 0),
        currentLevelPoints: num(readField(doc, r, 'CurrentLevelPoints'), 0),
        name: c.name || ('비급 ' + id),
        maxLevel: c.maxLevel || 10
      };
    });

    var miscs = readListItems(doc, gsRec, 'Miscs').map(function (r) {
      var id = str(readField(doc, r, 'Id'), '');
      var c = cat.miscs[id] || {};
      return { id: id, count: num(readField(doc, r, 'Count'), 0), name: c.name || ('잡물 ' + id) };
    });

    var specialItems = readListItems(doc, gsRec, 'SpecialItems').map(function (r) {
      var id = str(readField(doc, r, 'Id'), '');
      var c = cat.specialItems[id] || {};
      return { id: id, count: num(readField(doc, r, 'Count'), 0), name: c.name || ('귀중품 ' + id) };
    });

    var talents = readListItems(doc, gsRec, 'Talents').map(function (r) {
      var id = str(readField(doc, r, 'Id'), '');
      var c = cat.talents[id] || {};
      return { id: id, level: num(readField(doc, r, 'Level'), 0), name: c.name || ('특기 ' + id), maxLevel: c.maxLevel || 9 };
    });

    var battleSkills = readListItems(doc, gsRec, 'BattleSkills').map(function (r) {
      var key = str(readField(doc, r, 'Key'), '');
      var c = cat.battleSkills[key] || {};
      return { key: key, level: num(readField(doc, r, 'Level'), 0), active: !!readField(doc, r, 'Active'), name: c.name || key };
    });

    function mapUpgrade(field) {
      return readListItems(doc, gsRec, field).map(function (r) {
        var key = str(readField(doc, r, 'Key'), '');
        var c = cat.upgrades[key] || {};
        return {
          key: key,
          currentLevel: num(readField(doc, r, 'CurrentLevel'), 0),
          currentPoints: num(readField(doc, r, 'CurrentPoints'), 0),
          alreadyDevelop: !!readField(doc, r, 'AlreadyDevelop'),
          name: c.name || key,
          maxLevel: c.maxLevel || 10
        };
      });
    }

    var enemyTeams = readListItems(doc, gsRec, 'EnemyTeams').map(function (r) {
      var id = str(readField(doc, r, 'Id'), '');
      var c = cat.enemyTeams[id] || {};
      return {
        id: id,
        level: num(readField(doc, r, 'Level'), 1),
        people: num(readField(doc, r, 'People'), 0),
        team: num(readField(doc, r, 'Team'), 0),
        defaultBattleHP: num(readField(doc, r, 'DefaultBattleHP'), 100),
        name: c.name || ('세력 ' + id)
      };
    });

    var eventFlags = readListItems(doc, gsRec, 'EventFlags').map(function (r) {
      var name = str(readField(doc, r, 'Name'), '');
      var c = cat.flags[name] || {};
      return { name: name, state: num(readField(doc, r, 'State'), 0), label: c.name || name };
    });

    return {
      meta: meta,
      stats: stats,
      relationships: relationships,
      books: books,
      miscs: miscs,
      specialItems: specialItems,
      talents: talents,
      battleSkills: battleSkills,
      poisonUpgrades: mapUpgrade('PoisonUpgradeItem'),
      weaponUpgrades: mapUpgrade('WeaponUpgradeItem'),
      enemyTeams: enemyTeams,
      eventFlags: eventFlags
    };
  }

  function loadSaveBuffer(uint8Array, fileName) {
    var doc = NrbfCodec.parseNrbf(uint8Array);
    var rk = NrbfCodec.detectRootKind(doc);
    var cat = getCatalogIndex();
    var session = {
      doc: doc,
      kind: rk.kind,
      rootRecord: rk.rootRecord,
      gameSaveRecord: rk.gameSaveRecord,
      fileName: fileName || '',
      meta: null, stats: null, relationships: null, books: null, miscs: null,
      specialItems: null, talents: null, battleSkills: null, poisonUpgrades: null,
      weaponUpgrades: null, enemyTeams: null, eventFlags: null,
      legend: null, universe: null, snapshot: null
    };

    if (rk.kind === 'GameSave' || rk.kind === 'AutoGameSave') {
      var gs = flattenGameSave(doc, rk.gameSaveRecord, rk.rootRecord, rk.kind, cat);
      for (var k in gs) session[k] = gs[k];
    } else if (rk.kind === 'LegendSave') {
      var endKey = str(readField(doc, rk.rootRecord, 'EndKey'), '');
      var cEnd = cat.library[endKey] || {};
      session.legend = {
        timeTick: str(readField(doc, rk.rootRecord, 'TimeTick'), '0'),
        endKey: endKey,
        endTitle: cEnd.name || ('결말 ' + endKey),
        storyCount: readListItems(doc, rk.rootRecord, 'Story').length
      };
    } else if (rk.kind === 'UniverseSave') {
      var u = {
        version: str(readField(doc, rk.rootRecord, 'Version'), ''),
        timeTicks: str(readField(doc, rk.rootRecord, 'TimeTicks'), '0'),
        titlePartner: readField(doc, rk.rootRecord, 'TitlePartner'),
        currentSlot: readField(doc, rk.rootRecord, 'CurrentSlot')
      };
      for (var i = 1; i <= 4; i++) {
        u['library' + i] = readListItems(doc, rk.rootRecord, 'LibraryData' + i).map(function (r) {
          var lid = str(readField(doc, r, 'Name'), '');
          var cl = cat.library[lid] || {};
          return {
            name: lid,
            count: num(readField(doc, r, 'Count'), 0),
            title: cl.name || ('도감 ' + lid),
            category: cl.category || 'other'
          };
        });
      }
      session.universe = u;
    }

    session.snapshot = clone(flattenView(session));
    return session;
  }

  function flattenView(s) {
    var v = { kind: s.kind };
    var keys = ['meta', 'stats', 'relationships', 'books', 'miscs', 'specialItems', 'talents',
      'battleSkills', 'poisonUpgrades', 'weaponUpgrades', 'enemyTeams', 'eventFlags', 'legend', 'universe'];
    for (var i = 0; i < keys.length; i++) {
      if (s[keys[i]] != null) v[keys[i]] = clone(s[keys[i]]);
    }
    return v;
  }

  var NEG_FORBIDDEN = [
    'money', 'life', 'stamina', 'dexterity', 'charisma', 'literacy', 'fate', 'action',
    'people', 'fame', 'team', 'poison', 'weapon', 'martial-point', 'total-martial-point',
    'total-poison-point', 'total-weapon-point', 'cook', 'poison-resistance',
    'paralysis-resistance', 'confucianism', 'taoism', 'buddhism', 'mental'
  ];
  function isNegForbidden(k) { return k.indexOf('m-') === 0 || NEG_FORBIDDEN.indexOf(k) !== -1; }

  function validate(session) {
    var errors = [], warnings = [];
    if (!session) return { ok: false, errors: ['세션이 비어 있습니다.'], warnings: [] };
    function chkInt32(lbl, v) {
      if (!isInt(v) || v < INT32_MIN || v > INT32_MAX) errors.push(lbl + ' 값이 32비트 정수가 아닙니다.');
    }
    if (session.kind === 'GameSave' || session.kind === 'AutoGameSave') {
      var m = session.meta || {};
      if (num(m.currentYear) < 1) errors.push('연도는 1 이상이어야 합니다.');
      if (num(m.currentMonth) < 1 || num(m.currentMonth) > 12) errors.push('월은 1부터 12 사이여야 합니다.');
      if (num(m.currentStage) < 0 || num(m.currentStage) > 3) errors.push('순은 상순/중순/하순(0~3)이어야 합니다.');
      if (num(m.currentDayEnvironment) < 0 || num(m.currentDayEnvironment) > 2) errors.push('낮/밤 구분은 0~2 사이여야 합니다.');
      arr(session.stats).forEach(function (st) {
        chkInt32('능력치 ' + (st.name || st.key), st.value);
        if (isNegForbidden(st.key) && num(st.value) < 0) errors.push('능력치 ' + (st.name || st.key) + '은(는) 음수일 수 없습니다.');
        if (st.key === 'assets' && (num(st.value) < -99999 || num(st.value) > 99999)) errors.push('문파 자산은 -99999~99999 사이여야 합니다.');
        if (st.key === 'contribution' && (num(st.value) < -200 || num(st.value) > 200)) errors.push('공헌도는 -200~200 사이여야 합니다.');
        if (st.key === 'mental' && (num(st.value) < 0 || num(st.value) > 100)) warnings.push('심상은 0~100 사이를 권장합니다.');
      });
      arr(session.books).forEach(function (b) {
        if (num(b.count) < 0) errors.push('비급 ' + b.name + ' 권수는 0 이상이어야 합니다.');
        if (num(b.martialLevel) < 0) errors.push('비급 ' + b.name + ' 수련 단계는 0 이상이어야 합니다.');
      });
      arr(session.miscs).forEach(function (x) { if (num(x.count) < 0) errors.push('잡물 ' + x.name + ' 수량은 0 이상이어야 합니다.'); });
      arr(session.specialItems).forEach(function (x) { if (num(x.count) < 0) errors.push('귀중품 ' + x.name + ' 수량은 0 이상이어야 합니다.'); });
      arr(session.talents).forEach(function (t) { if (num(t.level) < 0) errors.push('특기 ' + t.name + ' 등급은 0 이상이어야 합니다.'); });
      arr(session.relationships).forEach(function (r) { chkInt32('호감도 ' + r.name, r.value); });
    } else if (session.kind === 'UniverseSave') {
      var u = session.universe || {};
      for (var i = 1; i <= 4; i++) {
        arr(u['library' + i]).forEach(function (it) {
          if (num(it.count) < 0) errors.push('도감 ' + it.title + ' 횟수는 0 이상이어야 합니다.');
        });
      }
    }
    return { ok: errors.length === 0, errors: errors, warnings: warnings };
  }

  function computeDerivedStats(session) {
    if (!session || (session.kind !== 'GameSave' && session.kind !== 'AutoGameSave')) return null;
    var map = {};
    arr(session.stats).forEach(function (st) { map[st.key] = num(st.value); });
    var mental = num(map.mental, 0);
    var stage = mental >= 80 ? '심화 (수련 효율 최고)' : (mental >= 40 ? '평온 (기본 효율)' : '위험 (주화입마 주의)');
    var life = num(map.life, 0), stamina = num(map.stamina, 0);
    var totalMartial = num(map['m-sword']) + num(map['m-fist']) + num(map['m-projectile']) + num(map['m-internal']) +
      num(map['m-leg']) + num(map['m-odd']) + num(map['m-soft']) + num(map['m-stick']);
    var maxLife = 100 + life * 4 + stamina * 2;
    var lit = num(map.literacy, 0);
    var readTier = lit >= 80 ? '최상급 비급 독해 가능' : (lit >= 50 ? '고급 비급 독해 가능' : (lit >= 30 ? '중급 독해 가능' : '기초 비급'));
    return {
      mentalStage: stage,
      expectedMaxLife: maxLife,
      martialTotal: totalMartial,
      readingGrade: readTier,
      scholarTotal: num(map.confucianism) + num(map.taoism) + num(map.buddhism)
    };
  }

  var PRESETS = [
    { id: 'rich_start', name: '풍요로운 시작', desc: '은자 99,999 · 무학 점수 200 · 행동력 10 · 문파 자산 50,000' },
    { id: 'hero_all_100', name: '강호 영웅', desc: '기초 능력치 11종 100 이상 및 심상 100 설정' },
    { id: 'martial_master', name: '무학 대가', desc: '무학 8계열 · 학문 3계열 100 이상 및 무학 점수 300' },
    { id: 'tangmen_prosperity', name: '당문 번영', desc: '문파 규모 6 · 문인 300 · 명성 100 · 향심력 100 · 연단/단조 500' },
    { id: 'full_favorability', name: '만인 호감', desc: '보유 인물 호감도 전부 100 및 활성 상태 설정' },
    { id: 'unlock_all_library', name: '도감 전체 해금', desc: '전역 세이브(Save_universe) 도감 216종 전수 해금' }
  ];

  function applyPreset(session, presetId) {
    if (!session) return false;
    var cat = getCatalogIndex();
    function ensureStat(key, val, mode) {
      var list = session.stats;
      if (!list) return;
      for (var i = 0; i < list.length; i++) {
        if (list[i].key === key) {
          list[i].value = (mode === 'min') ? Math.max(num(list[i].value), val) : val;
          return;
        }
      }
      var c = cat.stats[key] || {};
      list.push({ key: key, value: val, name: c.name || key, desc: c.desc || '', min: c.min || INT32_MIN, max: c.max || INT32_MAX });
    }
    if (presetId === 'rich_start' && session.stats) {
      ensureStat('money', 99999); ensureStat('martial-point', 200); ensureStat('action', 10);
      ensureStat('assets', 50000); ensureStat('fame', 100);
      return true;
    }
    if (presetId === 'hero_all_100' && session.stats) {
      ['life', 'stamina', 'dexterity', 'charisma', 'literacy', 'fate', 'talking', 'cook', 'poison-resistance', 'paralysis-resistance', 'defence']
        .forEach(function (k) { ensureStat(k, 100, 'min'); });
      ensureStat('mental', 100);
      return true;
    }
    if (presetId === 'martial_master' && session.stats) {
      ['m-sword', 'm-projectile', 'm-fist', 'm-leg', 'm-odd', 'm-soft', 'm-stick', 'm-internal', 'confucianism', 'taoism', 'buddhism']
        .forEach(function (k) { ensureStat(k, 100, 'min'); });
      ensureStat('martial-point', 300);
      return true;
    }
    if (presetId === 'tangmen_prosperity' && session.stats) {
      ensureStat('faction', 6); ensureStat('people', 300); ensureStat('fame', 100);
      ensureStat('team', 100); ensureStat('poison', 500); ensureStat('weapon', 500);
      return true;
    }
    if (presetId === 'full_favorability' && session.relationships) {
      session.relationships.forEach(function (r) { r.value = 100; r.active = true; });
      return true;
    }
    if (presetId === 'unlock_all_library' && session.kind === 'UniverseSave' && session.universe) {
      var libItems = (cat.raw && cat.raw.library) || [];
      var byCat = { death: 'library1', ending: 'library2', achievement: 'library3', cg: 'library4' };
      var existingMaps = {};
      for (var bi = 1; bi <= 4; bi++) {
        existingMaps['library' + bi] = {};
        arr(session.universe['library' + bi]).forEach(function (it) {
          if (num(it.count) < 1) it.count = 1;
          existingMaps['library' + bi][it.name] = it;
        });
      }
      libItems.forEach(function (c) {
        var bucket = byCat[c.category] || 'library1';
        if (!existingMaps[bucket][c.id]) {
          session.universe[bucket].push({ name: c.id, count: 1, title: c.name, category: c.category });
        }
      });
      return true;
    }
    return false;
  }

  function syncListToDoc(doc, parentRec, listField, modelItems, modelToFields) {
    var spec = LIST_SCHEMAS[listField];
    if (!spec) return;
    var rawList = readField(doc, parentRec, listField);
    var listRec = NrbfCodec.resolveRef(doc, rawList);
    if (!listRec) return;

    var desired = arr(modelItems);
    var desiredKeys = {};
    desired.forEach(function (it) {
      var f = modelToFields(it);
      desiredKeys[String(f[spec.key])] = f;
    });

    var existing = NrbfCodec.listGetItems(doc, listRec);
    var seen = {};
    for (var i = existing.length - 1; i >= 0; i--) {
      var itemRec = existing[i];
      if (!itemRec) continue;
      var kv = String(NrbfCodec.getFieldJs(doc, itemRec, spec.key));
      if (!desiredKeys[kv]) {
        NrbfCodec.listRemoveAt(doc, listRec, i);
      } else {
        seen[kv] = true;
        var upd = desiredKeys[kv];
        for (var j = 0; j < spec.fields.length; j++) {
          var fn = spec.fields[j];
          if (fn !== spec.key && upd[fn] !== undefined) {
            var cur = NrbfCodec.getFieldJs(doc, itemRec, fn);
            if (cur !== upd[fn]) NrbfCodec.setFieldJs(doc, itemRec, fn, upd[fn]);
          }
        }
      }
    }
    desired.forEach(function (it) {
      var f = modelToFields(it);
      var kv = String(f[spec.key]);
      if (!seen[kv]) {
        NrbfCodec.listAddItem(doc, listRec, spec.cls, f);
      }
    });
  }

  function exportSave(session) {
    if (!session || !session.doc) throw new Error('내보낼 세션이 없습니다.');
    var doc = session.doc;
    if (session.kind === 'GameSave' || session.kind === 'AutoGameSave') {
      var gs = session.gameSaveRecord;
      var m = session.meta || {};
      var scalarPairs = [
        ['IsDemo', !!m.isDemo], ['NewGamePlus', !!m.newGamePlus],
        ['CurrentYear', num(m.currentYear)], ['CurrentMonth', num(m.currentMonth)],
        ['CurrentStage', num(m.currentStage)], ['CurrentDayEnvironment', num(m.currentDayEnvironment)],
        ['CurrentScene', str(m.currentScene)], ['CurrentSceneKey', str(m.currentSceneKey)],
        ['CurrentEnemyTeamId', str(m.currentEnemyTeamId)],
        ['BattleSkill_1', str(arr(m.battleSkillsEquipped)[0])],
        ['BattleSkill_2', str(arr(m.battleSkillsEquipped)[1])],
        ['BattleSkill_3', str(arr(m.battleSkillsEquipped)[2])],
        ['BattleSkill_4', str(arr(m.battleSkillsEquipped)[3])]
      ];
      scalarPairs.forEach(function (p) {
        var cur = NrbfCodec.getFieldJs(doc, gs, p[0]);
        if (cur !== undefined && cur !== p[1]) NrbfCodec.setFieldJs(doc, gs, p[0], p[1]);
      });

      syncListToDoc(doc, gs, 'Stats', session.stats, function (x) { return { Key: x.key, Value: num(x.value) }; });
      syncListToDoc(doc, gs, 'Relationships', session.relationships, function (x) { return { Key: x.key, Value: num(x.value), Active: !!x.active }; });
      syncListToDoc(doc, gs, 'Books', session.books, function (x) { return { Id: str(x.id), Count: num(x.count), MartialLevel: num(x.martialLevel), CurrentLevelPoints: num(x.currentLevelPoints) }; });
      syncListToDoc(doc, gs, 'Miscs', session.miscs, function (x) { return { Id: str(x.id), Count: num(x.count) }; });
      syncListToDoc(doc, gs, 'SpecialItems', session.specialItems, function (x) { return { Id: str(x.id), Count: num(x.count) }; });
      syncListToDoc(doc, gs, 'Talents', session.talents, function (x) { return { Id: str(x.id), Level: num(x.level) }; });
      syncListToDoc(doc, gs, 'BattleSkills', session.battleSkills, function (x) { return { Key: str(x.key), Level: num(x.level), Active: !!x.active }; });
      syncListToDoc(doc, gs, 'PoisonUpgradeItem', session.poisonUpgrades, function (x) { return { Key: str(x.key), CurrentLevel: num(x.currentLevel), CurrentPoints: num(x.currentPoints), AlreadyDevelop: !!x.alreadyDevelop }; });
      syncListToDoc(doc, gs, 'WeaponUpgradeItem', session.weaponUpgrades, function (x) { return { Key: str(x.key), CurrentLevel: num(x.currentLevel), CurrentPoints: num(x.currentPoints), AlreadyDevelop: !!x.alreadyDevelop }; });
      syncListToDoc(doc, gs, 'EnemyTeams', session.enemyTeams, function (x) { return { Id: str(x.id), Level: num(x.level), People: num(x.people), Team: num(x.team), DefaultBattleHP: num(x.defaultBattleHP) }; });
      syncListToDoc(doc, gs, 'EventFlags', session.eventFlags, function (x) { return { Name: str(x.name), State: num(x.state) }; });
    } else if (session.kind === 'LegendSave' && session.legend) {
      var curEnd = NrbfCodec.getFieldJs(doc, session.rootRecord, 'EndKey');
      if (curEnd !== session.legend.endKey) NrbfCodec.setFieldJs(doc, session.rootRecord, 'EndKey', str(session.legend.endKey));
    } else if (session.kind === 'UniverseSave' && session.universe) {
      LIST_SCHEMAS.LibrarySave = { cls: 'Mortal.Core.LibrarySave', key: 'Name', fields: ['Name', 'Count'] };
      for (var li = 1; li <= 4; li++) {
        var lf = 'LibraryData' + li;
        LIST_SCHEMAS[lf] = LIST_SCHEMAS.LibrarySave;
        syncListToDoc(doc, session.rootRecord, lf, session.universe['library' + li], function (x) { return { Name: str(x.name), Count: num(x.count) }; });
      }
    }
    return NrbfCodec.serializeNrbf(doc);
  }

  function computeDiff(session) {
    var out = [];
    if (!session || !session.snapshot) return out;
    var a = session.snapshot, b = flattenView(session);
    function diffMap(sec, m1, m2) {
      m1 = m1 || {}; m2 = m2 || {};
      var keys = Object.assign({}, m1, m2);
      Object.keys(keys).forEach(function (k) {
        if (JSON.stringify(m1[k]) !== JSON.stringify(m2[k])) out.push({ section: sec, key: k, label: k, before: m1[k], after: m2[k] });
      });
    }
    function diffArr(sec, a1, a2, keyFn, lblFn) {
      var m1 = {}, m2 = {};
      arr(a1).forEach(function (x) { m1[keyFn(x)] = x; });
      arr(a2).forEach(function (x) { m2[keyFn(x)] = x; });
      var all = Object.assign({}, m1, m2);
      Object.keys(all).forEach(function (k) {
        if (JSON.stringify(m1[k]) !== JSON.stringify(m2[k])) out.push({ section: sec, key: k, label: lblFn(m2[k] || m1[k]), before: m1[k] || null, after: m2[k] || null });
      });
    }
    if (a.meta || b.meta) diffMap('기본 정보', a.meta, b.meta);
    if (a.stats || b.stats) diffArr('능력치', a.stats, b.stats, function (x) { return x.key; }, function (x) { return x.name || x.key; });
    if (a.relationships || b.relationships) diffArr('호감도', a.relationships, b.relationships, function (x) { return x.key; }, function (x) { return x.name || x.key; });
    if (a.books || b.books) diffArr('비급', a.books, b.books, function (x) { return x.id; }, function (x) { return x.name || x.id; });
    if (a.miscs || b.miscs) diffArr('잡물', a.miscs, b.miscs, function (x) { return x.id; }, function (x) { return x.name || x.id; });
    if (a.specialItems || b.specialItems) diffArr('귀중품', a.specialItems, b.specialItems, function (x) { return x.id; }, function (x) { return x.name || x.id; });
    if (a.talents || b.talents) diffArr('특기', a.talents, b.talents, function (x) { return x.id; }, function (x) { return x.name || x.id; });
    if (a.battleSkills || b.battleSkills) diffArr('전역 기술', a.battleSkills, b.battleSkills, function (x) { return x.key; }, function (x) { return x.name || x.key; });
    if (a.poisonUpgrades || b.poisonUpgrades) diffArr('독술·연단', a.poisonUpgrades, b.poisonUpgrades, function (x) { return x.key; }, function (x) { return x.name || x.key; });
    if (a.weaponUpgrades || b.weaponUpgrades) diffArr('단조·암기', a.weaponUpgrades, b.weaponUpgrades, function (x) { return x.key; }, function (x) { return x.name || x.key; });
    if (a.enemyTeams || b.enemyTeams) diffArr('적 세력', a.enemyTeams, b.enemyTeams, function (x) { return x.id; }, function (x) { return x.name || x.id; });
    if (a.eventFlags || b.eventFlags) diffArr('이벤트 플래그', a.eventFlags, b.eventFlags, function (x) { return x.name; }, function (x) { return x.label || x.name; });
    if (a.legend || b.legend) diffMap('전설 기록', a.legend, b.legend);
    if (a.universe || b.universe) {
      for (var li = 1; li <= 4; li++) {
        diffArr('도감 ' + li, (a.universe || {})['library' + li], (b.universe || {})['library' + li], function (x) { return x.name; }, function (x) { return x.title || x.name; });
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* 합성 데모 NRBF 바이너리 생성기 (LomNrbfCodec.serializeNrbf 1:1 규격) */
  /* ------------------------------------------------------------------ */
  function createDemoSaveBytes(kind) {
    var REC = NrbfCodec.REC, BT = NrbfCodec.BT, PT = NrbfCodec.PT;
    var nextId = 1;
    function nid() { return nextId++; }
    var records = [
      { recordType: REC.SerializedStreamHeader, rootId: 1, headerId: -1, majorVersion: 1, minorVersion: 0 },
      { recordType: REC.BinaryLibrary, libraryId: 2, libraryName: 'Mortal.Core, Version=0.0.0.0, Culture=neutral, PublicKeyToken=null' }
    ];
    function mkPrim(pt, val) { return { kind: 'prim', primType: pt, value: val, dirty: true }; }
    function mkStr(s) { return { recordType: REC.BinaryObjectString, kind: 'string', objectId: nid(), value: String(s), dirty: true }; }
    function mkNull() { return { recordType: REC.ObjectNull, kind: 'null', count: 1 }; }
    function mkClass(oid, name, mnames, btypes, ainfos, mvals, libId) {
      return {
        recordType: libId ? REC.ClassWithMembersAndTypes : REC.SystemClassWithMembersAndTypes,
        kind: 'object',
        objectId: oid,
        classInfo: { objectId: oid, name: name, memberCount: mnames.length, memberNames: mnames },
        memberTypeInfo: { binaryTypes: btypes, additionalInfos: ainfos },
        libraryId: libId || null,
        memberValues: mvals
      };
    }
    function mkList(elemCls, itemsArr) {
      var listId = nid();
      var arrId = nid();
      var padded = itemsArr.slice();
      while (padded.length < 4) padded.push(mkNull());
      var arrRec = { recordType: REC.ArraySingleObject, kind: 'array', objectId: arrId, length: padded.length, elements: padded };
      var listCls = 'System.Collections.Generic.List`1[[' + elemCls + ', Mortal.Core, Version=0.0.0.0, Culture=neutral, PublicKeyToken=null]]';
      return mkClass(
        listId, listCls,
        ['_items', '_size', '_version'],
        [BT.Object, BT.Primitive, BT.Primitive],
        [null, { primitiveType: PT.Int32 }, { primitiveType: PT.Int32 }],
        [arrRec, mkPrim(PT.Int32, itemsArr.length), mkPrim(PT.Int32, itemsArr.length)],
        null
      );
    }

    var rootId = nid(); // 1
    if (kind === 'UniverseSave') {
      var libFields = ['LibraryData1', 'LibraryData2', 'LibraryData3', 'LibraryData4'];
      var libLists = [
        mkList('Mortal.Core.LibrarySave', [mkClass(nid(), 'Mortal.Core.LibrarySave', ['Name', 'Count'], [BT.String, BT.Primitive], [null, { primitiveType: PT.Int32 }], [mkStr('10000'), mkPrim(PT.Int32, 1)], 2)]),
        mkList('Mortal.Core.LibrarySave', [mkClass(nid(), 'Mortal.Core.LibrarySave', ['Name', 'Count'], [BT.String, BT.Primitive], [null, { primitiveType: PT.Int32 }], [mkStr('20000'), mkPrim(PT.Int32, 1)], 2)]),
        mkList('Mortal.Core.LibrarySave', []),
        mkList('Mortal.Core.LibrarySave', [])
      ];
      records.push(mkClass(
        rootId, 'Mortal.Core.UniverseSave',
        ['Version', 'TimeTicks', 'TitlePartner', 'CurrentSlot'].concat(libFields),
        [BT.String, BT.Primitive, BT.Primitive, BT.String, BT.Object, BT.Object, BT.Object, BT.Object],
        [null, { primitiveType: PT.Int64 }, { primitiveType: PT.Int32 }, null, null, null, null, null],
        [mkStr('release_1.0.3300.6'), mkPrim(PT.Int64, '638867147073222530'), mkPrim(PT.Int32, 1), mkStr('001')].concat(libLists),
        2
      ));
      records.push({ recordType: REC.MessageEnd, kind: 'end' });
      return NrbfCodec.serializeNrbf({ header: records[0], records: records });
    }

    var statPairs = [
      ['money', 1000], ['life', 100], ['stamina', 80], ['dexterity', 60],
      ['literacy', 40], ['mental', 70], ['charisma', 50], ['fate', 20],
      ['action', 5], ['faction', 1], ['people', 50], ['fame', 10],
      ['team', 60], ['assets', 5000], ['martial-point', 20],
      ['m-sword', 30], ['m-fist', 30], ['m-projectile', 25], ['m-internal', 20],
      ['poison', 10], ['weapon', 10]
    ];
    var statItems = statPairs.map(function (p) {
      return mkClass(nid(), 'Mortal.Core.StatSave', ['Key', 'Value'], [BT.String, BT.Primitive], [null, { primitiveType: PT.Int32 }], [mkStr(p[0]), mkPrim(PT.Int32, p[1])], 2);
    });
    var relItems = [
      mkClass(nid(), 'Mortal.Core.RelationshipSave', ['Key', 'Value', 'Active'], [BT.String, BT.Primitive, BT.Primitive], [null, { primitiveType: PT.Int32 }, { primitiveType: PT.Boolean }], [mkStr('sister1'), mkPrim(PT.Int32, 40), mkPrim(PT.Boolean, true)], 2),
      mkClass(nid(), 'Mortal.Core.RelationshipSave', ['Key', 'Value', 'Active'], [BT.String, BT.Primitive, BT.Primitive], [null, { primitiveType: PT.Int32 }, { primitiveType: PT.Boolean }], [mkStr('brother1'), mkPrim(PT.Int32, 30), mkPrim(PT.Boolean, true)], 2)
    ];
    var bookItems = [mkClass(nid(), 'Mortal.Core.BookSave', ['Id', 'Count', 'MartialLevel', 'CurrentLevelPoints'], [BT.String, BT.Primitive, BT.Primitive, BT.Primitive], [null, { primitiveType: PT.Int32 }, { primitiveType: PT.Int32 }, { primitiveType: PT.Int32 }], [mkStr('1000'), mkPrim(PT.Int32, 1), mkPrim(PT.Int32, 1), mkPrim(PT.Int32, 0)], 2)];
    var miscItems = [mkClass(nid(), 'Mortal.Core.MiscSave', ['Id', 'Count'], [BT.String, BT.Primitive], [null, { primitiveType: PT.Int32 }], [mkStr('0001'), mkPrim(PT.Int32, 3)], 2)];
    var spItems = [mkClass(nid(), 'Mortal.Core.SpecialItemSave', ['Id', 'Count'], [BT.String, BT.Primitive], [null, { primitiveType: PT.Int32 }], [mkStr('1000'), mkPrim(PT.Int32, 1)], 2)];
    var talItems = [mkClass(nid(), 'Mortal.Core.TalentSave', ['Id', 'Level'], [BT.String, BT.Primitive], [null, { primitiveType: PT.Int32 }], [mkStr('0000'), mkPrim(PT.Int32, 1)], 2)];
    var bsItems = [mkClass(nid(), 'Mortal.Core.BattleSkillSave', ['Key', 'Level', 'Active'], [BT.String, BT.Primitive, BT.Primitive], [null, { primitiveType: PT.Int32 }, { primitiveType: PT.Boolean }], [mkStr('player_1'), mkPrim(PT.Int32, 1), mkPrim(PT.Boolean, true)], 2)];
    var pUpItems = [mkClass(nid(), 'Mortal.Core.UpgradeItemSave', ['Key', 'CurrentLevel', 'CurrentPoints', 'AlreadyDevelop'], [BT.String, BT.Primitive, BT.Primitive, BT.Primitive], [null, { primitiveType: PT.Int32 }, { primitiveType: PT.Int32 }, { primitiveType: PT.Boolean }], [mkStr('Poison_01'), mkPrim(PT.Int32, 1), mkPrim(PT.Int32, 0), mkPrim(PT.Boolean, true)], 2)];
    var wUpItems = [mkClass(nid(), 'Mortal.Core.UpgradeItemSave', ['Key', 'CurrentLevel', 'CurrentPoints', 'AlreadyDevelop'], [BT.String, BT.Primitive, BT.Primitive, BT.Primitive], [null, { primitiveType: PT.Int32 }, { primitiveType: PT.Int32 }, { primitiveType: PT.Boolean }], [mkStr('Knife_01'), mkPrim(PT.Int32, 1), mkPrim(PT.Int32, 0), mkPrim(PT.Boolean, true)], 2)];
    var etItems = [mkClass(nid(), 'Mortal.Core.EnemyTeamSave', ['Id', 'Level', 'People', 'Team', 'DefaultBattleHP'], [BT.String, BT.Primitive, BT.Primitive, BT.Primitive, BT.Primitive], [null, { primitiveType: PT.Int32 }, { primitiveType: PT.Int32 }, { primitiveType: PT.Int32 }, { primitiveType: PT.Int32 }], [mkStr('001'), mkPrim(PT.Int32, 1), mkPrim(PT.Int32, 100), mkPrim(PT.Int32, 50), mkPrim(PT.Int32, 100)], 2)];
    var efItems = [mkClass(nid(), 'Mortal.Core.EventFlagSave', ['Name', 'State'], [BT.String, BT.Primitive], [null, { primitiveType: PT.Int32 }], [mkStr('H00001'), mkPrim(PT.Int32, 10)], 2)];

    var stageEnum = mkClass(nid(), 'Mortal.Core.MonthStageType', ['value__'], [BT.Primitive], [{ primitiveType: PT.Int32 }], [mkPrim(PT.Int32, 1)], 2);
    var envEnum = mkClass(nid(), 'Mortal.Core.DayEnvironmentType', ['value__'], [BT.Primitive], [{ primitiveType: PT.Int32 }], [mkPrim(PT.Int32, 1)], 2);

    var gsNames = [
      'Version', 'TimeTick', 'IsDemo', 'NewGamePlus',
      'CurrentYear', 'CurrentMonth', 'CurrentStage', 'CurrentDayEnvironment',
      'CurrentScene', 'CurrentSceneKey', 'CurrentEnemyTeamId',
      'BattleSkill_1', 'BattleSkill_2', 'BattleSkill_3', 'BattleSkill_4',
      'Stats', 'Relationships', 'Books', 'Miscs', 'SpecialItems',
      'Talents', 'BattleSkills', 'PoisonUpgradeItem', 'WeaponUpgradeItem', 'EnemyTeams', 'EventFlags'
    ];
    var gsBtypes = [
      BT.String, BT.Primitive, BT.Primitive, BT.Primitive,
      BT.Primitive, BT.Primitive, BT.Object, BT.Object,
      BT.String, BT.String, BT.String,
      BT.String, BT.String, BT.String, BT.String,
      BT.Object, BT.Object, BT.Object, BT.Object, BT.Object,
      BT.Object, BT.Object, BT.Object, BT.Object, BT.Object, BT.Object
    ];
    var gsAinfos = [
      null, { primitiveType: PT.Int64 }, { primitiveType: PT.Boolean }, { primitiveType: PT.Boolean },
      { primitiveType: PT.Int32 }, { primitiveType: PT.Int32 }, null, null,
      null, null, null, null, null, null, null,
      null, null, null, null, null, null, null, null, null, null, null
    ];
    var gsVals = [
      mkStr('release_1.0.3300.6'), mkPrim(PT.Int64, '638867147073222530'), mkPrim(PT.Boolean, false), mkPrim(PT.Boolean, false),
      mkPrim(PT.Int32, 1), mkPrim(PT.Int32, 4), stageEnum, envEnum,
      mkStr('Free'), mkStr('1100_01'), mkStr('001'),
      mkStr('player_1'), mkStr(''), mkStr(''), mkStr(''),
      mkList('Mortal.Core.StatSave', statItems),
      mkList('Mortal.Core.RelationshipSave', relItems),
      mkList('Mortal.Core.BookSave', bookItems),
      mkList('Mortal.Core.MiscSave', miscItems),
      mkList('Mortal.Core.SpecialItemSave', spItems),
      mkList('Mortal.Core.TalentSave', talItems),
      mkList('Mortal.Core.BattleSkillSave', bsItems),
      mkList('Mortal.Core.UpgradeItemSave', pUpItems),
      mkList('Mortal.Core.UpgradeItemSave', wUpItems),
      mkList('Mortal.Core.EnemyTeamSave', etItems),
      mkList('Mortal.Core.EventFlagSave', efItems)
    ];
    records.push(mkClass(rootId, 'Mortal.Core.GameSave', gsNames, gsBtypes, gsAinfos, gsVals, 2));
    records.push({ recordType: REC.MessageEnd, kind: 'end' });
    return NrbfCodec.serializeNrbf({ header: records[0], records: records });
  }

  return {
    loadSaveBuffer: loadSaveBuffer,
    validate: validate,
    computeDerivedStats: computeDerivedStats,
    PRESETS: PRESETS,
    applyPreset: applyPreset,
    exportSave: exportSave,
    computeDiff: computeDiff,
    createDemoSaveBytes: createDemoSaveBytes,
    getCatalogIndex: getCatalogIndex
  };
}));
