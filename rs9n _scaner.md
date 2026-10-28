Repository is untouched (git status clean). Here is the investigation.
RS9n FkWeb Compatibility Investigation
1. Executive Summary
Conclusion: COMPATIBLE for the realtime_glog attendance path, with two blocking data prerequisites and one confirmed data-integrity gap.
The current local code already understands the exact real RS9n packet. This was not inferred from documentation — I executed the captured byte sequence through the real routing stack (routes/fkweb.routes.js + controllers/fkweb.controller.js + services/scanner.service.js) with in-memory model fakes and confirmed the outcome.
Result	Statement
The leading e	Handled correctly. JSON.parse() on the raw body throws, but the code never calls it on the raw body. extractJsonObject() scans for the first { (byte 1) and parses from there.
End-to-end e{"fk_bin_data_lib":"M50","user_id":"00000262",...}	Produces userId:"262", rawUserId:"00000262", timestamp:2026-10-02T06:49:36.000Z, eventType:"card", deviceEventId:"RSS202503111226:00000262:1790923776000:1:2:20261002121936"
Attendance created	Yes — gymId:MAIN, branchCode:OLD, date:2026-10-02, source:"scanner", status:"late"
HTTP ACK	Identical to the Python receiver: 200 + response_code: OK + Content-Length: 0 + Connection: close
Existing test suite	66/66 pass (npm test)
The two things that WILL stop a real scan today (neither is a parser bug):
1. Scanner.fkwebAcceptAfter is null on the Danbaba RS9n. Every realtime_glog is ACKed and silently dropped at fkweb.controller.js:162. Verified.
2. No Danbaba member has biometrics.deviceUserId set. Member documents are not seeded for the RS9n by any code path in this repo. Without it, resolveMember() returns null → unknown_user.
The one confirmed correctness gap (see Finding F-01, Medium): resolveMember() in services/scanner.service.js:40 queries only {gymId, "biometrics.deviceUserId"} — it does not filter by branchCode, and there is no unique index on biometrics.deviceUserId (models/member.model.js:21 is a plain sparse non-unique index). If 262 exists on a MAIN-branch member and on an OLD-branch member, findOne() returns an arbitrary one. If it returns the wrong branch, the scan is denied as branch_mismatch. This is deterministic-per-query but nondeterministic-across-queries. I reproduced the denial path in Case 5.
Nothing was modified, committed, or deployed.
2. Actual RS9n Protocol
The captured realtime_glog (source of truth)
POST http://<host>/ HTTP/1.0
Content-Type: application/octet-stream
request_code: realtime_glog
dev_id: RSS202503111226
Content-Length: 105
Connection: close

e{"fk_bin_data_lib":"M50","user_id":"00000262","verify_mode":2,"io_mode":1,"io_time":"20261002121936"}
Byte-level analysis of that exact body (measured, not assumed):
byte 0    : 0x65  'e'      <- envelope-type flag, NOT JSON
byte 1    : 0x7B  '{'      <- extractJsonObject() start offset
byte 102  : 0x7D  '}'      <- balance depth returns to 0 here
JSON span : bytes 1..102   (102 bytes)
JSON.parse("e{...}") → SyntaxError: Unexpected token 'e', "e{"fk_bin_"... is not valid JSON
extractJsonObject(Buffer) → {"fk_bin_data_lib":"M50","user_id":"00000262","verify_mode":2,"io_mode":1,"io_time":"20261002121936"} ✔
Note on the 105 vs 102 discrepancy: the transcribed body is 102 bytes; the header says 105. The most likely explanation is a 3-byte trailer (e.g. "\r\n" → 104, or a device framing byte). This is immaterial — extractJsonObject() matches the balanced closing brace and never reads past it. Confirmed in code (utils/fkwebParser.js:178-181).
The captured receive_cmd
POST http://<host>/ HTTP/1.0
request_code: receive_cmd
dev_id: RSS202503111226
trans_id: 14738
Content-Length: 164

e{"fk_name":"S362","fk_time":"20261002123303","fk_info":{"supported_enroll_data":["FP","PASSWORD","IDCARD"],"fk_bin_data_lib":"M50","firmware":"S362 v3.15.630"}}
Also parsed correctly (161 bytes of envelope in my reproduction). Acknowledged, nothing persisted — which is the intended behaviour.
Field semantics observed
Field	Observed	Consumed by current code?
request_code (header)	realtime_glog, receive_cmd, realtime_enroll_data, send_cmd_result	Yes — router (fkweb.controller.js:214-220)
dev_id (header)	RSS202503111226	Yes — scanner lookup, serial only
trans_id (header)	present on receive_cmd, absent on realtime_glog	Logged only, never required
user_id	zero-padded string "00000262"	Yes, dual-candidate lookup
verify_mode	2	Yes → eventType: "card"
io_mode	1	Only used in deviceEventId. Not used for check-in/check-out decision.
io_time	20261002121936 (YYYYMMDDHHMMSS, local wall clock)	Yes → fromZonedTime(..., scanner.deviceTimezone)
fk_bin_data_lib	"M50"	Read into the envelope, never used. Harmless.
3. Current Backend Flow
Exact executed path for the real packet, with line references:
Node HTTP parser (HTTP/1.0, absolute-form target "http://host/" → req.path === "/")
  │
  ├─ server.js:117   app.use(cors)          → no Origin header → allowed (corsOptions, line 78)
  ├─ server.js:120   app.options("*")       → skipped, method is POST
  ├─ server.js:137   app.use(helmet)        → sets response headers only, does not read body
  ├─ server.js:151   app.use("/iclock", express.text)  → path does not match, skipped
  ├─ server.js:152   app.use("/iclock", adms.routes)  → skipped
  │
  ├─ server.js:168   app.post("/", fkwebRoutes)       ← MATCH
  │    └─ routes/fkweb.routes.js:30-35
  │         ├─ express.raw({ type: "*/*", limit: "2mb" })  → req.body = Buffer(102 bytes)
  │         ├─ handleFkWeb                                  (controllers/fkweb.controller.js:200)
  │         └─ fkwebErrorHandler                            (controllers/fkweb.controller.js:276)
  │
  ├─ fkweb.controller.js:201  readFkWebRequestMeta(req)
  │     └─ fkwebParser.js:117 → requestCode="realtime_glog", devId="RSS202503111226", transId=""
  ├─ fkweb.controller.js:202  readRawBody(req)  → Buffer (line 85)
  ├─ fkweb.controller.js:204  requestCode present → continue
  ├─ fkweb.controller.js:209  devId present      → continue
  ├─ fkweb.controller.js:214  requestCode is a known code → continue
  │
  ├─ fkweb.controller.js:224  findScannerByDevId("RSS202503111226")
  │     └─ services/fkwebDeviceLookup.js:36  Scanner.findOne({ serial: "RSS202503111226" })
  │           (+ uppercase retry :39, lowercase retry :43)
  │     ✗ if null          → ACK + warn  (line 231)
  │     ✗ if "disabled"    → ACK + warn  (line 235)
  │
  ├─ fkweb.controller.js:243  case "realtime_glog" → handleRealtimeGlog()  (line 140)
  │     ├─ :141  extractJsonObject(body)      → skips the 'e', returns envelope
  │     │          ✗ null → ACK + warn "unparseable_body"   (:144)
  │     ├─ :148  toFkWebScannerEvent(env, scanner)          (fkwebParser.js:381)
  │     │          ├─ :384  rawUserId = "00000262"  (String(), NOT Number() — zeros preserved)
  │     │          ├─ :388  parseFkWebIoTime("20261002121936","Asia/Kolkata")
  │     │          │          → fkwebParser.js:211  fromZonedTime → 2026-10-02T06:49:36.000Z
  │     │          ├─ :399  event.userId   = normalizeUserId("00000262") = "262"
  │     │          ├─ :400  event.rawUserId = "00000262"
  │     │          ├─ :403  event.eventType = mapVerifyModeToEventType(2) = "card"
  │     │          └─ :404  event.deviceEventId = makeFkWebDeviceEventId(...)   (:356)
  │     │          ✗ {error} → ACK + warn  (:150)
  │     │
  │     ├─ :161  evaluateFkWebCutoff({scanner, timestamp})   (fkwebParser.js:258)
  │     │          ├─ cutoff === null  → {allow:false, reason:"cutoff_not_activated"}   ← PRODUCTION TODAY
  │     │          ├─ no eventTime     → {allow:false, reason:"invalid_event_time"}
  │     │          ├─ event < cutoff   → {allow:false, reason:"historical"}
  │     │          └─ event >= cutoff  → {allow:true}
  │     │          ✗ !allow → reportIgnoredRecord(:121) + touchScanner(:100) + ACK  ← pipeline NOT entered
  │     │
  │     └─ :181  await processScannerEvent({ scanner, event })   (services/scanner.service.js:132)
  │            ├─ :134  eventTime = 2026-10-02T06:49:36.000Z
  │            ├─ :136  deviceEventId (from FkWeb, NOT the arrival-time fallback)
  │            ├─ :139  ScannerEvent.findOne({deviceEventId}) → DUPLICATE GATE  ← replay collapses here
  │            ├─ :142  verified = true (event.verified === true)
  │            ├─ :150  resolveMember(gymId, event)                (:32)
  │            │          candidates = uniqueCandidates([ "262", "00000262" ])   ← :19
  │            │          for each: Member.findOne({ gymId:"MAIN", "biometrics.deviceUserId": c })  ← :40
  │            │          ✗ null → ScannerEvent deny "unknown_user"  (:152)
  │            ├─ :157-164  memberBranch ("old") vs scannerBranch ("old")
  │            │          ✗ mismatch → ScannerEvent deny "branch_mismatch"  (:161)
  │            ├─ :166  getEligibilityIssue(member)   (utils/membership.js:7)
  │            │          ✗ inactive/pending/cancelled/expired/frozen → "ineligible"
  │            │          ✗ membershipExpiryDate < now                → "expired"
  │            │          ✗ paymentStatus !== "paid"                 → "payment_pending"
  │            ├─ :173  today = formatDateInTimezone(eventTime) = "2026-10-02"   (DEFAULT_TIMEZONE)
  │            ├─ :174  hour  = getHourInTimeZone(eventTime) = 12 → isLate = true
  │            ├─ :177  Attendance.findOne({gymId, member, date:"2026-10-02", deletedAt:null})
  │            │          ├─ checkIn && checkOut → ScannerEvent allow/duplicate  (:180)
  │            │          ├─ checkIn only  → checkout, status→"completed", save   (:184-192)
  │            │          └─ neither        → set checkIn, save                  (:194-202)
  │            └─ :206  Attendance.create({ gymId, branchCode: scanner.branchCode="OLD",
  │                        member, date, checkIn, status:"late", source:"scanner",
  │                        scanner, eventType:"card", deviceEventId,
  │                        timezone: scanner.deviceTimezone })
  │                       :235 ScannerEvent.create({... decision:"allow", reason:"verified" ...})
  │                       :236 emitAttendanceUpdate → emitToGym("MAIN", "ui:attendance_update")
  │
  ├─ fkweb.controller.js:195  touchScanner(scanner)  — throttled 60s (:60)
  └─ fkweb.controller.js:197  sendFkWebAck(res)  → writeHead(200, ACK_HEADERS); end()
Also invoked: services/realtime.service.js:11 emitToGym() on every accepted check-in/checkout, which fans out over Socket.IO room gymId (server.js:397-418). Payload includes branchCode: "OLD" and the scanner deviceId.
4. Parser Compatibility
Measured by executing utils/fkwebParser.js against the exact captured bytes.
#	Requirement	Result	Evidence
1	Does the parser expect pure JSON?	PASS	It never assumes it. extractJsonObject (fkwebParser.js:147) takes a Buffer and brace-scans. JSON.parse is only called on the located {...} span (:180), wrapped in try/catch (:182).
2	Does it remove/handle the leading e?	PASS	fkwebParser.js:151 — scanWindow.indexOf(0x7b) returns 1, so 'e' is skipped by construction. JSON.parse(rawBody) throws; extractJsonObject(Buffer.from(rawBody)) succeeds.
3	Correct application/octet-stream handling?	PASS	routes/fkweb.routes.js:32 uses express.raw({type:"*/*"}). The global express.json() (server.js:171) is registered after app.post("/") (:168), so it never runs. fkweb.controller.js:85 returns the Buffer directly. Also handles a device variant omitting Content-Type (drains and ACKs, :96).
4	Leading-zero user IDs preserved?	PASS	fkwebParser.js:384 — String(record.user_id).trim() → "00000262". Never parseInt/Number. Stored on event.rawUserId.
5a	user_id parsed?	PASS	"00000262"; normalized copy "262" at :399; error missing_user_id if empty (:385).
5b	verify_mode parsed?	PASS	:392, mapped at :403 → "card" for mode 2. All 15 tested values produce valid enum members.
5c	io_mode parsed?	PASS (parsed, not applied)	:391. Used only in deviceEventId (:363) and logged (controller :175). It does not drive check-in vs check-out — that is decided by attendance row state (scanner.service.js:179-202). See Finding F-03.
5d	io_time parsed?	PASS	:388 → fkwebParser.js:200. Regex ^(\d{4})(\d{2})...(\d{2})$ (:35) → fromZonedTime("2026-10-02T12:19:36","Asia/Kolkata") → 2026-10-02T06:49:36.000Z. Verified.
5e	fk_bin_data_lib parsed?	PASS (ignored)	:147 extracts it into the envelope; nothing reads it. Harmless, and correctly not stored/logged.
6	Does it require trans_id?	PASS	Not required. readFkWebRequestMeta (:117) returns ""; only !meta.requestCode (controller :204) and !meta.devId (:209) gate. Controller :175 logs trans_id=-.
7	Does realtime_glog contain trans_id?	No	Your captured realtime_glog has no trans_id. receive_cmd does (14738). The code is correct for both.
8	Does the parser reject the request because of e?	NO — verified	End-to-end Case 2 below produced status=checkin.
9	Exact line that would reject it?	None exists	The only rejection lines are fkwebParser.js:182 (JSON.parse failure — unreachable here), :385 (missing_user_id), :389 (invalid_io_time), controller:143 (no envelope found). None trigger.
10	Exact parser output for the real packet	Measured	see below
toFkWebScannerEvent(realEnvelope, danbabaScanner)
  -> {
       ioTimeRaw : "20261002121936",
       ioMode    : 1,
       verifyMode: 2,
       event     : {
         userId      : "262",                                   // normalizeUserId stripped zeros
         rawUserId   : "00000262",                              // verbatim, for candidate #2
         timestamp   : 2026-10-02T06:49:36.000Z,
         verified    : true,
         eventType   : "card",
         deviceEventId: "RSS202503111226:00000262:1790923776000:1:2:20261002121936"
       }
     }
No line/function in the parser requires modification for this packet.
5. Scanner Registration Compatibility
Lookup implementation: services/fkwebDeviceLookup.js:32 findScannerByDevId(devId).
:36  Scanner.findOne({ serial: devId })            // exact
:39  + { serial: devId.toUpperCase() }            // if original was not already uppercase
:43  + { serial: devId.toLowerCase() }            // if original was not already lowercase
Requirement	Result	Notes
serial matching	PASS	Query key is serial only. RSS202503111226 stored verbatim → matches on the first attempt, no case fallback needed.
deviceId matching	N/A — not used	deviceId: "RS9N-DANBABA-001" is never queried on the wire path. It is only used as the deviceEventId fallback if serial were missing, and as ScannerEvent.deviceId + the Socket.IO payload field. See Finding F-06 (Low).
gymId	PASS	Not part of the lookup query. Single-gym deployment (gymId:"MAIN", required field, scanner.model.js:14). Cross-tenant ambiguity is theoretically possible but not in this deployment.
branchCode	PASS	branchCode:"OLD" read from the document. Never taken from the request.
status	PASS	Only "disabled" blocks (controller :235). "offline", "online", "maintenance" all ingest. Model default is "offline" (scanner.model.js:33) — your registration is safe either way.
protocol: p2p	PASS	Valid enum value (scanner.model.js:24). isFkWebCapableScanner() (fkwebParser.js:340) returns true on protocol === "p2p" (:342) — required by activateFkwebCutoff (scanner.controller.js:149).
type: fingerprint	PASS	Valid enum (scanner.model.js:25-29). Never read by the ingestion path — it is metadata only.
brand: realtime Biometric / model: RS9n	PASS	Valid strings. Secondary signal in isFkWebCapableScanner (:343).
IP 192.168.31.224 / port 5005	PASS (inert)	Stored on the document but never read by the FkWeb HTTP push path. They are descriptive — the device pushes to us, we never dial out. See §12.
timezone Asia/Kolkata	PASS	deviceTimezone default is "Asia/Kolkata" (scanner.model.js:23). Used at fkwebParser.js:388 for io_time and scanner.service.js:217 for Attendance.timezone.
fkwebAcceptAfter	NULL	Nullable by design (scanner.model.js:54). createScanner explicitly delete body.fkwebAcceptAfter (scanner.controller.js:64) so registration can never silently activate ingestion. This is the current blocker.
Verdict: the stated registration is fully compatible with the FkWeb implementation — with the single exception that ingestion is inert until POST /api/scanners/:id/fkweb-activate is called.
6. Member Mapping
Implementation: services/scanner.service.js:32 resolveMember(gymId, event), candidates built at :34-38 via uniqueCandidates (:19).
For user_id: "00000262":
candidate 1 : normalizeUserId("00000262") = "262"       (admsParser.js:18 — strips leading zeros)
candidate 2 : event.rawUserId              = "00000262"
candidate 3 : event.userId                 = "262"       (deduped away by uniqueCandidates)
query       : Member.findOne({ gymId: "MAIN", "biometrics.deviceUserId": <candidate> })
Requirement	Result	Evidence
Leading zeros preserved / normalized correctly	PASS	Both forms are queried. "262" → normalized, "00000262" → verbatim.
"00000262" can match the stored member ID	PASS	Verified both ways: member stored as "262" resolves (Case 2); member stored as "00000262" resolves (Case 4).
Card fallback does not interfere	PASS	event.cardId is undefined on the FkWeb path — toFkWebScannerEvent (fkwebParser.js:398-412) never sets it. The ADMS parser does set it (admsParser.js:104-107); FkWeb does not. So scanner.service.js:44-54 is skipped entirely.
Branch matching occurs	PASS (but after lookup — see F-01)	scanner.service.js:157-164.
gymId matching occurs	PASS	scanner.service.js:40 includes gymId.
Disabled / inactive handling	PASS	getEligibilityIssue (utils/membership.js:7): blocks inactive/pending/cancelled/expired/frozen → "ineligible"; membershipExpiryDate < now → "expired"; paymentStatus !== "paid" → "payment_pending".
Member must belong to the scanner branch	PASS (enforced, but with F-01 exposure)	scanner.service.js:160.
Exact reason attendance is rejected if 00000262 is not found:
scanner.service.js:151 → resolveMember() returns null → scanner.service.js:152 writes a ScannerEvent with decision:"deny", reason:"unknown_user", member:null, attendance:null, branchCode:"OLD" → returns {status:"denied", reason:"unknown_user"}. The controller logs it (fkweb.controller.js:190-193) and still ACKs. No attendance row is created. The device sees a success. This is the single most likely cause of "the scanner beeps green but nothing shows in the app."
7. Branch Isolation
Requirement: attendance from the RS9n must ALWAYS use branchCode = OLD, and must never trust a scanner-supplied branch.
Requirement	Result	Evidence
Attendance.branchCode sourced from the Scanner document	PASS	scanner.service.js:208 — branchCode: scanner.branchCode || "MAIN". Read-only from DB.
ScannerEvent.branchCode from the Scanner document	PASS	scanner.service.js:62 — branchCode: scanner.branchCode || "MAIN".
Socket.IO payload branch from the Scanner document	PASS	scanner.service.js:96.
No branchCode field exists anywhere in the FkWeb request handling path	PASS	Grep: fkwebParser.js never reads a branch field; fkweb.controller.js reads branch only for logging (:191, :240). The RS9n does not send one anyway.
Member must also belong to OLD	PASS	scanner.service.js:157-164, case-insensitive compare of member.branchCode vs scanner.branchCode.
The five requested scenarios (all verified by execution)
Scenario	Observed result
scanner OLD + member OLD	status=checkin. Attendance{gymId:"MAIN", branchCode:"OLD", date:"2026-10-02", source:"scanner", eventType:"card", status:"late"}. ScannerEvent{decision:"allow", reason:"verified", branchCode:"OLD"}. Socket.IO ui:attendance_update emitted.
scanner OLD + member in another branch	status=denied, reason:"branch_mismatch". 0 attendance rows. ScannerEvent{decision:"deny", reason:"branch_mismatch", branchCode:"OLD", member:<the other-branch member>}. Still ACKed 200/OK. (Case 5)
scanner unknown (dev_id: RSS000000000000)	findScannerByDevId → null → fkweb.controller.js:230 warn + ACK. 0 attendance, 0 ScannerEvents, processScannerEvent() never called. (Case 7)
scanner disabled	fkweb.controller.js:235 warn + ACK. 0 attendance. (Case 8)
scanner serial unknown but valid format	Same as "scanner unknown" — exact string match, no fuzzy fallback.
Additional: the admin API is also branch-scoped — scanner.controller.js:13 calls enforceBranchOwnership(scanner.branchCode, req) (middlewares/branchScope.middleware.js:34), so an OLD-branch admin cannot touch a MAIN-branch scanner, and POST /:id/fkweb-activate is behind protect, adminOnly (routes/scanner.routes.js:34).
Branch isolation: PASS.
8. Attendance Pipeline
Requirement	Result	Evidence
FkWeb calls the existing processScannerEvent()	PASS	fkweb.controller.js:41 imports it; :181 calls it. scanner.service.js was not modified by the RS9n commits (git log --stat: neither c2c9a5c nor d2f0b99 touch it).
Timestamp source	PASS	scanner.service.js:134 — event.timestamp, which is the device io_time resolved through scanner.deviceTimezone. Arrival time is never used when a timestamp exists.
Timezone	PARTIAL — see F-02	io_time → correct instant (Asia/Kolkata). But scanner.service.js:173-174 computes today and isLate with formatDateInTimezone()/getHourInTimeZone() which default to DEFAULT_TIMEZONE (utils/date.js:1, process.env.TIMEZONE || "Asia/Kolkata"), not scanner.deviceTimezone. Identical for Danbaba; divergent only if a scanner is ever registered in another zone.
Date calculation	PASS	2026-10-02T06:49:36Z → date: "2026-10-02".
Check-in	PASS	First scan of the day → checkIn set, status: "late" (hour 12 ≥ LATE_THRESHOLD_HOUR 9, :9).
Check-out	PASS	Second scan of the same day → checkOut set, status: "present"→"completed". Governed by settings.enableCheckOutOnSecondScan !== false (:184).
Duplicate handling	PASS	Three layers: ScannerEvent.findOne({deviceEventId}) (:139), {gymId,member,date} unique index (attendance.model.js:53), partial unique deviceEventId (attendance.model.js:59), plus 11000 handling (:227-231).
deviceEventId	PASS	Written to Attendance at :216 and :123; to ScannerEvent at :69.
ScannerEvent	PASS	Written on every terminal outcome, including all denials (:145, :152, :161, :168, :180, :189, :199, :228, :235).
Attendance	PASS	Attendance.create at :206 with source:"scanner".
Socket.IO	PASS	scanner.service.js:236 → emitAttendanceUpdate → emitToGym(scanner.gymId, "ui:attendance_update", {...}) (realtime.service.js:11). Only on checkin/checkout (:190, :236), guarded by if (!attendance || !scanner) return (:90).
App visibility	PASS	controllers/attendance.controller.js:771 history() scopes by the member's current branchCode (:788), not the stored Attendance.branchCode. A Danbaba (OLD) member's scan is visible to OLD-branch admins automatically.
Attendance pipeline: PASS for the Danbaba case (F-02 is latent, not active).
9. Duplicate/Event ID Handling
Implementation: utils/fkwebParser.js:356 makeFkWebDeviceEventId.
identity = scanner.serial || scanner.deviceId || "unknown"
id = [identity, userId, timeMs, ioMode, verifyMode, ioTimeRaw].join(":")
Measured for the real packet:
RSS202503111226:00000262:1790923776000:1:2:20261002121936
└── serial      └── rawUserId ──┘ └ epoch ms ┘ │ │ └─ raw io_time ─┘
                                             │ └─ verify_mode (2)
                                             └── io_mode (1)
Requirement	Result	Evidence
Deterministic	PASS	Every component is from the DB document or the device payload. No Date.now(). Verified: same inputs → byte-identical id.
Independent of request arrival time	PASS	The only time input is timestamp.getTime(), derived from io_time. The scanner.service.js:136 arrival-time fallback (${deviceId}:${eventTime}) is never reached, because fkwebParser.js:404 always populates event.deviceEventId.
Includes scanner identity	PASS	Prefixed by the registered serial — cross-protocol collision with K30 ids (serial:userId:timeMs:attState:verifyType:workCode, admsParser.js:79) is impossible.
Includes user + io_time + verify_mode + io_mode	PASS	All four present as discrete components.
Same RS9n event replayed twice — exact behaviour (measured, Case 3)
1st POST  -> status=checkin   → Attendance#1, ScannerEvent#1 (decision:allow)
2nd POST  -> status=duplicate → ScannerEvent.findOne({deviceEventId}) hits  [scanner.service.js:140]
3rd POST  -> status=duplicate → same
Final: 1 Attendance row, 1 ScannerEvent, both POSTs returned 200 + response_code:OK
- Duplicate attendance? No — impossible. The ScannerEvent gate short-circuits at line 140, before resolveMember, before the Attendance lookup, before any write.
- Rejected by ScannerEvent? Yes — the primary mechanism (scannerEvent.model.js:29 unique sparse deviceEventId, plus the explicit findOne).
- Rejected by Attendance constraints? Only as a backstop. Note attendance.model.js:59 is a partial unique index on deviceEventId, and attendance.model.js:53 is unique on {gymId, member, date}. Neither is the primary gate.
- Asymmetry worth knowing (F-04, Low): on a checkout, push() (scanner.service.js:123) overwrites attendance.deviceEventId with the checkout event's id. The check-in id disappears from the Attendance index but survives in ScannerEvent, so replay safety is preserved — but a direct query of Attendance.deviceEventId will only ever show the latest event of the day.
Duplicate/event-id handling: PASS.
10. Historical Cutoff
Requirement	Result	Evidence
Where stored	Scanner.fkwebAcceptAfter — models/scanner.model.js:54, {type: Date, default: null}	Nullable, never auto-populated (scanner.controller.js:64)
How applied	utils/fkwebParser.js:258 evaluateFkWebCutoff({scanner, timestamp}) — a pure predicate that calls nothing	Uses device io_time, never HTTP arrival time (fkwebParser.js:249)
Runs BEFORE processScannerEvent?	PASS	fkweb.controller.js:161, gate at :162; pipeline call at :181. Nothing but touchScanner() (:171) happens on the reject path.
Old records can create Attendance?	NO	Verified: io_time:"20250615103000" against a cutoff of 2026-10-02T06:40Z → reason:"historical", attendance:0, scannerEvents:0, and processScannerEvent() never entered (Case 6).
Records exactly at cutoff accepted?	PASS	fkwebParser.js:272 — strict < comparison; equal is eligible. Tested in test/fkweb.test.js:730 and :421-423.
Records before cutoff ACKed safely?	PASS	:172 → sendFkWebAck(res) at the same line as success. Response is byte-identical (verified). A non-2xx would trigger an unbounded device retry.
Historical replay can duplicate attendance?	NO	Rejected before the pipeline; and deviceEventId is deterministic, so even if the cutoff were later moved backwards, the replay would collapse at scanner.service.js:140.
Not activated = safe default	PASS	fkwebParser.js:264 — cutoff_not_activated blocks everything, including live scans. This is the state the RS9n is in today.
Log volume for 9,293 records	PASS	fkweb.controller.js:119-138 aggregates per scanner+reason, first hit in full, then at most once per 60s with a running ignored_total. A 9,293-record drain produces O(1) log lines, not 9,293.
Write amplification for 9,293 records	PASS	SCANNER_TOUCH_THROTTLE_MS = 60000 (:60) + Date.now() - lastSeen < throttle (:103) means at most one scanner.save() per minute during a full drain.
Rate limiting during drain	PASS	server.js:195-206. Verified with 350 rapid pushes → 350×200, 0×429 (test/fkweb.test.js:1104).
Two operational cautions (not defects):
1. Activation is a deliberate, auditable operator step (POST /api/scanners/:id/fkweb-activate, scanner.controller.js:144). It is never automatic. Do not set it "just in case."
2. Setting the cutoff to a time earlier than the backlog means the backlog becomes attendance. There is no upper bound and no per-scanner record cap. Choose the boundary deliberately — the recommended value is a timestamp after the last historical log you want discarded and before your first intended live scan.
Historical cutoff: PASS.
11. HTTP Response Compatibility
controllers/fkweb.controller.js:50-55:
const ACK_HEADERS = {
  response_code: "OK",
  "Content-Type": "text/plain; charset=utf-8",
  "Content-Length": "0",
  Connection: "close"
};
// :74-78  res.writeHead(200, ACK_HEADERS); res.end();
Wire capture from my end-to-end run (absolute-form POST http://127.0.0.1:49673/ HTTP/1.0):
HTTP/1.1 200 OK
X-Powered-By: Express
response_code: OK
Content-Type: text/plain; charset=utf-8
Content-Length: 0
Connection: close
Date: Fri, 02 Oct 2026 11:13:22 GMT
<zero-byte body>
Scenario	Status	response_code	Body	Attendance
Successful realtime_glog	200	OK	0 bytes	created
Malformed / unparseable body	200	OK	0 bytes	none
Unknown scanner (dev_id)	200	OK	0 bytes	none
Historical / not-activated	200	OK	0 bytes	none
Unknown member	200	OK	0 bytes	none
Branch mismatch	200	OK	0 bytes	none
Disabled scanner	200	OK	0 bytes	none
Internal error in pipeline	200	OK	0 bytes	none (caught :182-187)
Body-parser error (oversize/truncated)	200	OK	0 bytes	none (fkwebErrorHandler, :276)
Missing request_code / dev_id	200	OK	0 bytes	none
Unknown request_code	200	OK	0 bytes	none
receive_cmd / send_cmd_result	200	OK	0 bytes	none
realtime_enroll_data + 1 KB binary tail	200	OK	0 bytes	none
Compatibility with the Python receiver: PASS — functionally identical.
Attribute	Python receiver	Node backend
Status	200	200
response_code	OK	OK
Content-Length	0	0
Connection	close	close
Body	empty	empty
Minor, non-blocking divergences (both should be accepted by the firmware; your physical test will confirm):
1. Node replies HTTP/1.1, the Python receiver replied HTTP/1.0. Node honours the device's HTTP/1.0 request line and closes the socket anyway.
2. Node adds X-Powered-By, Date, and Content-Type: text/plain; charset=utf-8.
3. Node does not echo trans_id or any per-request correlation value. If the firmware turns out to require one, that is the thing to add — currently unverifiable from code.
12. Local Server Routing
The critical operational fact
Item	Value	Source
Local Node PORT	5000	.env line PORT=5000, consumed at server.js:529-531
ADMS listener PORT (local only)	8082	.env ADMS_PORT=8082, server.js:561
Python receiver PORT	88	(temporary tool, now retired)
RS9n device TCP port	5005	stored on Scanner.port, never read by the ingestion path
The RS9n must be pointed at http://192.168.31.222:5000/ — not :88/.
Port 5005 is the RS9n's own local service port. It is not the destination port. The scanner dials out to whatever URL you configure; the backend never dials in. Confirmed by grep: scanner.ipAddress / scanner.port are not referenced anywhere in routes/fkweb.routes.js, controllers/fkweb.controller.js, services/fkwebDeviceLookup.js, utils/fkwebParser.js, or services/scanner.service.js.
Route path
Question	Answer	Evidence
Should the scanner use /?	Yes — this is the intended target.	server.js:168 app.post("/", fkwebRoutes). The RS9n transmits an absolute-form request target (POST http://host/ HTTP/1.0), which Node preserves in req.url but normalises to req.path === "/". The scanner cannot be given a path if it emits absolute-form — so / is mandatory, not optional. Verified working (Case 1/2).
Should it use /fkweb?	Optional alias.	server.js:169 + routes/fkweb.routes.js:31. Works for tooling/manual testing, but the device will not produce it.
Special route required?	No.	Both are registered on the same router instance, and the router re-declares both paths because in Express 4 app.post("/fkweb", router) builds a Route (not a mount), leaving req.url === "/fkweb" (fkweb.routes.js:27-31).
application/octet-stream reaches the right parser?	PASS	express.raw({type:"*/*"}) at fkweb.routes.js:32.
Middleware could consume/alter the body?	NO	Verified order in server.js: cors (:117) → options (:120) → helmet (:137) → /iclock text+router (:151-152, path-gated, skipped) → app.post("/") (:168) → express.json (:171). Nothing before line 168 reads a body for a POST to /. express.json at :171 only consumes application/json and never runs for an already-terminated response.
Network prerequisites for the gym test
Laptop        : 192.168.31.222
Node backend  : 192.168.31.222:5000
RS9n          : 192.168.31.224
Subnet/ GW    : 192.168.31.0/24, 192.168.31.1
- Windows Firewall must allow inbound TCP 5000 from 192.168.31.0/24 — this is the #1 cause of "Python worked, Node doesn't". Python on 88 and Node on 5000 are different firewall rules.
- server.js:559 — the ADMS listener on 8082 also starts locally (RENDER is unset). That is fine; it does not conflict with 5000.
- PORT is read from .env (anchored to server.js:9-12, so cwd-independent).
- NODE_ENV=development → server.js:386 registers GET / returning a text banner. POST / is unaffected (method-specific, registered earlier). Verified: a POST / with no FkWeb headers still returns 200 + response_code:OK + Content-Length:0.
Local routing: PASS.
13. K30 Safety
Protected K30 files — DO NOT CHANGE
File	Role
utils/admsParser.js	K30 ATTLOG parsing, makeDeviceEventId, normalizeUserId
routes/adms.routes.js	/iclock/cdata, /iclock/getrequest, /iclock/devicecmd
controllers/adms.controller.js	handleCdata, handleGetRequest, handleDeviceCmd, DeviceCommand queue integration
services/admsDeviceLookup.js	findScannerBySerial (K30 serial resolution)
utils/admsResponse.js	K30 wire-format responses (buildGetRequestResponse, buildCdataResponse)
services/deviceCommand.service.js	K30 outbound command queue (C:<id>:<command> / SET OPTIONS ...)
services/scanner.service.js	The shared attendance pipeline — DO NOT MODIFY
Shared files — change with care
File	Shared surface	RS9n-added surface
server.js	/iclock text+router mount (:151-152), express.json (:171), rate limiter (:198), health (:212), all /api/*, static/SPA (:356), Socket.IO (:397), ADMS 8082 listener (:559)	app.post("/", fkwebRoutes) :168, app.post("/fkweb", ...) :169, isFkWebDevicePush :195-196
models/scanner.model.js	All existing fields + {gymId,branchCode} index (:61)	fkwebAcceptAfter :54, serial index :62
models/scannerEvent.model.js	Entire schema shared by both protocols	none
models/member.model.js	biometrics.deviceUserId / cardId	none
models/attendance.model.js	Entire schema shared	none
services/scanner.service.js	Entire pipeline shared	none
services/realtime.service.js	emitToGym	none
utils/date.js	DEFAULT_TIMEZONE used by both parsers and the pipeline	none
controllers/scanner.controller.js	Full scanner CRUD	activateFkwebCutoff :144, its import :8
routes/scanner.routes.js	All scanner endpoints	POST /:id/fkweb-activate :34
RS9n-only files — SAFE TO CHANGE FOR RS9n
utils/fkwebParser.js · controllers/fkweb.controller.js · routes/fkweb.routes.js · services/fkwebDeviceLookup.js
These four files contain zero references to /iclock, ADMS, ATTLOG, devicecmd, or DeviceCommand. The only cross-import is fkwebParser.js:32 → require("./admsParser") for the single pure function normalizeUserId (a 9-line string transform). That import is read-only; it mutates nothing and admsParser.js exports it unconditionally.
Can a fix to the RS9n parser affect the K30?
K30 surface	Could an RS9n-only change break it?
/iclock/cdata	No. Different router, mounted at server.js:152 with express.text. Verified working after RS9n traffic.
ATTLOG parsing	No. utils/admsParser.js is untouched; FkWeb never calls parseAttLog.
K30 authentication (/getrequest)	No. Resolves via admsDeviceLookup.findScannerBySerial, independent of FkWeb lookup.
K30 device commands (/devicecmd, getrequest queue)	No. deviceCommand.service.js is never imported by any FkWeb file. fkweb.controller.js:246-252 explicitly declines to implement an FkWeb command transport.
K30 attendance	No. Shares processScannerEvent, but the FkWeb path only feeds it — it never changes it. Both RS9n commits (c2c9a5c, d2f0b99) touched zero lines of scanner.service.js (verified via git log --stat).
Existing branch isolation	No. Unchanged.
POST / in production	Minor surface change: POST / previously had no route (only GET /). Now any POST / returns an FkWeb ACK. No K30 traffic uses POST /.
Scanner.fkwebAcceptAfter	No. Only fkwebParser.js and scanner.controller.js:activateFkwebCutoff read it. /iclock never does. Explicitly tested at test/fkweb.test.js:1169.
Live K30 regression check performed during this investigation (in-memory fakes, no DB):
POST /iclock/cdata?SN=K30SERIAL001&table=ATTLOG
body: "1001\t2026-09-30 11:15:51\t1\t0\t0\t0"
→ 200, body "OK\n"
→ Attendance{branchCode:"MAIN", source:"scanner", date:"2026-09-30", eventType:"fingerprint"}
→ deviceEventId: "K30SERIAL001:1001:1790747151000:0:1:0"
Existing regression tests: 4 of them (test/fkweb.test.js:1135, :1149, :1169, :1192) — all pass.
K30 safety: PASS. No K30 change is required, and no K30 file was touched.
14. Existing Test Coverage
npm test → node --test "test/*.test.js" → 1 file, 66 tests, 66 pass, 0 fail (23.3 s).
Covered
Area	Tests
Pure parser (io_time, malformed values, binary tail, brace-in-string, 4 KiB bound)	:256–:297
makeFkWebDeviceEventId determinism + arrival-time independence + field separation	:299, :312
toFkWebScannerEvent mapping + error codes	:324, :338
Header spelling variants (underscore/dash/camel/uppercase)	:354
readFkWebRequestMeta, isFkWebDevicePush	:354, :373
Scanner lookup incl. unknown/empty	:382
Cutoff predicate (null/before/at/after/invalid/arrival-time) + activation parsing + authorization	:396–:488
Branch isolation (both directions, via the real pipeline)	:496, :513, :529
Duplicate / historical replay idempotency	:543, :587, :969
Unknown user / eligibility	:597
Zero-padded deviceUserId resolution	:613
HTTP ACK contract, routing (/, /fkweb, absolute-form http + https)	:940–:1024
receive_cmd / send_cmd_result / realtime_enroll_data + binary template	:1026
Unknown request_code / unknown dev_id / disabled scanner / hostile bodies / 3 MB frame	:1049–:1102
Rate limit (350 pushes, 0×429)	:1104
K30 regression (4 tests)	:1135–:1216
The gap — this is exactly why your physical test matters
test/fkweb.test.js:249-250:
const GLOG = (userId, ioTime, verifyMode = 2, ioMode = 1) =>
  JSON.stringify({ fk_bin_data_lib: "M50", user_id: userId, verify_mode: verifyMode, io_mode: ioMode, io_time: ioTime });
JSON.stringify — there is no leading e. Every single FkWeb HTTP test in the repo sends a body the real RS9n never sends.
No test in the repository sends the exact real body:
e{"fk_bin_data_lib":"M50","user_id":"00000262","verify_mode":2,"io_mode":1,"io_time":"20261002121936"}
Confirmed by grep and by reading all 1,221 lines. Concretely, missing coverage:
Missing test	Why it matters
e prefix present in a realtime_glog body	The single most important behavioural difference between the test suite and the physical device. Currently protected only by the implicit behaviour of indexOf(0x7b), never asserted.
user_id: "00000262", io_time: "20261002121936"	No test uses the real captured values. 00000258 / 20260930111551 are used instead.
branchCode: "OLD"	The fixture uses branchCode:"BR2" (:169) and deviceId:"RS9N-BRANCH-2" (:173). OLD appears nowhere. The production Danbaba registration shape is untested.
Real receive_cmd body with trans_id: 14738	:1029 uses a generic {"dev_id":...,"cmd_id":1}.
Production registration fields	protocol:"p2p" ✓ (:485), but type:"fingerprint", port: 5005, ipAddress, gates: [] are never exercised.
Content-Length ≠ JSON length	Every test sets Content-Length to the exact body length. The real device declared 105 for a 102-byte envelope. The device-version discrepancy is untested.
Everything else is genuinely well covered. This is a test-fidelity gap, not a code defect — and I verified the real bytes work end-to-end (§7 Case 2) before writing it here.
15. Critical Findings
F-01 — Member resolution does not filter by branch → nondeterministic cross-branch denials
- File / function: services/scanner.service.js:32 resolveMember(), specifically line 40
- Exact behaviour: Member.findOne({ gymId, "biometrics.deviceUserId": candidate }) — no branchCode. models/member.model.js:21 declares biometrics.deviceUserId as {type:String, index:true, sparse:true} — a plain, non-unique index. Mongo therefore returns an arbitrary matching document.
- Why it matters: The RS9n's user_id space is the device's own enrollment numbering, not A1 Fitness's. Nothing in the codebase guarantees 262 is unique across branches. If an OLD member and a MAIN member both hold deviceUserId:"262", only one is ever returned, and if it is the wrong branch the scan is denied branch_mismatch — even though a valid OLD member exists. This is invisible (device ACKs, no attendance) and flips run to run as documents move.
- Severity: Medium. Not a crash and not a data-corruption bug (the deny path is correct given what it resolved). But it is the single most likely cause of intermittent "scanner works, attendance missing" once the Danbaba scanner goes live, and it is impossible to detect from the device side.
- Not fixed — investigation only.
F-02 — Attendance date/late-calculation ignores scanner.deviceTimezone
- File / function: services/scanner.service.js:173-174
- Exact behaviour: formatDateInTimezone(eventTime) and getHourInTimeZone(eventTime) are called with no timezone argument, defaulting to DEFAULT_TIMEZONE (utils/date.js:1 = process.env.TIMEZONE || "Asia/Kolkata"). The event timestamp itself was resolved from scanner.deviceTimezone (fkwebParser.js:388).
- Why it matters: If a scanner is ever registered with any deviceTimezone other than Asia/Kolkata, the row's date and its status (present vs late, threshold hour 9 at :9/:175) are computed in a different zone from the instant they describe. For Danbaba (Asia/Kolkata) the two are identical — inactive today.
- Severity: Low. Pre-existing, shared with the K30 path, and not triggered by the RS9n.
- Not fixed — investigation only.
F-03 — io_mode does not drive check-in vs check-out
- File / function: utils/fkwebParser.js:391 (io_mode captured) → discarded; decision made at services/scanner.service.js:179-202
- Exact behaviour: io_mode reaches only the log line (fkweb.controller.js:175) and the deviceEventId (:363). processScannerEvent decides purely on the current Attendance row's shape: no row → check-in; row with checkIn and no checkOut → check-out.
- Why it matters: The RS9n emits io_mode for a reason, and the captured packets are all io_mode: 1. If a member scans four times, this pipeline treats scans 2/3/4 as: 2 → check-out (status:"completed"), 3 → both set → duplicate, 4 → duplicate. So the third and fourth punches of the day are discarded silently — they appear as ScannerEvent{decision:"allow", reason:"duplicate"} but produce no attendance change.
- Severity: Low for a gym check-in/check-out model (which only has two states). Becomes Medium if you later want first-in / last-out semantics or multi-punch tracking.
- Not fixed — investigation only.
F-04 — Checkout overwrites Attendance.deviceEventId
- File / function: services/scanner.service.js:123 (push())
- Exact behaviour: attendance.deviceEventId = deviceEventId unconditionally, on both check-in and check-out.
- Why it matters: After a check-out, Attendance.deviceEventId holds the checkout event's id; the check-in id is no longer in the Attendance unique index. Replay safety is unaffected — ScannerEvent retains both ids and is queried first at :139. The impact is purely diagnostic: querying Attendance by deviceEventId returns only the day's last event.
- Severity: Low / informational.
F-05 — Scanner lookup is not gym-scoped
- File / function: services/fkwebDeviceLookup.js:36-44
- Exact behaviour: Scanner.findOne({ serial }) with no gymId filter. (services/admsDeviceLookup.js:11 has the identical characteristic — pre-existing, symmetric.)
- Why it matters: If two gyms ever register the same serial, either could be resolved and the wrong gym's branchCode/gymId would be applied to attendance. Not a risk in this single-gym (MAIN) deployment.
- Severity: Low.
F-06 — deviceId is never used for wire lookup
- File / function: services/fkwebDeviceLookup.js:36
- Exact behaviour: Only serial is queried. deviceId (RS9N-DANBABA-001) appears solely as a deviceEventId fallback (:357) and as ScannerEvent.deviceId (scanner.service.js:63).
- Why it matters: If serial is ever cleared on the Danbaba scanner, FkWeb ingestion stops entirely while deviceId still looks correct in the admin UI. The K30 lookup has the same shape, so this is consistent — but it is a single-point-of-failure worth knowing about.
- Severity: Low.
F-07 — Test bodies omit the e prefix
- File / function: test/fkweb.test.js:249-250 (GLOG helper)
- Exact behaviour: All 20+ FkWeb HTTP tests send JSON.stringify(...), never "e" + JSON.stringify(...).
- Why it matters: The suite's green result does not prove the real device body is handled. The physical e-prefixed body is verified only by my ad-hoc out-of-repo run (§7), which is not a durable regression guard. A future refactor of extractJsonObject could break e-prefixed bodies without any test failing.
- Severity: Medium (test-fidelity, not runtime).
Non-findings (checked, clean)
- extractJsonObject cannot reject an e-prefixed body — indexOf(0x7b) returns 1 (verified).
- express.json() cannot pre-consume the FkWeb body — registered at server.js:171, after app.post("/") at :168 (verified).
- Scanner.fkwebAcceptAfter cannot affect the K30 — never read outside fkwebParser.js (explicitly tested at test/fkweb.test.js:1169).
- ScannerEvent.raw stores no fingerprint payload for FkWeb — it stores the normalized event object (scanner.service.js:71), and realtime_enroll_data is never parsed (fkweb.controller.js:257-259).
- The 4 KiB JSON scan window (MAX_JSON_SCAN_BYTES, :42) is not a limit on the 2 MB body limit; only envelope extraction is bounded. A 105-byte envelope is nowhere near it.
16. Unknowns
Cannot be determined from code. Each requires the physical device or production to confirm.
 1. The 3-byte Content-Length discrepancy (105 vs 102). My reproduction of the transcribed body is 102 bytes. Either the device appends 3 trailing bytes, or the transcription dropped 3. Immaterial to correctness (balanced-brace extraction), but the true framing is unknown.
 2. Whether verify_mode: 2 means "card" or something else. The code maps 2 → "card" (fkwebParser.js:64) by analogy with the ADMS table, in which ADMS verifyType 2 is also treated as card. But verify_mode and ADMS verify_type are different enumerations from different vendors. If RS9n 2 actually means fingerprint, every RS9n attendance row and ScannerEvent will be labelled eventType:"card" instead of "fingerprint". Cosmetic today, but a data-quality issue. Cannot be resolved from code.
 3. What io_mode: 1 means and whether other values occur. Only 1 has been observed.
 4. Whether fk_bin_data_lib:"M50" ever varies. Currently ignored entirely.
 5. Whether the firmware requires trans_id to be echoed. The Node ACK returns none. The Python receiver also returned none and the device was satisfied — so this is probably fine, but it is not proven under all request codes.
 6. Whether Render's edge/LB preserves underscore headers (request_code, dev_id). Mitigated by four fallback spellings plus a query-string fallback (fkwebParser.js:92-114) — but no Render-side test exists. This is a production-only unknown and is the reason a local-only test cannot be treated as sufficient for production.
 7. Whether the ~9,293 historical logs span io_time values after any candidate cutoff. If the device's clock was ever set forward, "yesterday's" logs may carry today's dates and would pass any cutoff set to yesterday.
 8. Whether Member.biometrics.deviceUserId is already populated for any Danbaba member. No code in this repo seeds it; it is admin-entered via POST /api/members/:id/link-biometric (member.controller.js:878, stores the value verbatim, line 895). Whether it has been done for user 262 is a data question, not a code question.
 9. Whether deviceUserId values collide across branches today. This is F-01's trigger condition and can only be answered from the database.
10. The React Native app's live Socket.IO subscription state. The server emits ui:attendance_update correctly (scanner.service.js:91); whether the app is subscribed to the MAIN room on the device is outside this repo.
11. Cloudflare Worker behaviour. There is no Worker code in this repository. Any edge behaviour (header rewriting, buffering, body limits, HTTPS termination) is entirely outside the scope of what I could inspect. Per your instruction, I am making no assumption about it either way.
12. The RS9n's own 5005 service semantics. Stored on the document and never read by the backend; its purpose on the device is unknown.
17. Required Changes
NOT IMPLEMENTED. Listed for planning only. Based on the evidence above, the parser needs no change whatsoever — the real e-prefixed packet is already parsed correctly.
Parser changes
NONE REQUIRED. Verified by execution against the exact captured bytes.
Controller changes
NONE REQUIRED. Every path already ACKs 200 / response_code: OK / Content-Length: 0.
Routing changes
NONE REQUIRED. POST / (absolute-form) and POST /fkweb are both live, correctly ordered ahead of express.json(), and rate-limit-bypassed.
Model changes
NONE REQUIRED. Scanner.fkwebAcceptAfter already exists and is already nullable.
Data changes (not code — the actual blockers)
1. Populate Member.biometrics.deviceUserId for the Danbaba members, via the existing admin UI endpoint. Store the value exactly as it appears on the RS9n screen — both "262" and "00000262" resolve (scanner.service.js:34-38), but be consistent.
2. Before populating, resolve F-01 — check whether 262 is already assigned to a member in another branch.
3. Call POST /api/scanners/:id/fkweb-activate with an explicit acceptAfter, after the data above is correct and after a successful local test.
Recommended code changes — optional hardening, in priority order
Priority	Change	File	Rationale
1	Add branchCode to the member lookup, and/or add a unique compound index on {gymId, "biometrics.deviceUserId"}	services/scanner.service.js:40 and/or models/member.model.js	Fixes F-01. Shared with the K30 — a branch filter could change K30 behaviour if a K30 member id were ever duplicated across branches. Requires a K30 regression run.
2	Add FkWeb tests using the literal "e" + JSON.stringify(...) body and the real captured values (00000262, 20261002121936, branchCode:"OLD")	test/fkweb.test.js	Closes F-07. Test-only, zero runtime risk. This is the single highest-value change.
3	Pass scanner.deviceTimezone into formatDateInTimezone / getHourInTimeZone	services/scanner.service.js:173-174	Fixes F-02. Shared with the K30; inert while every scanner is Asia/Kolkata.
4	Confirm the RS9n verify_mode enum with the vendor before labelling attendance	utils/fkwebParser.js:62-70	Resolves Unknown #2. A mapping change after go-live would need a data backfill.
5	Fall back to deviceId in the FkWeb lookup	services/fkwebDeviceLookup.js	Fixes F-06. RS9n-only file, K30 unaffected.
I explicitly do not recommend touching services/scanner.service.js, utils/admsParser.js, routes/adms.routes.js, controllers/adms.controller.js, services/admsDeviceLookup.js, utils/admsResponse.js, or services/deviceCommand.service.js. Items 1 and 3 above both require scanner.service.js and therefore both require a full K30 regression run.
18. Local Physical Test Plan
Safe, sequential, production-untouched. Do not skip a step.
Phase 0 — Offline preparation (at the gym, laptop on the 192.168.31.0/24 network, before powering the scanner on)
Step 0.1 — Point MONGO_URI at a local/test database.
Open .env, confirm MONGO_URI is not the production Atlas URI. server.js:492 connectDb() runs on boot, and server.js:498-507 runs seeds and two index migrations on connect. Verify the URI is local before starting. Do not proceed otherwise.
Step 2 — Register the scanner in the LOCAL database only.
POST /api/scanners        (Bearer: branch-admin token for OLD)
{
  "name": "Danbaba RS9n",
  "deviceId": "RS9N-DANBABA-001",
  "serial": "RSS202503111226",
  "brand": "realtime Biometric",
  "model": "RS9n",
  "protocol": "p2p",
  "type": "fingerprint",
  "ipAddress": "192.168.31.224",
  "port": 5005,
  "deviceTimezone": "Asia/Kolkata",
  "status": "online"
}
branchCode defaults to your admin's branch (scanner.controller.js:52) — confirm it is OLD. fkwebAcceptAfter is force-stripped (:64), so it stays null.
Verify: GET /api/scanners shows branchCode: "OLD", serial: "RSS202503111226".
Step 0.3 — Resolve F-01 before enrolling anyone.
For every Danbaba member you intend to test, check that the intended deviceUserId is not already assigned to a member in another branch. If it is, change that other member's id first. Otherwise your first physical scan may deny for branch_mismatch and you will misdiagnose it.
Step 0.4 — Link the test member.
POST /api/members/:id/link-biometric    (Bearer: admin/trainer with update_member)
{ "deviceUserId": "262" }
Read the number off the RS9n screen, not from memory. Verify: GET /api/members/:id → biometrics.deviceUserId matches exactly, and branchCode is OLD, gymId is MAIN, status is active, paymentStatus is paid, and membershipExpiryDate is in the future (else getEligibilityIssue denies: utils/membership.js:7-14).
Step 0.5 — Do NOT activate the cutoff yet. Leave fkwebAcceptAfter: null.
Phase 1 — First physical connection (backlog drain)
Step 1.1 — Start the server and confirm the port.
npm run dev
Expect Server running on port 5000 (server.js:460). Confirm NODE_ENV=development and RENDER unset so the 8082 ADMS listener also starts.
Step 1.2 — Open port 5000 on the laptop firewall for 192.168.31.0/24. (Step 1.1 will appear to work fine from localhost and still fail from the scanner — this is the classic false negative.)
Step 1.3 — Point the RS9n at http://192.168.31.222:5000/ — NOT :88/.
Step 1.4 — Watch the console and expect exactly this, in this order:
[FKWEB] request_code=realtime_glog dev_id=RSS202503111226 scanner=<id> branch=OLD trans_id=- blk_no=- bodyBytes=102
[FKWEB] request_code=receive_cmd   dev_id=RSS202503111226 scanner=<id> branch=OLD trans_id=14738 ...
[FKWEB] historical event ignored scanner=RSS202503111226 user_id=... cutoff=not_activated reason=cutoff_not_activated ignored_total=1
[FKWEB] request_code=realtime_enroll_data scanner=<id> ... enrollment_sync=not_implemented template_data=not_stored
PASS criteria for Phase 1 (cutoff still null, so no attendance may be created):
- branch=OLD and scanner=<ObjectId> on every line → serial lookup succeeded. This is the single most important Phase 1 signal.
- reason=cutoff_not_activated → the cutoff gate is working.
- bodyBytes ≈ 102–105 → body arrived intact.
- ignored_total climbs as the backlog drains. Log lines must stay bounded (throttled per 60 s, fkweb.controller.js:128) — if you see thousands of lines, stop and investigate.
- GET /api/scanners → status flipped offline→online and lastSeen advanced (proves touchScanner at :171 ran, i.e. the ACK reached the device and it considered it acceptable).
- SELECT nothing in production. Zero Attendance, zero ScannerEvent. Verify this explicitly.
Phase 2 — Activate the cutoff (locally)
Step 2.1 — Wait until the backlog drain has fully stopped. Note the wall-clock time.
Step 2.2 — Activate with an explicit timestamp a few minutes in the past:
POST /api/scanners/<id>/fkweb-activate
{ "acceptAfter": "2026-10-02T18:30:00" }     # interpreted in Asia/Kolkata
Verify the response echoes fkwebAcceptAfter as an ISO instant and timezone: "Asia/Kolkata".
Step 2.3 — Confirm the idempotent refusal: calling it again without acceptAfter must return 400 (scanner.controller.js:154-156). Confirm a K30 400 from isFkWebCapableScanner (:149).
Phase 3 — Live scan
Step 3.1 — Note the exact wall-clock time. Perform one deliberate scan as the linked Danbaba member.
Step 3.2 — Console must show:
[FKWEB] request_code=realtime_glog dev_id=... user_id=00000262 io_mode=1 verify_mode=2 trans_id=-
[FKWEB] scanner=<id> branch=OLD user_id=00000262 -> attendance accepted status=checkin
Step 3.3 — Verify in the local database:
Attendance:  gymId=MAIN, branchCode=OLD, member=<Danbaba member>, source=scanner,
             eventType=<card|fingerprint>, checkIn == the device io_time (NOT the arrival time),
             deviceEventId = "RSS202503111226:00000262:<epoch>:1:2:<io_time>",
             timezone=Asia/Kolkata, scanner=<the Scanner _id>
ScannerEvent: decision=allow, reason=verified, branchCode=OLD, member=<same>, attendance=<same>
Cross-check checkIn against the io_time on the RS9n screen. They must be equal to the second. If checkIn is the server's arrival time instead, something is wrong.
Step 3.4 — Scan the same member a second time.
Step 3.5 — Verify: status=checkout, the same Attendance row gains checkOut (still exactly 1 row), and the device changed status to completed. Note that Attendance.deviceEventId is now the checkout id (F-04).
Phase 4 — Negative tests (all with branchCode=OLD)
Test	Expected console	Expected DB
Unregistered user_id (enroll a stranger on the device)	rejected status=denied	ScannerEvent{deny, unknown_user}; 0 Attendance
MAIN-branch member scanned on the OLD scanner	rejected	ScannerEvent{deny, branch_mismatch, branchCode:OLD}; 0 Attendance
Expired / paymentStatus != paid member	rejected	ScannerEvent{deny, expired | payment_pending | ineligible}; 0 Attendance
Replay the exact same request 3×	1× checkin, 2× duplicate	exactly 1 Attendance, 1 ScannerEvent
Phase 5 — App visibility
Step 5.1 — GET /api/attendance/history?date=<today> as an OLD-branch admin → the record must appear (attendance.controller.js:788 scopes by the member's branch).
Step 5.2 — Same query as a MAIN-branch admin → the record must NOT appear.
Step 5.3 — React Native app: log in as an OLD-branch user, confirm the attendance appears (REST and/or via the ui:attendance_update Socket.IO event on the MAIN room).
Phase 6 — K30 regression (non-negotiable)
Point the K30 at the same local backend and confirm:
- /iclock/getrequest still returns OK and DeviceCommands still dispatch.
- /iclock/cdata?SN=...&table=ATTLOG still returns 200 + body OK\n.
- K30 attendance still lands with the correct branchCode.
- npm test → 66/66 pass.
Phase 7 — Teardown
Leave the cutoff activated for the next session, or clear it ({"acceptAfter": null}) to return to the safe ignore-everything state. Both are safe; clearing is safer if you will not scan again soon.
If any step deviates from the expected console/DB state, STOP. Do not activate anything in production, and do not deploy.
19. Deployment Gate
Deploy the tested commit to Render only if every gate below is green.
G1 — Automated tests
- npm test exits 0 with 66 passing, 0 failing (or more if tests were added — never fewer).
- git status is clean; the diff contains only intended files.
- No file under routes/adms.routes.js, controllers/adms.controller.js, services/admsDeviceLookup.js, utils/admsParser.js, utils/admsResponse.js, services/deviceCommand.service.js appears in the diff — unless F-01/F-02 is being fixed, in which case G6 applies.
G2 — Real-packet fidelity (the reason this investigation existed)
- A test sends the literal body e{"fk_bin_data_lib":"M50","user_id":"00000262","verify_mode":2,"io_mode":1,"io_time":"20261002121936"} over real HTTP and asserts status === "checkin" with branchCode === "OLD" (closes F-07).
- A test sends the same body with an absolute-form target and asserts 200 + response_code: OK + Content-Length: 0.
G3 — Physical RS9n proof on the laptop backend
- Serial lookup succeeded (scanner=<ObjectId> branch=OLD on the console) — proves RSS202503111226 resolves.
- With fkwebAcceptAfter: null, a full backlog drain created 0 Attendance and 0 ScannerEvent (Phase 1).
- After activation, one live scan created Attendance with checkIn exactly equal to the device io_time (Phase 3.3).
- branchCode === "OLD" on both Attendance and ScannerEvent, always.
- Replaying the identical request 3× produced exactly 1 Attendance row.
G4 — Negative paths
- Unknown user_id → unknown_user, 0 Attendance.
- Cross-branch member → branch_mismatch, 0 Attendance.
- Expired / unpaid member → denied, 0 Attendance.
- Unregistered dev_id and status:"disabled" → 200 OK ACK, 0 Attendance.
G5 — ACK contract
- Every one of the above returned HTTP 200 + response_code: OK + Content-Length: 0, with no 4xx and no 5xx.
- No unhandledRejection or express error in the server log during the abuse run.
G6 — K30 non-regression (blocks deploy if scanner.service.js changed)
- Physical K30 pushed ATTLOG to the local backend → 200, body OK\n, correct branchCode.
- /iclock/getrequest returned OK; a pending DeviceCommand was still delivered and acknowledged.
- A K30 with fkwebAcceptAfter: null still creates attendance (test/fkweb.test.js:1169).
- An RS9n backlog drain neither blocks nor pollutes K30 attendance (test/fkweb.test.js:1192).
G7 — Isolation
- Work was done against a local MongoDB. No production URI was used at any point.
- No production data was read, written, or deleted.
- Nothing was committed, pushed, or deployed as part of this investigation.
G8 — Production readiness
- Render env has RENDER=true → the 8082 ADMS listener is skipped (server.js:559) and /iclock is served from the main port. Unchanged from the current production setup.
- The RS9n's production URL is unchanged until after the deploy.
- The Danbaba RS9n stays pointed at the laptop for the whole Render deploy. Only repoint it once Render is verified healthy. This decouples "the code is wrong" from "the network is wrong".
- First Render verification must be with fkwebAcceptAfter still null. Confirm on Render that the console shows scanner=<id> branch=OLD and reason=cutoff_not_activated. That single log pair proves the RS9n reached Render and that the edge preserved the request_code / dev_id headers (Unknown #6) without writing a single Attendance row.
- Only then activate the cutoff on Render.
G9 — Documentation
- The verify_mode semantics (Unknown #2) are confirmed with the vendor. If 2 is not "card", the VERIFY_MODE_TO_EVENT_TYPE map and any existing RS9n eventType values need correcting before meaningful volume accrues — after that it needs a backfill.
Bottom line: your local code already understands the real RS9n realtime_glog packet, including the leading e. The parser needs no change. What is missing is data (member deviceUserId), an operator action (cutoff activation), and a test that uses the actual bytes the device sends. Do Phase 0–3 locally before anything touches Render.
▣  Build · Big Pickle · 10m 58s