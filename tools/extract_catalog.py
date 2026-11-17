#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""활협전(Legend of Mortal) 세이브 에디터 한국어 카탈로그 추출기.

extracted_db.json / ko_ui_terms.json / corpus/companion-dashboard.json 을 읽어
순수 한국어 UMD 모듈 src/catalog-data.js (LomCatalog) 를 원자적으로 생성·검증한다.

사용법:
    python3 tools/extract_catalog.py
    python3 tools/extract_catalog.py --check-only
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from typing import Any, Dict, Iterable, List, Optional, Tuple

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = "/home/jiyoung/workspace/무협위키/.local/graph/legend-of-mortal-data"
DB_PATH = os.path.join(DATA_DIR, "extracted_db.json")
KO_PATH = os.path.join(DATA_DIR, "ko_ui_terms.json")
CORPUS_DIR = "/home/jiyoung/workspace/무협위키/games/legend-of-mortal/corpus"
COMPANION_PATH = os.path.join(CORPUS_DIR, "companion-dashboard.json")
OUTPUT_PATH = os.path.join(ROOT, "src", "catalog-data.js")

TAG_RE = re.compile(r"<[^>]*>")
URL_RE = re.compile(r"(?:https?|ftp|wss?)://\S+|www\.\S+", re.IGNORECASE)
HANZI_RE = re.compile(r"[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]")
KANA_RE = re.compile(r"[\u3040-\u30FF]")
HANGUL_RE = re.compile(r"[\uAC00-\uD7A3]")
WS_RE = re.compile(r"\s+")
CTRL_RE = re.compile(r"[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]")
BRACKET_RE = re.compile(r"[\u3010\u3011\u300c\u300d\u300e\u300f\u3014\u3015\u300a\u300b\u3008\u3009]")

HTML_ENTITIES = {
    "&nbsp;": " ",
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
}


def clean_text(value: Any, fallback: str = "") -> str:
    if value is None:
        return fallback
    s = str(value)
    for k, v in HTML_ENTITIES.items():
        if k in s:
            s = s.replace(k, v)
    s = re.sub(r"&#x?[0-9A-Fa-f]+;", "", s)
    s = TAG_RE.sub("", s)
    s = URL_RE.sub("", s)
    s = BRACKET_RE.sub(" ", s)
    s = HANZI_RE.sub("", s)
    s = KANA_RE.sub("", s)
    s = CTRL_RE.sub("", s)
    s = s.replace("\u200b", "").replace("\ufeff", "")
    s = WS_RE.sub(" ", s).strip()
    if not s:
        return fallback
    if not HANGUL_RE.search(s) and len(s) <= 1 and not s.isdigit():
        return fallback
    return s


def fallback_name(prefix: str, key: Any) -> str:
    return clean_text("%s %s" % (prefix, str(key).strip()), "%s" % prefix)


def load_json(path: str) -> Any:
    if not os.path.exists(path):
        raise FileNotFoundError("필수 입력 파일이 없습니다: %s" % path)
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def pick(rec: Any, *names: str, default: Any = None) -> Any:
    if not isinstance(rec, dict):
        return default
    for n in names:
        if n in rec and rec[n] is not None:
            return rec[n]
    return default


def to_int(v: Any, default: Optional[int] = None) -> Optional[int]:
    if v is None:
        return default
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        return int(v)
    try:
        s = str(v).strip()
        return int(float(s)) if s else default
    except Exception:
        return default


def _sort_num_str(s: str) -> Tuple[int, str]:
    m = re.match(r"^(\d+)", str(s))
    return (int(m.group(1)), str(s)) if m else (10**9, str(s))


STAT_KEYS: List[str] = [
    "life", "stamina", "dexterity", "money", "charisma", "literacy", "mental", "fate",
    "disposition", "behaviour", "training", "karma", "talking",
    "contribution", "total-contribution", "cook", "poison-resistance", "paralysis-resistance",
    "title", "lover", "girl", "internal", "defence", "change-heart",
    "martial-point", "total-martial-point",
    "m-sword", "m-projectile", "m-fist", "m-leg", "m-odd", "m-soft", "m-stick", "m-internal",
    "confucianism", "taoism", "buddhism", "xingyi",
    "action", "add-action-1", "add-action-2", "add-action-3",
    "faction", "fame", "people", "team", "assets", "poison", "weapon",
    "total-poison-point", "total-weapon-point", "default-battle-hp", "battle-people",
    "combat-attack", "combat-defence", "combat-ultimate", "combat-attack-dice",
    "combat-weapon", "combat-weapon-dice",
]

