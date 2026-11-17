#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""활협전(Legend of Mortal) 세이브 에디터 CLI 및 루프백 HTTP 서버.

Python 3 표준 라이브러리(서드파티 패키지 0개)만으로 동작하며,
MS-NRBF(.NET BinaryFormatter) 무손실 AST 코덱·도메인 검증·안전 백업·루프백 서버를 제공한다.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import http.server
import json
import os
import re
import secrets
import stat
import struct
import subprocess
import sys
import tempfile
import urllib.parse
import webbrowser
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# MS-NRBF 상수 (src/nrbf-codec.js 와 1:1 동형)
# ---------------------------------------------------------------------------

T_HEADER = 0
T_CLASSID = 1
T_SYSANDT = 4
T_CLASSANDT = 5
T_STRING = 6
T_BARRAY = 7
T_PRIMVAL = 8
T_MEMBERREF = 9
T_NULL = 10
T_MSGEND = 11
T_LIBRARY = 12
T_NULL256 = 13
T_NULLMULT = 14
T_ARRPRIM = 15
T_ARROBJ = 16
T_ARRSTR = 17

BT_PRIMITIVE = 0
BT_STRING = 1
BT_OBJECT = 2
BT_SYSCLASS = 3
BT_CLASS = 4
BT_OBJECTARR = 5
BT_STRINGARR = 6
BT_PRIMITIVEARR = 7

PT_BOOLEAN = 1
PT_BYTE = 2
PT_CHAR = 3
PT_DECIMAL = 5
PT_DOUBLE = 6
PT_INT16 = 7
PT_INT32 = 8
PT_INT64 = 9
PT_SBYTE = 10
PT_SINGLE = 11
PT_TIMESPAN = 12
PT_DATETIME = 13
PT_UINT16 = 14
PT_UINT32 = 15
PT_UINT64 = 16
PT_NULL = 17
PT_STRING = 18

_PRIM_FMT = {
    PT_BOOLEAN: ("<?", 1),
    PT_BYTE: ("<B", 1),
    PT_INT16: ("<h", 2),
    PT_INT32: ("<i", 4),
    PT_INT64: ("<q", 8),
    PT_SBYTE: ("<b", 1),
    PT_TIMESPAN: ("<q", 8),
    PT_DATETIME: ("<Q", 8),
    PT_UINT16: ("<H", 2),
    PT_UINT32: ("<I", 4),
    PT_UINT64: ("<Q", 8),
}


class NRBFError(Exception):
    pass


class GameRunningError(Exception):
    pass


class UnsafePathError(Exception):
    pass


class _Reader:
    __slots__ = ("buf", "pos")

    def __init__(self, buf: bytes, pos: int = 0) -> None:
        self.buf = buf
        self.pos = pos

    def eof(self) -> bool:
        return self.pos >= len(self.buf)

    def _take(self, n: int) -> bytes:
        end = self.pos + n
        if end > len(self.buf):
            raise NRBFError(f"스트림 조기 종료 @ {self.pos} (+{n})")
        v = self.buf[self.pos:end]
        self.pos = end
        return v

    def u8(self) -> int:
        return self._take(1)[0]

    def i32(self) -> int:
        return struct.unpack("<i", self._take(4))[0]

    def lebu(self) -> int:
        val = 0
        shift = 0
        while True:
            b = self.u8()
            val |= (b & 0x7F) << shift
            if not (b & 0x80):
                return val
            shift += 7

    def bstr(self) -> str:
        n = self.lebu()
        return self._take(n).decode("utf-8", "surrogateescape") if n else ""


def _lebu_bytes(v: int) -> bytes:
    out = bytearray()
    while True:
        b = v & 0x7F
        v >>= 7
        if v:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def _str_bytes(s: str) -> bytes:
    raw = str(s).encode("utf-8", "surrogateescape")
    return _lebu_bytes(len(raw)) + raw


def _read_primitive(r: _Reader, pt: int) -> Any:
    if pt == PT_CHAR:
        b0 = r._take(1)
        v = b0[0]
        extra = 0 if (v & 0x80) == 0 else (1 if (v & 0xE0) == 0xC0 else (2 if (v & 0xF0) == 0xE0 else 3))
        return (b0 + r._take(extra)).decode("utf-8", "surrogateescape")
    if pt in (PT_DECIMAL, PT_STRING):
        return r.bstr()
    if pt == PT_NULL:
        return None
    if pt == PT_SINGLE:
        return ("raw4", r._take(4))
    if pt == PT_DOUBLE:
        return ("raw8", r._take(8))
    if pt not in _PRIM_FMT:
        raise NRBFError(f"지원하지 않는 원시 타입: {pt}")
    fmt, sz = _PRIM_FMT[pt]
    return struct.unpack(fmt, r._take(sz))[0]


def _write_primitive(pt: int, val: Any) -> bytes:
    if pt == PT_CHAR:
        return str(val or "\0").encode("utf-8", "surrogateescape")
    if pt in (PT_DECIMAL, PT_STRING):
        return _str_bytes(val if val is not None else "")
    if pt == PT_NULL:
        return b""
    if pt == PT_SINGLE:
        if isinstance(val, tuple) and val[0] == "raw4":
            return val[1]
        return struct.pack("<f", float(val or 0))
    if pt == PT_DOUBLE:
        if isinstance(val, tuple) and val[0] == "raw8":
            return val[1]
        return struct.pack("<d", float(val or 0))
    fmt, _ = _PRIM_FMT[pt]
    if pt == PT_BOOLEAN:
        return struct.pack(fmt, bool(val))
    return struct.pack(fmt, int(val or 0))


def _read_add_info(r: _Reader, bt: int) -> Any:
    if bt in (BT_PRIMITIVE, BT_PRIMITIVEARR):
        return r.u8()
    if bt == BT_SYSCLASS:
        return r.bstr()
    if bt == BT_CLASS:
        return (r.bstr(), r.i32())
    return None


def _write_add_info(bt: int, extra: Any) -> bytes:
    if bt in (BT_PRIMITIVE, BT_PRIMITIVEARR):
        return bytes([extra])
    if bt == BT_SYSCLASS:
        return _str_bytes(extra)
    if bt == BT_CLASS:
        return _str_bytes(extra[0]) + struct.pack("<i", extra[1])
    return b""


def _read_mti(r: _Reader, count: int) -> List[Tuple[int, Any]]:
    btypes = [r.u8() for _ in range(count)]
    return [(bt, _read_add_info(r, bt)) for bt in btypes]


def _write_mti(infos: List[Tuple[int, Any]]) -> bytes:
    out = bytearray(bt for bt, _ in infos)
    for bt, extra in infos:
        out.extend(_write_add_info(bt, extra))
    return bytes(out)


def _read_class_info(r: _Reader) -> Dict[str, Any]:
    oid = r.i32()
    name = r.bstr()
    mc = r.i32()
    if mc < 0 or mc > 8192:
        raise NRBFError(f"비정상 멤버 개수: {mc}")
    return {"objectId": oid, "name": name, "memberNames": [r.bstr() for _ in range(mc)]}


