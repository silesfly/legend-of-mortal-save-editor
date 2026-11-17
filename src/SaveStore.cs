using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace LegendOfMortalSaveEditor
{
    public class SaveSlotInfo
    {
        public string Path { get; set; }
        public string Name { get; set; }
        public string Kind { get; set; }
        public long Size { get; set; }
        public DateTime ModifiedUtc { get; set; }
        public string Sha256 { get; set; }
    }

    public class SaveReadResult
    {
        public string Path { get; set; }
        public string Kind { get; set; }
        public byte[] Bytes { get; set; }
        public string Sha256 { get; set; }
    }

    public class SaveWriteResult
    {
        public bool Success { get; set; }
        public string Path { get; set; }
        public string BackupPath { get; set; }
        public string NewSha256 { get; set; }
    }

    public static class SaveStore
    {
        public const string SimulateRunningVar = "LOM_SIMULATE_GAME_RUNNING";
        public const int MaxSaveBytes = 32 * 1024 * 1024;

        private const uint MOVEFILE_REPLACE_EXISTING = 1;
        private const uint MOVEFILE_WRITE_THROUGH = 8;

        private const uint GENERIC_READ = 0x80000000;
        private const uint FILE_READ_ATTRIBUTES = 0x00000080;
        private const uint FILE_SHARE_READ = 0x00000001;
        private const uint FILE_SHARE_WRITE = 0x00000002;
        private const uint FILE_SHARE_DELETE = 0x00000004;
        private const uint OPEN_EXISTING = 3;
        private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
        private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
        private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;

        private const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
        private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;

        private static readonly byte[] NrbfHeader = new byte[]
        {
            0x00, 0x01, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF, 0xFF,
            0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
        };

        [StructLayout(LayoutKind.Sequential)]
        private struct ByHandleFileInformation
        {
            public uint FileAttributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
            public uint VolumeSerialNumber;
            public uint FileSizeHigh;
            public uint FileSizeLow;
            public uint NumberOfLinks;
            public uint FileIndexHigh;
            public uint FileIndexLow;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(
            string lpFileName,
            uint dwDesiredAccess,
            uint dwShareMode,
            IntPtr lpSecurityAttributes,
            uint dwCreationDisposition,
            uint dwFlagsAndAttributes,
            IntPtr hTemplateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandle(
            SafeFileHandle hFile,
            out ByHandleFileInformation lpFileInformation);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFinalPathNameByHandleW(
            SafeFileHandle hFile,
            StringBuilder lpszFilePath,
            uint cchFilePath,
            uint dwFlags);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool MoveFileExW(
            string lpExistingFileName,
            string lpNewFileName,
            uint dwFlags);

        public static void NoLinks(string path)
        {
            if (string.IsNullOrEmpty(path))
                throw new ArgumentException("Path is required.", "path");

            if (path.IndexOf('\0') >= 0)
                throw new ArgumentException("Path contains an invalid character.", "path");

            string root = Path.GetPathRoot(path);
            if (string.IsNullOrEmpty(root) || root.Length < 2 || root[1] != ':')
                throw new ArgumentException("Path must be rooted on a drive.", "path");

            if (root.Length < 3 || root[2] != Path.DirectorySeparatorChar)
                throw new ArgumentException("Path must be a fully rooted drive path.", "path");

            if (path.Length > 2 && HasInvalidColon(path))
                throw new ArgumentException("Alternate data stream paths are not allowed.", "path");

            string fullPath = Path.GetFullPath(path);
            string fullRoot = Path.GetPathRoot(fullPath);
            if (string.IsNullOrEmpty(fullRoot) || fullRoot.Length < 2 || fullRoot[1] != ':')
                throw new ArgumentException("Path must be rooted on a drive.", "path");

            string[] parts = fullPath.Split(new char[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar },
                StringSplitOptions.RemoveEmptyEntries);
            foreach (string part in parts)
            {
                if (part == "...")
                    throw new ArgumentException("Path contains a forbidden '...' component.", "path");
                if (IsReservedDosName(part))
                    throw new ArgumentException("Path contains a reserved DOS device name.", "path");
            }

            string current = fullRoot;
            string parent = Path.GetDirectoryName(fullPath);
            if (string.IsNullOrEmpty(parent))
                parent = fullRoot;

            List<string> ancestors = new List<string>();
            string cursor = parent;
            while (!string.IsNullOrEmpty(cursor))
            {
                ancestors.Add(cursor);
                if (string.Equals(cursor, fullRoot, StringComparison.OrdinalIgnoreCase))
                    break;
                string next = Path.GetDirectoryName(cursor);
                if (string.IsNullOrEmpty(next) || string.Equals(next, cursor, StringComparison.OrdinalIgnoreCase))
                    break;
                cursor = next;
            }

            ancestors.Reverse();
            foreach (string dir in ancestors)
                ValidateDirectoryNoLinks(dir);

            if (File.Exists(fullPath))
                ValidateFileNoLinks(fullPath);
            else if (Directory.Exists(fullPath))
                ValidateDirectoryNoLinks(fullPath);
        }

        public static string ValidateSaveBytes(byte[] bytes)
        {
            if (bytes == null)
                throw new ArgumentNullException("bytes");
            if (bytes.Length < 17)
                throw new InvalidDataException("Save data is too small to be a valid NRBF stream.");
            if (bytes.Length > MaxSaveBytes)
                throw new InvalidDataException("Save data exceeds the maximum allowed size.");

            for (int i = 0; i < NrbfHeader.Length; i++)
            {
                if (bytes[i] != NrbfHeader[i])
                    throw new InvalidDataException("Invalid NRBF SerializedStreamHeader.");
            }

            bool hasMessageEnd = false;
            for (int i = 17; i < bytes.Length; i++)
            {
                if (bytes[i] == 0x0B)
                {
                    hasMessageEnd = true;
                    break;
                }
            }
            if (!hasMessageEnd)
                throw new InvalidDataException("NRBF MessageEnd byte was not found.");

            int prefixLength = Math.Min(bytes.Length, 4096);
            string prefix = Encoding.UTF8.GetString(bytes, 0, prefixLength);

            if (prefix.IndexOf("Mortal.Core.AutoGameSave", StringComparison.Ordinal) >= 0)
                return "AutoGameSave";
            if (prefix.IndexOf("Mortal.Core.GameSave", StringComparison.Ordinal) >= 0)
                return "GameSave";
            if (prefix.IndexOf("Mortal.Core.LegendSave", StringComparison.Ordinal) >= 0)
                return "LegendSave";
            if (prefix.IndexOf("Mortal.Core.UniverseSave", StringComparison.Ordinal) >= 0)
                return "UniverseSave";

            throw new InvalidDataException("Unknown Legend of Mortal NRBF root type.");
        }

        public static bool IsGameRunning()
        {
            string simulated = Environment.GetEnvironmentVariable(SimulateRunningVar);
            if (string.Equals(simulated, "1", StringComparison.Ordinal))
                return true;

            Process[] processes = Process.GetProcesses();
            try
            {
                foreach (Process process in processes)
                {
                    if (process == null)
                        continue;
                    try
                    {
                        if (string.Equals(process.ProcessName, "Mortal", StringComparison.OrdinalIgnoreCase))
                            return true;
                    }
                    catch
                    {
                        // Ignore processes that exit or cannot be inspected.
                    }
                }
            }
            finally
            {
                foreach (Process process in processes)
                {
                    if (process != null)
                        process.Dispose();
                }
            }
            return false;
        }

        public static List<SaveSlotInfo> DiscoverSaves(params string[] extraRoots)
        {
            List<string> roots = new List<string>();

            string userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            if (!string.IsNullOrEmpty(userProfile))
            {
                string localLow = Path.Combine(userProfile, "AppData", "LocalLow", "Obb Studio", "Mortal");
                if (Directory.Exists(localLow))
                {
                    roots.Add(localLow);
                    try
                    {
                        foreach (string dir in Directory.GetDirectories(localLow, "*", SearchOption.TopDirectoryOnly))
                        {
                            string name = Path.GetFileName(dir);
                            if (IsSteamId64(name))
                                roots.Add(dir);
                        }
                    }
                    catch
                    {
                    }
                }
            }

            AddSteamRoots(roots, Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86));
            AddSteamRoots(roots, Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles));

            if (extraRoots != null)
            {
                foreach (string extra in extraRoots)
                {
                    if (!string.IsNullOrEmpty(extra))
                        roots.Add(extra);
                }
            }

            HashSet<string> seenRoots = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            List<SaveSlotInfo> results = new List<SaveSlotInfo>();

            foreach (string root in roots)
            {
                string fullRoot;
                try
                {
                    fullRoot = Path.GetFullPath(root);
                }
                catch
                {
                    continue;
                }

                if (seenRoots.Contains(fullRoot))
                    continue;
                seenRoots.Add(fullRoot);

                if (!Directory.Exists(fullRoot))
                    continue;

                ScanSaveRoot(fullRoot, results);
            }

            results.Sort(CompareSaveSlots);
            return results;
        }

        public static SaveReadResult ReadSave(string path)
        {
            if (string.IsNullOrEmpty(path))
                throw new ArgumentException("Path is required.", "path");
            if (!string.Equals(Path.GetExtension(path), ".dat", StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("Save path must end with .dat.", "path");

            NoLinks(path);

            byte[] bytes = File.ReadAllBytes(path);
            string kind = ValidateSaveBytes(bytes);
            string sha = Sha256Hex(bytes);

            SaveReadResult result = new SaveReadResult();
            result.Path = path;
            result.Kind = kind;
            result.Bytes = bytes;
            result.Sha256 = sha;
            return result;
        }

        public static SaveWriteResult SaveWithBackup(string path, byte[] newBytes, string expectedSha256)
        {
            if (IsGameRunning())
                throw new IOException("The game appears to be running; refusing to write a save.");

            if (string.IsNullOrEmpty(path))
                throw new ArgumentException("Path is required.", "path");
            if (!string.Equals(Path.GetExtension(path), ".dat", StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("Save path must end with .dat.", "path");

            ValidateSaveBytes(newBytes);

            string fullPath = Path.GetFullPath(path);
            string parent = Path.GetDirectoryName(fullPath);
            if (string.IsNullOrEmpty(parent))
                throw new ArgumentException("Save path must have a parent directory.", "path");

            NoLinks(fullPath);
            bool exists = File.Exists(fullPath);
            string backupPath = null;

            if (exists)
            {
                byte[] existing = File.ReadAllBytes(fullPath);
                if (!string.IsNullOrEmpty(expectedSha256))
                {
                    string actual = Sha256Hex(existing);
                    if (!string.Equals(actual, expectedSha256, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException("The save file has changed since it was read.");
                }

                string stamp = DateTime.UtcNow.ToString("yyyyMMddHHmmssfff");
                int pid = Process.GetCurrentProcess().Id;
                string rand = RandomHex8();
                backupPath = fullPath + ".backup-" + stamp + "-" + pid.ToString() + "-" + rand + ".bak";
                File.Copy(fullPath, backupPath, false);
            }

            string pendingPath = fullPath + ".pending-" + Process.GetCurrentProcess().Id.ToString() + "-" + RandomHex8();

            try
            {
                using (FileStream fs = new FileStream(pendingPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    fs.Write(newBytes, 0, newBytes.Length);
                    fs.Flush(true);
                }

                if (!MoveFileExW(pendingPath, fullPath, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
                {
                    int err = Marshal.GetLastWin32Error();
                    throw new IOException("Failed to replace save file atomically. Win32 error: " + err.ToString());
                }

                SaveWriteResult result = new SaveWriteResult();
                result.Success = true;
                result.Path = fullPath;
                result.BackupPath = backupPath;
                result.NewSha256 = Sha256Hex(newBytes);
                return result;
            }
            catch
            {
                try
                {
                    if (File.Exists(pendingPath))
                        File.Delete(pendingPath);
                }
                catch
                {
                }
                throw;
            }
        }

        private static void AddSteamRoots(List<string> roots, string programFiles)
        {
            if (string.IsNullOrEmpty(programFiles))
                return;

            string steam = Path.Combine(programFiles, "Steam");
            if (!Directory.Exists(steam))
                return;

            string steamApps = Path.Combine(steam, "steamapps");
            string common = Path.Combine(steamApps, "common");
            if (!Directory.Exists(common))
                return;

            try
            {
                foreach (string dir in Directory.GetDirectories(common, "*", SearchOption.TopDirectoryOnly))
                {
                    string name = Path.GetFileName(dir);
                    if (name.IndexOf("Mortal", StringComparison.OrdinalIgnoreCase) < 0 &&
                        name.IndexOf("Legend", StringComparison.OrdinalIgnoreCase) < 0)
                        continue;

                    string saveDir = Path.Combine(dir, "Saves");
                    if (Directory.Exists(saveDir))
                        roots.Add(saveDir);
                    roots.Add(dir);
                }
            }
            catch
            {
            }
        }

        private static void ScanSaveRoot(string root, List<SaveSlotInfo> results)
        {
            try
            {
                foreach (string file in Directory.GetFiles(root, "*.dat", SearchOption.TopDirectoryOnly))
                {
                    string name = Path.GetFileName(file);
                    if (name.EndsWith(".bak", StringComparison.OrdinalIgnoreCase))
                        continue;

                    try
                    {
                        if (HasLink(file))
                            continue;

                        byte[] bytes = File.ReadAllBytes(file);
                        string kind = ValidateSaveBytes(bytes);
                        FileInfo fi = new FileInfo(file);

                        SaveSlotInfo info = new SaveSlotInfo();
                        info.Path = file;
                        info.Name = name;
                        info.Kind = kind;
                        info.Size = fi.Length;
                        info.ModifiedUtc = fi.LastWriteTimeUtc;
                        info.Sha256 = Sha256Hex(bytes);
                        results.Add(info);
                    }
                    catch
                    {
                    }
                }
            }
            catch
            {
            }
        }

        private static int CompareSaveSlots(SaveSlotInfo a, SaveSlotInfo b)
        {
            int ra = SaveSortRank(a.Name);
            int rb = SaveSortRank(b.Name);
            if (ra != rb)
                return ra.CompareTo(rb);
            return string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase);
        }

        private static int SaveSortRank(string name)
        {
            if (string.Equals(name, "Save_universe.dat", StringComparison.OrdinalIgnoreCase))
                return 0;
            if (string.Equals(name, "Save_FastSave_QQ.dat", StringComparison.OrdinalIgnoreCase))
                return 1;
            if (name.StartsWith("Save_auto", StringComparison.OrdinalIgnoreCase))
                return 4;
            if (name.StartsWith("Save_", StringComparison.OrdinalIgnoreCase))
                return 2;
            if (name.StartsWith("Legend_", StringComparison.OrdinalIgnoreCase))
                return 3;
            return 5;
        }

        private static bool HasLink(string path)
        {
            try
            {
                using (SafeFileHandle handle = CreateFileW(path, FILE_READ_ATTRIBUTES,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, IntPtr.Zero,
                    OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero))
                {
                    if (handle.IsInvalid)
                        return true;

                    ByHandleFileInformation info;
                    if (!GetFileInformationByHandle(handle, out info))
                        return true;

                    return (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || info.NumberOfLinks > 1;
                }
            }
            catch
            {
                return true;
            }
        }

        private static void ValidateDirectoryNoLinks(string dir)
        {
            using (SafeFileHandle handle = CreateFileW(dir, FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, IntPtr.Zero,
                OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero))
            {
                if (handle.IsInvalid)
                    throw new IOException("Unable to open directory for validation: " + dir);

                ByHandleFileInformation info;
                if (!GetFileInformationByHandle(handle, out info))
                    throw new IOException("Unable to read directory information: " + dir);

                if ((info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
                    throw new IOException("Directory is a reparse point and is not allowed: " + dir);

                string final = GetFinalPath(handle);
                if (final.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase) ||
                    final.StartsWith("\\\\.\\", StringComparison.OrdinalIgnoreCase))
                    throw new IOException("Directory resolves to an unsafe path: " + dir);
            }
        }

        private static void ValidateFileNoLinks(string file)
        {
            using (SafeFileHandle handle = CreateFileW(file, FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, IntPtr.Zero,
                OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero))
            {
                if (handle.IsInvalid)
                    throw new IOException("Unable to open file for validation: " + file);

                ByHandleFileInformation info;
                if (!GetFileInformationByHandle(handle, out info))
                    throw new IOException("Unable to read file information: " + file);

                if ((info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
                    throw new IOException("File is a reparse point and is not allowed: " + file);

                if (info.NumberOfLinks > 1)
                    throw new IOException("File has multiple hard links and is not allowed: " + file);

                string final = GetFinalPath(handle);
                if (final.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase) ||
                    final.StartsWith("\\\\.\\", StringComparison.OrdinalIgnoreCase))
                    throw new IOException("File resolves to an unsafe path: " + file);
            }
        }

        private static string GetFinalPath(SafeFileHandle handle)
        {
            StringBuilder sb = new StringBuilder(1024);
            uint len = GetFinalPathNameByHandleW(handle, sb, (uint)sb.Capacity, 0);
            if (len == 0)
                throw new IOException("Unable to resolve final path.");

            if (len >= sb.Capacity)
            {
                sb = new StringBuilder((int)len + 1);
                len = GetFinalPathNameByHandleW(handle, sb, (uint)sb.Capacity, 0);
                if (len == 0 || len >= sb.Capacity)
                    throw new IOException("Unable to resolve final path.");
            }

            return sb.ToString();
        }

        private static bool HasInvalidColon(string path)
        {
            for (int i = 2; i < path.Length; i++)
            {
                if (path[i] == ':')
                    return true;
            }
            return false;
        }

        private static bool IsReservedDosName(string component)
        {
            if (string.IsNullOrEmpty(component))
                return false;

            string name = component.TrimEnd(' ', '.');
            int dot = name.IndexOf('.');
            if (dot >= 0)
                name = name.Substring(0, dot);
            name = name.TrimEnd(' ', '.');

            if (name.Length == 0)
                return false;

            string upper = name.ToUpperInvariant();
            if (upper == "CON" || upper == "PRN" || upper == "AUX" || upper == "NUL")
                return true;
            if (upper.Length == 4)
            {
                if ((upper.StartsWith("COM", StringComparison.Ordinal) || upper.StartsWith("LPT", StringComparison.Ordinal)) &&
                    upper[3] >= '1' && upper[3] <= '9')
                    return true;
            }
            return false;
        }

        private static bool IsSteamId64(string name)
        {
            if (string.IsNullOrEmpty(name) || name.Length < 15)
                return false;
            for (int i = 0; i < name.Length; i++)
            {
                if (name[i] < '0' || name[i] > '9')
                    return false;
            }
            return true;
        }

        private static string Sha256Hex(byte[] bytes)
        {
            using (SHA256 sha = SHA256.Create())
            {
                byte[] hash = sha.ComputeHash(bytes);
                StringBuilder sb = new StringBuilder(hash.Length * 2);
                for (int i = 0; i < hash.Length; i++)
                    sb.Append(hash[i].ToString("x2"));
                return sb.ToString();
            }
        }

        private static string RandomHex8()
        {
            byte[] bytes = new byte[4];
            using (RandomNumberGenerator rng = RandomNumberGenerator.Create())
            {
                rng.GetBytes(bytes);
            }
            StringBuilder sb = new StringBuilder(8);
            for (int i = 0; i < bytes.Length; i++)
                sb.Append(bytes[i].ToString("x2"));
            return sb.ToString();
        }
    }
}