STAT_KO_OVERRIDES: Dict[str, Tuple[str, str]] = {
    "life": ("체력", "최대 기혈과 물리 생존력을 결정하는 기초 능력치"),
    "stamina": ("내력", "절초와 특수기 발동 및 내공 판정에 쓰이는 능력치"),
    "dexterity": ("경공", "전투 이동 속도·회피율·선공 기합에 반영되는 능력치"),
    "money": ("은자", "행상 상점 거래와 개발에 사용되는 재화"),
    "charisma": ("매력", "인물 첫인상과 대인 반응에 영향을 미치는 수치"),
    "literacy": ("학문", "비급 독해 및 강경당 수련 요구치 충족에 필요한 학식"),
    "mental": ("심상", "80 이상 심화 시 수련 효율 상승, 0 이하 시 주화입마 위험"),
    "fate": ("운명", "주사위 판정 및 기연에 관여하는 운명 수치"),
    "disposition": ("성정", "성품 성향 축"),
    "behaviour": ("처세", "대인 흥정 및 담판에 쓰이는 처세 축"),
    "training": ("수양", "전투 기합과 특수 대사에 반영되는 수양 축"),
    "karma": ("도덕", "선악 평판 및 정파 외교 분기에 반영되는 도덕 축"),
    "talking": ("구력", "설전 및 구변 판정에 사용되는 수치"),
    "contribution": ("공헌도", "당문 내 공헌도"),
    "total-contribution": ("누적 공헌도", "누적 획득 공헌도"),
    "cook": ("요리", "부엌 작업 및 음식 제작 숙련도"),
    "poison-resistance": ("항독", "독 상태이상 저항력"),
    "paralysis-resistance": ("항마", "마비 상태이상 저항력"),
    "title": ("칭호", "현재 칭호 단계"),
    "lover": ("마음에 둔 사람", "연모 대상 식별 값"),
    "girl": ("인연 지수", "인연 관련 보조 수치"),
    "internal": ("음양 내공", "음양 내공 균형 수치"),
    "defence": ("방어력", "기본 방어 수치"),
    "change-heart": ("변심", "연모 대상 변경 횟수"),
    "martial-point": ("무학 점수", "무학 수련에 사용할 수 있는 잔여 점수"),
    "total-martial-point": ("누적 무학 점수", "지금까지 획득한 누적 무학 점수"),
    "m-sword": ("도검", "도·검 계열 무학 숙련도"),
    "m-projectile": ("암기", "암기 계열 무학 숙련도"),
    "m-fist": ("권장", "권·장 계열 무학 숙련도"),
    "m-leg": ("각법", "다리 기술 무학 숙련도"),
    "m-odd": ("기문", "기문 병기 무학 숙련도"),
    "m-soft": ("연병기", "연병기 무학 숙련도"),
    "m-stick": ("창곤", "창·곤 계열 무학 숙련도"),
    "m-internal": ("내공", "내공 계열 무학 숙련도"),
    "confucianism": ("유학", "유가 경전 학문 수준"),
    "taoism": ("도학", "도가 경전 학문 수준"),
    "buddhism": ("불학", "불가 경전 학문 수준"),
    "xingyi": ("형의권", "형의권 무학 숙련 수치"),
    "action": ("행동력", "월간 기본 행동 가능 횟수"),
    "add-action-1": ("추가 행동력 1", "추가 행동 보너스 1"),
    "add-action-2": ("추가 행동력 2", "추가 행동 보너스 2"),
    "add-action-3": ("추가 행동력 3", "추가 행동 보너스 3"),
    "faction": ("문파 규모", "당문 문파 규모 단계"),
    "fame": ("문파 명성", "강호 내 당문 명성 수치"),
    "people": ("문인", "당문 소속 제자 및 인원 수"),
    "team": ("향심력", "문파 내부 단결력 및 사기"),
    "assets": ("문파 자산", "당문 운영 자금(음수 가능)"),
    "poison": ("연단·독술 점수", "당문 연단·독술 누적 개발 점수"),
    "weapon": ("단조 점수", "당문 대장간 무기·암기 개발 점수"),
    "total-poison-point": ("누적 연단 점수", "누적 획득 연단 개발 점수"),
    "total-weapon-point": ("누적 단조 점수", "누적 획득 단조 개발 점수"),
    "default-battle-hp": ("기본 전투 체력", "단체전 문인 기본 체력"),
    "battle-people": ("전투 인원", "단체전 출전 인원 수치"),
    "combat-attack": ("공격", "결투 공격 보정치"),
    "combat-defence": ("방어", "결투 방어 보정치"),
    "combat-ultimate": ("절초", "결투 절초 보정치"),
    "combat-attack-dice": ("무기 치명타 주사위", "결투 무기 치명타 주사위 보정"),
    "combat-weapon": ("암기 위력", "결투 암기 위력 보정치"),
    "combat-weapon-dice": ("암기 치명타 주사위", "결투 암기 치명타 주사위 보정"),
}