def _write_class_info(ci: Dict[str, Any]) -> bytes:
    out = bytearray(struct.pack("<i", ci["objectId"]))
    out.extend(_str_bytes(ci["name"]))
    out.extend(struct.pack("<i", len(ci["memberNames"])))
    for m in ci["memberNames"]:
        out.extend(_str_bytes(m))
    return bytes(out)


def parse_nrbf(raw: bytes) -> Dict[str, Any]:
    r = _Reader(raw, 0)
    if r.eof():
        raise NRBFError("빈 파일입니다.")
    first = r.u8()
    if first != T_HEADER:
        raise NRBFError(f"NRBF 헤더가 아닙니다 (0x{first:02X}).")

    doc: Dict[str, Any] = {
        "raw": raw,
        "header": {
            "recordType": T_HEADER,
            "rootId": r.i32(),
            "headerId": r.i32(),
            "majorVersion": r.i32(),
            "minorVersion": r.i32(),
        },
        "records": [],
        "classesById": {},
        "classesByName": {},
        "byId": {},
        "libraries": {},
        "nextObjectId": 1,
        "streamEndOffset": 0,
        "trailingBytesCount": 0,
        "_dirty": False,
    }
    doc["records"].append(doc["header"])

    def track(oid: int, rec: Dict[str, Any]) -> None:
        doc["byId"][oid] = rec
        if oid > 0 and oid >= doc["nextObjectId"]:
            doc["nextObjectId"] = oid + 1

    def read_array_elems(total: int) -> List[Any]:
        elems: List[Any] = []
        rem = total
        while rem > 0:
            node = read_record_by_tag(r.u8())
            if isinstance(node, dict) and "$nulls" in node:
                elems.append(node)
                rem -= node["$nulls"]
            else:
                elems.append(node)
                rem -= 1
        if rem < 0:
            raise NRBFError(f"배열 null 패딩 초과: {-rem}")
        return elems

    def read_member_values(mti: List[Tuple[int, Any]]) -> List[Any]:
        vals: List[Any] = []
        for bt, extra in mti:
            if bt == BT_PRIMITIVE:
                vals.append(_read_primitive(r, extra))
            else:
                vals.append(read_record_by_tag(r.u8()))
        return vals

    def read_record_by_tag(tag: int) -> Dict[str, Any]:
        if tag == T_LIBRARY:
            lid = r.i32()
            lname = r.bstr()
            doc["libraries"][lid] = lname
            return {"recordType": tag, "libraryId": lid, "libraryName": lname}
        if tag in (T_SYSANDT, T_CLASSANDT):
            ci = _read_class_info(r)
            mti = _read_mti(r, len(ci["memberNames"]))
            lid = r.i32() if tag == T_CLASSANDT else None
            rec = {
                "recordType": tag,
                "classInfo": ci,
                "memberTypeInfo": mti,
                "libraryId": lid,
                "memberValues": [],
            }
            doc["classesById"][ci["objectId"]] = rec
            doc["classesByName"].setdefault(ci["name"], rec)
            track(ci["objectId"], rec)
            rec["memberValues"] = read_member_values(mti)
            return rec
        if tag == T_CLASSID:
            oid = r.i32()
            mid = r.i32()
            meta = doc["classesById"].get(mid)
            if meta is None:
                raise NRBFError(f"ClassWithId 메타 미발견: {mid}")
            rec = {
                "recordType": tag,
                "objectId": oid,
                "metadataId": mid,
                "memberValues": [],
            }
            track(oid, rec)
            rec["memberValues"] = read_member_values(meta["memberTypeInfo"])
            return rec
        if tag == T_STRING:
            oid = r.i32()
            val = r.bstr()
            rec = {"recordType": tag, "objectId": oid, "value": val}
            track(oid, rec)
            return rec
        if tag == T_BARRAY:
            oid = r.i32()
            bat = r.u8()
            rank = r.i32()
            lengths = [r.i32() for _ in range(rank)]
            lower = [r.i32() for _ in range(rank)] if bat in (3, 4, 5) else None
            et = r.u8()
            eai = _read_add_info(r, et)
            total = 1
            for ln in lengths:
                total *= ln
            rec = {
                "recordType": tag,
                "objectId": oid,
                "binaryArrayType": bat,
                "rank": rank,
                "lengths": lengths,
                "lowerBounds": lower,
                "elementType": et,
                "elementAdditionalInfo": eai,
                "elements": [],
            }
            track(oid, rec)
            rec["elements"] = read_array_elems(total)
            return rec
        if tag == T_ARRPRIM:
            oid = r.i32()
            length = r.i32()
            pt = r.u8()
            rec = {
                "recordType": tag,
                "objectId": oid,
                "length": length,
                "primitiveType": pt,
                "elements": [],
            }
            track(oid, rec)
            rec["elements"] = [_read_primitive(r, pt) for _ in range(length)]
            return rec
        if tag in (T_ARROBJ, T_ARRSTR):
            oid = r.i32()
            length = r.i32()
            rec = {"recordType": tag, "objectId": oid, "length": length, "elements": []}
            track(oid, rec)
            rec["elements"] = read_array_elems(length)
            return rec
        if tag == T_PRIMVAL:
            pt = r.u8()
            return {"recordType": tag, "primitiveType": pt, "value": _read_primitive(r, pt)}
        if tag == T_MEMBERREF:
            return {"recordType": tag, "idRef": r.i32()}
        if tag == T_NULL:
            return {"recordType": tag, "$nulls": 1}
        if tag == T_NULL256:
            return {"recordType": tag, "$nulls": r.u8()}
        if tag == T_NULLMULT:
            return {"recordType": tag, "$nulls": r.i32()}
        if tag == T_MSGEND:
            return {"recordType": tag}
        raise NRBFError(f"알 수 없는 레코드 태그 0x{tag:02X} @ {r.pos - 1}")

    while not r.eof():
        tag = r.u8()
        rec = read_record_by_tag(tag)
        doc["records"].append(rec)
        if tag == T_MSGEND:
            break

    doc["streamEndOffset"] = r.pos
    doc["trailingBytesCount"] = len(raw) - r.pos
    return doc


