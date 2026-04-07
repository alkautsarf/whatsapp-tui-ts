// WhatsAppTuiNotifier — background macOS daemon that fires native
// UNUserNotifications on behalf of whatsapp-tui.
//
// Watches /tmp/wa-tui-notif/ for *.json files and fires a notification
// per file via UNUserNotificationCenter, then deletes the file.
//
// Each file should contain a JSON object:
//   { "title": "...", "body": "...", "subtitle": "...", "sound": "Glass",
//     "chatJid": "...", "messageId": "..." }
//
// Architecture mirrors elpabl0's ClaudeNotifier.
// Bundle id:  com.elpabl0.whatsapp-tui-notifier
// Display:    "WhatsApp" (so notifications show up under that name)
// Icon:       extracted from /Applications/WhatsApp.app at build time

import Foundation
import UserNotifications
import AppKit

// MARK: - Configuration

let watchDirectory = "/tmp/wa-tui-notif"

// MARK: - Logging

func log(_ msg: String) {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let ts = formatter.string(from: Date())
    fputs("[\(ts)] \(msg)\n", stderr)
}

// MARK: - Notification Payload

struct NotificationPayload: Codable {
    let title: String
    let body: String
    let subtitle: String?
    let sound: String?
    let chatJid: String?
    let messageId: String?
}

// MARK: - Directory Watcher

final class DirectoryWatcher {
    let path: String
    private var stream: FSEventStreamRef?
    weak var delegate: AppDelegate?

    init(path: String, delegate: AppDelegate) {
        self.path = path
        self.delegate = delegate
    }

    func start() {
        let fm = FileManager.default
        if !fm.fileExists(atPath: path) {
            try? fm.createDirectory(atPath: path, withIntermediateDirectories: true)
        }

        // Process anything that piled up while the daemon was offline.
        processDirectory()

        let pathsToWatch: CFArray = [path] as CFArray
        var context = FSEventStreamContext(
            version: 0,
            info: Unmanaged.passUnretained(self).toOpaque(),
            retain: nil,
            release: nil,
            copyDescription: nil
        )

        let callback: FSEventStreamCallback = { _, info, _, _, _, _ in
            guard let info = info else { return }
            let watcher = Unmanaged<DirectoryWatcher>.fromOpaque(info).takeUnretainedValue()
            watcher.processDirectory()
        }

        let flags = UInt32(kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer)
        stream = FSEventStreamCreate(
            kCFAllocatorDefault,
            callback,
            &context,
            pathsToWatch,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            0.1, // 100ms latency
            flags
        )

        if let stream = stream {
            FSEventStreamSetDispatchQueue(stream, DispatchQueue.main)
            FSEventStreamStart(stream)
            log("watching \(path)")
        } else {
            log("ERROR: failed to create FSEventStream for \(path)")
        }
    }

    func processDirectory() {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(atPath: path) else { return }

        // Sort by filename — payloads are written as `${ts}-${rand}.json`
        // so lexicographic sort = chronological order.
        let jsonFiles = entries.filter { $0.hasSuffix(".json") }.sorted()

        for filename in jsonFiles {
            let filepath = "\(path)/\(filename)"
            do {
                let data = try Data(contentsOf: URL(fileURLWithPath: filepath))
                let payload = try JSONDecoder().decode(NotificationPayload.self, from: data)
                delegate?.fire(payload: payload)
                try fm.removeItem(atPath: filepath)
            } catch {
                log("ERROR processing \(filename): \(error.localizedDescription)")
                // Move bad file aside so we don't infinite-loop on it.
                try? fm.moveItem(atPath: filepath, toPath: filepath + ".err")
            }
        }
    }
}

// MARK: - App Delegate

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    private var watcher: DirectoryWatcher?

    func applicationDidFinishLaunching(_ notification: Notification) {
        log("WhatsAppTuiNotifier starting")

        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            if let error = error {
                log("ERROR auth: \(error.localizedDescription)")
            }
            log("notification permission granted: \(granted)")
        }

        watcher = DirectoryWatcher(path: watchDirectory, delegate: self)
        watcher?.start()
    }

    func fire(payload: NotificationPayload) {
        let content = UNMutableNotificationContent()
        content.title = payload.title
        content.body = payload.body

        // .timeSensitive is the highest interruption level — breaks through
        // most Focus modes (Personal/Work) that allow time-sensitive
        // notifications, and tells macOS this is high-priority enough to
        // show as a banner instead of going silently to Notification Center.
        if #available(macOS 12.0, *) {
            content.interruptionLevel = .timeSensitive
            content.relevanceScore = 1.0
        }

        if let subtitle = payload.subtitle, !subtitle.isEmpty {
            content.subtitle = subtitle
        }

        // Sound: "Glass" → /System/Library/Sounds/Glass.aiff
        //        "default" → system default
        //        "none" → silent
        //        nil → default
        switch payload.sound {
        case nil, "default":
            content.sound = .default
        case "none":
            content.sound = nil
        case let name?:
            content.sound = UNNotificationSound(named: UNNotificationSoundName(rawValue: "\(name).aiff"))
        }

        // Use chatJid as the request identifier so subsequent notifications
        // from the same chat replace the previous one in Notification Center
        // (matches how Messages.app and WhatsApp.app behave).
        let identifier = payload.chatJid ?? UUID().uuidString

        let request = UNNotificationRequest(
            identifier: identifier,
            content: content,
            trigger: nil
        )

        UNUserNotificationCenter.current().add(request) { error in
            if let error = error {
                log("ERROR fire: \(error.localizedDescription)")
            } else {
                log("fired: \(payload.title) — \(payload.body.prefix(40))")
            }
        }
    }

    // Show notifications even when our app is the "foreground" app.
    // We're LSUIElement so we never appear visually, but UN treats us as
    // foreground, so without this delegate the banners would be suppressed.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .badge])
    }
}

// MARK: - Main

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
