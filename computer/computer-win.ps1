# Works another app's window through UI Automation, for computer.ts. It reads
# one JSON request on stdin and writes one JSON reply on stdout.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

$Auto = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$Invoke = [System.Windows.Automation.InvokePattern]
$Value = [System.Windows.Automation.ValuePattern]
$Toggle = [System.Windows.Automation.TogglePattern]
$Pick = [System.Windows.Automation.SelectionItemPattern]
$Expand = [System.Windows.Automation.ExpandCollapsePattern]

function Native {
	if ('LabWin' -as [type]) { return }
	Add-Type -AssemblyName System.Windows.Forms, System.Drawing
	Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class LabWin {
	[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
	[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
	[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
	[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
	[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, IntPtr e);
	[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
	[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
	public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
}

function Forward($hwnd) {
	Native
	$h = [IntPtr]$hwnd
	if ([LabWin]::IsIconic($h)) { [void][LabWin]::ShowWindow($h, 9) }
	[void][LabWin]::SetForegroundWindow($h)
	Start-Sleep -Milliseconds 120
}

function Apps {
	$found = @()
	$all = $Auto::RootElement.FindAll($Scope::Children, [System.Windows.Automation.Condition]::TrueCondition)
	foreach ($w in $all) {
		$title = $w.Current.Name
		if (-not $title) { continue }
		$id = $w.Current.ProcessId
		$name = (Get-Process -Id $id -ErrorAction SilentlyContinue).ProcessName
		$found += @{ app = "$name"; pid = $id; title = $title; window = "$($w.Current.NativeWindowHandle)" }
	}
	, $found
}

function Rooted($hwnd) { $Auto::FromHandle([IntPtr][int64]$hwnd) }

function Look($hwnd, $limit) {
	$root = Rooted $hwnd
	$c = New-Object System.Windows.Automation.CacheRequest
	foreach ($p in @(
			$Auto::NameProperty, $Auto::ControlTypeProperty, $Auto::IsEnabledProperty, $Auto::IsPasswordProperty,
			$Auto::RuntimeIdProperty, $Auto::ClassNameProperty, $Auto::IsInvokePatternAvailableProperty, $Auto::IsValuePatternAvailableProperty,
			$Auto::IsTogglePatternAvailableProperty, $Auto::IsSelectionItemPatternAvailableProperty,
			$Auto::IsExpandCollapsePatternAvailableProperty, $Value::ValueProperty, $Toggle::ToggleStateProperty)) {
		$c.Add($p)
	}
	$c.TreeScope = $Scope::Element
	$c.Push()
	try {
		$all = $root.FindAll($Scope::Descendants, [System.Windows.Automation.Automation]::ControlViewCondition)
	}
	finally { $c.Pop() }
	$out = New-Object System.Collections.ArrayList
	foreach ($e in $all) {
		if ($out.Count -ge $limit) { break }
		$can = @()
		if ($e.GetCachedPropertyValue($Auto::IsInvokePatternAvailableProperty)) { $can += 'press' }
		if ($e.GetCachedPropertyValue($Auto::IsTogglePatternAvailableProperty)) { $can += 'toggle' }
		if ($e.GetCachedPropertyValue($Auto::IsSelectionItemPatternAvailableProperty)) { $can += 'select' }
		if ($e.GetCachedPropertyValue($Auto::IsExpandCollapsePatternAvailableProperty)) { $can += 'expand' }
		$settable = $e.GetCachedPropertyValue($Auto::IsValuePatternAvailableProperty)
		if ($settable) { $can += 'set' }
		$name = [string]$e.GetCachedPropertyValue($Auto::NameProperty)
		$secret = [bool]$e.GetCachedPropertyValue($Auto::IsPasswordProperty)
		# A classic edit box with no accessibility of its own gives its text as its
		# name, which could be a password, so it stays nameless.
		if ([string]$e.GetCachedPropertyValue($Auto::ClassNameProperty) -match 'edit') {
			if ($e.GetCachedPropertyValue($Auto::ControlTypeProperty).ProgrammaticName -eq 'ControlType.Pane') { $name = '' }
		}
		$text = ''
		if ($settable -and -not $secret) { $text = [string]$e.GetCachedPropertyValue($Value::ValueProperty) }
		if (-not $name -and -not $text -and $can.Count -eq 0) { continue }
		$type = $e.GetCachedPropertyValue($Auto::ControlTypeProperty)
		$role = ($type.ProgrammaticName -replace '^ControlType\.', '').ToLower()
		$row = @{ id = (@($e.GetRuntimeId()) -join '.'); role = $role; name = $name; can = $can }
		if ($text) { $row.value = $text }
		if ($secret) { $row.secret = $true }
		if (-not $e.GetCachedPropertyValue($Auto::IsEnabledProperty)) { $row.off = $true }
		if ($can -contains 'toggle') { $row.on = "$($e.GetCachedPropertyValue($Toggle::ToggleStateProperty))" -eq 'On' }
		[void]$out.Add($row)
	}
	, @($out)
}

function Found($hwnd, $id) {
	$runtime = [int[]]($id -split '\.')
	$is = New-Object System.Windows.Automation.PropertyCondition($Auto::RuntimeIdProperty, $runtime)
	$e = (Rooted $hwnd).FindFirst($Scope::Subtree, $is)
	if (-not $e) { throw "Element $id isn't in the window any more. Look again." }
	$e
}

function Pattern($e, $p) {
	$got = $null
	if ($e.TryGetCurrentPattern($p::Pattern, [ref]$got)) { return $got }
	$null
}

function Press($e) {
	$p = Pattern $e $Invoke
	if ($p) { $p.Invoke(); return }
	$p = Pattern $e $Toggle
	if ($p) { $p.Toggle(); return }
	$p = Pattern $e $Pick
	if ($p) { $p.Select(); return }
	$p = Pattern $e $Expand
	if ($p) {
		if ($p.Current.ExpandCollapseState -eq 'Collapsed') { $p.Expand() } else { $p.Collapse() }
		return
	}
	throw "That can't be pressed without the mouse. Use click."
}

function NotAPassword {
	if ($Auto::FocusedElement.Current.IsPassword) { throw "The focus is on a password field, so nothing was typed. He types those himself." }
}

$Named = @{
	enter = 'ENTER'; return = 'ENTER'; tab = 'TAB'; esc = 'ESC'; escape = 'ESC'; backspace = 'BS'; delete = 'DEL'
	up = 'UP'; down = 'DOWN'; left = 'LEFT'; right = 'RIGHT'; home = 'HOME'; end = 'END'; pageup = 'PGUP'; pagedown = 'PGDN'; space = ' '
}

function Escaped($text) { [regex]::Replace($text, '[+^%~(){}\[\]]', '{$0}') -replace "`r?`n", '{ENTER}' }

function Combo($keys) {
	$mods = ''
	$parts = $keys.ToLower() -split '\+'
	$last = $parts[-1]
	foreach ($m in $parts[0..($parts.Count - 2)]) {
		if ($parts.Count -eq 1) { break }
		switch ($m) {
			{ $_ -in 'ctrl', 'cmd', 'control', 'command' } { $mods += '^'; break }
			'shift' { $mods += '+'; break }
			{ $_ -in 'alt', 'option' } { $mods += '%'; break }
			default { throw "$m isn't a key this knows." }
		}
	}
	$key = if ($Named.ContainsKey($last)) { if ($last -eq 'space') { ' ' } else { '{' + $Named[$last] + '}' } }
	elseif ($last -match '^f\d+$') { '{' + $last.ToUpper() + '}' }
	else { Escaped $last }
	$mods + $key
}

function Shot($hwnd, $file) {
	Native
	$h = [IntPtr][int64]$hwnd
	$r = New-Object LabWin+RECT
	[void][LabWin]::GetWindowRect($h, [ref]$r)
	$bmp = New-Object System.Drawing.Bitmap ($r.Right - $r.Left), ($r.Bottom - $r.Top)
	$g = [System.Drawing.Graphics]::FromImage($bmp)
	$dc = $g.GetHdc()
	# 2 asks for the window's own rendering, so what's in front of it doesn't show.
	$ok = [LabWin]::PrintWindow($h, $dc, 2)
	$g.ReleaseHdc($dc)
	$g.Dispose()
	if (-not $ok) { $bmp.Dispose(); throw "Windows wouldn't draw that window to a picture." }
	$bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
	$bmp.Dispose()
}

function Step($hwnd, $s) {
	switch ($s.do) {
		'press' { Press (Found $hwnd $s.id) }
		'set' {
			$e = Found $hwnd $s.id
			if ($e.Current.IsPassword) { throw "That's a password field, so nothing was typed. He types those himself." }
			$p = Pattern $e $Value
			if (-not $p) { throw "That can't be filled in directly. Use focus and type." }
			$p.SetValue([string]$s.text)
		}
		'focus' { (Found $hwnd $s.id).SetFocus() }
		'click' {
			$e = Found $hwnd $s.id
			$b = $e.Current.BoundingRectangle
			Forward $hwnd
			[void][LabWin]::SetCursorPos([int]($b.X + $b.Width / 2), [int]($b.Y + $b.Height / 2))
			[LabWin]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero)
			[LabWin]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero)
		}
		'type' {
			Forward $hwnd
			NotAPassword
			[System.Windows.Forms.SendKeys]::SendWait((Escaped ([string]$s.text)))
		}
		'keys' {
			Forward $hwnd
			[System.Windows.Forms.SendKeys]::SendWait((Combo ([string]$s.keys)))
		}
		'shot' { Shot $hwnd ([string]$s.file) }
		default { throw "$($s.do) isn't something this can do." }
	}
}

try {
	$q = [Console]::In.ReadToEnd() | ConvertFrom-Json
	$reply = @{ ok = $true }
	if ($q.op -eq 'apps') { $reply.apps = Apps }
	else {
		foreach ($s in @($q.steps)) {
			if ($s.do -eq 'look') { continue }
			Step $q.window $s
		}
		if (@($q.steps | Where-Object { $_.do -eq 'look' }).Count -gt 0) {
			Start-Sleep -Milliseconds 150
			$reply.elements = Look $q.window ([int]$q.limit)
		}
	}
	$reply | ConvertTo-Json -Compress -Depth 6
}
catch {
	@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
