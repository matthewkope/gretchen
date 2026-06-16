// Gretchen.app — a thin native shell around the web app. It spawns the
// bundled node server (same server.js/lib/public as the repo, copied into
// Resources/app at build time) and shows it in a WKWebView window. All data
// still lives in ~/.gretchen, shared with the CLI and the browser version.
import Cocoa
import WebKit

let PORT = ProcessInfo.processInfo.environment["GRETCHEN_PORT"] ?? "52770"

class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var server: Process?

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        startServer()

        let frame = NSRect(x: 0, y: 0, width: 1180, height: 780)
        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "✻ Gretchen"
        window.minSize = NSSize(width: 720, height: 480)
        window.center()
        window.delegate = self
        window.setFrameAutosaveName("GretchenMain")

        let config = WKWebViewConfiguration()
        webView = WKWebView(frame: frame, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.uiDelegate = self // so window.alert/confirm/prompt show native panels
        webView.underPageBackgroundColor = NSColor(red: 0.980, green: 0.976, blue: 0.957, alpha: 1) // --bg, light theme
        window.contentView = webView

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        loadWhenReady(attempts: 0)
    }

    // node may take a moment to bind the port — poll until /api/state answers
    func loadWhenReady(attempts: Int) {
        let url = URL(string: "http://127.0.0.1:\(PORT)/api/state")!
        URLSession.shared.dataTask(with: url) { _, resp, _ in
            DispatchQueue.main.async {
                if (resp as? HTTPURLResponse)?.statusCode == 200 {
                    self.webView.load(URLRequest(url: URL(string: "http://127.0.0.1:\(PORT)/")!))
                } else if attempts < 40 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                        self.loadWhenReady(attempts: attempts + 1)
                    }
                } else {
                    self.webView.loadHTMLString(
                        "<body style='background:#faf9f4;color:#2b2820;font-family:monospace;padding:2em'>" +
                        "Gretchen's server didn't start. Is node installed?</body>", baseURL: nil)
                }
            }
        }.resume()
    }

    func startServer() {
        // if a Gretchen server is already on the port (dev, or a second copy
        // of the app), just use it instead of spawning another
        let probe = URL(string: "http://127.0.0.1:\(PORT)/api/state")!
        let sem = DispatchSemaphore(value: 0)
        var alreadyRunning = false
        URLSession.shared.dataTask(with: probe) { _, resp, _ in
            alreadyRunning = (resp as? HTTPURLResponse)?.statusCode == 200
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 1)
        if alreadyRunning { return }

        guard let appDir = Bundle.main.resourceURL?.appendingPathComponent("app") else { return }
        // node isn't on GUI apps' PATH — ask a login shell where it lives
        let which = Process()
        which.executableURL = URL(fileURLWithPath: "/bin/zsh")
        which.arguments = ["-lc", "command -v node"]
        let pipe = Pipe()
        which.standardOutput = pipe
        try? which.run()
        which.waitUntilExit()
        let nodePath = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !nodePath.isEmpty else { return }

        let p = Process()
        p.executableURL = URL(fileURLWithPath: nodePath)
        p.arguments = [appDir.appendingPathComponent("server.js").path]
        p.environment = ProcessInfo.processInfo.environment.merging(["PORT": PORT]) { _, new in new }
        p.currentDirectoryURL = appDir
        try? p.run()
        server = p
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        NSApp.terminate(nil)
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        server?.terminate()
    }

    // a minimal menu so cmd+Q/W/C/V/X/A/Z work in the web view
    func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Gretchen", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Gretchen", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit Gretchen", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let editItem = NSMenuItem()
        main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        let viewItem = NSMenuItem()
        main.addItem(viewItem)
        let viewMenu = NSMenu(title: "View")
        // the web app is served live from the repo, so ⌘R picks up edits
        viewMenu.addItem(withTitle: "Reload", action: #selector(reloadWeb), keyEquivalent: "r")
        viewItem.submenu = viewMenu

        let windowItem = NSMenuItem()
        main.addItem(windowItem)
        let win = NSMenu(title: "Window")
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = win
        NSApp.windowsMenu = win

        NSApp.mainMenu = main
    }

    // ⌘R — re-fetch the page so live edits to public/ show without relaunching
    @objc func reloadWeb() {
        webView.reloadFromOrigin()
    }
}

// Without these, WKWebView silently drops window.alert/confirm/prompt — which
// is why the web UI's prompts did nothing inside the app. Back them with the
// matching AppKit panels so the shell behaves like a real browser.
extension AppDelegate: WKUIDelegate {
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.addButton(withTitle: "OK")
        a.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "Cancel")
        a.beginSheetModal(for: window) { resp in completionHandler(resp == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let a = NSAlert()
        a.messageText = prompt
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "Cancel")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 240, height: 24))
        field.stringValue = defaultText ?? ""
        a.accessoryView = field
        a.beginSheetModal(for: window) { resp in
            completionHandler(resp == .alertFirstButtonReturn ? field.stringValue : nil)
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