def serialize_nrbf(doc: Dict[str, Any]) -> bytes:
    if not doc.get("_dirty") and doc.get("raw") is not None:
        return doc["raw"][:doc["streamEndOffset"]]

    out = bytearray()

    def emit_node(node: Dict[str, Any]) -> None:
        t = node["recordType"]
        if t == T_HEADER:
            out.append(T_HEADER)
            out.extend(struct.pack("<iiii", node["rootId"], node["headerId"], node["majorVersion"], node["minorVersion"]))
        elif t == T_LIBRARY:
            out.append(T_LIBRARY)
            out.extend(struct.pack("<i", node["libraryId"]))
            out.extend(_str_bytes(node["libraryName"]))
        elif t in (T_SYSANDT, T_CLASSANDT):
            out.append(t)
            out.extend(_write_class_info(node["classInfo"]))
            out.extend(_write_mti(node["memberTypeInfo"]))
            if t == T_CLASSANDT:
                out.extend(struct.pack("<i", node["libraryId"]))
            emit_members(node["memberTypeInfo"], node["memberValues"])
        elif t == T_CLASSID:
            out.append(T_CLASSID)
            out.extend(struct.pack("<ii", node["objectId"], node["metadataId"]))
            meta = doc["classesById"][node["metadataId"]]
            emit_members(meta["memberTypeInfo"], node["memberValues"])
        elif t == T_STRING:
            out.append(T_STRING)
            out.extend(struct.pack("<i", node["objectId"]))
            out.extend(_str_bytes(node["value"]))
        elif t == T_BARRAY:
            out.append(T_BARRAY)
            out.extend(struct.pack("<iBi", node["objectId"], node["binaryArrayType"], node["rank"]))
            for ln in node["lengths"]:
                out.extend(struct.pack("<i", ln))
            if node["lowerBounds"] is not None:
                for lb in node["lowerBounds"]:
                    out.extend(struct.pack("<i", lb))
            out.append(node["elementType"])
            out.extend(_write_add_info(node["elementType"], node["elementAdditionalInfo"]))
            for el in node["elements"]:
                emit_node(el)
        elif t == T_ARRPRIM:
            out.append(T_ARRPRIM)
            out.extend(struct.pack("<iiB", node["objectId"], node["length"], node["primitiveType"]))
            for el in node["elements"]:
                out.extend(_write_primitive(node["primitiveType"], el))
        elif t in (T_ARROBJ, T_ARRSTR):
            out.append(t)
            out.extend(struct.pack("<ii", node["objectId"], node["length"]))
            for el in node["elements"]:
                emit_node(el)
        elif t == T_PRIMVAL:
            out.append(T_PRIMVAL)
            out.append(node["primitiveType"])
            out.extend(_write_primitive(node["primitiveType"], node["value"]))
        elif t == T_MEMBERREF:
            out.append(T_MEMBERREF)
            out.extend(struct.pack("<i", node["idRef"]))
        elif t == T_NULL:
            out.append(T_NULL)
        elif t == T_NULL256:
            out.append(T_NULL256)
            out.append(node["$nulls"] & 0xFF)
        elif t == T_NULLMULT:
            out.append(T_NULLMULT)
            out.extend(struct.pack("<i", node["$nulls"]))
        elif t == T_MSGEND:
            out.append(T_MSGEND)
        else:
            raise NRBFError(f"직렬화 불가 레코드: {t}")

    def emit_members(mti: List[Tuple[int, Any]], vals: List[Any]) -> None:
        for (bt, extra), val in zip(mti, vals):
            if bt == BT_PRIMITIVE:
                out.extend(_write_primitive(extra, val))
            else:
                emit_node(val)

    ended = False
    for rec in doc["records"]:
        emit_node(rec)
        if rec["recordType"] == T_MSGEND:
            ended = True
            break
    if not ended:
        out.append(T_MSGEND)
    return bytes(out)


# ---------------------------------------------------------------------------
# 도메인 어댑터
# ---------------------------------------------------------------------------

def _resolve(doc: Dict[str, Any], node: Any) -> Any:
    if isinstance(node, dict):
        if node.get("recordType") == T_MEMBERREF:
            return doc["byId"].get(node["idRef"])
        if node.get("recordType") in (T_NULL, T_NULL256, T_NULLMULT):
            return None
    return node


def _class_meta(doc: Dict[str, Any], rec: Dict[str, Any]) -> Dict[str, Any]:
    if rec.get("recordType") == T_CLASSID:
        return doc["classesById"][rec["metadataId"]]
    return rec


def get_field(doc: Dict[str, Any], rec: Any, name: str) -> Any:
    rec = _resolve(doc, rec)
    if not isinstance(rec, dict):
        return None
    meta = _class_meta(doc, rec)
    names = meta["classInfo"]["memberNames"]
    if name not in names:
        return None
    idx = names.index(name)
    val = rec["memberValues"][idx]
    bt, _ = meta["memberTypeInfo"][idx]
    if bt == BT_PRIMITIVE:
        return val
    res = _resolve(doc, val)
    if isinstance(res, dict):
        if res.get("recordType") == T_STRING:
            return res["value"]
        if res.get("recordType") in (T_CLASSID, T_CLASSANDT, T_SYSANDT):
            rm = _class_meta(doc, res)
            if rm["classInfo"]["memberNames"] == ["value__"]:
                return res["memberValues"][0]
        return res
    return res


def set_field(doc: Dict[str, Any], rec: Any, name: str, val: Any) -> bool:
    rec = _resolve(doc, rec)
    if not isinstance(rec, dict):
        return False
    meta = _class_meta(doc, rec)
    names = meta["classInfo"]["memberNames"]
    if name not in names:
        return False
    idx = names.index(name)
    bt, extra = meta["memberTypeInfo"][idx]
    if bt == BT_PRIMITIVE:
        if extra == PT_BOOLEAN:
            rec["memberValues"][idx] = bool(val)
        else:
            rec["memberValues"][idx] = int(val)
    else:
        cur = _resolve(doc, rec["memberValues"][idx])
        if isinstance(cur, dict) and cur.get("recordType") in (T_CLASSID, T_CLASSANDT, T_SYSANDT):
            rm = _class_meta(doc, cur)
            if rm["classInfo"]["memberNames"] == ["value__"]:
                cur["memberValues"][0] = int(val)
                doc["_dirty"] = True
                return True
        if val is None:
            rec["memberValues"][idx] = {"recordType": T_NULL, "$nulls": 1}
        elif isinstance(cur, dict) and cur.get("recordType") == T_STRING:
            cur["value"] = str(val)
        else:
            oid = doc["nextObjectId"]
            doc["nextObjectId"] += 1
            srec = {"recordType": T_STRING, "objectId": oid, "value": str(val)}
            doc["byId"][oid] = srec
            rec["memberValues"][idx] = srec
    doc["_dirty"] = True
    return True


def _expand_slots(elements: List[Dict[str, Any]]) -> List[Optional[Dict[str, Any]]]:
    slots: List[Optional[Dict[str, Any]]] = []
    for el in elements:
        if "$nulls" in el:
            slots.extend([None] * el["$nulls"])
        else:
            slots.append(el)
    return slots


