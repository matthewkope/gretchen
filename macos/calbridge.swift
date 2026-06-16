// calbridge — a tiny read-only EventKit bridge for Gretchen.
//
// The Node server (lib/applecal.js) shells out to this binary to show the
// user's Apple Calendar events in the calendar view. It NEVER writes events.
//
//   calbridge list                       → JSON [{id,title,colorHex,type,source}]
//   calbridge events <start> <end>       → JSON [{calId,calTitle,colorHex,title,
//                                                  start,end,allDay,location}]
//     dates are YYYY-MM-DD (local); the range is [start 00:00, end 00:00).
//
// On first use macOS shows the Calendars permission prompt. If denied it prints
// {"error":"unauthorized"} and exits 2 so the caller can surface a hint.
import EventKit
import Foundation

let store = EKEventStore()

func requestAccess() -> Bool {
    let sem = DispatchSemaphore(value: 0)
    var granted = false
    if #available(macOS 14.0, *) {
        store.requestFullAccessToEvents { ok, _ in granted = ok; sem.signal() }
    } else {
        store.requestAccess(to: .event) { ok, _ in granted = ok; sem.signal() }
    }
    sem.wait()
    return granted
}

// CGColor → "#RRGGBB"; falls back to a neutral gray for missing/odd colors
func hex(_ cg: CGColor?) -> String {
    guard let comps = cg?.components, !comps.isEmpty else { return "#999999" }
    let r: CGFloat, g: CGFloat, b: CGFloat
    if comps.count >= 3 { r = comps[0]; g = comps[1]; b = comps[2] }
    else { r = comps[0]; g = comps[0]; b = comps[0] } // grayscale
    func ch(_ v: CGFloat) -> Int { max(0, min(255, Int((v * 255).rounded()))) }
    return String(format: "#%02X%02X%02X", ch(r), ch(g), ch(b))
}

func typeName(_ t: EKCalendarType) -> String {
    switch t {
    case .local: return "local"
    case .calDAV: return "caldav"
    case .exchange: return "exchange"
    case .subscription: return "subscription"
    case .birthday: return "birthday"
    @unknown default: return "other"
    }
}

let dayFmt: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd"
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone.current
    return f
}()

// ISO-8601 with the local offset, e.g. 2026-06-15T09:00:00-07:00
let isoFmt: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd'T'HH:mm:ssZZZZZ"
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone.current
    return f
}()

func emit(_ obj: Any) {
    if let data = try? JSONSerialization.data(withJSONObject: obj, options: []) {
        FileHandle.standardOutput.write(data)
    } else {
        FileHandle.standardOutput.write(Data("[]".utf8))
    }
}

func fail(_ msg: String, _ code: Int32) -> Never {
    print("{\"error\":\"\(msg)\"}")
    exit(code)
}

guard requestAccess() else { fail("unauthorized", 2) }

let args = CommandLine.arguments
let cmd = args.count > 1 ? args[1] : "list"

switch cmd {
case "list":
    let cals = store.calendars(for: .event)
    emit(cals.map { c in
        [
            "id": c.calendarIdentifier,
            "title": c.title,
            "colorHex": hex(c.cgColor),
            "type": typeName(c.type),
            "source": c.source?.title ?? "",
        ]
    })

case "events":
    guard args.count >= 4,
          let start = dayFmt.date(from: args[2]),
          let end = dayFmt.date(from: args[3])
    else { fail("usage: calbridge events <yyyy-MM-dd> <yyyy-MM-dd>", 1) }
    let pred = store.predicateForEvents(withStart: start, end: end, calendars: nil)
    let events = store.events(matching: pred)
    emit(events.map { e in
        [
            "calId": e.calendar?.calendarIdentifier ?? "",
            "calTitle": e.calendar?.title ?? "",
            "colorHex": hex(e.calendar?.cgColor),
            "title": e.title ?? "(untitled)",
            "start": isoFmt.string(from: e.startDate),
            "end": isoFmt.string(from: e.endDate),
            "allDay": e.isAllDay,
            "location": e.location ?? "",
        ]
    })

default:
    fail("unknown command \(cmd)", 1)
}
