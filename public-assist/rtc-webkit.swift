import AppKit
import WebKit

final class Viewer: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    private let page: URL
    private let script: String
    private let world = WKContentWorld.defaultClient
    private var window: NSWindow!
    private var webView: WKWebView!
    private var loaded = false
    private var pending: [[String: Any]] = []

    init(page: URL, script: String) {
        self.page = page
        self.script = script
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let edit = NSMenuItem(title: "编辑", action: nil, keyEquivalent: "")
        edit.submenu = NSMenu(title: "编辑")
        edit.submenu?.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        menu.addItem(edit)
        NSApp.mainMenu = menu

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsAirPlayForMediaPlayback = false
        config.userContentController.add(self, contentWorld: world, name: "assistRtc")
        config.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentEnd,
                                                              forMainFrameOnly: true, in: world))

        let bounds = NSRect(x: 0, y: 0, width: 1024, height: 640)
        webView = WKWebView(frame: bounds, configuration: config)
        webView.navigationDelegate = self
        window = NSWindow(contentRect: bounds, styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "YCLJ 屏幕共享"
        window.delegate = self
        window.contentView = webView
        window.center()
        webView.loadFileURL(page, allowingReadAccessTo: page)

        Thread.detachNewThread {
            while let line = readLine() {
                guard let message = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else {
                    DispatchQueue.main.async { self.fail() }
                    return
                }
                DispatchQueue.main.async { self.receive(message) }
            }
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }

    private func receive(_ message: [String: Any]) {
        guard loaded else { pending.append(message); return }
        if message["op"] as? String == "screen_state" {
            if message["active"] as? Bool == true {
                if !window.isVisible && !window.isMiniaturized {
                    NSApp.setActivationPolicy(.regular)
                    window.orderFrontRegardless()
                }
            } else {
                if window.isMiniaturized { window.deminiaturize(nil) }
                window.orderOut(nil)
            }
        }
        let source = message["op"] as? String == "init" ? "ycljRtcStart(payload.options)" : "ycljRtcReceive(payload)"
        webView.callAsyncJavaScript(source, arguments: ["payload": message], in: nil, in: world) { result in
            if case .failure = result { self.fail() }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true
        pending.forEach(receive)
        pending.removeAll()
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let allowed = !loaded && action.targetFrame?.isMainFrame == true && action.request.url == page
        decisionHandler(allowed ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail() }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail() }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { fail() }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let line = message.body as? String,
              let event = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { return }
        guard event["event"] is String else { return }
        FileHandle.standardOutput.write(Data((line + "\n").utf8))
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.miniaturize(nil)
        return false
    }

    private func fail() {
        FileHandle.standardOutput.write(Data("{\"event\":\"fatal\"}\n".utf8))
        NSApp.terminate(nil)
    }
}

guard CommandLine.arguments.count == 3,
      let script = try? String(contentsOfFile: CommandLine.arguments[2], encoding: .utf8) else { exit(1) }
let viewer = Viewer(page: URL(fileURLWithPath: CommandLine.arguments[1]), script: script)
NSApplication.shared.setActivationPolicy(.accessory)
NSApplication.shared.delegate = viewer
NSApplication.shared.run()