STAT_BOUNDS: Dict[str, Tuple[int, int]] = {
    "faction": (1, 6),
    "assets": (-99999, 99999),
    "contribution": (-200, 200),
    "money": (0, 9999999),
    "mental": (0, 100),
    "life": (0, 999),
    "stamina": (0, 999),
    "dexterity": (0, 999),
    "people": (0, 9999),
    "fame": (0, 9999),
    "team": (0, 999),
}

RELATIONSHIP_KO_OVERRIDES: Dict[str, Tuple[str, str]] = {
    "brother1": ("당포의", "대사형 · 비협"),
    "brother2": ("당쟁", "이사형"),
    "brother3": ("당승", "삼사형"),
    "brother4": ("당유원", "사사형"),
    "sister1": ("당묵령", "소사매"),
    "master": ("당중령", "당문 장문인"),
    "player": ("조활", "주인공"),
    "girl1": ("서행", "행화선"),
    "girl2": ("엽운상", "점창명주"),
    "girl2_1": ("엽운추 1", "점창 인연"),
    "girl2_2": ("엽운추 2", "점창 인연"),
    "girl4": ("용상", "망우협려"),
    "girl5": ("우소매", "비천문 여제자"),
    "girl5_explore": ("우소매 (탐험)", "탐험 전용 수치"),
    "girl6": ("하후란", "설산파 탈백유란"),
    "girl7": ("욱죽", "열골마"),
    "girl8": ("위국", "현공문 장문인"),
    "girl9": ("상관형", "상관천금"),
    "special1": ("유악", "흑의 소년"),
    "special2": ("용연", "전 무림맹주"),
    "special3": ("엽운주", "창송검객"),
    "special4": ("번소천", "광견"),
    "special6": ("만리붕정", "응인"),
    "special7": ("석공원", "비석방주"),
    "special101": ("남궁원", "남궁가주"),
    "special102": ("남궁심", "남궁세가"),
    "special103": ("남궁천", "남궁세가"),
    "special201": ("추박", "청성파 장문인"),
    "special205": ("윤지평", "전진교"),
    "special206": ("복온", "소림사"),
    "special215": ("맹공", "항금 장수"),
    "special401": ("왕이장", "강호 인물"),
    "special403": ("조규", "강호 인물"),
    "special404": ("단하자", "공동파"),
    "special405": ("신도룡", "무림 인물"),
    "special409": ("차헌원", "강호 인물"),
    "special800": ("송비", "강호 인물"),
    "special805": ("학수", "강호 인물"),
    "special808": ("해무진", "강호 인물"),
    "special809": ("이부귀", "강호 인물"),
    "special817": ("대송 황제", "조정"),
    "special819": ("대금 황제", "금국"),
    "special825": ("하령서", "강호 인물"),
    "special831": ("맹선요", "강호 인물"),
    "special836": ("영양군주", "조정"),
    "special999": ("서생", "호의검소"),
}


