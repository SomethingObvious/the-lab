// The Lab's window on this computer. It shows the same app/ as the phone, in
// the WebView2 runtime Windows already has, and signs in with the token from
// the lab folder it sits in, so the token never goes on a command line.
// csc.exe from .NET Framework builds it, which only knows C# 5.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

// Without it .NET runs in its 4.0 mode, where Uri turns an escaped / in a
// path back into a real one.
[assembly: System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.6.2")]

static class Program
{
	[DllImport("user32.dll")]
	static extern bool SetProcessDpiAwarenessContext(IntPtr value);

	[STAThread]
	static void Main(string[] args)
	{
		// --check FILE opens the app off screen, writes a picture of it to FILE
		// and what it found to FILE.txt, then quits. Setup uses it to test a build.
		var check = args.Length == 2 && args[0] == "--check" ? args[1] : null;
		if (check != null)
		{
			SetProcessDpiAwarenessContext(new IntPtr(-4));
			Application.Run(new Shell(null, check));
			return;
		}
		bool first;
		using (var one = new Mutex(true, "TheLab.Desktop", out first))
		using (var show = new EventWaitHandle(false, EventResetMode.AutoReset, "TheLab.Desktop.Show"))
		{
			// A second launch brings the open window forward instead.
			if (!first)
			{
				show.Set();
				return;
			}
			SetProcessDpiAwarenessContext(new IntPtr(-4));
			Application.EnableVisualStyles();
			Application.Run(new Shell(show, null));
			if (!Shell.Again)
				return;
			// The new copy has to find the mutex free, or it would only signal this one.
			one.ReleaseMutex();
		}
		Process.Start(Application.ExecutablePath);
	}
}

class Shell : Form
{
	[DllImport("user32.dll")]
	static extern uint GetDpiForSystem();
	[DllImport("user32.dll")]
	static extern uint GetDpiForWindow(IntPtr hwnd);
	[DllImport("user32.dll")]
	static extern int GetSystemMetricsForDpi(int index, uint dpi);
	[DllImport("user32.dll")]
	static extern bool IsZoomed(IntPtr hwnd);
	[DllImport("user32.dll")]
	static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);

	[StructLayout(LayoutKind.Sequential)]
	struct RECT
	{
		public int Left, Top, Right, Bottom;
	}

	public static bool Again;
	static readonly HttpClient http = new HttpClient(new HttpClientHandler { UseProxy = false });
	static readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
	readonly WebView2 web = new WebView2();
	readonly string lab;
	readonly string place;
	readonly System.Windows.Forms.Timer retry = new System.Windows.Forms.Timer();
	// Only the script injected into this window knows it, so a message that
	// carries it came from <lab-ask> and not from the design.
	readonly string key = Key();
	string origin = "";
	string token = "";
	// The stand-in page showing while the app can't, or null.
	string page;

	readonly string check;
	readonly int strip;

	public Shell(EventWaitHandle show, string check)
	{
		this.check = check;
		lab = Path.GetDirectoryName(Path.GetDirectoryName(Application.ExecutablePath));
		place = Path.Combine(lab, "desktop", "window.txt");
		Text = "The Lab";
		Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
		// Sizes are in real pixels here, so they scale with the display. DeviceDpi
		// would say 96, as WinForms doesn't know the process is DPI aware.
		var k = GetDpiForSystem() / 96f;
		MinimumSize = new Size((int)(360 * k), (int)(480 * k));
		var work = Screen.PrimaryScreen.WorkingArea;
		Size = new Size(Math.Min((int)(1280 * k), work.Width), Math.Min((int)(820 * k), work.Height));
		// The page draws its own title bar, so the system's is taken away in
		// WndProc. This strip above the page is the top edge to resize from.
		strip = Math.Max(1, (int)Math.Round(4 * k));
		Padding = new Padding(0, strip, 0, 0);
		StartPosition = FormStartPosition.CenterScreen;
		BackColor = Dark() ? Color.FromArgb(0x10, 0x0c, 0x1e) : Color.FromArgb(0xf5, 0xf1, 0xff);
		web.DefaultBackgroundColor = BackColor;
		web.Dock = DockStyle.Fill;
		Controls.Add(web);
		Restore();
		retry.Interval = 3000;
		retry.Tick += (s, e) => Probe();
		Load += (s, e) => Start();
		if (check == null)
			FormClosing += (s, e) => Save();
		Resize += (s, e) =>
		{
			Slim();
			Tell();
		};
		Activated += (s, e) => Tell();
		Deactivate += (s, e) => Tell();
		if (check != null)
		{
			ShowInTaskbar = false;
			StartPosition = FormStartPosition.Manual;
			Bounds = new Rectangle(-30000, -30000, Size.Width, Size.Height);
			return;
		}
		var waiter = new Thread(() =>
		{
			while (show.WaitOne())
				BeginInvoke((Action)Front);
		});
		waiter.IsBackground = true;
		waiter.Start();
	}

	static bool Dark()
	{
		var v = Registry.GetValue(
			@"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
			"AppsUseLightTheme",
			1);
		return v is int && (int)v == 0;
	}

	async void Start()
	{
		try
		{
			// Drawing without the GPU measured 126 MB and 1.5 ms of CPU a second idle,
			// against 200 MB and 4.6 ms with it, and the page has little to animate.
			// Off screen counts as covered up, and Edge stops drawing a covered window.
			var env = await CoreWebView2Environment.CreateAsync(
				null,
				Path.Combine(lab, "desktop", "data"),
				new CoreWebView2EnvironmentOptions(
					check == null
						? "--disable-gpu"
						: "--disable-gpu --disable-features=CalculateNativeWinOcclusion"));
			await web.EnsureCoreWebView2Async(env);
		}
		catch (WebView2RuntimeNotFoundException)
		{
			MessageBox.Show(
				"The Lab needs the Microsoft Edge WebView2 Runtime, which is missing on this computer. The download page opens next.",
				"The Lab");
			Open("https://developer.microsoft.com/microsoft-edge/webview2/");
			Close();
			return;
		}
		var core = web.CoreWebView2;
		core.Settings.IsStatusBarEnabled = false;
		core.Settings.IsPasswordAutosaveEnabled = false;
		core.Settings.IsGeneralAutofillEnabled = false;
		// Parts of the page marked app-region: drag move the window, the way a
		// title bar does, with snapping and double-click to maximize.
		core.Settings.IsNonClientRegionSupportEnabled = true;
		await core.AddScriptToExecuteOnDocumentCreatedAsync(
			"globalThis.labShell = 'desktop'; globalThis.labOs = 'windows';");
		// Built into the exe, so the agent can't swap it, and kept off the
		// stand-in pages, which aren't on the computer's address.
		string ask;
		using (var r = new StreamReader(typeof(Shell).Assembly.GetManifestResourceStream("ask.js")))
			ask = r.ReadToEnd();
		await core.AddScriptToExecuteOnDocumentCreatedAsync(
			"if (location.hostname === '127.0.0.1') {\n" + ask.Replace("__LAB_ASK_KEY__", key) + "\n}");
		// Only the top document's messages arrive here, never a frame's.
		core.WebMessageReceived += (s, e) =>
		{
			if (Ours(e.Source))
			{
				string text = null;
				try
				{
					text = e.TryGetWebMessageAsString();
				}
				catch (ArgumentException)
				{
					// The title bar's messages are objects. Only <lab-ask> sends strings.
				}
				if (text != null)
					Ask(text);
				else
					Heard(e.WebMessageAsJson, true);
			}
			else if (page != null && !e.Source.StartsWith("http"))
				Heard(e.WebMessageAsJson, false);
		};
		core.NewWindowRequested += NewWindow;
		core.NavigationStarting += (s, e) =>
		{
			if (Ours(e.Uri) || e.Uri.StartsWith("data:") || e.Uri.StartsWith("about:"))
				return;
			e.Cancel = true;
			Open(e.Uri);
		};
		core.NavigationCompleted += (s, e) =>
		{
			// The server answers 404 for / when the design's index.html is gone,
			// which waiting won't fix.
			if (e.HttpStatusCode == 404 && core.Source == origin + "/")
				Missing(false);
			else if (!e.IsSuccess && e.WebErrorStatus != CoreWebView2WebErrorStatus.OperationCanceled)
				Down();
			else if (check != null && Ours(core.Source))
				Report();
			Tell();
		};
		core.ProcessFailed += (s, e) =>
		{
			if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited)
			{
				Again = true;
				Close();
				return;
			}
			if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited
				|| e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessUnresponsive)
				Go();
		};
		Go();
	}

	async void Report()
	{
		await System.Threading.Tasks.Task.Delay(4000);
		var core = web.CoreWebView2;
		var platform = await core.ExecuteScriptAsync("globalThis.lab && lab.platform");
		var asks = await core.ExecuteScriptAsync("customElements.get('lab-ask') ? 'yes' : 'no'");
		long bytes = Process.GetCurrentProcess().PrivateMemorySize64;
		var count = 1;
		foreach (var info in core.Environment.GetProcessInfos())
			try
			{
				bytes += Process.GetProcessById(info.ProcessId).PrivateMemorySize64;
				count++;
			}
			catch (ArgumentException)
			{
				// It exited between the list and the look.
			}
		using (var f = File.Create(check))
			await core.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, f);
		File.WriteAllText(
			check + ".txt",
			"platform " + platform + "\nask " + asks + "\nprocesses " + count + "\nprivate MB " + (bytes >> 20) + "\n");
		Close();
	}

	bool Ours(string uri)
	{
		return origin.Length > 0 && uri.StartsWith(origin + "/");
	}

	static string Key()
	{
		var b = new byte[16];
		using (var r = RandomNumberGenerator.Create())
			r.GetBytes(b);
		return BitConverter.ToString(b).Replace("-", "").ToLowerInvariant();
	}

	// Signs in with the same cookie pairing would set, so the token never
	// goes in a URL.
	async void Go()
	{
		var config = Path.Combine(lab, "config.json");
		var text = File.Exists(config) ? File.ReadAllText(config) : "";
		var t = Regex.Match(text, "\"token\"\\s*:\\s*\"([^\"]+)\"").Groups[1].Value;
		var port = Regex.Match(text, "\"port\"\\s*:\\s*(\\d+)").Groups[1].Value;
		if (t.Length == 0 || port.Length == 0)
		{
			Down();
			return;
		}
		origin = "http://127.0.0.1:" + port;
		token = t;
		page = null;
		retry.Stop();
		var cookies = web.CoreWebView2.CookieManager;
		var c = cookies.CreateCookie("lab", Uri.EscapeDataString(token), "127.0.0.1", "/");
		c.IsHttpOnly = true;
		c.SameSite = CoreWebView2CookieSameSiteKind.Strict;
		c.Expires = DateTime.Now.AddYears(1);
		cookies.AddOrUpdateCookie(c);
		// Adding returns before the cookie is in, and reading it back waits for that.
		await cookies.GetCookiesAsync(origin + "/");
		web.CoreWebView2.Navigate(origin + "/");
	}

	// The server restarts after an update and isn't running before sign-in
	// finishes, so the window waits for it rather than showing an error page.
	void Down()
	{
		Show("down", "<p>The Lab isn't answering on this computer yet.<br>This window connects by itself once it's back.</p>");
	}

	void Missing(bool tried)
	{
		Show(
			tried ? "missing again" : "missing",
			"<p>The app's design is missing on this computer, so there's nothing to show.</p>"
			+ (tried
				? "<p>There's no earlier design to go back to. Open the safe screen on the phone and ask the agent to put the app back.</p>"
				: "<p>Undo the last design change to put the one before it back, or tap Undo Last Design Change on the phone's safe screen.</p>"
					+ "<p><button class=pill data-undo>Undo Last Design Change</button></p>")
			+ "<p>This window opens the app by itself once it's back.</p>");
	}

	// A stand-in page with the same window buttons as the app, since the
	// window has no system title bar to move or close it by.
	void Show(string which, string body)
	{
		if (page == which || web.CoreWebView2 == null)
			return;
		page = which;
		var bg = "#" + BackColor.ToArgb().ToString("x8").Substring(2);
		Func<string, string, string, string> button = (w, label, path) =>
			"<button data-window=" + w + " aria-label=" + label + " title=" + label + (w == "close" ? " class=x" : "")
			+ "><svg viewBox=\"0 0 24 24\" aria-hidden=true>" + path + "</svg></button>";
		web.CoreWebView2.NavigateToString(
			"<!doctype html><meta charset=utf-8><style>"
			+ "body{margin:0;height:100vh;display:grid;grid-template-rows:32px 1fr;font:16px system-ui;color:#888;background:" + bg + "}"
			+ ".bar{app-region:drag;display:flex;justify-content:flex-end}"
			+ ".bar button{app-region:no-drag;width:46px;border:0;background:none;color:inherit;display:grid;place-items:center}"
			+ ".bar button:hover{background:#8883}.bar .x:hover{background:#c42b1c;color:#fff}"
			+ "svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.4}"
			+ "main{display:grid;place-items:center;text-align:center;padding:0 24px 32px}main div{max-width:34em}"
			+ ".pill{font:inherit;font-weight:600;color:inherit;background:#8882;border:1px solid #8886;border-radius:20px;padding:10px 18px}"
			+ ".pill:hover{background:#8884}</style>"
			+ "<div class=bar>"
			+ button("minimize", "Minimize", "<path d=\"M6.5 12h11\"/>")
			+ button("maximize", "Maximize", "<rect x=\"6.5\" y=\"6.5\" width=\"11\" height=\"11\" rx=\"1.5\"/>")
			+ button("close", "Close", "<path d=\"m7 7 10 10M17 7 7 17\"/>")
			+ "</div><main><div>" + body + "</div></main><script>"
			+ "document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;"
			+ "if(b.dataset.window)chrome.webview.postMessage({window:b.dataset.window});"
			+ "else{b.disabled=true;chrome.webview.postMessage({undo:true})}})</script>");
		retry.Start();
	}

	// Asks for / itself, so a window showing the missing design opens the app
	// once it's back, and one showing the server down learns which it is.
	async void Probe()
	{
		if (page == null)
		{
			retry.Stop();
			return;
		}
		if (origin.Length == 0)
		{
			Go();
			return;
		}
		var got = await Computer(HttpMethod.Get, "/", null, 2000);
		if (page == null)
			return;
		if (got.Item1 == 200)
			Go();
		else if (got.Item1 == 404)
			Missing(page == "missing again");
		else
			Down();
	}

	async void Undo()
	{
		var got = await Computer(HttpMethod.Post, "/design/undo", "{}", 15000);
		if (got.Item1 == 200)
			Go();
		else
			Missing(true);
	}

	// A request to the computer with the token, which the page never sees.
	// The status is 0 when it didn't answer.
	async Task<Tuple<int, string>> Computer(HttpMethod method, string path, string body, int ms)
	{
		try
		{
			using (var stop = new CancellationTokenSource(ms))
			using (var req = new HttpRequestMessage(method, origin + path))
			{
				req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
				if (body != null)
					req.Content = new StringContent(body, Encoding.UTF8, "application/json");
				using (var res = await http.SendAsync(req, stop.Token))
					return Tuple.Create((int)res.StatusCode, await res.Content.ReadAsStringAsync());
			}
		}
		catch (HttpRequestException)
		{
			// Not running, or it closed the connection.
		}
		catch (TaskCanceledException)
		{
			// It took too long.
		}
		return Tuple.Create(0, "");
	}

	static object Parse(string text)
	{
		try
		{
			return json.DeserializeObject(text);
		}
		catch (ArgumentException)
		{
			return null;
		}
		catch (InvalidOperationException)
		{
			return null;
		}
	}

	// <lab-ask> asking for a question or passing on his answer. Anything
	// without this window's key is dropped without a word.
	async void Ask(string text)
	{
		var m = Parse(text) as Dictionary<string, object>;
		object k, op, nonce, r, allow, always;
		if (m == null || !m.TryGetValue("key", out k) || !(k is string) || (string)k != key
			|| !m.TryGetValue("op", out op) || !m.TryGetValue("nonce", out nonce) || !(nonce is string)
			|| !m.TryGetValue("ref", out r) || !(r is string) || ((string)r).Length == 0)
			return;
		var reply = new Dictionary<string, object> { { "op", op }, { "nonce", nonce } };
		if ((op as string) == "askInfo")
		{
			var got = await Computer(HttpMethod.Get, "/asks/" + Uri.EscapeDataString((string)r), null, 15000);
			reply["status"] = got.Item1;
			reply["ask"] = got.Item1 == 200 ? Parse(got.Item2) : null;
		}
		else if ((op as string) == "askAnswer" && m.TryGetValue("allow", out allow) && allow is bool
			&& m.TryGetValue("always", out always) && always is bool)
		{
			var body = json.Serialize(new Dictionary<string, object> { { "ref", r }, { "allow", allow }, { "always", always } });
			reply["status"] = (await Computer(HttpMethod.Post, "/answer", body, 15000)).Item1;
		}
		else
			return;
		try
		{
			web.CoreWebView2.PostWebMessageAsString(json.Serialize(reply));
		}
		catch (InvalidOperationException)
		{
			// The window closed while the computer was answering.
		}
	}

	// Its own pages (a photo, the pairing code) open in a plain window that
	// shares the sign-in, only when he clicked something. Anything else goes
	// to the browser. These windows get neither <lab-ask> nor the messages.
	void NewWindow(object sender, CoreWebView2NewWindowRequestedEventArgs e)
	{
		e.Handled = true;
		if (!e.IsUserInitiated)
			return;
		if (Ours(e.Uri))
			Popup(e);
		else
			Open(e.Uri);
	}

	async void Popup(CoreWebView2NewWindowRequestedEventArgs e)
	{
		var later = e.GetDeferral();
		try
		{
			var k = GetDpiForSystem() / 96f;
			var form = new Form
			{
				Text = "The Lab",
				Icon = Icon,
				BackColor = BackColor,
				Size = new Size((int)(640 * k), (int)(720 * k)),
				StartPosition = FormStartPosition.CenterParent,
			};
			var view = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = BackColor };
			form.Controls.Add(view);
			form.Show(this);
			await view.EnsureCoreWebView2Async(web.CoreWebView2.Environment);
			var core = view.CoreWebView2;
			core.Settings.IsStatusBarEnabled = false;
			core.Settings.IsPasswordAutosaveEnabled = false;
			core.Settings.IsGeneralAutofillEnabled = false;
			core.NewWindowRequested += NewWindow;
			core.NavigationStarting += (s, n) =>
			{
				if (Ours(n.Uri) || n.Uri.StartsWith("about:"))
					return;
				n.Cancel = true;
				if (n.IsUserInitiated)
					Open(n.Uri);
			};
			core.DocumentTitleChanged += (s, n) => form.Text = core.DocumentTitle.Length > 0 ? core.DocumentTitle : "The Lab";
			core.WindowCloseRequested += (s, n) => form.Close();
			e.NewWindow = core;
		}
		finally
		{
			later.Complete();
		}
	}

	// What the page's title bar asks for. The page is only ever The Lab's own,
	// but the agent can change it, so a reveal only shows a file it sent or
	// got, and never opens or runs anything. A stand-in page only has the
	// window buttons and Undo.
	void Heard(string json, bool app)
	{
		var w = Regex.Match(json, @"""window""\s*:\s*""(\w+)""").Groups[1].Value;
		if (w == "minimize")
			WindowState = FormWindowState.Minimized;
		else if (w == "maximize")
			WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
		else if (w == "close")
			Close();
		if (!app)
		{
			if (Regex.IsMatch(json, @"""undo""\s*:\s*true") && page != null && page.StartsWith("missing"))
				Undo();
			return;
		}
		var bar = Regex.Match(json, @"""bar""\s*:\s*""(#[0-9a-fA-F]{6})""").Groups[1].Value;
		if (bar.Length > 0)
			BackColor = ColorTranslator.FromHtml(bar);
		var reveal = Regex.Match(json, @"""reveal""\s*:\s*""/files/([^""/\\]+)""").Groups[1].Value;
		if (reveal.Length > 0)
		{
			var name = Uri.UnescapeDataString(reveal);
			var file = Path.Combine(lab, "files", name);
			if (name.IndexOfAny(new[] { '/', '\\', ':', '"' }) < 0 && !name.StartsWith(".") && File.Exists(file))
				Process.Start("explorer.exe", "/select,\"" + file + "\"");
		}
	}

	// Tells the page whether the window is maximized and in front, so its
	// buttons and title bar can match.
	void Tell()
	{
		if (web.CoreWebView2 == null)
			return;
		web.CoreWebView2.PostWebMessageAsJson(
			"{\"kind\":\"window\",\"maximized\":" + (WindowState == FormWindowState.Maximized ? "true" : "false")
			+ ",\"active\":" + (ActiveForm == this ? "true" : "false") + "}");
		var top = WindowState == FormWindowState.Normal ? strip : 0;
		if (Padding.Top != top)
			Padding = new Padding(0, top, 0, 0);
	}

	protected override void OnHandleCreated(EventArgs e)
	{
		base.OnHandleCreated(e);
		// SWP_FRAMECHANGED, so WM_NCCALCSIZE runs again with the frame taken away.
		SetWindowPos(Handle, IntPtr.Zero, 0, 0, 0, 0, 0x0020 | 0x0002 | 0x0001 | 0x0004);
	}

	protected override void WndProc(ref Message m)
	{
		const int WM_NCCALCSIZE = 0x0083, WM_NCHITTEST = 0x0084;
		if (m.Msg == WM_NCCALCSIZE && m.WParam != IntPtr.Zero)
		{
			// Windows keeps the side and bottom edges, which are invisible and
			// resize the window, and the top goes back to where the frame began.
			var r = (RECT)Marshal.PtrToStructure(m.LParam, typeof(RECT));
			var top = r.Top;
			base.WndProc(ref m);
			r = (RECT)Marshal.PtrToStructure(m.LParam, typeof(RECT));
			// A maximized window hangs over the screen's edges by its frame.
			var dpi = GetDpiForWindow(Handle);
			r.Top = top + (IsZoomed(Handle) ? GetSystemMetricsForDpi(33, dpi) + GetSystemMetricsForDpi(92, dpi) : 0);
			Marshal.StructureToPtr(r, m.LParam, false);
			m.Result = IntPtr.Zero;
			return;
		}
		base.WndProc(ref m);
		if (m.Msg == WM_NCHITTEST && m.Result == (IntPtr)1 && !IsZoomed(Handle))
		{
			var at = PointToClient(new Point(unchecked((short)(long)m.LParam), unchecked((short)((long)m.LParam >> 16))));
			if (at.Y < strip)
				m.Result = (IntPtr)(at.X < strip * 4 ? 13 : at.X >= ClientSize.Width - strip * 4 ? 14 : 12);
		}
	}

	// A minimized window gives memory back. The page keeps its connection.
	void Slim()
	{
		if (web.CoreWebView2 == null)
			return;
		web.CoreWebView2.MemoryUsageTargetLevel = WindowState == FormWindowState.Minimized
			? CoreWebView2MemoryUsageTargetLevel.Low
			: CoreWebView2MemoryUsageTargetLevel.Normal;
	}

	void Front()
	{
		if (WindowState == FormWindowState.Minimized)
			WindowState = FormWindowState.Normal;
		Activate();
	}

	static void Open(string uri)
	{
		if (!(uri.StartsWith("https://") || uri.StartsWith("http://") || uri.StartsWith("mailto:")))
			return;
		try
		{
			Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true });
		}
		catch (System.ComponentModel.Win32Exception)
		{
			// No browser is set up to open it.
		}
	}

	void Restore()
	{
		if (!File.Exists(place))
			return;
		var p = File.ReadAllText(place).Split(' ');
		int x, y, w, h;
		if (p.Length < 5 || !int.TryParse(p[0], out x) || !int.TryParse(p[1], out y)
			|| !int.TryParse(p[2], out w) || !int.TryParse(p[3], out h))
			return;
		var r = new Rectangle(x, y, w, h);
		// A monitor that has been unplugged would leave it off screen.
		foreach (var s in Screen.AllScreens)
			if (s.WorkingArea.IntersectsWith(r))
			{
				StartPosition = FormStartPosition.Manual;
				Bounds = r;
				if (p[4] == "max")
					WindowState = FormWindowState.Maximized;
				return;
			}
	}

	void Save()
	{
		var r = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
		try
		{
			File.WriteAllText(
				place,
				r.X + " " + r.Y + " " + r.Width + " " + r.Height + " "
				+ (WindowState == FormWindowState.Maximized ? "max" : "normal"));
		}
		catch (IOException)
		{
			// It opens in the middle next time instead.
		}
	}
}
