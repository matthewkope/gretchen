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
        webView.underPageBackgroundColor = NSColor(red: 0.10, green: 0.098, blue: 0.082, alpha: 1)
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
                        "<body style='background:#1a1915;color:#e8e6e3;font-family:monospace;padding:2em'>" +
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

        let windowItem = NSMenuItem()
        main.addItem(windowItem)
        let win = NSMenu(title: "Window")
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = win
        NSApp.windowsMenu = win

        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
