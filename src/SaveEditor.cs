using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace LegendOfMortalSaveEditor
{
    public static class Program
    {
        [STAThread]
        public static int Main(string[] args)
        {
            HookAssemblyResolver();

            string outDir = null;
            string seedPath = null;
            bool selfTest = false;

            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--self-test") { selfTest = true; }
                else if (args[i] == "--out-dir" && i + 1 < args.Length) { outDir = args[++i]; }
                else if (args[i] == "--seed" && i + 1 < args.Length) { seedPath = args[++i]; }
            }

            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string baseDir = Path.Combine(localAppData, "LegendOfMortalSaveEditor");
            string runtimeDir = Path.Combine(baseDir, "runtime-1.0.0");
            string htmlDir = Path.Combine(baseDir, "html-1.0.0");
            string htmlPath = Path.Combine(htmlDir, "LegendOfMortalSaveEditor-v1.0.html");

            try
            {
                EnsureDir(runtimeDir);
                EnsureDir(htmlDir);
                ExtractResource("WebView2Loader.dll", Path.Combine(runtimeDir, "WebView2Loader.dll"));
                ExtractResource("LegendOfMortalSaveEditor-v1.0.html", htmlPath);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("Extraction failed: " + ex.Message);
                return 1;
            }

            // SetLoaderDllFolderPath touches CoreWebView2Environment; call via non-inlined helper.
            ApplyLoaderFolder(runtimeDir);

            if (selfTest)
            {
                bool ok = SelfTestRunner.Run(outDir, seedPath, htmlDir);
                return ok ? 0 : 1;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new SaveEditorForm(htmlDir, baseDir));
            return 0;
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void ApplyLoaderFolder(string runtimeDir)
        {
            try
            {
                CoreWebView2Environment.SetLoaderDllFolderPath(runtimeDir);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("SetLoaderDllFolderPath failed: " + ex.Message);
            }
        }

        public static void HookAssemblyResolver()
        {
            AppDomain.CurrentDomain.AssemblyResolve += OnResolveAssembly;
        }

        private static Assembly OnResolveAssembly(object sender, ResolveEventArgs e)
        {
            string simpleName;
            try { simpleName = new AssemblyName(e.Name).Name; }
            catch { return null; }

            if (simpleName == "Microsoft.Web.WebView2.Core")
                return LoadEmbeddedAssembly("Microsoft.Web.WebView2.Core.dll");
            if (simpleName == "Microsoft.Web.WebView2.WinForms")
                return LoadEmbeddedAssembly("Microsoft.Web.WebView2.WinForms.dll");
            return null;
        }

        private static Assembly LoadEmbeddedAssembly(string name)
        {
            Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream(name);
            if (s == null) return null;
            byte[] buf = new byte[s.Length];
            int read = 0;
            while (read < buf.Length)
            {
                int n = s.Read(buf, read, buf.Length - read);
                if (n <= 0) break;
                read += n;
            }
            s.Close();
            return Assembly.Load(buf);
        }

        private static void EnsureDir(string dir)
        {
            if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
        }

        private static void ExtractResource(string name, string dest)
        {
            Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream(name);
            if (s == null) throw new FileNotFoundException("Embedded resource missing: " + name);
            using (s)
            using (FileStream fs = File.Create(dest))
            {
                s.CopyTo(fs);
            }
        }
    }

    public sealed class SaveEditorForm : Form
    {
        private readonly string _htmlDir;
        private readonly string _baseDir;
        private WebView2 _webView;
        private readonly JavaScriptSerializer _json = new JavaScriptSerializer();

        public SaveEditorForm(string htmlDir, string baseDir)
        {
            _htmlDir = htmlDir;
            _baseDir = baseDir;
            _json.MaxJsonLength = int.MaxValue;

            Text = "활협전 세이브 에디터 v1.0";
            Width = 1280;
            Height = 840;
            StartPosition = FormStartPosition.CenterScreen;

            _webView = new WebView2();
            _webView.Dock = DockStyle.Fill;
            Controls.Add(_webView);

            Load += OnFormLoad;
        }

        private async void OnFormLoad(object sender, EventArgs e)
        {
            try
            {
                await InitializeWebViewCoreAsync(_webView, _baseDir, _htmlDir);
                _webView.CoreWebView2.WebMessageReceived += HandleWebMessage;
                _webView.NavigationCompleted += OnNavCompleted;
                _webView.Source = new Uri("https://lom-editor.local/LegendOfMortalSaveEditor-v1.0.html");
            }
            catch (Exception ex)
            {
                MessageBox.Show("WebView2 초기화 실패: " + ex.Message, "오류",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void OnNavCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            // no-op; navigation is expected to succeed
        }

        public static async Task InitializeWebViewCoreAsync(WebView2 webView, string localAppDataBase, string htmlDir)
        {
            string userDataDir = Path.Combine(localAppDataBase, "webview2-1.0.0");
            if (!Directory.Exists(userDataDir)) Directory.CreateDirectory(userDataDir);

            CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, userDataDir);
            await webView.EnsureCoreWebView2Async(env);
            CoreWebView2 core = webView.CoreWebView2;

            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreHostObjectsAllowed = false;

            core.NavigationStarting += delegate(object s, CoreWebView2NavigationStartingEventArgs e)
            {
                Uri navUri;
                if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out navUri)
                    || !string.Equals(navUri.Scheme, "https", StringComparison.OrdinalIgnoreCase)
                    || !string.Equals(navUri.Host, "lom-editor.local", StringComparison.OrdinalIgnoreCase)
                    || !navUri.IsDefaultPort)
                {
                    e.Cancel = true;
                }
            };
            core.NewWindowRequested += delegate(object s, CoreWebView2NewWindowRequestedEventArgs e)
            {
                e.Handled = true;
            };

            core.SetVirtualHostNameToFolderMapping(
                "lom-editor.local",
                htmlDir,
                CoreWebView2HostResourceAccessKind.Deny);
        }

        private void HandleWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (_webView == null || _webView.CoreWebView2 == null)
            {
                return;
            }
            Uri srcUri;
            if (!Uri.TryCreate(e.Source, UriKind.Absolute, out srcUri)
                || !string.Equals(srcUri.Scheme, "https", StringComparison.OrdinalIgnoreCase)
                || !string.Equals(srcUri.Host, "lom-editor.local", StringComparison.OrdinalIgnoreCase)
                || !srcUri.IsDefaultPort)
            {
                return;
            }
            string raw;
            try { raw = e.TryGetWebMessageAsString(); }
            catch { raw = e.WebMessageAsJson; }

            if (string.IsNullOrEmpty(raw)) return;

            Dictionary<string, object> req;
            try { req = _json.Deserialize<Dictionary<string, object>>(raw); }
            catch { return; }
            if (req == null) return;

            object idObj;
            string reqId = req.TryGetValue("id", out idObj) && idObj != null ? Convert.ToString(idObj) : null;
            object methodObj;
            string method = req.TryGetValue("method", out methodObj) ? Convert.ToString(methodObj) : null;
            Dictionary<string, object> prms = null;
            object paramsObj;
            if (req.TryGetValue("params", out paramsObj)) prms = paramsObj as Dictionary<string, object>;

            Dictionary<string, object> resp = new Dictionary<string, object>();
            resp["id"] = reqId;

            try
            {
                object result = Dispatch(method, prms);
                resp["result"] = result;
            }
            catch (Exception ex)
            {
                resp["error"] = ex.Message;
            }

            string jsonResp = _json.Serialize(resp);
            string script = "window.__LOM_HOST__ && window.__LOM_HOST__.receive(" + jsonResp + ");";
            try
            {
                if (_webView != null && _webView.CoreWebView2 != null)
                    _webView.CoreWebView2.ExecuteScriptAsync(script);
            }
            catch { }
        }

        private static string GetParam(Dictionary<string, object> p, string key)
        {
            if (p == null || !p.ContainsKey(key) || p[key] == null) return null;
            return Convert.ToString(p[key]);
        }

        private object Dispatch(string method, Dictionary<string, object> p)
        {
            if (method == null) throw new ArgumentException("Missing method");

            if (method == "ready") return new Dictionary<string, object> { { "ok", true } };

            if (method == "discoverSaves")
            {
                List<SaveSlotInfo> found = SaveStore.DiscoverSaves();
                List<object> slots = new List<object>();
                for (int i = 0; i < found.Count; i++)
                {
                    SaveSlotInfo s = found[i];
                    Dictionary<string, object> m = new Dictionary<string, object>();
                    m["path"] = s.Path;
                    m["name"] = s.Name;
                    m["kind"] = s.Kind;
                    m["size"] = s.Size;
                    m["sha256"] = s.Sha256;
                    slots.Add(m);
                }
                return new Dictionary<string, object> { { "slots", slots } };
            }

            if (method == "loadSave")
            {
                string path = GetParam(p, "path");
                if (string.IsNullOrEmpty(path)) throw new ArgumentException("loadSave requires 'path'");
                SaveReadResult sr = SaveStore.ReadSave(path);
                Dictionary<string, object> r = new Dictionary<string, object>();
                r["path"] = sr.Path;
                r["kind"] = sr.Kind;
                r["sha256"] = sr.Sha256;
                r["data"] = Convert.ToBase64String(sr.Bytes);
                return r;
            }

            if (method == "saveFile")
            {
                string path = GetParam(p, "path");
                string expectedSha = GetParam(p, "expectedSha256");
                string suggested = GetParam(p, "suggestedName");
                string b64 = GetParam(p, "dataBase64");
                if (string.IsNullOrEmpty(b64)) throw new ArgumentException("saveFile requires 'dataBase64'");
                byte[] bytes = Convert.FromBase64String(b64);

                if (string.IsNullOrEmpty(path))
                {
                    using (SaveFileDialog dlg = new SaveFileDialog())
                    {
                        dlg.Title = "세이브 파일 저장";
                        dlg.Filter = "Save files (*.dat)|*.dat|All files (*.*)|*.*";
                        if (!string.IsNullOrEmpty(suggested)) dlg.FileName = suggested;
                        if (dlg.ShowDialog(this) != DialogResult.OK)
                            return new Dictionary<string, object> { { "canceled", true } };
                        path = dlg.FileName;
                    }
                    expectedSha = null;
                }

                SaveWriteResult wr = SaveStore.SaveWithBackup(path, bytes, expectedSha);
                Dictionary<string, object> r = new Dictionary<string, object>();
                r["canceled"] = false;
                r["path"] = wr.Path;
                r["backupPath"] = wr.BackupPath;
                r["sha256"] = wr.NewSha256;
                r["ok"] = wr.Success;
                return r;
            }

            if (method == "openFileDialog")
            {
                using (OpenFileDialog dlg = new OpenFileDialog())
                {
                    dlg.Title = "세이브 파일 열기";
                    dlg.Filter = "Save files (*.dat)|*.dat|All files (*.*)|*.*";
                    if (dlg.ShowDialog(this) == DialogResult.OK)
                    {
                        SaveReadResult sr = SaveStore.ReadSave(dlg.FileName);
                        Dictionary<string, object> r = new Dictionary<string, object>();
                        r["canceled"] = false;
                        r["path"] = sr.Path;
                        r["kind"] = sr.Kind;
                        r["sha256"] = sr.Sha256;
                        r["data"] = Convert.ToBase64String(sr.Bytes);
                        return r;
                    }
                }
                return new Dictionary<string, object> { { "canceled", true } };
            }

            if (method == "saveAsDialog")
            {
                string suggested = GetParam(p, "suggestedName");
                string b64 = GetParam(p, "dataBase64");
                if (string.IsNullOrEmpty(b64)) throw new ArgumentException("saveAsDialog requires 'dataBase64'");
                byte[] bytes = Convert.FromBase64String(b64);
                using (SaveFileDialog dlg = new SaveFileDialog())
                {
                    dlg.Title = "다른 이름으로 세이브 저장";
                    dlg.Filter = "Save files (*.dat)|*.dat|All files (*.*)|*.*";
                    if (!string.IsNullOrEmpty(suggested)) dlg.FileName = suggested;
                    if (dlg.ShowDialog(this) == DialogResult.OK)
                    {
                        SaveWriteResult wr = SaveStore.SaveWithBackup(dlg.FileName, bytes, null);
                        Dictionary<string, object> r = new Dictionary<string, object>();
                        r["canceled"] = false;
                        r["path"] = wr.Path;
                        r["sha256"] = wr.NewSha256;
                        r["backupPath"] = wr.BackupPath;
                        return r;
                    }
                }
                return new Dictionary<string, object> { { "canceled", true } };
            }

            throw new InvalidOperationException("Unknown method: " + method);
        }
    }

    public static class SelfTestRunner
    {
        public static bool Run(string outDir, string seedPath, string htmlDir)
        {
            if (string.IsNullOrEmpty(outDir))
                outDir = Path.Combine(Path.GetTempPath(), "lom-selftest-" + DateTime.UtcNow.Ticks);

            Directory.CreateDirectory(outDir);
            string outSub = Path.Combine(outDir, "selftest");
            Directory.CreateDirectory(outSub);

            bool ok = false;
            SelfTestForm form = null;
            Exception error = null;

            Thread t = new Thread(delegate()
            {
                try
                {
                    form = new SelfTestForm(outSub, seedPath, htmlDir);
                    form.ShowDialog(); // blocks until form closes itself
                    ok = form.Success;
                }
                catch (Exception ex) { error = ex; }
            });
            t.SetApartmentState(ApartmentState.STA);
            t.IsBackground = true;
            t.Start();

            bool timedOut = !t.Join(TimeSpan.FromSeconds(120));
            if (timedOut)
            {
                try { if (form != null && form.IsHandleCreated) form.BeginInvoke(new Action(delegate() { form.Close(); })); }
                catch { }
            }

            Dictionary<string, object> receipt = new Dictionary<string, object>();
            receipt["ok"] = ok && !timedOut;
            receipt["webview2Version"] = form != null ? (form.WebView2Version ?? "") : "";
            receipt["seedUsed"] = seedPath != null ? seedPath : "";
            receipt["backupExists"] = form != null ? form.BackupExists : false;
            receipt["validateSaveBytes"] = form != null ? form.ValidateSaveBytes : "";
            receipt["hanziCount"] = form != null ? form.HanziCount : -1;
            receipt["kanaCount"] = form != null ? form.KanaCount : -1;
            receipt["savedPath"] = form != null ? form.SavedPath : "";
            receipt["backupPath"] = form != null ? form.BackupPath : "";
            if (timedOut) receipt["error"] = "self-test timed out";
            else if (error != null) receipt["error"] = error.Message;

            JavaScriptSerializer json = new JavaScriptSerializer();
            json.MaxJsonLength = int.MaxValue;
            string receiptJson = json.Serialize(receipt);
            File.WriteAllText(Path.Combine(outDir, "receipt.json"), receiptJson, new UTF8Encoding(false));

            return ok && !timedOut;
        }
    }

    public sealed class SelfTestForm : Form
    {
        private readonly string _outSub;
        private readonly string _seed;
        private readonly string _htmlDir;
        private readonly JavaScriptSerializer _json = new JavaScriptSerializer();
        private WebView2 _webView;
        private string _initialSha;
        private string _targetPath;
        private TaskCompletionSource<bool> _navTcs;
        private TaskCompletionSource<bool> _testTcs;

        public bool Success { get; private set; }
        public string WebView2Version { get; private set; }
        public bool BackupExists { get; private set; }
        public string ValidateSaveBytes { get; private set; }
        public int HanziCount { get; private set; }
        public int KanaCount { get; private set; }
        public string SavedPath { get; private set; }
        public string BackupPath { get; private set; }

        public SelfTestForm(string outSub, string seedPath, string htmlDir)
        {
            _outSub = outSub;
            _seed = seedPath;
            _htmlDir = htmlDir;
            _json.MaxJsonLength = int.MaxValue;
            Success = false;
            HanziCount = -1;
            KanaCount = -1;
            WebView2Version = "";

            ShowInTaskbar = false;
            WindowState = FormWindowState.Minimized;
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            Location = new System.Drawing.Point(-32000, -32000);
            Size = new System.Drawing.Size(1280, 840);

            _webView = new WebView2();
            _webView.Dock = DockStyle.Fill;
            Controls.Add(_webView);

            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string baseDir = Path.Combine(localAppData, "LegendOfMortalSaveEditor");

            Shown += async delegate(object s, EventArgs e)
            {
                try { await RunAsync(baseDir); }
                catch (Exception ex)
                {
                    Success = false;
                    try { Console.Error.WriteLine("SelfTest error: " + ex.Message); } catch { }
                }
                finally { try { Close(); } catch { } }
            };
        }

        private async Task RunAsync(string baseDir)
        {
            _navTcs = new TaskCompletionSource<bool>();
            _webView.NavigationCompleted += delegate(object s, CoreWebView2NavigationCompletedEventArgs e)
            {
                if (e.IsSuccess) _navTcs.TrySetResult(true);
                else _navTcs.TrySetResult(false);
            };

            await SaveEditorForm.InitializeWebViewCoreAsync(_webView, baseDir, _htmlDir);
            WebView2Version = _webView.CoreWebView2.Environment.BrowserVersionString;

            _webView.Source = new Uri("https://lom-editor.local/LegendOfMortalSaveEditor-v1.0.html");
            bool navOk = await _navTcs.Task;
            if (!navOk) throw new InvalidOperationException("Navigation failed");
            await Task.Delay(400);

            // Also wait for the UI to signal ready (best-effort).
            for (int i = 0; i < 50; i++)
            {
                string r = await _webView.CoreWebView2.ExecuteScriptAsync(
                    "typeof window.LomUi !== 'undefined' && typeof window.LomEditorCore !== 'undefined' ? 'yes' : 'no'");
                if (r != null && r.IndexOf("yes", StringComparison.Ordinal) >= 0) break;
                await Task.Delay(100);
            }

            string fileName = string.IsNullOrEmpty(_seed) ? "Save_001.dat" : Path.GetFileName(_seed);
            _targetPath = Path.Combine(_outSub, fileName);

            if (!string.IsNullOrEmpty(_seed) && File.Exists(_seed))
            {
                SaveReadResult sr = SaveStore.ReadSave(_seed);
                File.WriteAllBytes(_targetPath, sr.Bytes);
                _initialSha = sr.Sha256;

                string b64 = Convert.ToBase64String(sr.Bytes);
                string script =
                    "(function(){var b=atob('" + b64 + "');var u=new Uint8Array(b.length);" +
                    "for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);" +
                    "window.LomUi.loadBytes(u, '" + fileName.Replace("'", "\\'") + "');})();";
                await _webView.CoreWebView2.ExecuteScriptAsync(script);
            }
            else
            {
                await _webView.CoreWebView2.ExecuteScriptAsync("window.LomUi.loadDemo('GameSave');");
                string b64 = await EvalBase64Async(
                    "window.LomEditorCore.exportSave(window.LomUi.getState().session)");
                byte[] bytes = Convert.FromBase64String(b64);
                File.WriteAllBytes(_targetPath, bytes);
                using (SHA256 sha = SHA256.Create())
                {
                    byte[] h = sha.ComputeHash(bytes);
                    StringBuilder sb = new StringBuilder(h.Length * 2);
                    for (int hi = 0; hi < h.Length; hi++) sb.Append(h[hi].ToString("x2"));
                    _initialSha = sb.ToString();
                }
            }

            // Verify no CJK Hanzi and no Kana in body text.
            string bodyText = await EvalStringAsync("document.body.innerText");
            int hanzi = CountInRanges(bodyText, new int[][] {
                new int[] { 0x4E00, 0x9FFF }, new int[] { 0x3400, 0x4DBF } });
            int kana = CountInRanges(bodyText, new int[][] { new int[] { 0x3040, 0x30FF } });
            HanziCount = hanzi;
            KanaCount = kana;

            // Apply preset.
            await _webView.CoreWebView2.ExecuteScriptAsync("window.LomUi.applyPresetId('rich_start');");

            // Validate.
            string validate = await EvalStringAsync(
                "window.LomEditorCore.validate(window.LomUi.getState().session).ok === true ? 'true' : 'false'");
            if (validate != "true") throw new InvalidOperationException("Validation failed after preset");

            // Export and save.
            string finalB64 = await EvalBase64Async(
                "window.LomEditorCore.exportSave(window.LomUi.getState().session)");
            byte[] finalBytes = Convert.FromBase64String(finalB64);
            SaveWriteResult wr = SaveStore.SaveWithBackup(_targetPath, finalBytes, _initialSha);

            BackupPath = wr.BackupPath;
            BackupExists = !string.IsNullOrEmpty(BackupPath) && File.Exists(BackupPath);
            SavedPath = _targetPath;
            byte[] onDisk = File.ReadAllBytes(_targetPath);
            ValidateSaveBytes = SaveStore.ValidateSaveBytes(onDisk);

            bool ok = BackupExists
                && (ValidateSaveBytes == "GameSave" || ValidateSaveBytes == "AutoGameSave")
                && HanziCount == 0
                && KanaCount == 0;

            Success = ok;
        }

        private async Task<string> EvalStringAsync(string script)
        {
            string raw = await _webView.CoreWebView2.ExecuteScriptAsync(script);
            if (raw == null) return null;
            return _json.Deserialize<string>(raw);
        }

        private async Task<string> EvalBase64Async(string expression)
        {
            // Ask JS to return base64 string via built-in btoa on Uint8Array
            string script =
                "(function(){var b=" + expression + ";var u=(b instanceof Uint8Array)?b:new Uint8Array(b);" +
                "var s='';for(var i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);return btoa(s);})()";
            string raw = await _webView.CoreWebView2.ExecuteScriptAsync(script);
            if (raw == null) throw new InvalidOperationException("exportSave returned null");
            return _json.Deserialize<string>(raw);
        }

        private static int CountInRanges(string text, int[][] ranges)
        {
            if (string.IsNullOrEmpty(text)) return 0;
            int count = 0;
            for (int i = 0; i < text.Length; i++)
            {
                char c = text[i];
                for (int r = 0; r < ranges.Length; r++)
                {
                    if (c >= ranges[r][0] && c <= ranges[r][1]) { count++; break; }
                }
            }
            return count;
        }
    }
}
