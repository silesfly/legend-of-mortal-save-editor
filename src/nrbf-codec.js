/* src/nrbf-codec.js — MS-NRBF (.NET BinaryFormatter) lossless AST reader/writer + domain adapters.
 * UMD module: LomNrbfCodec (ES2020 BigInt supported in Node 12+ and Edge WebView2 / Chromium).
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module && typeof module.exports === 'object') {
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else {
    root.LomNrbfCodec = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  var REC = {
    SerializedStreamHeader: 0,
    ClassWithId: 1,
    SystemClassWithMembers: 2,
    ClassWithMembers: 3,
    SystemClassWithMembersAndTypes: 4,
    ClassWithMembersAndTypes: 5,
    BinaryObjectString: 6,
    BinaryArray: 7,
    MemberPrimitiveTyped: 8,
    MemberReference: 9,
    ObjectNull: 10,
    MessageEnd: 11,
    BinaryLibrary: 12,
    ObjectNullMultiple256: 13,
    ObjectNullMultiple: 14,
    ArraySinglePrimitive: 15,
    ArraySingleObject: 16,
    ArraySingleString: 17
  };

  var BT = {
    Primitive: 0,
    String: 1,
    Object: 2,
    SystemClass: 3,
    Class: 4,
    ObjectArray: 5,
    StringArray: 6,
    PrimitiveArray: 7
  };

  var PT = {
    Boolean: 1,
    Byte: 2,
    Char: 3,
    Decimal: 5,
    Double: 6,
    Int16: 7,
    Int32: 8,
    Int64: 9,
    SByte: 10,
    Single: 11,
    TimeSpan: 12,
    DateTime: 13,
    UInt16: 14,
    UInt32: 15,
    UInt64: 16,
    Null: 17,
    String: 18
  };

  var BAT = {
    Single: 0,
    Jagged: 1,
    Rectangular: 2,
    SingleOffset: 3,
    JaggedOffset: 4,
    RectangularOffset: 5
  };

  var CORE_LIB = 'Mortal.Core';

  var _TE = (typeof TextEncoder !== 'undefined') ? new TextEncoder() : null;
  var _TD = (typeof TextDecoder !== 'undefined') ? new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }) : null;
  var _HAS_BUF = (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function');
  var _HAS_BIGINT = (typeof BigInt === 'function');

  function utf8Encode(str) {
    if (str === null || str === undefined) return new Uint8Array(0);
    var s = String(str);
    if (_TE) return _TE.encode(s);
    if (_HAS_BUF) {
      var b = Buffer.from(s, 'utf8');
      return new Uint8Array(b.buffer, b.byteOffset, b.byteLength).slice();
    }
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
        var c2 = s.charCodeAt(i + 1);
        if (c2 >= 0xDC00 && c2 <= 0xDFFF) {
          var cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
          out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
          i++;
        } else out.push(0xEF, 0xBF, 0xBD);
      } else if (c >= 0xD800 && c <= 0xDFFF) {
        out.push(0xEF, 0xBF, 0xBD);
      } else out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
    }
    return new Uint8Array(out);
  }

  function utf8Decode(bytes) {
    if (!bytes || bytes.length === 0) return '';
    if (_TD) return _TD.decode(bytes);
    if (_HAS_BUF) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
    var s = '', i = 0;
    while (i < bytes.length) {
      var b0 = bytes[i++];
      if (b0 < 0x80) s += String.fromCharCode(b0);
      else if ((b0 & 0xE0) === 0xC0 && i < bytes.length) s += String.fromCharCode(((b0 & 0x1F) << 6) | (bytes[i++] & 0x3F));
      else if ((b0 & 0xF0) === 0xE0 && i + 1 < bytes.length) s += String.fromCharCode(((b0 & 0x0F) << 12) | ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F));
      else if ((b0 & 0xF8) === 0xF0 && i + 2 < bytes.length) {
        var cp = ((b0 & 0x07) << 18) | ((bytes[i++] & 0x3F) << 12) | ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F);
        cp -= 0x10000;
        s += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
      } else s += '\uFFFD';
    }
    return s;
  }

  function Reader(bytes) {
    this.b = bytes;
    this.p = 0;
  }
  Reader.prototype.need = function (n) {
    if (this.p + n > this.b.length) {
      throw new Error('LomNrbfCodec: unexpected EOF at ' + this.p + ' (need ' + n + ')');
    }
  };
  Reader.prototype.u8 = function () { this.need(1); return this.b[this.p++]; };
  Reader.prototype.i8 = function () { this.need(1); var v = this.b[this.p++]; return v > 127 ? v - 256 : v; };
  Reader.prototype.i16 = function () {
    this.need(2);
    var v = this.b[this.p] | (this.b[this.p + 1] << 8);
    this.p += 2;
    return v >= 0x8000 ? v - 0x10000 : v;
  };
  Reader.prototype.u16 = function () {
    this.need(2);
    var v = this.b[this.p] | (this.b[this.p + 1] << 8);
    this.p += 2;
    return v;
  };
  Reader.prototype.i32 = function () {
    this.need(4);
    var b = this.b, p = this.p;
    var v = (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24));
    this.p = p + 4;
    return v | 0;
  };
  Reader.prototype.u32 = function () {
    this.need(4);
    var b = this.b, p = this.p;
    var v = (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24));
    this.p = p + 4;
    return v >>> 0;
  };
  Reader.prototype.f32raw = function () {
    this.need(4);
    var raw = this.b.slice(this.p, this.p + 4);
    var dv = new DataView(raw.buffer, raw.byteOffset, 4);
    this.p += 4;
    return { value: dv.getFloat32(0, true), raw: raw };
  };
  Reader.prototype.f64raw = function () {
    this.need(8);
    var raw = this.b.slice(this.p, this.p + 8);
    var dv = new DataView(raw.buffer, raw.byteOffset, 8);
    this.p += 8;
    return { value: dv.getFloat64(0, true), raw: raw };
  };
  Reader.prototype.bytes = function (n) {
    this.need(n);
    var s = this.b.slice(this.p, this.p + n);
    this.p += n;
    return s;
  };
  Reader.prototype.leb128 = function () {
    var result = 0, shift = 0, b;
    do {
      this.need(1);
      b = this.b[this.p++];
      result |= (b & 0x7F) << shift;
      shift += 7;
    } while (b & 0x80);
    return result >>> 0;
  };
  Reader.prototype.lpString = function () {
    var len = this.leb128();
    var raw = this.bytes(len);
    return { value: utf8Decode(raw), raw: raw };
  };

  function Writer() {
    this.chunks = [];
    this.length = 0;
    this._tmp = new Uint8Array(8);
    this._dv = new DataView(this._tmp.buffer);
  }
  Writer.prototype._push = function (arr) { this.chunks.push(arr); this.length += arr.length; };
  Writer.prototype.u8 = function (v) { this._tmp[0] = v & 0xFF; this._push(this._tmp.slice(0, 1)); };
  Writer.prototype.i8 = function (v) { this._tmp[0] = v & 0xFF; this._push(this._tmp.slice(0, 1)); };
  Writer.prototype.i16 = function (v) { this._dv.setInt16(0, v | 0, true); this._push(this._tmp.slice(0, 2)); };
  Writer.prototype.u16 = function (v) { this._dv.setUint16(0, v >>> 0, true); this._push(this._tmp.slice(0, 2)); };
  Writer.prototype.i32 = function (v) { this._dv.setInt32(0, v | 0, true); this._push(this._tmp.slice(0, 4)); };
  Writer.prototype.u32 = function (v) { this._dv.setUint32(0, v >>> 0, true); this._push(this._tmp.slice(0, 4)); };
  Writer.prototype.f32raw = function (raw, val) {
    if (raw && raw.length === 4) { this._push(raw); return; }
    this._dv.setFloat32(0, Number(val) || 0, true);
    this._push(this._tmp.slice(0, 4));
  };
  Writer.prototype.f64raw = function (raw, val) {
    if (raw && raw.length === 8) { this._push(raw); return; }
    this._dv.setFloat64(0, Number(val) || 0, true);
    this._push(this._tmp.slice(0, 8));
  };
  Writer.prototype.bytes = function (arr) { this._push(arr); };
  Writer.prototype.leb128 = function (v) {
    v = v >>> 0;
    do {
      var b = v & 0x7F;
      v >>>= 7;
      if (v !== 0) b |= 0x80;
      this.u8(b);
    } while (v !== 0);
  };
  Writer.prototype.lpString = function (strOrObj) {
    if (strOrObj && typeof strOrObj === 'object' && strOrObj.raw instanceof Uint8Array && !strOrObj.dirty) {
      this.leb128(strOrObj.raw.length);
      this._push(strOrObj.raw);
      return;
    }
    var s = (strOrObj && typeof strOrObj === 'object' && strOrObj.value !== undefined) ? strOrObj.value : strOrObj;
    var raw = utf8Encode(s == null ? '' : String(s));
    this.leb128(raw.length);
    this._push(raw);
  };
  Writer.prototype.toUint8Array = function () {
    var out = new Uint8Array(this.length);
    var off = 0;
    for (var i = 0; i < this.chunks.length; i++) {
      out.set(this.chunks[i], off);
      off += this.chunks[i].length;
    }
    return out;
  };

  function le64ToStr(raw8, signed) {
    if (_HAS_BIGINT) {
      var hex = '';
      for (var i = 7; i >= 0; i--) {
        var h = raw8[i].toString(16);
        hex += (h.length < 2 ? '0' + h : h);
      }
      var u = BigInt('0x' + hex);
      if (signed && u >= BigInt('0x8000000000000000')) {
        u = u - BigInt('0x10000000000000000');
      }
      return u.toString(10);
    }
    var lo = (raw8[0] | (raw8[1] << 8) | (raw8[2] << 16) | (raw8[3] << 24)) >>> 0;
    var hi = (raw8[4] | (raw8[5] << 8) | (raw8[6] << 16) | (raw8[7] << 24)) >>> 0;
    return '0x' + hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
  }

  function strToLe64(val) {
    if (_HAS_BIGINT) {
      var u = typeof val === 'bigint' ? val : BigInt(String(val || '0'));
      if (u < 0) u = u + BigInt('0x10000000000000000');
      var hex = u.toString(16).padStart(16, '0');
      var out = new Uint8Array(8);
      for (var i = 0; i < 8; i++) {
        var pos = (7 - i) * 2;
        out[i] = parseInt(hex.slice(pos, pos + 2), 16);
      }
      return out;
    }
    return new Uint8Array(8);
  }

  function readPrimitive(rd, pt) {
    switch (pt) {
      case PT.Boolean: return { kind: 'prim', primType: pt, value: rd.u8() !== 0 };
      case PT.Byte: return { kind: 'prim', primType: pt, value: rd.u8() };
      case PT.SByte: return { kind: 'prim', primType: pt, value: rd.i8() };
      case PT.Char: {
        rd.need(1);
        var b0 = rd.b[rd.p];
        var len = (b0 & 0x80) === 0 ? 1 : (b0 & 0xE0) === 0xC0 ? 2 : (b0 & 0xF0) === 0xE0 ? 3 : 4;
        var raw = rd.bytes(len);
        return { kind: 'prim', primType: pt, value: utf8Decode(raw), raw: raw };
      }
      case PT.Decimal: {
        var ds = rd.lpString();
        return { kind: 'prim', primType: pt, value: ds.value, raw: ds.raw };
      }
      case PT.Double: {
        var d = rd.f64raw();
        return { kind: 'prim', primType: pt, value: d.value, raw: d.raw };
      }
      case PT.Int16: return { kind: 'prim', primType: pt, value: rd.i16() };
      case PT.UInt16: return { kind: 'prim', primType: pt, value: rd.u16() };
      case PT.Int32: return { kind: 'prim', primType: pt, value: rd.i32() };
      case PT.UInt32: return { kind: 'prim', primType: pt, value: rd.u32() };
      case PT.Int64:
      case PT.TimeSpan: {
        var r8s = rd.bytes(8);
        return { kind: 'prim', primType: pt, value: le64ToStr(r8s, true), raw: r8s };
      }
      case PT.DateTime:
      case PT.UInt64: {
        var r8u = rd.bytes(8);
        return { kind: 'prim', primType: pt, value: le64ToStr(r8u, false), raw: r8u };
      }
      case PT.Single: {
        var f = rd.f32raw();
        return { kind: 'prim', primType: pt, value: f.value, raw: f.raw };
      }
      case PT.Null: return { kind: 'prim', primType: pt, value: null };
      case PT.String: {
        var st = rd.lpString();
        return { kind: 'prim', primType: pt, value: st.value, raw: st.raw };
      }
      default:
        throw new Error('LomNrbfCodec: unknown PrimitiveTypeEnum ' + pt + ' at ' + rd.p);
    }
  }

  function writePrimitive(wr, pt, node) {
    switch (pt) {
      case PT.Boolean: wr.u8(node && node.value ? 1 : 0); return;
      case PT.Byte: wr.u8((node ? node.value : 0) & 0xFF); return;
      case PT.SByte: wr.i8((node ? node.value : 0) | 0); return;
      case PT.Char:
        if (node && node.raw && !node.dirty) wr.bytes(node.raw);
        else wr.bytes(utf8Encode(node && node.value ? node.value : '\0'));
        return;
      case PT.Decimal:
      case PT.String:
        if (node && node.raw && !node.dirty) { wr.leb128(node.raw.length); wr.bytes(node.raw); }
        else wr.lpString(node ? node.value : '');
        return;
      case PT.Double: wr.f64raw(node && !node.dirty ? node.raw : null, node ? node.value : 0); return;
      case PT.Int16: wr.i16((node ? node.value : 0) | 0); return;
      case PT.UInt16: wr.u16((node ? node.value : 0) >>> 0); return;
      case PT.Int32: wr.i32((node ? node.value : 0) | 0); return;
      case PT.UInt32: wr.u32((node ? node.value : 0) >>> 0); return;
      case PT.Int64:
      case PT.TimeSpan:
      case PT.DateTime:
      case PT.UInt64:
        if (node && node.raw && node.raw.length === 8 && !node.dirty) { wr.bytes(node.raw); return; }
        wr.bytes(strToLe64(node ? node.value : '0'));
        return;
      case PT.Single: wr.f32raw(node && !node.dirty ? node.raw : null, node ? node.value : 0); return;
      case PT.Null: return;
      default:
        throw new Error('LomNrbfCodec: cannot write primitive ' + pt);
    }
  }

  function readClassInfo(rd) {
    var oid = rd.i32();
    var name = rd.lpString();
    var mcount = rd.i32();
    var mnames = [];
    for (var i = 0; i < mcount; i++) mnames.push(rd.lpString());
    return { objectId: oid, name: name.value, nameObj: name, memberCount: mcount, memberNames: mnames };
  }

  function readAdditionalTypeInfo(rd, bt) {
    switch (bt) {
      case BT.Primitive: return { primitiveType: rd.u8() };
      case BT.SystemClass: return { className: rd.lpString() };
      case BT.Class: return { className: rd.lpString(), libraryId: rd.i32() };
      case BT.PrimitiveArray: return { primitiveType: rd.u8() };
      case BT.String:
      case BT.Object:
      case BT.ObjectArray:
      case BT.StringArray:
        return null;
      default:
        throw new Error('LomNrbfCodec: unknown BinaryTypeEnum ' + bt + ' at ' + rd.p);
    }
  }

  function readMemberTypeInfo(rd, count) {
    var types = [], infos = [];
    for (var i = 0; i < count; i++) types.push(rd.u8());
    for (var j = 0; j < count; j++) infos.push(readAdditionalTypeInfo(rd, types[j]));
    return { binaryTypes: types, additionalInfos: infos };
  }

  function trackId(doc, oid, rec) {
    if (oid !== undefined && oid !== null) {
      doc.byId[oid] = rec;
      if (oid > 0 && oid >= doc._nextId) doc._nextId = oid + 1;
    }
  }

  function readRecordBodyByType(rd, rt, doc) {
    var rec;
    switch (rt) {
      case REC.ClassWithId: {
        var oid = rd.i32();
        var mid = rd.i32();
        var meta = doc.classesById[mid];
        if (!meta) throw new Error('LomNrbfCodec: missing metadata classId ' + mid + ' for object ' + oid);
        rec = { recordType: rt, kind: 'object', objectId: oid, metadataId: mid, memberValues: null };
        trackId(doc, oid, rec);
        rec.memberValues = readMemberValues(rd, meta.memberTypeInfo, doc);
        return rec;
      }
      case REC.SystemClassWithMembersAndTypes:
      case REC.ClassWithMembersAndTypes: {
        var ci = readClassInfo(rd);
        var mti = readMemberTypeInfo(rd, ci.memberCount);
        var libId = (rt === REC.ClassWithMembersAndTypes) ? rd.i32() : null;
        rec = {
          recordType: rt,
          kind: 'object',
          objectId: ci.objectId,
          classInfo: ci,
          memberTypeInfo: mti,
          libraryId: libId,
          memberValues: null
        };
        doc.classesById[ci.objectId] = rec;
        if (!doc.classesByName[ci.name]) doc.classesByName[ci.name] = rec;
        trackId(doc, ci.objectId, rec);
        rec.memberValues = readMemberValues(rd, mti, doc);
        return rec;
      }
      case REC.BinaryObjectString: {
        var soid = rd.i32();
        var s = rd.lpString();
        rec = { recordType: rt, kind: 'string', objectId: soid, value: s.value, raw: s.raw, dirty: false };
        trackId(doc, soid, rec);
        return rec;
      }
      case REC.BinaryArray: {
        var aoid = rd.i32();
        var bat = rd.u8();
        var rank = rd.i32();
        var lengths = [];
        for (var i = 0; i < rank; i++) lengths.push(rd.i32());
        var lowerBounds = null;
        if (bat === BAT.SingleOffset || bat === BAT.JaggedOffset || bat === BAT.RectangularOffset) {
          lowerBounds = [];
          for (var j = 0; j < rank; j++) lowerBounds.push(rd.i32());
        }
        var et = rd.u8();
        var eai = readAdditionalTypeInfo(rd, et);
        var total = 1;
        for (var k = 0; k < rank; k++) total *= lengths[k];
        rec = {
          recordType: rt, kind: 'array', objectId: aoid,
          binaryArrayType: bat, rank: rank, lengths: lengths, lowerBounds: lowerBounds,
          elementType: et, elementAdditionalInfo: eai, elements: null
        };
        trackId(doc, aoid, rec);
        rec.elements = readArrayElements(rd, et, eai, total, doc);
        return rec;
      }
      case REC.ArraySinglePrimitive: {
        var poid = rd.i32();
        var plen = rd.i32();
        var ppt = rd.u8();
        var pels = [];
        rec = { recordType: rt, kind: 'array', objectId: poid, length: plen, primitiveType: ppt, elements: pels };
        trackId(doc, poid, rec);
        for (var pi = 0; pi < plen; pi++) pels.push(readPrimitive(rd, ppt));
        return rec;
      }
      case REC.ArraySingleObject:
      case REC.ArraySingleString: {
        var ooid = rd.i32();
        var olen = rd.i32();
        rec = { recordType: rt, kind: 'array', objectId: ooid, length: olen, elements: null };
        trackId(doc, ooid, rec);
        rec.elements = readArrayElements(rd, BT.Object, null, olen, doc);
        return rec;
      }
      case REC.MemberPrimitiveTyped: {
        var mpt = rd.u8();
        return { recordType: rt, kind: 'prim-typed', primitiveType: mpt, valueNode: readPrimitive(rd, mpt) };
      }
      case REC.MemberReference:
        return { recordType: rt, kind: 'ref', idRef: rd.i32() };
      case REC.ObjectNull:
        return { recordType: rt, kind: 'null', count: 1 };
      case REC.ObjectNullMultiple256:
        return { recordType: rt, kind: 'null-multiple256', count: rd.u8() };
      case REC.ObjectNullMultiple:
        return { recordType: rt, kind: 'null-multiple', count: rd.i32() };
      case REC.BinaryLibrary: {
        var lid = rd.i32();
        var lname = rd.lpString();
        rec = { recordType: rt, kind: 'library', libraryId: lid, libraryName: lname.value, libraryNameObj: lname };
        doc.libraries[lid] = rec;
        return rec;
      }
      case REC.MessageEnd:
        return { recordType: rt, kind: 'end' };
      default:
        throw new Error('LomNrbfCodec: unsupported recordType ' + rt + ' at ' + (rd.p - 1));
    }
  }

  function readMemberValues(rd, mti, doc) {
    var vals = [];
    for (var i = 0; i < mti.binaryTypes.length; i++) {
      var bt = mti.binaryTypes[i];
      if (bt === BT.Primitive) {
        vals.push(readPrimitive(rd, mti.additionalInfos[i].primitiveType));
      } else {
        var rt = rd.u8();
        vals.push(readRecordBodyByType(rd, rt, doc));
      }
    }
    return vals;
  }

  function readArrayElements(rd, elementType, additionalInfo, total, doc) {
    var out = [];
    var remaining = total;
    while (remaining > 0) {
      if (elementType === BT.PrimitiveArray && additionalInfo && additionalInfo.primitiveType != null) {
        // Not normally used inside ArraySingleObject, handled if BinaryArray of primitives
      }
      var rt = rd.u8();
      var node = readRecordBodyByType(rd, rt, doc);
      if (node.kind === 'null' || node.kind === 'null-multiple256' || node.kind === 'null-multiple') {
        out.push(node);
        remaining -= node.count;
      } else {
        out.push(node);
        remaining -= 1;
      }
    }
    if (remaining < 0) {
      throw new Error('LomNrbfCodec: array null-multiple overflow by ' + (-remaining));
    }
    return out;
  }

  function parseNrbf(input) {
    var bytes;
    if (input instanceof Uint8Array) bytes = input;
    else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
    else if (ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    else if (Array.isArray(input)) bytes = new Uint8Array(input);
    else throw new Error('LomNrbfCodec: expected Uint8Array or ArrayBuffer');

    var rd = new Reader(bytes);
    var first = rd.u8();
    if (first !== REC.SerializedStreamHeader) {
      throw new Error('LomNrbfCodec: expected SerializedStreamHeader (0), got ' + first);
    }
    var doc = {
      kind: 'nrbf-document',
      header: {
        recordType: REC.SerializedStreamHeader,
        rootId: rd.i32(),
        headerId: rd.i32(),
        majorVersion: rd.i32(),
        minorVersion: rd.i32()
      },
      records: [],
      byId: {},
      classesById: {},
      classesByName: {},
      libraries: {},
      _nextId: 1,
      streamEndOffset: 0,
      trailingBytesCount: 0,
      trailingBytes: new Uint8Array(0),
      rootRecord: null
    };
    doc.records.push(doc.header);

    while (rd.p < bytes.length) {
      var rt = rd.u8();
      var rec = readRecordBodyByType(rd, rt, doc);
      doc.records.push(rec);
      if (rt === REC.MessageEnd) {
        doc.streamEndOffset = rd.p;
        doc.trailingBytesCount = bytes.length - rd.p;
        doc.trailingBytes = bytes.slice(rd.p);
        doc.rootRecord = doc.byId[doc.header.rootId] || null;
        return doc;
      }
    }
    doc.streamEndOffset = rd.p;
    doc.rootRecord = doc.byId[doc.header.rootId] || null;
    return doc;
  }

  // ─── Writer ──────────────────────────────────────────────────────────────
  function writeAdditionalTypeInfo(wr, bt, ai) {
    if (bt === BT.Primitive || bt === BT.PrimitiveArray) {
      wr.u8(ai.primitiveType);
    } else if (bt === BT.SystemClass) {
      wr.lpString(ai.className);
    } else if (bt === BT.Class) {
      wr.lpString(ai.className);
      wr.i32(ai.libraryId);
    }
  }

  function writeMemberTypeInfo(wr, mti) {
    var i;
    for (i = 0; i < mti.binaryTypes.length; i++) wr.u8(mti.binaryTypes[i]);
    for (i = 0; i < mti.binaryTypes.length; i++) writeAdditionalTypeInfo(wr, mti.binaryTypes[i], mti.additionalInfos[i]);
  }

  function writeRecordNode(wr, node, doc) {
    switch (node.recordType) {
      case REC.ClassWithId: {
        wr.u8(REC.ClassWithId);
        wr.i32(node.objectId);
        wr.i32(node.metadataId);
        var meta = doc.classesById[node.metadataId];
        if (!meta) throw new Error('LomNrbfCodec: missing metadata for ClassWithId ' + node.metadataId);
        writeMemberValues(wr, meta.memberTypeInfo, node.memberValues, doc);
        return;
      }
      case REC.SystemClassWithMembersAndTypes:
      case REC.ClassWithMembersAndTypes: {
        wr.u8(node.recordType);
        var ci = node.classInfo;
        wr.i32(ci.objectId);
        wr.lpString(ci.nameObj || ci.name);
        wr.i32(ci.memberCount);
        for (var i = 0; i < ci.memberNames.length; i++) wr.lpString(ci.memberNames[i]);
        writeMemberTypeInfo(wr, node.memberTypeInfo);
        if (node.recordType === REC.ClassWithMembersAndTypes) wr.i32(node.libraryId);
        writeMemberValues(wr, node.memberTypeInfo, node.memberValues, doc);
        return;
      }
      case REC.BinaryObjectString: {
        wr.u8(REC.BinaryObjectString);
        wr.i32(node.objectId);
        wr.lpString(node);
        return;
      }
      case REC.BinaryArray: {
        wr.u8(REC.BinaryArray);
        wr.i32(node.objectId);
        wr.u8(node.binaryArrayType);
        wr.i32(node.rank);
        for (var li = 0; li < node.lengths.length; li++) wr.i32(node.lengths[li]);
        if (node.lowerBounds) {
          for (var bi = 0; bi < node.lowerBounds.length; bi++) wr.i32(node.lowerBounds[bi]);
        }
        wr.u8(node.elementType);
        writeAdditionalTypeInfo(wr, node.elementType, node.elementAdditionalInfo);
        for (var ei = 0; ei < node.elements.length; ei++) writeRecordNode(wr, node.elements[ei], doc);
        return;
      }
      case REC.ArraySinglePrimitive: {
        wr.u8(REC.ArraySinglePrimitive);
        wr.i32(node.objectId);
        wr.i32(node.length);
        wr.u8(node.primitiveType);
        for (var pi = 0; pi < node.elements.length; pi++) writePrimitive(wr, node.primitiveType, node.elements[pi]);
        return;
      }
      case REC.ArraySingleObject:
      case REC.ArraySingleString: {
        wr.u8(node.recordType);
        wr.i32(node.objectId);
        wr.i32(node.length);
        for (var ai = 0; ai < node.elements.length; ai++) writeRecordNode(wr, node.elements[ai], doc);
        return;
      }
      case REC.MemberPrimitiveTyped: {
        wr.u8(REC.MemberPrimitiveTyped);
        wr.u8(node.primitiveType);
        writePrimitive(wr, node.primitiveType, node.valueNode);
        return;
      }
      case REC.MemberReference:
        wr.u8(REC.MemberReference);
        wr.i32(node.idRef);
        return;
      case REC.ObjectNull:
        wr.u8(REC.ObjectNull);
        return;
      case REC.ObjectNullMultiple256:
        wr.u8(REC.ObjectNullMultiple256);
        wr.u8(node.count);
        return;
      case REC.ObjectNullMultiple:
        wr.u8(REC.ObjectNullMultiple);
        wr.i32(node.count);
        return;
      case REC.BinaryLibrary:
        wr.u8(REC.BinaryLibrary);
        wr.i32(node.libraryId);
        wr.lpString(node.libraryNameObj || node.libraryName);
        return;
      case REC.MessageEnd:
        wr.u8(REC.MessageEnd);
        return;
      default:
        throw new Error('LomNrbfCodec: cannot serialize recordType ' + node.recordType);
    }
  }

  function writeMemberValues(wr, mti, vals, doc) {
    for (var i = 0; i < mti.binaryTypes.length; i++) {
      var bt = mti.binaryTypes[i];
      if (bt === BT.Primitive) {
        writePrimitive(wr, mti.additionalInfos[i].primitiveType, vals[i]);
      } else {
        writeRecordNode(wr, vals[i], doc);
      }
    }
  }

  function serializeNrbf(doc) {
    if (!doc || !doc.header || !doc.records) {
      throw new Error('LomNrbfCodec: invalid document');
    }
    var wr = new Writer();
    var h = doc.header;
    wr.u8(REC.SerializedStreamHeader);
    wr.i32(h.rootId);
    wr.i32(h.headerId);
    wr.i32(h.majorVersion);
    wr.i32(h.minorVersion);
    var ended = false;
    for (var i = 1; i < doc.records.length; i++) {
      var r = doc.records[i];
      if (!r || r.recordType === REC.SerializedStreamHeader) continue;
      writeRecordNode(wr, r, doc);
      if (r.recordType === REC.MessageEnd) {
        ended = true;
        break;
      }
    }
    if (!ended) wr.u8(REC.MessageEnd);
    return wr.toUint8Array();
  }

  // ─── Domain Adapters ─────────────────────────────────────────────────────
  function nextObjectId(doc) {
    var id = doc._nextId > 0 ? doc._nextId : 1;
    while (doc.byId[id] || doc.classesById[id]) id++;
    doc._nextId = id + 1;
    return id;
  }

  function resolveRef(doc, node) {
    if (!node) return null;
    if (node.kind === 'ref') return doc.byId[node.idRef] || null;
    if (node.kind === 'null' || node.kind === 'null-multiple256' || node.kind === 'null-multiple') return null;
    return node;
  }

  function getClassMeta(doc, rec) {
    if (!rec) return null;
    if (rec.recordType === REC.ClassWithId) return doc.classesById[rec.metadataId] || null;
    return rec;
  }

  function getMemberNames(meta) {
    if (!meta || !meta.classInfo) return [];
    var out = [];
    for (var i = 0; i < meta.classInfo.memberNames.length; i++) {
      var mn = meta.classInfo.memberNames[i];
      out.push(typeof mn === 'string' ? mn : mn.value);
    }
    return out;
  }

  function getObjFields(doc, rec) {
    var meta = getClassMeta(doc, rec);
    var out = {};
    if (!meta || !rec.memberValues) return out;
    var names = getMemberNames(meta);
    for (var i = 0; i < names.length; i++) {
      out[names[i]] = rec.memberValues[i];
    }
    return out;
  }

  function nodeToJs(doc, node) {
    var r = resolveRef(doc, node);
    if (!r) return null;
    if (r.kind === 'prim') return r.value;
    if (r.kind === 'prim-typed') return r.valueNode ? r.valueNode.value : null;
    if (r.kind === 'string') return r.value;
    if (r.kind === 'object') {
      var meta = getClassMeta(doc, r);
      var names = getMemberNames(meta);
      if (names.length === 1 && names[0] === 'value__' && r.memberValues && r.memberValues[0]) {
        return r.memberValues[0].value;
      }
      return r;
    }
    return r;
  }

  function getFieldJs(doc, rec, name) {
    var fields = getObjFields(doc, rec);
    if (!(name in fields)) return undefined;
    return nodeToJs(doc, fields[name]);
  }

  function setFieldJs(doc, rec, name, jsVal) {
    var meta = getClassMeta(doc, rec);
    if (!meta) return false;
    var names = getMemberNames(meta);
    var idx = names.indexOf(name);
    if (idx < 0) return false;
    var mti = meta.memberTypeInfo;
    var bt = mti.binaryTypes[idx];
    var ai = mti.additionalInfos[idx];
    var cur = rec.memberValues[idx];

    if (bt === BT.Primitive) {
      var pt = ai.primitiveType;
      cur.value = coercePrimitive(pt, jsVal);
      cur.dirty = true;
      return true;
    }
    // Boxed Enum?
    var resolved = resolveRef(doc, cur);
    if (resolved && resolved.kind === 'object') {
      var rmeta = getClassMeta(doc, resolved);
      var rnames = getMemberNames(rmeta);
      if (rnames.length === 1 && rnames[0] === 'value__') {
        resolved.memberValues[0].value = Math.trunc(Number(jsVal) || 0);
        resolved.memberValues[0].dirty = true;
        return true;
      }
    }
    if (bt === BT.String || bt === BT.Object) {
      if (jsVal === null || jsVal === undefined) {
        rec.memberValues[idx] = { recordType: REC.ObjectNull, kind: 'null', count: 1 };
        return true;
      }
      var s = String(jsVal);
      if (resolved && resolved.kind === 'string') {
        resolved.value = s;
        resolved.dirty = true;
        return true;
      }
      var newId = nextObjectId(doc);
      var snode = { recordType: REC.BinaryObjectString, kind: 'string', objectId: newId, value: s, raw: utf8Encode(s), dirty: true };
      doc.byId[newId] = snode;
      rec.memberValues[idx] = snode;
      return true;
    }
    return false;
  }

  function coercePrimitive(pt, val) {
    switch (pt) {
      case PT.Boolean: return !!val;
      case PT.Int64:
      case PT.UInt64:
      case PT.TimeSpan:
      case PT.DateTime:
        return String(val == null ? '0' : val);
      case PT.Single:
      case PT.Double:
        return Number(val) || 0;
      default:
        return Math.trunc(Number(val) || 0);
    }
  }

  function expandArraySlots(elements) {
    var slots = [];
    for (var i = 0; i < elements.length; i++) {
      var e = elements[i];
      if (e.kind === 'null' || e.kind === 'null-multiple256' || e.kind === 'null-multiple') {
        for (var k = 0; k < e.count; k++) slots.push(null);
      } else {
        slots.push(e);
      }
    }
    return slots;
  }

  function compressArraySlots(slots) {
    var out = [];
    var i = 0;
    while (i < slots.length) {
      if (slots[i] !== null) {
        out.push(slots[i]);
        i++;
      } else {
        var run = 0;
        while (i + run < slots.length && slots[i + run] === null) run++;
        if (run === 1) {
          out.push({ recordType: REC.ObjectNull, kind: 'null', count: 1 });
        } else if (run <= 255) {
          out.push({ recordType: REC.ObjectNullMultiple256, kind: 'null-multiple256', count: run });
        } else {
          out.push({ recordType: REC.ObjectNullMultiple, kind: 'null-multiple', count: run });
        }
        i += run;
      }
    }
    return out;
  }

  function listGetItems(doc, listRec) {
    var listNode = resolveRef(doc, listRec);
    if (!listNode) return [];
    var fields = getObjFields(doc, listNode);
    var size = fields._size ? fields._size.value : 0;
    var arr = resolveRef(doc, fields._items);
    if (!arr || !arr.elements) return [];
    var slots = expandArraySlots(arr.elements);
    var out = [];
    for (var i = 0; i < size && i < slots.length; i++) {
      out.push(slots[i] ? resolveRef(doc, slots[i]) : null);
    }
    return out;
  }

  function findLibraryId(doc, libPrefix) {
    for (var k in doc.libraries) {
      var lib = doc.libraries[k];
      if (lib && lib.libraryName && lib.libraryName.indexOf(libPrefix) === 0) return Number(k);
    }
    return 2;
  }

  function makeStringNode(doc, s) {
    var oid = nextObjectId(doc);
    var str = String(s == null ? '' : s);
    var node = { recordType: REC.BinaryObjectString, kind: 'string', objectId: oid, value: str, raw: utf8Encode(str), dirty: true };
    doc.byId[oid] = node;
    return node;
  }

  // Known Mortal.Core item schemas if not yet present in save stream
  var KNOWN_SCHEMAS = {
    'Mortal.Core.StatSave': [['Key', BT.String, null], ['Value', BT.Primitive, { primitiveType: PT.Int32 }]],
    'Mortal.Core.RelationshipSave': [['Key', BT.String, null], ['Value', BT.Primitive, { primitiveType: PT.Int32 }], ['Active', BT.Primitive, { primitiveType: PT.Boolean }]],
    'Mortal.Core.BookSave': [['Id', BT.String, null], ['Count', BT.Primitive, { primitiveType: PT.Int32 }], ['MartialLevel', BT.Primitive, { primitiveType: PT.Int32 }], ['CurrentLevelPoints', BT.Primitive, { primitiveType: PT.Int32 }]],
    'Mortal.Core.MiscSave': [['Id', BT.String, null], ['Count', BT.Primitive, { primitiveType: PT.Int32 }]],
    'Mortal.Core.SpecialItemSave': [['Id', BT.String, null], ['Count', BT.Primitive, { primitiveType: PT.Int32 }]],
    'Mortal.Core.TalentSave': [['Id', BT.String, null], ['Level', BT.Primitive, { primitiveType: PT.Int32 }]],
    'Mortal.Core.BattleSkillSave': [['Key', BT.String, null], ['Level', BT.Primitive, { primitiveType: PT.Int32 }], ['Active', BT.Primitive, { primitiveType: PT.Boolean }]],
    'Mortal.Core.UpgradeItemSave': [['Key', BT.String, null], ['CurrentLevel', BT.Primitive, { primitiveType: PT.Int32 }], ['CurrentPoints', BT.Primitive, { primitiveType: PT.Int32 }], ['AlreadyDevelop', BT.Primitive, { primitiveType: PT.Boolean }]],
    'Mortal.Core.EventFlagSave': [['Name', BT.String, null], ['State', BT.Primitive, { primitiveType: PT.Int32 }]],
    'Mortal.Core.LibrarySave': [['Name', BT.String, null], ['Count', BT.Primitive, { primitiveType: PT.Int32 }]],
    'Mortal.Core.EnemyTeamSave': [['Id', BT.String, null], ['Level', BT.Primitive, { primitiveType: PT.Int32 }], ['People', BT.Primitive, { primitiveType: PT.Int32 }], ['Team', BT.Primitive, { primitiveType: PT.Int32 }], ['DefaultBattleHP', BT.Primitive, { primitiveType: PT.Int32 }]]
  };

  function buildNewClassItem(doc, className, fieldsMap) {
    var meta = doc.classesByName[className];
    var oid = nextObjectId(doc);
    var rec;
    if (meta) {
      var names = getMemberNames(meta);
      var mti = meta.memberTypeInfo;
      var vals = [];
      for (var i = 0; i < names.length; i++) {
        var fn = names[i];
        var v = fieldsMap ? fieldsMap[fn] : undefined;
        if (mti.binaryTypes[i] === BT.Primitive) {
          vals.push({ kind: 'prim', primType: mti.additionalInfos[i].primitiveType, value: coercePrimitive(mti.additionalInfos[i].primitiveType, v), dirty: true });
        } else if (v === null || v === undefined) {
          vals.push({ recordType: REC.ObjectNull, kind: 'null', count: 1 });
        } else {
          vals.push(makeStringNode(doc, v));
        }
      }
      var mnamesClone = meta.classInfo.memberNames.map(function (mn) {
        return { value: mn.value, raw: mn.raw ? mn.raw.slice() : utf8Encode(mn.value), dirty: true };
      });
      rec = {
        recordType: REC.ClassWithMembersAndTypes,
        kind: 'object',
        objectId: oid,
        classInfo: {
          objectId: oid,
          name: className,
          nameObj: { value: className, raw: utf8Encode(className), dirty: true },
          memberCount: mnamesClone.length,
          memberNames: mnamesClone
        },
        memberTypeInfo: {
          binaryTypes: mti.binaryTypes.slice(),
          additionalInfos: mti.additionalInfos.slice()
        },
        libraryId: meta.libraryId !== undefined ? meta.libraryId : findLibraryId(doc, CORE_LIB),
        memberValues: vals
      };
      doc.classesById[oid] = rec;
      doc.byId[oid] = rec;
      return rec;
    }

    var schema = KNOWN_SCHEMAS[className];
    if (!schema) throw new Error('LomNrbfCodec: unknown class schema ' + className);
    var libId = findLibraryId(doc, CORE_LIB);
    var mnames = [];
    var btypes = [];
    var ainfos = [];
    var mvals = [];
    for (var s = 0; s < schema.length; s++) {
      var fname = schema[s][0], sbt = schema[s][1], sai = schema[s][2];
      mnames.push({ value: fname, raw: utf8Encode(fname), dirty: true });
      btypes.push(sbt);
      ainfos.push(sai);
      var fv = fieldsMap ? fieldsMap[fname] : undefined;
      if (sbt === BT.Primitive) {
        mvals.push({ kind: 'prim', primType: sai.primitiveType, value: coercePrimitive(sai.primitiveType, fv), dirty: true });
      } else if (fv === null || fv === undefined) {
        mvals.push({ recordType: REC.ObjectNull, kind: 'null', count: 1 });
      } else {
        mvals.push(makeStringNode(doc, fv));
      }
    }
    rec = {
      recordType: REC.ClassWithMembersAndTypes,
      kind: 'object',
      objectId: oid,
      classInfo: {
        objectId: oid,
        name: className,
        nameObj: { value: className, raw: utf8Encode(className), dirty: true },
        memberCount: mnames.length,
        memberNames: mnames
      },
      memberTypeInfo: { binaryTypes: btypes, additionalInfos: ainfos },
      libraryId: libId,
      memberValues: mvals
    };
    doc.classesById[oid] = rec;
    doc.classesByName[className] = rec;
    doc.byId[oid] = rec;
    return rec;
  }

  function listAddItem(doc, listRec, className, fieldsMap) {
    var listNode = resolveRef(doc, listRec);
    if (!listNode) throw new Error('LomNrbfCodec: null list');
    var fields = getObjFields(doc, listNode);
    var size = fields._size ? (fields._size.value | 0) : 0;
    var arr = resolveRef(doc, fields._items);
    if (!arr) throw new Error('LomNrbfCodec: list has no _items array');
    var slots = expandArraySlots(arr.elements);
    var item = buildNewClassItem(doc, className, fieldsMap);
    if (size < slots.length) {
      slots[size] = item;
    } else {
      var targetLen = Math.max(4, slots.length === 0 ? 4 : slots.length * 2);
      slots.push(item);
      while (slots.length < targetLen) slots.push(null);
    }
    arr.elements = compressArraySlots(slots);
    if (arr.lengths && arr.lengths.length > 0) arr.lengths[0] = slots.length;
    else arr.length = slots.length;
    setFieldJs(doc, listNode, '_size', size + 1);
    setFieldJs(doc, listNode, '_version', (getFieldJs(doc, listNode, '_version') | 0) + 1);
    return item;
  }

  function listRemoveAt(doc, listRec, index) {
    var listNode = resolveRef(doc, listRec);
    if (!listNode) return false;
    var fields = getObjFields(doc, listNode);
    var size = fields._size ? (fields._size.value | 0) : 0;
    if (index < 0 || index >= size) return false;
    var arr = resolveRef(doc, fields._items);
    var slots = expandArraySlots(arr.elements);
    slots.splice(index, 1);
    slots.push(null);
    arr.elements = compressArraySlots(slots);
    if (arr.lengths && arr.lengths.length > 0) arr.lengths[0] = slots.length;
    else arr.length = slots.length;
    setFieldJs(doc, listNode, '_size', size - 1);
    setFieldJs(doc, listNode, '_version', (getFieldJs(doc, listNode, '_version') | 0) + 1);
    return true;
  }

  function detectRootKind(doc) {
    var root = doc.rootRecord || doc.byId[doc.header.rootId];
    if (!root) return { kind: 'Unknown', rootRecord: null, gameSaveRecord: null };
    var meta = getClassMeta(doc, root);
    var cname = meta && meta.classInfo ? meta.classInfo.name : '';
    var shortName = cname.split('.').pop();
    if (shortName === 'AutoGameSave') {
      var gsNode = getObjFields(doc, root).GameSave;
      return { kind: 'AutoGameSave', rootRecord: root, gameSaveRecord: resolveRef(doc, gsNode) };
    }
    if (shortName === 'GameSave') {
      return { kind: 'GameSave', rootRecord: root, gameSaveRecord: root };
    }
    if (shortName === 'LegendSave') {
      return { kind: 'LegendSave', rootRecord: root, gameSaveRecord: null };
    }
    if (shortName === 'UniverseSave') {
      return { kind: 'UniverseSave', rootRecord: root, gameSaveRecord: null };
    }
    return { kind: shortName || 'Unknown', rootRecord: root, gameSaveRecord: null };
  }

  return {
    REC: REC,
    BT: BT,
    PT: PT,
    BAT: BAT,
    parseNrbf: parseNrbf,
    serializeNrbf: serializeNrbf,
    nextObjectId: nextObjectId,
    resolveRef: resolveRef,
    getClassMeta: getClassMeta,
    getMemberNames: getMemberNames,
    getObjFields: getObjFields,
    getFieldJs: getFieldJs,
    setFieldJs: setFieldJs,
    listGetItems: listGetItems,
    listAddItem: listAddItem,
    listRemoveAt: listRemoveAt,
    detectRootKind: detectRootKind
  };
});
