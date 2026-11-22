using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

sealed class Viewer : Form
{
    private const string HostName = "yclj-viewer.invalid";
    private const string PageUrl = "https://yclj-viewer.invalid/rtc.html";
    private readonly string[] args;
    private readonly WebView2 view = new WebView2 { Dock = DockStyle.Fill };
    private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
    private readonly TaskCompletionSource<bool> pageLoaded = new TaskCompletionSource<bool>();
    private bool exiting;

    [STAThread]
    static void Main(string[] args)
    {
        if (args.Length != 3) return;
        Console.InputEncoding = Console.OutputEncoding = new UTF8Encoding(false);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using (var viewer = new Viewer(args)) Application.Run(viewer);
    }

    private Viewer(string[] args)
    {
        this.args = args;
        Text = "YCLJ \u5c4f\u5e55\u5171\u4eab";
        ClientSize = new Size(1024, 640);
        MinimumSize = new Size(480, 320);
        StartPosition = FormStartPosition.CenterScreen;
        ShowInTaskbar = false;
        Opacity = 0;
        Controls.Add(view);
    }

    protected override bool ShowWithoutActivation { get { return true; } }

    protected override async void OnShown(EventArgs e)
    {
        base.OnShown(e);
        try
        {
            await InitializePage();
            Hide();
            ShowInTaskbar = true;
            Opacity = 1;
            await ReadCommands();
        }
        catch (WebView2RuntimeNotFoundException)
        {
            ReportError("Microsoft Edge WebView2 Runtime is required. https://developer.microsoft.com/microsoft-edge/webview2/");
        }
        catch (Exception)
        {
            ReportError("Windows viewer could not start or communicate with WebView2.");
        }
        finally
        {
            ExitViewer();
        }
    }

    private async Task InitializePage()
    {
        var document = Path.Combine(args[2], "document");
        Directory.CreateDirectory(document);
        File.Copy(args[0], Path.Combine(document, "rtc.html"));
        var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(args[2], "webview2"));
        await view.EnsureCoreWebView2Async(environment);
        var core = view.CoreWebView2;
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.AreBrowserAcceleratorKeysEnabled = false;
        core.SetVirtualHostNameToFolderMapping(HostName, document, CoreWebView2HostResourceAccessKind.Deny);
        core.NavigationStarting += (sender, e) => e.Cancel = e.Uri != PageUrl || pageLoaded.Task.IsCompleted;
        core.NewWindowRequested += (sender, e) => e.Handled = true;
        core.NavigationCompleted += (sender, e) => pageLoaded.TrySetResult(e.IsSuccess);
        core.ProcessFailed += (sender, e) => { ReportError("WebView2 process exited."); ExitViewer(); };
        core.WebMessageReceived += (sender, e) =>
        {
            if (e.Source == PageUrl) Console.WriteLine(e.TryGetWebMessageAsString());
        };
        await core.AddScriptToExecuteOnDocumentCreatedAsync(File.ReadAllText(args[1]));
        core.Navigate(PageUrl);
        if (!await pageLoaded.Task) throw new IOException("Could not load viewer.");
    }

    private async Task ReadCommands()
    {
        while (!exiting)
        {
            var line = await Task.Run(() => Console.ReadLine());
            if (line == null || exiting) return;
            var command = json.Deserialize<Dictionary<string, object>>(line);
            var operation = (string)command["op"];
            var encoded = Convert.ToBase64String(Encoding.UTF8.GetBytes(line));
            var script = "(() => { const packet = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('" + encoded +
                "'), c => c.charCodeAt(0)))); try { if (packet.op === 'init') ycljRtcStart(packet.options); " +
                "else ycljRtcReceive(packet); return true; } catch { return false; } })()";
            if (await view.ExecuteScriptAsync(script) != "true") throw new IOException("Viewer command failed.");
            if (operation == "screen_state")
            {
                if ((bool)command["active"])
                {
                    if (!Visible) Show();
                }
                else Hide();
            }
        }
    }

    private void ReportError(string message)
    {
        if (!exiting) Console.WriteLine(json.Serialize(new { @event = "fatal", data = message }));
    }

    private void ExitViewer()
    {
        if (exiting) return;
        exiting = true;
        Close();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (!exiting && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            WindowState = FormWindowState.Minimized;
        }
        base.OnFormClosing(e);
    }
}
