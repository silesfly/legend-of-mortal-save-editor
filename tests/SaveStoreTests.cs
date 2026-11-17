// tests/SaveStoreTests.cs
//
// Strict C# 5.0 test harness (no ?., no $"...", no nameof, no =>)
// built for .NET Framework 4.8 via csc.exe.
//
// Build:  csc.exe /target:exe /out:SaveStoreTests.exe tests\SaveStoreTests.cs src\SaveStore.cs
// Run:    SaveStoreTests.exe

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace LegendOfMortalSaveEditor.Tests
{
    using LegendOfMortalSaveEditor;

    internal static class SaveStoreTests
    {
        private static int _passed;
        private static int _failed;
        private static readonly List<string> _notes = new List<string>();

        public static int Main(string[] args)
        {
            string rootTemp = Path.Combine(Path.GetTempPath(), "lom_tests_" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(rootTemp);
            try
            {
                RunTest("DiscoverSaves finds .dat, skips .bak",       Test_DiscoverSaves);
                RunTest("Read/Validate accepts & rejects correctly",  Test_ReadValidate);
                RunTest("SaveWithBackup backs up + atomic + SHA",     Test_SaveWithBackup);
                RunTest("LOM_SIMULATE_GAME_RUNNING => IOException",   Test_SimulateGameRunning);
                RunTest("Reparse-point rejection (junction)",         Test_Junction);
            }
            finally
            {
                try { Directory.Delete(rootTemp, true); }
                catch (Exception cleanupErr)
                {
                    _notes.Add("cleanup of " + rootTemp + " failed: " + cleanupErr.Message);
                }
            }

            Console.WriteLine();
            Console.WriteLine("Summary: " + _passed + " passed, " + _failed + " failed.");
            if (_notes.Count > 0)
            {
                Console.WriteLine("Notes:");
                for (int i = 0; i < _notes.Count; i++) Console.WriteLine("  - " + _notes[i]);
            }
            return (_failed == 0) ? 0 : 1;
        }

        /* ------------------------------------------------------------------ */
        /* Test runner plumbing                                                */
        /* ------------------------------------------------------------------ */

        private static void RunTest(string name, Action body)
        {
            try
            {
                body();
                _passed++;
                Console.WriteLine("[PASS] " + name);
            }
            catch (Exception ex)
            {
                _failed++;
                Console.WriteLine("[FAIL] " + name + " :: " + ex.GetType().Name + ": " + ex.Message);
            }
        }

        /* ------------------------------------------------------------------ */
        /* NRBF fixture helper                                                 */
        /* ------------------------------------------------------------------ */

        // Builds a minimal NRBF stream:
        //   SerializedStreamHeader (17 bytes)  + LengthPrefixedString("Mortal.Core.GameSave") + 0x0B terminator.
        private static byte[] BuildMinimalSave(string rootTypeName)
        {
            byte[] typeBytes = Encoding.UTF8.GetBytes(rootTypeName);
            using (MemoryStream ms = new MemoryStream())
            {
                using (BinaryWriter w = new BinaryWriter(ms, Encoding.UTF8, true))
                {
                    // SerializedStreamHeader record type = 0
                    w.Write((byte)0);
                    w.Write((Int32)1);              // RootId
                    w.Write((Int32)(-1));           // HeaderId
                    w.Write((Int32)1);              // MajorVersion
                    w.Write((Int32)0);              // MinorVersion
                    // BinaryLibrary (record type 12) referencing library id 2
                    w.Write((byte)12);
                    w.Write((Int32)2);
                    w.Write((byte)0); // empty string library name (length 0)
                    // ClassWithMembersAndTypes-ish root ClassWithId (record type 1) pointing at header
                    w.Write((byte)1);
                    w.Write((Int32)1);              // objectId = root
                    w.Write((Int32)1);              // metadataId
                    // LengthPrefixedString of the type name (COBS-style NRBF string)
                    WriteLengthPrefixedString(w, typeBytes);
                    // ClassTerminator
                    w.Write((byte)0x0B);
                }
                return ms.ToArray();
            }
        }

        // NRBF LengthPrefixedString: single byte length when <= 0x7F, else escaped.
        private static void WriteLengthPrefixedString(BinaryWriter w, byte[] utf8)
        {
            if (utf8.Length <= 0x7F)
            {
                w.Write((byte)utf8.Length);
            }
            else
            {
                // Use 0x80 + next byte for lengths > 127 (simplified: only handles up to 0xFFFF).
                w.Write((byte)0x80);
                w.Write((byte)(utf8.Length & 0xFF));
                w.Write((byte)((utf8.Length >> 8) & 0xFF));
            }
            w.Write(utf8);
        }

        private static string Sha256Hex(byte[] data)
        {
            using (SHA256 sha = SHA256.Create())
            {
                byte[] hash = sha.ComputeHash(data);
                StringBuilder sb = new StringBuilder(hash.Length * 2);
                for (int i = 0; i < hash.Length; i++) sb.Append(hash[i].ToString("x2"));
                return sb.ToString();
            }
        }

        private static string NewTempSubdir(string parent, string tag)
        {
            string d = Path.Combine(parent, tag + "_" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(d);
            return d;
        }

        /* ------------------------------------------------------------------ */
        /* Test 1: DiscoverSaves                                               */
        /* ------------------------------------------------------------------ */

        private static void Test_DiscoverSaves()
        {
            string dir = NewTempSubdir(Path.GetTempPath(), "d");
            string valid  = Path.Combine(dir, "slot1.dat");
            string valid2 = Path.Combine(dir, "slot2.DAT");
            string bak    = Path.Combine(dir, "slot1.dat.backup-old.bak");
            File.WriteAllBytes(valid,  BuildMinimalSave("Mortal.Core.GameSave"));
            File.WriteAllBytes(valid2, BuildMinimalSave("Mortal.Core.UniverseSave"));
            File.WriteAllBytes(bak,    new byte[] { 1, 2, 3 });

            List<SaveSlotInfo> found = SaveStore.DiscoverSaves(dir);
            int datCount = 0, bakCount = 0;
            for (int i = 0; i < found.Count; i++)
            {
                string p = found[i].Path;
                string lowerName = Path.GetFileName(p).ToLowerInvariant();
                if (lowerName.EndsWith(".bak")) bakCount++;
                else if (lowerName.EndsWith(".dat")) datCount++;
            }
            if (datCount < 2) throw new Exception("Expected >=2 .dat slots, got " + datCount);
            if (bakCount != 0) throw new Exception("DiscoverSaves must skip .bak files (saw " + bakCount + ")");
        }

        /* ------------------------------------------------------------------ */
        /* Test 2: ReadSave + ValidateSaveBytes                                */
        /* ------------------------------------------------------------------ */

        private static void Test_ReadValidate()
        {
            string dir = NewTempSubdir(Path.GetTempPath(), "r");

            // --- valid GameSave ---
            string gs = Path.Combine(dir, "game.dat");
            File.WriteAllBytes(gs, BuildMinimalSave("Mortal.Core.GameSave"));
            SaveReadResult r1 = SaveStore.ReadSave(gs);
            if (r1 == null) throw new Exception("ReadSave returned null for valid GameSave");
            SaveStore.ValidateSaveBytes(File.ReadAllBytes(gs));

            // --- valid UniverseSave ---
            string us = Path.Combine(dir, "universe.dat");
            File.WriteAllBytes(us, BuildMinimalSave("Mortal.Core.UniverseSave"));
            SaveReadResult r2 = SaveStore.ReadSave(us);
            if (r2 == null) throw new Exception("ReadSave returned null for valid UniverseSave");
            SaveStore.ValidateSaveBytes(File.ReadAllBytes(us));

            // --- missing magic (empty file) ---
            string empty = Path.Combine(dir, "empty.dat");
            File.WriteAllBytes(empty, new byte[0]);
            ExpectThrow<InvalidDataException>(delegate { SaveStore.ValidateSaveBytes(File.ReadAllBytes(empty)); },
                "empty file must be rejected");

            // --- unknown root type ---
            string unknown = Path.Combine(dir, "unknown.dat");
            File.WriteAllBytes(unknown, BuildMinimalSave("Mortal.Core.SomethingElse"));
            ExpectThrow<InvalidDataException>(delegate { SaveStore.ValidateSaveBytes(File.ReadAllBytes(unknown)); },
                "unknown root type must be rejected");

            // --- non-.dat extension ---
            string txt = Path.Combine(dir, "game.txt");
            File.WriteAllBytes(txt, BuildMinimalSave("Mortal.Core.GameSave"));
            ExpectThrow<ArgumentException>(delegate { SaveStore.ReadSave(txt); },
                "non-.dat extension must be rejected");

            // --- ADS colon ---
            ExpectThrow<ArgumentException>(delegate { SaveStore.ReadSave(Path.Combine(dir, "evil.dat:stream")); },
                "ADS colon in path must be rejected");

            // --- device name ---
            ExpectThrow<ArgumentException>(delegate { SaveStore.ReadSave("CON.dat"); },
                "reserved device name must be rejected");
        }

        /* ------------------------------------------------------------------ */
        /* Test 3: SaveWithBackup                                              */
        /* ------------------------------------------------------------------ */

        private static void Test_SaveWithBackup()
        {
            string dir = NewTempSubdir(Path.GetTempPath(), "w");
            string target = Path.Combine(dir, "slot.dat");

            byte[] v1 = BuildMinimalSave("Mortal.Core.GameSave");
            File.WriteAllBytes(target, v1);
            string sha1 = Sha256Hex(v1);

            byte[] v2 = BuildMinimalSave("Mortal.Core.UniverseSave");
            string sha2 = Sha256Hex(v2);

            SaveWriteResult wr = SaveStore.SaveWithBackup(target, v2, sha1);
            if (wr == null) throw new Exception("SaveWithBackup returned null");
            if (wr.NewSha256 == null || wr.NewSha256.ToLowerInvariant() != sha2)
                throw new Exception("SaveWithBackup must return new SHA-256 (" + sha2 + "), got " + (wr.NewSha256 ?? "<null>"));

            // Backup created
            string[] backups = Directory.GetFiles(dir, "slot.dat.backup-*.bak");
            if (backups == null || backups.Length < 1)
                throw new Exception("Expected .backup-*.bak file, none found");
            byte[] backupContent = File.ReadAllBytes(backups[0]);
            if (Sha256Hex(backupContent) != sha1)
                throw new Exception("Backup must contain the pre-write bytes");

            // Target updated
            byte[] after = File.ReadAllBytes(target);
            if (Sha256Hex(after) != sha2)
                throw new Exception("Target must contain the new bytes after SaveWithBackup");

            // Wrong expected SHA
            ExpectThrow<InvalidOperationException>(delegate { SaveStore.SaveWithBackup(target, v1, "deadbeef"); },
                "wrong expectedSha256 must throw InvalidOperationException");
        }

        /* ------------------------------------------------------------------ */
        /* Test 4: game running simulation                                     */
        /* ------------------------------------------------------------------ */

        private static void Test_SimulateGameRunning()
        {
            string dir = NewTempSubdir(Path.GetTempPath(), "g");
            string target = Path.Combine(dir, "slot.dat");
            byte[] v1 = BuildMinimalSave("Mortal.Core.GameSave");
            File.WriteAllBytes(target, v1);
            byte[] before = File.ReadAllBytes(target);

            string prev = Environment.GetEnvironmentVariable("LOM_SIMULATE_GAME_RUNNING");
            Environment.SetEnvironmentVariable("LOM_SIMULATE_GAME_RUNNING", "1");
            try
            {
                byte[] v2 = BuildMinimalSave("Mortal.Core.UniverseSave");
                ExpectThrow<IOException>(delegate { SaveStore.SaveWithBackup(target, v2, null); },
                    "Simulated game running must throw IOException");
            }
            finally
            {
                Environment.SetEnvironmentVariable("LOM_SIMULATE_GAME_RUNNING", prev);
            }

            byte[] after = File.ReadAllBytes(target);
            if (before.Length != after.Length) throw new Exception("File length changed during simulated lock");
            for (int i = 0; i < before.Length; i++)
                if (before[i] != after[i]) throw new Exception("File content changed during simulated lock (byte " + i + ")");
        }

        /* ------------------------------------------------------------------ */
        /* Test 5: NTFS junction / reparse point                               */
        /* ------------------------------------------------------------------ */

        private static void Test_Junction()
        {
            string dir = NewTempSubdir(Path.GetTempPath(), "j");
            string realTarget = Path.Combine(dir, "real");
            string junction   = Path.Combine(dir, "link");
            Directory.CreateDirectory(realTarget);

            ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", "/c mklink /J \"" + junction + "\" \"" + realTarget + "\"");
            psi.CreateNoWindow = true;
            psi.UseShellExecute = false;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            Process proc = Process.Start(psi);
            proc.WaitForExit();
            bool created = proc.ExitCode == 0 && Directory.Exists(junction);

            if (!created)
            {
                _notes.Add("Junction creation failed (probably non-privileged). SKIP reparse-point check.");
                return;
            }

            try
            {
                string inner = Path.Combine(junction, "payload.dat");
                File.WriteAllBytes(inner, BuildMinimalSave("Mortal.Core.GameSave"));

                ExpectThrow<IOException>(delegate { SaveStore.NoLinks(inner); },
                    "SaveStore.NoLinks must reject paths through a reparse-point directory");
            }
            finally
            {
                try
                {
                    // Microsoft's recommended junction removal: Directory.Delete with recurse=false
                    Directory.Delete(junction, false);
                }
                catch (Exception cleanupErr)
                {
                    _notes.Add("junction cleanup failed: " + cleanupErr.Message);
                }
            }
        }

        /* ------------------------------------------------------------------ */
        /* Tiny assertion helper                                               */
        /* ------------------------------------------------------------------ */

        private static void ExpectThrow<T>(Action action, string message) where T : Exception
        {
            if (action == null) throw new ArgumentNullException("action");
            try
            {
                action();
            }
            catch (T)
            {
                return;
            }
            catch (Exception other)
            {
                throw new Exception(message + " — expected " + typeof(T).Name + " but got " + other.GetType().Name, other);
            }
            throw new Exception(message + " — expected " + typeof(T).Name + " but no exception was thrown");
        }
    }
}