def _compress_slots(slots: List[Optional[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    i = 0
    n = len(slots)
    while i < n:
        if slots[i] is not None:
            out.append(slots[i])  # type: ignore[arg-type]
            i += 1
        else:
            run = 0
            while i + run < n and slots[i + run] is None:
                run += 1
            if run == 1:
                out.append({"recordType": T_NULL, "$nulls": 1})
            elif run <= 255:
                out.append({"recordType": T_NULL256, "$nulls": run})
            else:
                out.append({"recordType": T_NULLMULT, "$nulls": run})
            i += run
    return out


def list_get_items(doc: Dict[str, Any], list_rec: Any) -> List[Dict[str, Any]]:
    lr = _resolve(doc, list_rec)
    if not isinstance(lr, dict):
        return []
    size = get_field(doc, lr, "_size") or 0
    arr = _resolve(doc, get_field(doc, lr, "_items"))
    if not isinstance(arr, dict):
        return []
    slots = _expand_slots(arr["elements"])
    out: List[Dict[str, Any]] = []
    for s in slots[:size]:
        r = _resolve(doc, s)
        if isinstance(r, dict):
            out.append(r)
    return out


_KNOWN_SCHEMAS = {
    "Mortal.Core.StatSave": [("Key", BT_STRING, None), ("Value", BT_PRIMITIVE, PT_INT32)],
    "Mortal.Core.RelationshipSave": [("Key", BT_STRING, None), ("Value", BT_PRIMITIVE, PT_INT32), ("Active", BT_PRIMITIVE, PT_BOOLEAN)],
    "Mortal.Core.LibrarySave": [("Name", BT_STRING, None), ("Count", BT_PRIMITIVE, PT_INT32)],
}


def list_upsert(doc: Dict[str, Any], list_rec: Any, class_name: str, key_field: str, key_val: Any, updates: Dict[str, Any]) -> Dict[str, Any]:
    lr = _resolve(doc, list_rec)
    arr = _resolve(doc, get_field(doc, lr, "_items"))
    size = get_field(doc, lr, "_size") or 0
    slots = _expand_slots(arr["elements"])

    for s in slots[:size]:
        item = _resolve(doc, s)
        if item and str(get_field(doc, item, key_field)) == str(key_val):
            for k, v in updates.items():
                set_field(doc, item, k, v)
            doc["_dirty"] = True
            return item

    oid = doc["nextObjectId"]
    doc["nextObjectId"] += 1
    meta = doc["classesByName"].get(class_name)
    if meta:
        mti = meta["memberTypeInfo"]
        names = meta["classInfo"]["memberNames"]
        vals = []
        for (bt, extra), fn in zip(mti, names):
            fv = key_val if fn == key_field else updates.get(fn)
            if bt == BT_PRIMITIVE:
                vals.append(bool(fv) if extra == PT_BOOLEAN else int(fv or 0))
            elif fv is None:
                vals.append({"recordType": T_NULL, "$nulls": 1})
            else:
                soid = doc["nextObjectId"]
                doc["nextObjectId"] += 1
                srec = {"recordType": T_STRING, "objectId": soid, "value": str(fv)}
                doc["byId"][soid] = srec
                vals.append(srec)
        new_rec: Dict[str, Any] = {
            "recordType": T_CLASSANDT,
            "classInfo": {"objectId": oid, "name": class_name, "memberNames": list(names)},
            "memberTypeInfo": list(mti),
            "libraryId": meta.get("libraryId", next((k for k, v in doc["libraries"].items() if v.startswith("Mortal.Core")), 2)),
            "memberValues": vals,
        }
        doc["classesById"][oid] = new_rec
    else:
        schema = _KNOWN_SCHEMAS[class_name]
        lib_id = next((k for k, v in doc["libraries"].items() if v.startswith("Mortal.Core")), 2)
        names = [x[0] for x in schema]
        mti = [(x[1], x[2]) for x in schema]
        vals = []
        for fn, bt, extra in schema:
            fv = key_val if fn == key_field else updates.get(fn)
            if bt == BT_PRIMITIVE:
                vals.append(bool(fv) if extra == PT_BOOLEAN else int(fv or 0))
            elif fv is None:
                vals.append({"recordType": T_NULL, "$nulls": 1})
            else:
                soid = doc["nextObjectId"]
                doc["nextObjectId"] += 1
                srec = {"recordType": T_STRING, "objectId": soid, "value": str(fv)}
                doc["byId"][soid] = srec
                vals.append(srec)
        new_rec = {
            "recordType": T_CLASSANDT,
            "classInfo": {"objectId": oid, "name": class_name, "memberNames": names},
            "memberTypeInfo": mti,
            "libraryId": lib_id,
            "memberValues": vals,
        }
        doc["classesById"][oid] = new_rec
        doc["classesByName"][class_name] = new_rec

    doc["byId"][oid] = new_rec
    if size < len(slots):
        slots[size] = new_rec
    else:
        target_len = max(4, len(slots) * 2 if slots else 4)
        slots.append(new_rec)
        while len(slots) < target_len:
            slots.append(None)
    arr["elements"] = _compress_slots(slots)
    if arr.get("lengths"):
        arr["lengths"][0] = len(slots)
    else:
        arr["length"] = len(slots)
    set_field(doc, lr, "_size", size + 1)
    set_field(doc, lr, "_version", (get_field(doc, lr, "_version") or 0) + 1)
    doc["_dirty"] = True
    return new_rec


def detect_root_kind(doc: Dict[str, Any]) -> Tuple[str, Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
    root = doc["byId"].get(doc["header"]["rootId"])
    if not root:
        return "Unknown", None, None
    meta = _class_meta(doc, root)
    short = meta["classInfo"]["name"].split(".")[-1]
    if short == "AutoGameSave":
        inner = _resolve(doc, get_field(doc, root, "GameSave"))
        return "AutoGameSave", root, inner
    if short == "GameSave":
        return "GameSave", root, root
    if short == "LegendSave":
        return "LegendSave", root, None
    if short == "UniverseSave":
        return "UniverseSave", root, None
    return short, root, None


_STAT_SUMMARY_KEYS = (
    "money", "life", "stamina", "dexterity", "mental",
    "literacy", "fame", "people", "assets", "martial-point",
)


def _read_stat_map(doc: Dict[str, Any], game: Dict[str, Any]) -> Dict[str, int]:
    out: Dict[str, int] = {}
    srec = get_field(doc, game, "Stats")
    for item in list_get_items(doc, srec):
        k = get_field(doc, item, "Key")
        v = get_field(doc, item, "Value")
        if isinstance(k, str) and isinstance(v, int):
            out[k] = v
    return out


def summarize_doc(doc: Dict[str, Any], path: str, raw: bytes) -> Dict[str, Any]:
    kind, root, game = detect_root_kind(doc)
    stats = _read_stat_map(doc, game) if game else {}
    counts: Dict[str, int] = {}
    if game:
        for out_k, fld in (
            ("books", "Books"), ("miscs", "Miscs"), ("specialItems", "SpecialItems"),
            ("talents", "Talents"), ("relationships", "Relationships"),
        ):
            counts[out_k] = len(list_get_items(doc, get_field(doc, game, fld)))
    elif kind == "UniverseSave" and root:
        for i in range(1, 5):
            counts[f"library{i}"] = len(list_get_items(doc, get_field(doc, root, f"LibraryData{i}")))
    elif kind == "LegendSave" and root:
        counts["story"] = len(list_get_items(doc, get_field(doc, root, "Story")))

    return {
        "path": os.path.abspath(path),
        "name": os.path.basename(path),
        "kind": kind,
        "size": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "version": get_field(doc, game or root, "Version") if (game or root) else None,
        "currentYear": get_field(doc, game, "CurrentYear") if game else None,
        "currentMonth": get_field(doc, game, "CurrentMonth") if game else None,
        "currentStage": get_field(doc, game, "CurrentStage") if game else None,
        "slot": get_field(doc, root, "Slot") if kind == "AutoGameSave" else None,
        "endKey": get_field(doc, root, "EndKey") if kind == "LegendSave" else None,
        "stats": {k: stats.get(k) for k in _STAT_SUMMARY_KEYS if k in stats},
        "counts": counts,
        "trailingBytesCount": doc["trailingBytesCount"],
        "recordCount": len(doc["records"]),
    }


_NONNEG_STATS = {
    "money", "life", "stamina", "dexterity", "charisma", "literacy",
    "fate", "action", "people", "fame", "team", "poison", "weapon",
    "martial-point", "total-martial-point", "total-poison-point",
    "total-weapon-point", "cook", "poison-resistance", "paralysis-resistance",
    "confucianism", "taoism", "buddhism", "mental",
}


def validate_doc(doc: Dict[str, Any]) -> Dict[str, Any]:
    problems: List[str] = []
    kind, root, game = detect_root_kind(doc)
    if root is None:
        problems.append("루트 세이브 레코드가 없습니다.")
        return {"ok": False, "kind": kind, "problems": problems}
    if kind in ("GameSave", "AutoGameSave") and game is None:
        problems.append("자동저장 내부 GameSave가 비어 있습니다.")
        return {"ok": False, "kind": kind, "problems": problems}

    if game is not None:
        cy = get_field(doc, game, "CurrentYear")
        if isinstance(cy, int) and cy < 1:
            problems.append(f"연도 값 오류: {cy}")
        cm = get_field(doc, game, "CurrentMonth")
        if isinstance(cm, int) and not (1 <= cm <= 12):
            problems.append(f"월 값 오류: {cm}")
        cs = get_field(doc, game, "CurrentStage")
        if isinstance(cs, int) and not (0 <= cs <= 3):
            problems.append(f"순 값 오류: {cs}")
        de = get_field(doc, game, "CurrentDayEnvironment")
        if isinstance(de, int) and not (0 <= de <= 2):
            problems.append(f"낮/밤 값 오류: {de}")

        for k, v in _read_stat_map(doc, game).items():
            if not (-(2**31) <= v < 2**31):
                problems.append(f"능력치 32비트 범위 초과: {k}={v}")
            if (k in _NONNEG_STATS or k.startswith("m-")) and v < 0:
                problems.append(f"음수 불가 능력치: {k}={v}")
            if k == "assets" and not (-99999 <= v <= 99999):
                problems.append(f"문파 자산 범위 초과: {v}")
            if k == "contribution" and not (-200 <= v <= 200):
                problems.append(f"공헌도 범위 초과: {v}")

    return {
        "ok": len(problems) == 0,
        "kind": kind,
        "problems": problems,
        "trailingBytesCount": doc["trailingBytesCount"],
        "recordCount": len(doc["records"]),
    }


PRESETS: Dict[str, Dict[str, Any]] = {
    "rich_start": {
        "name": "풍요로운 시작",
        "desc": "은자 99,999 · 무학 점수 200 · 행동력 10 · 문파 자산 50,000",
        "stats": {"money": 99999, "martial-point": 200, "action": 10, "assets": 50000, "fame": 100},
    },
    "hero_all_100": {
        "name": "강호 영웅",
        "desc": "기초 능력치 11종 100 및 심상 100 설정",
        "stats": {
            "life": 100, "stamina": 100, "dexterity": 100, "charisma": 100,
            "literacy": 100, "fate": 100, "talking": 100, "cook": 100,
            "poison-resistance": 100, "paralysis-resistance": 100, "defence": 100, "mental": 100,
        },
    },
    "martial_master": {
        "name": "무학 대가",
        "desc": "무학 8계열 · 학문 3계열 100 및 무학 점수 300",
        "stats": {
            "m-sword": 100, "m-projectile": 100, "m-fist": 100, "m-leg": 100,
            "m-odd": 100, "m-soft": 100, "m-stick": 100, "m-internal": 100,
            "confucianism": 100, "taoism": 100, "buddhism": 100, "martial-point": 300,
        },
    },
    "tangmen_prosperity": {
        "name": "당문 번영",
        "desc": "문파 규모 6 · 문인 300 · 명성 100 · 향심력 100 · 연단/단조 500",
        "stats": {"faction": 6, "people": 300, "fame": 100, "team": 100, "poison": 500, "weapon": 500},
    },
    "full_favorability": {
        "name": "만인 호감",
        "desc": "보유 인물 호감도 전부 100 및 활성 상태 설정",
        "relationships_max": 100,
    },
    "unlock_all_library": {
        "name": "도감 전체 해금",
        "desc": "전역 세이브(Save_universe) 보유 도감 항목 카운트 1 이상 해금",
        "unlock_library": True,
    },
}


def apply_domain_edits(doc: Dict[str, Any], presets: List[str], stat_pairs: List[str], money: Optional[int]) -> None:
    kind, root, game = detect_root_kind(doc)
    merged_stats: Dict[str, int] = {}
    max_rel = False
    unlock_lib = False

    for pid in presets or []:
        if pid not in PRESETS:
            raise ValueError(f"알 수 없는 프리셋입니다: {pid}")
        p = PRESETS[pid]
        for k, v in p.get("stats", {}).items():
            merged_stats[k] = v
        if "relationships_max" in p:
            max_rel = True
        if p.get("unlock_library"):
            unlock_lib = True

    for kv in stat_pairs or []:
        if "=" not in kv:
            raise ValueError(f"K=V 형식이 아닙니다: {kv}")
        k, v = kv.split("=", 1)
        merged_stats[k.strip()] = int(v.strip(), 10)

    if money is not None:
        merged_stats["money"] = int(money)

    if game is not None:
        srec = get_field(doc, game, "Stats")
        for k, v in merged_stats.items():
            list_upsert(doc, srec, "Mortal.Core.StatSave", "Key", k, {"Value": v})
        if max_rel:
            rrec = get_field(doc, game, "Relationships")
            for item in list_get_items(doc, rrec):
                set_field(doc, item, "Value", 100)
                set_field(doc, item, "Active", True)
    elif kind == "UniverseSave" and root is not None and unlock_lib:
        for i in range(1, 5):
            lrec = get_field(doc, root, f"LibraryData{i}")
            for item in list_get_items(doc, lrec):
                if (get_field(doc, item, "Count") or 0) < 1:
                    set_field(doc, item, "Count", 1)


def build_demo_save_bytes(kind: str = "GameSave") -> bytes:
    """실제 Mortal.Core.GameSave / UniverseSave 스키마와 동형인 합성 MS-NRBF 생성."""
    nxt = [1]

    def nid() -> int:
        v = nxt[0]
        nxt[0] += 1
        return v

    def mk_str(s: str) -> Dict[str, Any]:
        return {"recordType": T_STRING, "objectId": nid(), "value": str(s)}

    def mk_class(oid: int, name: str, names: List[str], mti: List[Tuple[int, Any]], vals: List[Any], lib: Optional[int] = 2) -> Dict[str, Any]:
        return {
            "recordType": T_CLASSANDT if lib else T_SYSANDT,
            "classInfo": {"objectId": oid, "name": name, "memberNames": names},
            "memberTypeInfo": mti,
            "libraryId": lib,
            "memberValues": vals,
        }

    def mk_list(elem_cls: str, items: List[Dict[str, Any]]) -> Dict[str, Any]:
        lid = nid()
        aid = nid()
        padded: List[Any] = list(items)
        pad_n = max(0, 4 - len(padded))
        if pad_n:
            padded.append({"recordType": T_NULL256, "$nulls": pad_n})
        arr = {"recordType": T_ARROBJ, "objectId": aid, "length": max(4, len(items)), "elements": padded}
        lcls = f"System.Collections.Generic.List`1[[{elem_cls}, Mortal.Core, Version=0.0.0.0, Culture=neutral, PublicKeyToken=null]]"
        return mk_class(
            lid, lcls, ["_items", "_size", "_version"],
            [(BT_OBJECT, None), (BT_PRIMITIVE, PT_INT32), (BT_PRIMITIVE, PT_INT32)],
            [arr, len(items), len(items)], lib=None,
        )

    records: List[Dict[str, Any]] = [
        {"recordType": T_HEADER, "rootId": 1, "headerId": -1, "majorVersion": 1, "minorVersion": 0},
        {"recordType": T_LIBRARY, "libraryId": 2, "libraryName": "Mortal.Core, Version=0.0.0.0, Culture=neutral, PublicKeyToken=null"},
    ]
    root_id = nid()  # 1

    if kind == "UniverseSave":
        l1 = mk_list("Mortal.Core.LibrarySave", [mk_class(nid(), "Mortal.Core.LibrarySave", ["Name", "Count"], [(BT_STRING, None), (BT_PRIMITIVE, PT_INT32)], [mk_str("10000"), 1])])
        l2 = mk_list("Mortal.Core.LibrarySave", [mk_class(nid(), "Mortal.Core.LibrarySave", ["Name", "Count"], [(BT_STRING, None), (BT_PRIMITIVE, PT_INT32)], [mk_str("20000"), 0])])
        l3 = mk_list("Mortal.Core.LibrarySave", [])
        l4 = mk_list("Mortal.Core.LibrarySave", [])
        records.append(mk_class(
            root_id, "Mortal.Core.UniverseSave",
            ["Version", "TimeTicks", "TitlePartner", "CurrentSlot", "LibraryData1", "LibraryData2", "LibraryData3", "LibraryData4"],
            [(BT_STRING, None), (BT_PRIMITIVE, PT_INT64), (BT_PRIMITIVE, PT_INT32), (BT_STRING, None), (BT_OBJECT, None), (BT_OBJECT, None), (BT_OBJECT, None), (BT_OBJECT, None)],
            [mk_str("release_1.0.3300.6"), 638867147073222530, 1, mk_str("001"), l1, l2, l3, l4],
        ))
    else:
        stat_items = [
            mk_class(nid(), "Mortal.Core.StatSave", ["Key", "Value"], [(BT_STRING, None), (BT_PRIMITIVE, PT_INT32)], [mk_str(k), v])
            for k, v in (
                ("money", 1000), ("life", 100), ("stamina", 80), ("dexterity", 60),
                ("literacy", 40), ("mental", 70), ("charisma", 50), ("fate", 20),
                ("action", 5), ("faction", 1), ("people", 50), ("fame", 10),
                ("team", 60), ("assets", 5000), ("martial-point", 20),
            )
        ]
        rel_items = [
            mk_class(nid(), "Mortal.Core.RelationshipSave", ["Key", "Value", "Active"], [(BT_STRING, None), (BT_PRIMITIVE, PT_INT32), (BT_PRIMITIVE, PT_BOOLEAN)], [mk_str("sister1"), 40, True]),
            mk_class(nid(), "Mortal.Core.RelationshipSave", ["Key", "Value", "Active"], [(BT_STRING, None), (BT_PRIMITIVE, PT_INT32), (BT_PRIMITIVE, PT_BOOLEAN)], [mk_str("brother1"), 30, True]),
        ]
        stage_enum = mk_class(nid(), "Mortal.Core.MonthStageType", ["value__"], [(BT_PRIMITIVE, PT_INT32)], [1])
        env_enum = mk_class(nid(), "Mortal.Core.DayEnvironmentType", ["value__"], [(BT_PRIMITIVE, PT_INT32)], [1])
        records.append(mk_class(
            root_id, "Mortal.Core.GameSave",
            ["Version", "TimeTick", "IsDemo", "NewGamePlus", "CurrentYear", "CurrentMonth", "CurrentStage", "CurrentDayEnvironment",
             "CurrentScene", "CurrentSceneKey", "Stats", "Relationships", "Books", "Miscs", "SpecialItems", "Talents"],
            [(BT_STRING, None), (BT_PRIMITIVE, PT_INT64), (BT_PRIMITIVE, PT_BOOLEAN), (BT_PRIMITIVE, PT_BOOLEAN),
             (BT_PRIMITIVE, PT_INT32), (BT_PRIMITIVE, PT_INT32), (BT_OBJECT, None), (BT_OBJECT, None),
             (BT_STRING, None), (BT_STRING, None), (BT_OBJECT, None), (BT_OBJECT, None),
             (BT_OBJECT, None), (BT_OBJECT, None), (BT_OBJECT, None), (BT_OBJECT, None)],
            [mk_str("release_1.0.3300.6"), 638867147073222530, False, False, 1, 4, stage_enum, env_enum,
             mk_str("Free"), mk_str("1100_01"),
             mk_list("Mortal.Core.StatSave", stat_items),
             mk_list("Mortal.Core.RelationshipSave", rel_items),
             mk_list("Mortal.Core.BookSave", []),
             mk_list("Mortal.Core.MiscSave", []),
             mk_list("Mortal.Core.SpecialItemSave", []),
             mk_list("Mortal.Core.TalentSave", [])],
        ))

    records.append({"recordType": T_MSGEND})
    return serialize_nrbf({"records": records, "_dirty": True})


# ---------------------------------------------------------------------------
# 안전 경로 · 프로세스 차단 · 원자적 백업 쓰기
# ---------------------------------------------------------------------------

_RESERVED = {"con", "prn", "aux", "nul"} | {f"com{i}" for i in range(1, 10)} | {f"lpt{i}" for i in range(1, 10)}
_SAVE_NAME_RE = re.compile(r"^(Save_0(?:0[1-9]|1[0-9]|20)\.dat|Save_FastSave_QQ\.dat|Save_auto\w*\.dat|Legend_\d+\.dat|Save_universe\.dat)$")


def _has_invalid_colon(path: str) -> bool:
    for i, ch in enumerate(path):
        if ch != ":":
            continue
        is_drive = (i == 1 and path[0].isalpha() and len(path) > 2 and path[2] in ("\\", "/"))
        if not is_drive:
            return True
    return False


def _has_reparse_or_link(path: str) -> bool:
    cur = os.path.abspath(path)
    for _ in range(512):
        try:
            st = os.lstat(cur)
            if stat.S_ISLNK(st.st_mode):
                return True
            if getattr(st, "st_file_attributes", 0) & 0x400:
                return True
        except FileNotFoundError:
            pass
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
    return False


def safe_resolve(path: str, allow_write_only_dat: bool = True) -> str:
    if not isinstance(path, str) or not path:
        raise UnsafePathError("경로가 비어 있습니다.")
    if "\x00" in path or path.startswith("\\\\") or path.startswith("//"):
        raise UnsafePathError("허용되지 않은 UNC 또는 널 문자 경로입니다.")
    if ".." in path.replace("\\", "/").split("/"):
        raise UnsafePathError("상위 디렉터리(..) 이동 경로는 허용되지 않습니다.")
    if _has_invalid_colon(path):
        raise UnsafePathError("허용되지 않은 콜론(ADS) 경로입니다.")
    base = os.path.basename(path.rstrip("\\/"))
    if not base:
        raise UnsafePathError("파일 이름이 비어 있습니다.")
    stem = base.split(".")[0].strip().lower()
    if stem in _RESERVED:
        raise UnsafePathError(f"예약된 장치 이름입니다: {base}")
    if allow_write_only_dat and os.path.splitext(base)[1].lower() != ".dat":
        raise UnsafePathError("세이브 쓰기는 .dat 확장자만 허용됩니다.")
    absp = os.path.abspath(path)
    if _has_reparse_or_link(absp):
        raise UnsafePathError("심볼릭 링크 또는 리파스 포인트 경로는 차단됩니다.")
    if os.path.exists(absp):
        st = os.lstat(absp)
        if st.st_nlink > 1:
            raise UnsafePathError("다중 하드링크 파일은 차단됩니다.")
    return absp


def game_running() -> bool:
    if os.environ.get("LOM_SIMULATE_GAME_RUNNING") == "1":
        return True
    if os.name == "nt":
        try:
            out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq Mortal.exe"], capture_output=True, timeout=4)
            return b"mortal.exe" in out.stdout.lower()
        except Exception:
            return False
    try:
        for d in os.listdir("/proc"):
            if d.isdigit():
                try:
                    with open(f"/proc/{d}/comm", "r", encoding="utf-8", errors="ignore") as f:
                        if f.read().strip().lower() in ("mortal.exe", "mortal"):
                            return True
                except OSError:
                    pass
    except OSError:
        pass
    return False


def atomic_write(path: str, data: bytes) -> None:
    d = os.path.dirname(os.path.abspath(path)) or "."
    fd, tmp = tempfile.mkstemp(prefix=".lom-edit-", dir=d)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def make_backup(path: str, orig_bytes: bytes) -> str:
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    bak = f"{path}.backup-{ts}-{secrets.token_hex(4)}.bak"
    atomic_write(bak, orig_bytes)
    if hashlib.sha256(Path(bak).read_bytes()).hexdigest() != hashlib.sha256(orig_bytes).hexdigest():
        raise IOError("백업 SHA-256 검증 실패")
    return bak


def _default_root() -> str:
    base = os.environ.get("USERPROFILE") or os.path.expanduser("~")
    return os.path.join(base, "AppData", "LocalLow", "Obb Studio", "Mortal")


def discover(root: Optional[str] = None) -> Dict[str, Any]:
    target = root or _default_root()
    slots: List[Dict[str, Any]] = []
    if not os.path.isdir(target):
        return {"root": target, "found": 0, "slots": slots}

    scan_dirs = [target]
    for sub in sorted(os.listdir(target)):
        sp = os.path.join(target, sub)
        if sub.isdigit() and os.path.isdir(sp) and not os.path.islink(sp):
            scan_dirs.append(sp)

    for sdir in scan_dirs:
        for name in sorted(os.listdir(sdir)):
            if not _SAVE_NAME_RE.match(name):
                continue
            full = os.path.join(sdir, name)
            if os.path.islink(full) or not os.path.isfile(full):
                continue
            try:
                raw = Path(full).read_bytes()
                doc = parse_nrbf(raw)
                slots.append(summarize_doc(doc, full, raw))
            except Exception as exc:
                slots.append({"path": full, "name": name, "error": str(exc)})
    return {"root": os.path.abspath(target), "found": len(slots), "slots": slots}


def do_edit(file_path: str, presets: List[str], stat_pairs: List[str], money: Optional[int], dry_run: bool) -> Dict[str, Any]:
    if game_running():
        raise GameRunningError("활협전 게임 프로세스가 실행 중이므로 저장을 차단했습니다.")
    safe = safe_resolve(file_path, allow_write_only_dat=True)
    raw = Path(safe).read_bytes()
    doc = parse_nrbf(raw)
    val1 = validate_doc(doc)
    if not val1["ok"]:
        raise ValueError("편집 전 세이브 검증 실패: " + "; ".join(val1["problems"]))

    apply_domain_edits(doc, presets, stat_pairs, money)
    new_raw = serialize_nrbf(doc)
    doc2 = parse_nrbf(new_raw)
    val2 = validate_doc(doc2)
    if not val2["ok"]:
        raise ValueError("편집 후 세이브 검증 실패: " + "; ".join(val2["problems"]))

    res: Dict[str, Any] = {
        "ok": True,
        "path": safe,
        "dryRun": bool(dry_run),
        "sha256Before": hashlib.sha256(raw).hexdigest(),
        "sha256After": hashlib.sha256(new_raw).hexdigest(),
        "sizeBefore": len(raw),
        "sizeAfter": len(new_raw),
    }
    if dry_run:
        return res
    bak = make_backup(safe, raw)
    atomic_write(safe, new_raw)
    res["backupPath"] = bak
    return res


# ---------------------------------------------------------------------------
# 루프백 HTTP 서버
# ---------------------------------------------------------------------------

STATE: Dict[str, Any] = {"root": None, "token": None, "port": None, "base_url": None}
ROOT_DIR = Path(__file__).resolve().parent


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "LomEditor/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        return

    def _send(self, code: int, obj: Any, content_type: str = "application/json; charset=utf-8") -> None:
        payload = obj if isinstance(obj, bytes) else json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def _check_security(self, require_token: bool) -> bool:
        port = STATE["port"]
        host = (self.headers.get("Host") or "").strip().lower()
        if host not in (f"127.0.0.1:{port}", f"localhost:{port}"):
            self._send(403, {"error": "허용되지 않은 Host 헤더입니다."})
            return False
        origin = self.headers.get("Origin")
        if origin and origin.strip().lower() not in (f"http://127.0.0.1:{port}", f"http://localhost:{port}"):
            self._send(403, {"error": "허용되지 않은 Origin입니다."})
            return False
        sfs = self.headers.get("Sec-Fetch-Site")
        if sfs and sfs.strip().lower() not in ("same-origin", "none"):
            self._send(403, {"error": "교차 출처 요청이 거부되었습니다."})
            return False
        if require_token:
            tok = self.headers.get("X-Lom-Token") or ""
            if not hmac.compare_digest(tok, STATE["token"] or ""):
                self._send(401, {"error": "유효하지 않은 세션 토큰입니다."})
                return False
        return True

    def do_GET(self) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        need_tok = parsed.path.startswith("/api/")
        if not self._check_security(need_tok):
            return
        if parsed.path in ("/", "/index.html"):
            return self._serve_index()
        if parsed.path == "/api/discover":
            return self._send(200, discover(STATE["root"]))
        if parsed.path == "/api/load":
            q = urllib.parse.parse_qs(parsed.query)
            p = (q.get("path") or [""])[0]
            try:
                safe = safe_resolve(p, allow_write_only_dat=False)
            except UnsafePathError as e:
                return self._send(403, {"error": str(e)})
            if not os.path.isfile(safe):
                return self._send(404, {"error": "파일을 찾을 수 없습니다."})
            raw = Path(safe).read_bytes()
            doc = parse_nrbf(raw)
            kind, _, _ = detect_root_kind(doc)
            return self._send(200, {
                "path": safe,
                "kind": kind,
                "size": len(raw),
                "sha256": hashlib.sha256(raw).hexdigest(),
                "data": base64.b64encode(raw).decode("ascii"),
            })
        if parsed.path == "/health":
            return self._send(200, {"ok": True})
        self._send(404, {"error": "존재하지 않는 경로입니다."})

    def do_POST(self) -> None:
        if not self._check_security(True):
            return
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype != "application/json":
            return self._send(400, {"error": "Content-Type은 application/json이어야 합니다."})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > 64 * 1024 * 1024:
                raise ValueError("요청 본문 길이 오류")
            body = json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception as e:
            return self._send(400, {"error": f"잘못된 JSON 요청입니다: {e}"})

        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == "/api/validate":
            try:
                raw = base64.b64decode(body.get("data", ""), validate=True)
                doc = parse_nrbf(raw)
                return self._send(200, validate_doc(doc))
            except Exception as e:
                return self._send(400, {"error": str(e)})
        if parsed.path == "/api/save":
            try:
                safe = safe_resolve(body.get("path", ""), allow_write_only_dat=True)
            except UnsafePathError as e:
                return self._send(403, {"error": str(e)})
            if game_running():
                return self._send(423, {"error": "활협전 게임이 실행 중이어서 저장할 수 없습니다."})
            try:
                new_raw = base64.b64decode(body.get("data", ""), validate=True)
                doc = parse_nrbf(new_raw)
                val = validate_doc(doc)
                if not val["ok"]:
                    return self._send(400, {"error": "세이브 검증 실패", "problems": val["problems"]})
            except Exception as e:
                return self._send(400, {"error": f"손상된 NRBF 데이터: {e}"})
            if not os.path.isfile(safe):
                return self._send(404, {"error": "대상 파일이 존재하지 않습니다."})
            cur = Path(safe).read_bytes()
            cur_sha = hashlib.sha256(cur).hexdigest()
            exp_sha = body.get("expectedSha256")
            if exp_sha and exp_sha != cur_sha:
                return self._send(409, {"error": "파일이 외부에서 변경되었습니다(SHA-256 불일치).", "sha256": cur_sha})
            bak = make_backup(safe, cur)
            atomic_write(safe, new_raw)
            return self._send(200, {"ok": True, "backupPath": bak, "sha256": hashlib.sha256(new_raw).hexdigest()})
        self._send(404, {"error": "존재하지 않는 경로입니다."})

    def _serve_index(self) -> None:
        html_path = ROOT_DIR / "dist" / "LegendOfMortalSaveEditor-v1.0.html"
        if not html_path.is_file():
            html_path = ROOT_DIR / "src" / "editor-page.html"
        content = html_path.read_text(encoding="utf-8") if html_path.is_file() else "<html><head></head><body><h1>HTML 없음</h1></body></html>"
        content = content.replace("connect-src 'none'", "connect-src 'self'")
        cfg = json.dumps({"token": STATE["token"], "baseUrl": STATE["base_url"]})
        inject = f"<meta name=\"lom-token\" content=\"{STATE['token']}\">\n<script>window.__LOM_SERVER__ = {cfg};</script>\n"
        content = content.replace("<head>", "<head>\n" + inject, 1) if "<head>" in content else inject + content
        self._send(200, content.encode("utf-8"), content_type="text/html; charset=utf-8")


# ---------------------------------------------------------------------------
# CLI 진입점
# ---------------------------------------------------------------------------

def cmd_demo(args: argparse.Namespace) -> int:
    os.makedirs(args.out_dir, exist_ok=True)
    gs = os.path.join(args.out_dir, "Save_001.dat")
    us = os.path.join(args.out_dir, "Save_universe.dat")
    atomic_write(gs, build_demo_save_bytes("GameSave"))
    atomic_write(us, build_demo_save_bytes("UniverseSave"))
    print(json.dumps({"outDir": os.path.abspath(args.out_dir), "created": [gs, us]}, ensure_ascii=False, indent=2))
    return 0


def cmd_discover(args: argparse.Namespace) -> int:
    print(json.dumps(discover(args.root), ensure_ascii=False, indent=2))
    return 0


def cmd_inspect(args: argparse.Namespace) -> int:
    safe = safe_resolve(args.file, allow_write_only_dat=False)
    raw = Path(safe).read_bytes()
    doc = parse_nrbf(raw)
    out = {"summary": summarize_doc(doc, safe, raw), "validation": validate_doc(doc)}
    if args.json:
        print(json.dumps(out, ensure_ascii=False, indent=2))
    else:
        s = out["summary"]
        print(f"파일: {s['path']} ({s['kind']}, {s['size']}바이트, trailing={s['trailingBytesCount']})")
        print(f"검증: {'통과' if out['validation']['ok'] else '실패'}")
    return 0


def cmd_validate(args: argparse.Namespace) -> int:
    try:
        safe = safe_resolve(args.file, allow_write_only_dat=False)
        doc = parse_nrbf(Path(safe).read_bytes())
        out = validate_doc(doc)
    except Exception as e:
        out = {"ok": False, "problems": [str(e)]}
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0 if out.get("ok") else 1


def cmd_presets(_args: argparse.Namespace) -> int:
    items = [{"id": k, "name": v["name"], "desc": v["desc"]} for k, v in PRESETS.items()]
    print(json.dumps({"presets": items}, ensure_ascii=False, indent=2))
    return 0


def cmd_edit(args: argparse.Namespace) -> int:
    try:
        res = do_edit(args.file, args.preset, args.stat, args.money, args.dry_run)
        print(json.dumps(res, ensure_ascii=False, indent=2))
        return 0
    except GameRunningError as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        return 3
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        return 2


def cmd_serve(args: argparse.Namespace) -> int:
    token = secrets.token_urlsafe(24)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    actual_port = server.server_address[1]
    base = f"http://127.0.0.1:{actual_port}"
    STATE.update({"root": args.root or _default_root(), "token": token, "port": actual_port, "base_url": base})
    print(json.dumps({"url": base + "/", "port": actual_port, "token": token}, ensure_ascii=False), flush=True)
    if not args.no_browser:
        webbrowser.open(base + "/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(prog="lom_editor.py", description="활협전 세이브 에디터 CLI")
    sub = p.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("demo", help="합성 데모 세이브 생성"); d.add_argument("--out-dir", required=True); d.set_defaults(func=cmd_demo)
    d = sub.add_parser("discover", help="세이브 슬롯 탐색"); d.add_argument("--root", default=None); d.set_defaults(func=cmd_discover)
    d = sub.add_parser("inspect", help="세이브 요약 및 검증"); d.add_argument("file"); d.add_argument("--json", action="store_true"); d.set_defaults(func=cmd_inspect)
    d = sub.add_parser("validate", help="세이브 불변식 검증"); d.add_argument("file"); d.set_defaults(func=cmd_validate)
    d = sub.add_parser("presets", help="지원 프리셋 목록"); d.set_defaults(func=cmd_presets)
    d = sub.add_parser("edit", help="세이브 편집 및 안전 백업"); d.add_argument("file"); d.add_argument("--preset", action="append", default=[]); d.add_argument("--stat", action="append", default=[]); d.add_argument("--money", type=int, default=None); d.add_argument("--dry-run", action="store_true"); d.set_defaults(func=cmd_edit)
    d = sub.add_parser("serve", help="루프백 웹 서버 실행"); d.add_argument("--port", type=int, default=0); d.add_argument("--root", default=None); d.add_argument("--no-browser", action="store_true"); d.set_defaults(func=cmd_serve)
    args = p.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
