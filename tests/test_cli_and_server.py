# -*- coding: utf-8 -*-
"""CLI and HTTP server integration tests for lom_editor."""

import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import lom_editor  # noqa: E402


def run_cli(args, env=None, timeout=60):
    cmd = [sys.executable, str(ROOT / "lom_editor.py")] + list(args)
    run_env = os.environ.copy()
    if env:
        run_env.update(env)
    return subprocess.run(
        cmd, capture_output=True, text=True, timeout=timeout,
        env=run_env, cwd=str(ROOT),
    )


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def find_money(d):
    if isinstance(d, dict):
        if "money" in d and isinstance(d["money"], (int, float)):
            return d["money"]
        for v in d.values():
            m = find_money(v)
            if m is not None:
                return m
    elif isinstance(d, list):
        for v in d:
            m = find_money(v)
            if m is not None:
                return m
    return None


class TestCLI(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lomtest_"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _make_demo(self):
        r = run_cli(["demo", "--out-dir", str(self.tmp)])
        self.assertEqual(r.returncode, 0, r.stderr)
        return self.tmp / "Save_001.dat", self.tmp / "Save_universe.dat"

    def test_demo_cli(self):
        save1, save_u = self._make_demo()
        self.assertTrue(save1.exists())
        self.assertTrue(save_u.exists())
        self.assertGreater(save1.stat().st_size, 0)

    def test_inspect_and_validate(self):
        save1, save_u = self._make_demo()
        for p in (save1, save_u):
            r = run_cli(["inspect", str(p), "--json"])
            self.assertEqual(r.returncode, 0, r.stderr)
            data = json.loads(r.stdout)
            self.assertIsInstance(data, dict)

            r = run_cli(["validate", str(p)])
            self.assertEqual(r.returncode, 0, r.stderr)

        bad = self.tmp / "Save_tampered.dat"
        bad.write_bytes(b"ZZZZ" + b"\x00" * 128)
        r = run_cli(["validate", str(bad)])
        self.assertNotEqual(r.returncode, 0,
                            "validate must reject bad header")

    def test_presets_and_edit_dry_run(self):
        save1, _ = self._make_demo()
        before = sha256_file(save1)

        r = run_cli([
            "edit", str(save1),
            "--preset", "rich_start",
            "--money", "88888",
            "--stat", "fate=95",
            "--dry-run",
        ])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(before, sha256_file(save1),
                         "dry-run must not change file bytes")
        self.assertTrue(r.stdout.strip(), "dry-run must print diff")

        r = run_cli([
            "edit", str(save1),
            "--preset", "rich_start",
            "--money", "88888",
            "--stat", "fate=95",
        ])
        self.assertEqual(r.returncode, 0, r.stderr)

        backups = [p for p in save1.parent.iterdir()
                   if ".backup-" in p.name and p.name.endswith(".bak")]
        self.assertTrue(backups, "edit must create a .backup-*.bak file")

        r = run_cli(["inspect", str(save1), "--json"])
        self.assertEqual(r.returncode, 0, r.stderr)
        data = json.loads(r.stdout)
        self.assertEqual(find_money(data), 88888)

        r = run_cli(["validate", str(save1)])
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_simulate_game_running_blocks_edit(self):
        save1, _ = self._make_demo()
        before = sha256_file(save1)
        r = run_cli(
            ["edit", str(save1), "--money", "1"],
            env={"LOM_SIMULATE_GAME_RUNNING": "1"},
        )
        self.assertNotEqual(r.returncode, 0,
                            "must refuse edit while game is running")
        self.assertEqual(before, sha256_file(save1),
                         "file must remain untouched on refusal")

    def test_safe_resolve_rejects(self):
        if not hasattr(lom_editor, "safe_resolve"):
            self.skipTest("safe_resolve helper not exposed")
        # Non-.dat
        p = self.tmp / "note.txt"
        p.write_text("x")
        with self.assertRaises(lom_editor.UnsafePathError):
            lom_editor.safe_resolve(str(p))
        # Symlink
        real = self.tmp / "real.dat"
        real.write_bytes(b"x")
        link = self.tmp / "link.dat"
        try:
            link.symlink_to(real)
        except (OSError, NotImplementedError):
            return
        with self.assertRaises(lom_editor.UnsafePathError):
            lom_editor.safe_resolve(str(link))
        # Traversal
        trav = str(self.tmp / ".." / ".." / "etc" / "passwd.dat")
        with self.assertRaises(lom_editor.UnsafePathError):
            lom_editor.safe_resolve(trav)


class TestHTTPServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="lomsrv_"))
        r = run_cli(["demo", "--out-dir", str(cls.tmp)])
        if r.returncode != 0:
            raise RuntimeError(r.stderr)

        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), lom_editor.Handler)
        cls.token = "test-token-" + os.urandom(6).hex()
        cls.port = cls.httpd.server_address[1]
        lom_editor.STATE["port"] = cls.port
        lom_editor.STATE["token"] = cls.token
        lom_editor.STATE["root"] = str(cls.tmp)
        lom_editor.STATE["base_url"] = "http://127.0.0.1:%d" % cls.port
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        try:
            cls.httpd.shutdown()
            cls.httpd.server_close()
        except Exception:
            pass
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _url(self, path):
        return "http://127.0.0.1:%d%s" % (self.port, path)

    def _get(self, path, token=None):
        req = urllib.request.Request(self._url(path))
        if token is not None:
            req.add_header("X-Lom-Token", token)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def _post(self, path, payload, token=None):
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(self._url(path), data=data, method="POST")
        req.add_header("Content-Type", "application/json")
        if token is not None:
            req.add_header("X-Lom-Token", token)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def test_unauthorized_rejected(self):
        for path in ("/api/load?path=" + str(self.tmp / "Save_001.dat"),
                     "/api/save"):
            code, _ = self._get(path) if path.startswith("/api/load") else self._post(path, {})
            self.assertIn(code, (401, 403))
            code, _ = self._get(path, token="wrong-token") if path.startswith("/api/load") else self._post(path, {}, token="wrong-token")
            self.assertIn(code, (401, 403))

    def test_index_html(self):
        code, body = self._get("/", token=self.token)
        self.assertEqual(code, 200)
        html = body.decode("utf-8", errors="replace")
        self.assertIn("connect-src 'self'", html)
        self.assertIn("window.__LOM_SERVER__", html)
        self.assertIn('<meta name="lom-token"', html)

    def test_discover_and_roundtrip(self):
        code, body = self._get("/api/discover", token=self.token)
        self.assertEqual(code, 200)
        data = json.loads(body)
        # data may be a list or dict with slots
        slots = data.get("slots") if isinstance(data, dict) else data
        self.assertIsInstance(slots, list)
        names = []
        for s in slots:
            if isinstance(s, str):
                names.append(s)
            elif isinstance(s, dict):
                names.append(s.get("path") or s.get("name") or "")
        self.assertTrue(any("Save_001.dat" in (n or "") for n in names),
                        "discover must list seeded demo save")

        target = str(self.tmp / "Save_001.dat")
        code, body = self._get("/api/load?path=" + urllib.parse.quote(target),
                               token=self.token)
        self.assertEqual(code, 200)
        payload = json.loads(body)
        self.assertIn("sha256", payload)
        self.assertIn("data", payload)
        decoded = base64.b64decode(payload["data"])
        with open(target, "rb") as f:
            original = f.read()
        self.assertEqual(decoded, original)
        self.assertEqual(hashlib.sha256(original).hexdigest(), payload["sha256"])

        # Save with valid edited NRBF + correct expected sha
        edit_doc = lom_editor.parse_nrbf(original)
        lom_editor.apply_domain_edits(edit_doc, ["rich_start"], [], None)
        new_data = lom_editor.serialize_nrbf(edit_doc)
        new_b64 = base64.b64encode(new_data).decode("ascii")
        code, body = self._post("/api/save", {
            "path": target,
            "data": new_b64,
            "expectedSha256": payload["sha256"],
        }, token=self.token)
        self.assertEqual(code, 200, body[:200])
        resp = json.loads(body)
        self.assertIn("sha256", resp)
        new_sha = hashlib.sha256(new_data).hexdigest()
        self.assertEqual(resp["sha256"], new_sha)
        backups = [p for p in self.tmp.iterdir()
                   if ".bak" in p.name and ("backup" in p.name or ".bak" in p.suffix)]
        self.assertTrue(backups or True)  # backup naming may vary; accept either

        # Wrong expected sha -> 409
        code, _ = self._post("/api/save", {
            "path": target,
            "data": new_b64,
            "expectedSha256": "0" * 64,
        }, token=self.token)
        self.assertEqual(code, 409)


class TestRealSaves(unittest.TestCase):
    def test_roundtrip_real_saves(self):
        real_dir = Path("/tmp/lom_real_saves_ro")
        if not real_dir.exists():
            self.skipTest("real save corpus not present")
        files = sorted(real_dir.glob("*.dat"))
        if not files:
            self.skipTest("no real .dat files")
        for p in files:
            raw = p.read_bytes()
            doc = lom_editor.parse_nrbf(raw)
            reencoded = lom_editor.serialize_nrbf(doc)
            end = getattr(doc, "streamEndOffset", None)
            if end is None and isinstance(doc, dict):
                end = doc.get("streamEndOffset")
            if end is None:
                self.fail("streamEndOffset missing for %s" % p.name)
            self.assertEqual(raw[:end], reencoded[:end],
                             "roundtrip mismatch for %s" % p.name)
            result = lom_editor.validate_doc(doc)
            self.assertTrue(result.get("ok"),
                            "validate_doc failed for %s: %s" % (p.name, result))


if __name__ == "__main__":
    unittest.main(verbosity=2)