class KoDict:
    def __init__(self, raw: Dict[str, Any]):
        self.data: Dict[str, str] = {}
        for k, v in raw.items():
            if isinstance(v, (str, int, float)):
                self.data[str(k)] = str(v)

    def get(self, key: str, fallback: str = "") -> str:
        return clean_text(self.data.get(key), fallback)

    def get_any(self, keys: Iterable[str], fallback: str = "") -> str:
        for k in keys:
            v = self.get(k)
            if v:
                return v
        return fallback

    def collect_ids(self, prefix: str) -> List[str]:
        out: List[str] = []
        seen = set()
        for k in self.data:
            if k.startswith(prefix):
                rest = k[len(prefix):]
                if rest and rest not in seen:
                    seen.add(rest)
                    out.append(rest)
        return out


def normalize_rel_key(m_name: str) -> str:
    s = str(m_name or "")
    if s.startswith("Relationship_"):
        s = s[len("Relationship_"):]
    if "葉雲啾_1" in s:
        return "girl2_1"
    if "葉雲啾_2" in s:
        return "girl2_2"
    if "探險" in s:
        return "girl5_explore"
    head = s.split("_")[0]
    return re.sub(r"[^0-9A-Za-z]", "", head).lower()


def build_stats(ko: KoDict) -> List[Dict[str, Any]]:
    out = []
    for k in STAT_KEYS:
        ov_name, ov_desc = STAT_KO_OVERRIDES.get(k, ("", ""))
        name = ko.get("PlayerStat/" + k) or ov_name or fallback_name("능력치", k)
        desc = ko.get("PlayerStatDesc/" + k) or ov_desc
        mn, mx = STAT_BOUNDS.get(k, (-999999, 999999))
        out.append({
            "id": k,
            "name": clean_text(name, k),
            "desc": clean_text(desc, ""),
            "min": mn,
            "max": mx,
        })
    return out


def build_relationships(db: Dict[str, Any], ko: KoDict) -> List[Dict[str, Any]]:
    out = []
    seen = set()
    for rec in db.get("Mortal.Core.RelationshipStat", []):
        key = normalize_rel_key(pick(rec, "m_Name", default=""))
        if not key or key in seen:
            continue
        seen.add(key)
        ov_name, ov_title = RELATIONSHIP_KO_OVERRIDES.get(key, ("", ""))
        ko_name = ko.get("Character/" + key)
        if ko_name in ("???", "???"):
            ko_name = ""
        name = ov_name or ko_name or fallback_name("인물", key)
        title = ko.get("CharacterTitle/" + key) or ov_title
        if "{title}" in title:
            title = ov_title
        out.append({
            "id": key,
            "name": clean_text(name, key),
            "title": clean_text(title, ""),
            "defaultValue": to_int(pick(rec, "_default"), 0) or 0,
            "max": to_int(pick(rec, "_max"), 100) or 100,
        })
    for key, (ov_name, ov_title) in RELATIONSHIP_KO_OVERRIDES.items():
        if key not in seen:
            seen.add(key)
            out.append({
                "id": key,
                "name": clean_text(ov_name, key),
                "title": clean_text(ov_title, ""),
                "defaultValue": 0,
                "max": 100,
            })
    out.sort(key=lambda x: x["id"])
    return out


def build_books(db: Dict[str, Any], ko: KoDict) -> List[Dict[str, Any]]:
    out = []
    seen = set()
    for rec in db.get("Mortal.Core.Book", []):
        bid = str(pick(rec, "_id", default="")).strip()
        if not bid or bid in seen:
            continue
        seen.add(bid)
        name = ko.get("Book/Name/" + bid) or fallback_name("비급", bid)
        desc = ko.get("Book/Desc/" + bid)
        lvl = pick(rec, "_martialLevel")
        if lvl is None:
            ld = pick(rec, "_martialLevelData")
            lvl = len(ld) if isinstance(ld, list) else 10
        out.append({
            "id": bid,
            "name": name,
            "desc": desc,
            "cost": to_int(pick(rec, "_cost"), 0) or 0,
            "maxLevel": to_int(lvl, 10) or 10,
        })
    out.sort(key=lambda x: _sort_num_str(x["id"]))
    return out


def build_special_items(db: Dict[str, Any], ko: KoDict) -> List[Dict[str, Any]]:
    out = []
    seen = set()
    for rec in db.get("Mortal.Core.SpecialItem", []):
        sid = str(pick(rec, "_id", default="")).strip()
        if not sid or sid in seen:
            continue
        seen.add(sid)
        out.append({
            "id": sid,
            "name": ko.get("Special/Name/" + sid) or fallback_name("귀중품", sid),
            "desc": ko.get("Special/Desc/" + sid),
            "cost": to_int(pick(rec, "_cost"), 0) or 0,
        })
    out.sort(key=lambda x: _sort_num_str(x["id"]))
    return out


