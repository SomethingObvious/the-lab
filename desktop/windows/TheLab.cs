// The Lab's window on this computer. It shows the same app/ as the phone, in
// the WebView2 runtime Windows already has, and signs in with the token from
// the lab folder it sits in, so the token never goes on a command line.
// csc.exe from .NET Framework builds it, which only knows C# 5.

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

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
	readonly WebView2 web = new WebView2();
	readonly string lab;
	readonly string place;
	readonly System.Windows.Forms.Timer retry = new System.Windows.Forms.Timer();
	string origin = "";
	bool offline;

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
		core.WebMessageReceived += (s, e) =>
		{
			if (Ours(e.Source))
				Heard(e.WebMessageAsJson);
		};
		// Its own pages (a photo, the pairing code) open in a WebView2 window
		// that shares the sign-in. Anything else goes to the browser.
		core.NewWindowRequested += (s, e) =>
		{
			if (Ours(e.Uri))
				return;
			e.Handled = true;
			Open(e.Uri);
		};
		core.NavigationStarting += (s, e) =>
		{
			if (Ours(e.Uri) || e.Uri.StartsWith("data:") || e.Uri.StartsWith("about:"))
				return;
			e.Cancel = true;
			Open(e.Uri);
		};
		core.NavigationCompleted += (s, e) =>
		{
			if (!e.IsSuccess && e.WebErrorStatus != CoreWebView2WebErrorStatus.OperationCanceled)
				Down();
			else if (check != null && Ours(core.Source) && !core.Source.Contains("/pair"))
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
			"platform " + platform + "\nprocesses " + count + "\nprivate MB " + (bytes >> 20) + "\n");
		Close();
	}

	bool Ours(string uri)
	{
		return origin.Length > 0 && uri.StartsWith(origin + "/");
	}

	void Go()
	{
		var config = Path.Combine(lab, "config.json");
		var text = File.Exists(config) ? File.ReadAllText(config) : "";
		var token = Regex.Match(text, "\"token\"\\s*:\\s*\"([^\"]+)\"").Groups[1].Value;
		var port = Regex.Match(text, "\"port\"\\s*:\\s*(\\d+)").Groups[1].Value;
		if (token.Length == 0 || port.Length == 0)
		{
			Down();
			return;
		}
		origin = "http://127.0.0.1:" + port;
		offline = false;
		retry.Stop();
		web.CoreWebView2.Navigate(origin + "/pair?t=" + Uri.EscapeDataString(token));
	}

	// The server restarts after an update and isn't running before sign-in
	// finishes, so the window waits for it rather than showing an error page.
	void Down()
	{
		if (offline)
			return;
		offline = true;
		web.CoreWebView2.NavigateToString(
			"<!doctype html><meta charset=utf-8><body style=\"font:16px system-ui;color:#888;"
			+ "background:#" + BackColor.ToArgb().ToString("x8").Substring(2)
			+ ";display:grid;place-items:center;height:90vh;margin:0;text-align:center\">"
			+ "<p>The Lab isn't answering on this computer yet.<br>"
			+ "This window connects by itself once it's back.</p>");
		retry.Start();
	}

	void Probe()
	{
		var req = (HttpWebRequest)WebRequest.Create((origin.Length > 0 ? origin : "http://127.0.0.1:8417") + "/health");
		req.Timeout = 2000;
		req.Proxy = null;
		ThreadPool.QueueUserWorkItem(_ =>
		{
			try
			{
				using (req.GetResponse())
					BeginInvoke((Action)Go);
			}
			catch (WebException)
			{
				// Still down. The next tick asks again.
			}
			catch (InvalidOperationException)
			{
				// The window closed while it was asking.
			}
		});
	}

	// What the page's title bar asks for. The page is only ever The Lab's own,
	// but the agent can change it, so a reveal only shows a file it sent or
	// got, and never opens or runs anything.
	void Heard(string json)
	{
		var w = Regex.Match(json, @"""window""\s*:\s*""(\w+)""").Groups[1].Value;
		if (w == "minimize")
			WindowState = FormWindowState.Minimized;
		else if (w == "maximize")
			WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
		else if (w == "close")
			Close();
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