def build_miscs(ko: KoDict) -> List[Dict[str, Any]]:
    out = []
    for mid in ko.collect_ids("Misc/Name/"):
        out.append({
            "id": mid,
            "name": ko.get("Misc/Name/" + mid) or fallback_name("잡물", mid),
            "desc": ko.get("Misc/Desc/" + mid),
        })
    out.sort(key=lambda x: _sort_num_str(x["id"]))
    return out


def build_talents(db: Dict[str, Any], ko: KoDict) -> List[Dict[str, Any]]:
    out = []
    seen = set()
    for rec in db.get("Mortal.Core.PlayerTalentData", []):
        tid = str(pick(rec, "_id", default="")).strip()
        if not tid or tid in seen:
            continue
        seen.add(tid)
        out.append({
            "id": tid,
            "name": ko.get("PlayerTalent/Name/" + tid) or fallback_name("특기", tid),
            "desc": ko.get("PlayerTalent/Desc/" + tid),
            "maxLevel": to_int(pick(rec, "_maxLevel"), 1) or 1,
        })
    out.sort(key=lambda x: _sort_num_str(x["id"]))
    return out


def build_battle_skills(db: Dict[str, Any], ko: KoDict) -> List[Dict[str, Any]]:
    out = []
    seen = set()
    for rec in db.get("Mortal.Core.BattleSkillData", []):
        key = str(pick(rec, "_key", default="")).strip()
        if not key or key in seen:
            continue
        seen.add(key)
        out.append({
            "key": key,
            "name": ko.get("BattleSkill/Name/" + key) or fallback_name("전역 기술", key),
            "desc": ko.get("BattleSkill/Desc/" + key),
            "cooldown": to_int(pick(rec, "_cooldownTime"), 0) or 0,
        })
    out.sort(key=lambda x: x["key"])
    return out


def build_upgrades(db: Dict[str, Any], ko: KoDict) -> List[Dict[str, Any]]:
    type_names = {1: "독술", 2: "연단", 11: "평사", 12: "포사", 13: "함정", 21: "무기", 22: "방어구"}
    out = []
    seen = set()
    for rec in db.get("Mortal.Core.UpgradeItemData", []):
        key = str(pick(rec, "_key", default="")).strip()
        if not key or key in seen:
            continue
        seen.add(key)
        itype = to_int(pick(rec, "_itemType"), 0) or 0
        lvls = pick(rec, "_upgradeLevels")
        max_lvl = len(lvls) if isinstance(lvls, list) else 10
        out.append({
            "key": key,
            "name": ko.get_any(["Equip/Name/" + key, "UpgradeItem/Name/" + key]) or fallback_name("개발", key),
            "desc": ko.get_any(["Equip/Desc/" + key, "UpgradeItem/Desc/" + key]),
            "category": type_names.get(itype, "기타"),
            "isPoison": itype in (1, 2),
            "maxLevel": max_lvl,
        })
    out.sort(key=lambda x: x["key"])
    return out


def build_library(db: Dict[str, Any], ko: KoDict) -> List[Dict[str, Any]]:
    def cat_of(lid: str) -> str:
        try:
            n = int(lid)
        except Exception:
            return "other"
        if 10000 <= n < 20000:
            return "death"
        if 20000 <= n < 30000:
            return "ending"
        if 30000 <= n < 40000:
            return "achievement"
        if 40000 <= n < 50000:
            return "cg"
        return "other"

    out = []
    seen = set()
    for rec in db.get("Mortal.Core.LibraryItemData", []):
        lid = str(pick(rec, "m_Name", default="")).strip()
        if not lid or lid in seen:
            continue
        seen.add(lid)
        out.append({
            "id": lid,
            "name": ko.get("Library/Title/" + lid) or fallback_name("도감", lid),
            "desc": ko.get("Library/Desc/" + lid),
            "category": cat_of(lid),
        })
    for lid in ko.collect_ids("Library/Title/"):
        if lid not in seen:
            seen.add(lid)
            out.append({
                "id": lid,
                "name": ko.get("Library/Title/" + lid) or fallback_name("도감", lid),
                "desc": ko.get("Library/Desc/" + lid),
                "category": cat_of(lid),
            })
    out.sort(key=lambda x: _sort_num_str(x["id"]))
    return out


def build_enemy_teams(db: Dict[str, Any], ko: KoDict) -> List[Dict[str, Any]]:
    out = []
    seen = set()
    for rec in db.get("Mortal.Core.BattleTeamStat", []):
        tid = str(pick(rec, "_id", default="")).strip()
        if not tid or tid in seen:
            continue
        seen.add(tid)
        out.append({
            "id": tid,
            "name": ko.get("EnemyTeam/" + tid) or fallback_name("세력", tid),
        })
    out.sort(key=lambda x: _sort_num_str(x["id"]))
    return out


def build_flags(db: Dict[str, Any], ko: KoDict) -> List[Dict[str, Any]]:
    out = []
    seen = set()
    for rec in db.get("Mortal.Core.FlagData", []):
        fid = str(pick(rec, "m_Name", default="")).strip()
        if not fid or fid in seen:
            continue
        seen.add(fid)
        name = ko.get_any(["Flag/Name/" + fid, "Flag/Desc/" + fid]) or ("이벤트 플래그 " + fid)
        out.append({
            "id": fid,
            "name": name,
            "defaultValue": to_int(pick(rec, "_default"), 0) or 0,
        })
    out.sort(key=lambda x: x["id"])
    return out


def verify_catalog_text(js_text: str) -> Tuple[List[str], List[str], List[str]]:
    return HANZI_RE.findall(js_text), KANA_RE.findall(js_text), URL_RE.findall(js_text)


def write_atomic(path: str, text: str) -> None:
    parent = os.path.dirname(os.path.abspath(path))
    os.makedirs(parent, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix=".catalog-", suffix=".tmp", dir=parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="활협전 한국어 카탈로그 추출 및 검증기")
    parser.add_argument("--check-only", action="store_true", help="기존 catalog-data.js 검증만 수행")
    args = parser.parse_args(argv)

    if not args.check_only:
        db = load_json(DB_PATH)
        ko = KoDict(load_json(KO_PATH))
        catalog = {
            "meta": {"title": "활협전", "appId": 1859910},
            "stats": build_stats(ko),
            "relationships": build_relationships(db, ko),
            "books": build_books(db, ko),
            "miscs": build_miscs(ko),
            "specialItems": build_special_items(db, ko),
            "talents": build_talents(db, ko),
            "battleSkills": build_battle_skills(db, ko),
            "upgrades": build_upgrades(db, ko),
            "library": build_library(db, ko),
            "enemyTeams": build_enemy_teams(db, ko),
            "flags": build_flags(db, ko),
        }
        payload = json.dumps(catalog, ensure_ascii=False, separators=(",", ":"))
        js = (
            "/* Auto-generated by tools/extract_catalog.py — pure Korean catalog (LomCatalog). */\n"
            "(function (root, factory) {\n"
            "  'use strict';\n"
            "  if (typeof module === 'object' && module.exports) { module.exports = factory(); }\n"
            "  else if (typeof define === 'function' && define.amd) { define([], factory); }\n"
            "  else { root.LomCatalog = factory(); }\n"
            "})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function () {\n"
            "  'use strict';\n"
            "  return " + payload + ";\n"
            "});\n"
        )
        write_atomic(OUTPUT_PATH, js)

    if not os.path.isfile(OUTPUT_PATH):
        sys.stderr.write("[ERROR] catalog-data.js not found\n")
        return 1

    text = open(OUTPUT_PATH, "r", encoding="utf-8").read()
    hz, kn, urls = verify_catalog_text(text)
    m = re.search(r"return (\{.*\});", text, re.DOTALL)
    data = json.loads(m.group(1)) if m else {}
    counts = {k: len(v) for k, v in data.items() if isinstance(v, list)}
    print("[OK] Catalog counts:", ", ".join(f"{k}={v}" for k, v in counts.items()))
    print(f"[OK] Hanzi: {len(hz)}, Kana: {len(kn)}, URLs: {len(urls)}")
    if hz or kn or urls:
        sys.stderr.write(f"[ERROR] Forbidden characters/URLs: hz={hz[:10]} kn={kn[:10]} urls={urls[:5]}\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
