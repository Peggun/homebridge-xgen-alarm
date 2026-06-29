# homebridge-xgen-alarm

A Homebridge platform plugin for alarm panels that expose a local "xGen" web
UI (`/login.cgi`, `/user/*.json`, `/user/keyfunction.cgi`) — the kind of
local web interface seen on some UltraSync+ compatible panels.

Built directly against the panel's own `master.js`/`status.js`, not
guesswork — see "How it works" below for the full protocol writeup.

## Features

- HomeKit Security System accessory: Arm Away, Arm Stay, Disarm.
- Lightweight polling (mirrors the panel's own `seq.json`/`status.json`
  dance, not a full re-login every cycle).
- Self-healing session handling — automatically logs in again if the
  session expires, instead of failing forever (see "The 302 bug" below).
- Push notifications (ntfy / Pushover / generic webhook) when the alarm is
  triggered, as a backup to HomeKit's own built-in notification.
- A full offline test suite + an interactive simulated-panel mode, so you
  can test changes without touching the real alarm.

## How it works

```
Homebridge
   └─ XGenAlarmPlatform (lib/platform.js)
        ├─ HomeKit Security System service: maps HAP characteristics
        │  to/from the friendly state strings below
        ├─ Notifier (lib/notifier.js): fires on the disarmed→triggered edge
        └─ XGenClient (lib/xgenClient.js): all the panel HTTP protocol
```

**Login:** `POST /login.cgi` with `lgname`/`lgpin` → an HTML page whose
inline JS exposes the initial status and a `getSession()` token.

**Session:** every later request is `POST` with body `sess=<token>[&extra]`
— there's no cookie auth, the token is a request parameter (this mirrors
`newAJAXCommand()` in the panel's own `master.js`).

**Polling:** `POST /user/seq.json` returns a sequence number per 8-area
"bank". Only banks whose number changed get fetched via
`POST /user/status.json` (`arsel=<bank>`) — the same lazy-update dance the
panel's own dashboard does.

**Arm/Disarm:** `POST /user/keyfunction.cgi` with
`fnum=<n>&start=<bank>&mask=<bit>`. Confirmed function numbers: **15 = Arm
Away, 1 = Arm Stay, 0 = Disarm** (overridable via config if your firmware
variant differs — see Config reference).

**State decoding:** each area's status lives as individual bits inside a
hex string (`bankstates`) — armed-away, armed-stay, night, alarm,
exit-delay, chime, fault, all decoded per the offsets the panel's own
`updateArea()` function reads. Internal state strings are one of:
`DISARMED`, `STAY_ARM`, `AWAY_ARM`, `NIGHT_ARM`, `ALARM_TRIGGERED` — see
`XGenClient.STATE_LABELS` for the human-readable text used in logs
("Disarmed", "Armed Stay", "Armed Away", "Armed Night", "Alarm Triggered").

There's no confirmed *command* for Night arm — the web UI only has
Away/Stay/Off/Chime buttons — so Night is reported as a possible *current*
state (in case the physical keypad puts it there) but isn't offered as
something HomeKit can request.

## The 302 bug (read this if you've seen "status poll failed: ... HTTP status 302")

**What happened:** Node's HTTP client doesn't auto-follow redirects the
way a browser does. When the panel's session expires, it answers
`/user/seq.json` with an HTTP `302` redirecting to the login page. A
browser's XHR follows that transparently; our raw HTTP client just saw a
302 and (in the old version of this plugin) gave up. Since nothing ever
logged in again, **every poll after the first expiry failed forever**,
which is why it filled the log.

**The fix:** `XGenClient._authedPost()` now treats an HTTP 3xx response
(or a 200 whose body is the login page itself — the *other* way the panel
signals an expired session) as "log in again," then retries the request
once. This is the literal browser behavior, just made explicit. See
`test/run-tests.js`'s "Reproducing the reported bug" suite, which
deliberately expires a session against a simulated panel and asserts the
client recovers instead of throwing.

**Why your log won't fill up anymore, even for *other* kinds of
failures:** on top of the actual fix above, `XGenAlarmPlatform` now
throttles repeated identical poll errors — see `_reportPollFailure()` in
`lib/platform.js`. The first occurrence of a new error logs at `error`
level immediately. If the *same* error keeps happening every poll (a
sustained network outage, say), only every 20th occurrence logs again (at
the softer `warn` level) — everything in between drops to `debug`
(invisible unless you run Homebridge with `-D`). A change back to success
logs a one-line "recovered after N failed attempts."

## Testing locally — no real panel required

Everything below runs entirely in-process against a simulated panel.
Nothing touches your real alarm, so this is safe to run any time —
including at 2am without waking anyone up.

### Automated test suite

```bash
cd homebridge-xgen-alarm
npm install
npm test
```

This runs ~19 checks covering: login/decode against your actual captured
state, a full arm/disarm cycle, **the exact 302 session-expiry bug and its
fix** (reproduced against a fake server that returns the same 302 your
real panel did), HomeKit state mapping, notification firing (once on the
rising edge, not repeated, refires after a clear+retrigger), and the log
throttling behavior. All should print ✅.

### Interactive simulated panel

For poking around by hand:

Terminal 1: start the mock server and watch state:

```bash
node test-connection.js --mock --watch
```

Terminal 2: send commands against the mock server (use the port from terminal 1):

```bash
node test-connection.js --host 127.0.0.1 --port <PORT from previous> --user <mockuser> or <USER from previous> --pin <0000> or <PIN from previous> --command <cmd>
# example
node test-connection.js --host 127.0.0.1 --port 30000 --user mockuser --pin 0000 --command disarm
```

You can also just log in and print the decoded state:

```bash
node test-connection.js --mock
```

Other simulated actions:

```bash
# Reproduce tonight's exact bug and watch the auto-recovery happen
node test-connection.js --mock --expire-session

# See the ALARM_TRIGGERED state (and exercise the notifier, if configured)
node test-connection.js --mock --trigger-alarm
```

### Against the real panel (once you're ready)

Same script, without `--mock`:

```bash
node test-connection.js --host 192.168.1.50 --user master --pin 1234
node test-connection.js --host 192.168.1.50 --user master --pin 1234 --watch
node test-connection.js --host 192.168.1.50 --user master --pin 1234 --command stay   # ⚠️ real command, 3s countdown to abort
```

## Installing into Homebridge

```bash
cd homebridge-xgen-alarm
npm install
sudo npm link
```

Then, wherever Homebridge runs:

```bash
sudo npm link homebridge-xgen-alarm
```

This needs to happen in the same global npm prefix Homebridge uses to find
plugins (Homebridge UI: Settings → "Plugin Path"; manual/systemd installs:
usually wherever `npm root -g` points for the Homebridge user; Docker:
mount/copy this folder into the plugin volume; HOOBS: copy directly into
HOOBS's plugin folder). If `npm link` isn't convenient, copying the whole
folder straight into Homebridge's `node_modules` works just as well —
nothing here needs compiling.

Add the platform block to `config.json` (or use the form
`config.schema.json` generates automatically in Homebridge UI):

```json
{
  "platforms": [
    {
      "platform": "XGenAlarm",
      "name": "Home Alarm",
      "host": "192.168.1.50",
      "protocol": "http",
      "port": 80,
      "username": "master",
      "pin": "1234",
      "areaIndex": 1,
      "pollIntervalSeconds": 15,
      "notifications": {
        "enabled": true,
        "service": "ntfy",
        "ntfy": { "topic": "your-private-topic-name" }
      }
    }
  ]
}
```

Restart Homebridge and check the log for `XGenAlarm: logged in
successfully.`

### Testing safely from HomeKit

Tap **Disarm** first (safe no-op if already disarmed), confirm the log
shows `XGenAlarm: sent Disarmed for area 1` and the Home app reflects it.
Then try Stay before ever trying Away — Away will trigger real sensors if
you walk past them.

## Notifications setup

HomeKit already notifies you automatically when a Security System
accessory goes into the "Triggered" state — **enable it once** in the Home
app: tap the accessory → Notifications → on. That's free and needs no
config here.

The `notifications` block adds an independent second path (useful for
Android, for redundancy, or if you just want it). Pick one `service`:

**ntfy** (easiest — no signup):
```json
"notifications": { "enabled": true, "service": "ntfy", "ntfy": { "topic": "pick-a-private-topic-name" } }
```
Then subscribe to that topic in the [ntfy app](https://ntfy.sh/) or
website. Topic names are unauthenticated by default, so pick something
non-guessable, or run `ntfy.server` pointed at your own self-hosted
instance.

## Config reference

| Key | Required | Default | Notes |
|---|---|---|---|
| `host` | yes | — | Panel IP or hostname |
| `protocol` | no | `http` | `http` or `https` |
| `port` | no | 80/443 | |
| `rejectUnauthorized` | no | `true` | Set `false` for a self-signed HTTPS cert |
| `username` | yes | — | `lgname` |
| `pin` | yes | — | `lgpin` |
| `areaIndex` | no | `1` | 1-based area number, matching the panel's own numbering |
| `pollIntervalSeconds` | no | `15` | Uses the lightweight seq.json/status.json calls |
| `fnumAway` / `fnumStay` / `fnumDisarm` | no | `15` / `1` / `0` | Override only if your firmware variant differs |
| `notifications.enabled` | no | `false` | |
| `notifications.service` | no | — | `ntfy` \| `pushover` \| `webhook` |
| `notifications.ntfy` | no | — | See "Notifications setup" above |

## Security notes

- Your PIN is stored in plaintext in Homebridge's `config.json`, same as
  any password-based Homebridge plugin. Keep that file's permissions
  tight, and consider a dedicated lower-privilege user code on the panel
  rather than your master code, if it supports one.
- This plugin only talks to your panel on the local network; notifications
  (if enabled) talk to whichever service you configured.
- The session token is logged at debug level only — be mindful if sharing
  logs captured with `-D`.

## Possible next steps

- **Chime toggle as a HomeKit Switch** — controlled the same way
  (`fnum=10`/`11` via `keyfunction.cgi`), just not wired into the Security
  System service yet.
- **Per-zone contact sensors** — the panel exposes equivalent zone decode
  logic (`zoneStatus` bit tables, `/user/zstate.json`,
  `/user/zonefunction.cgi`) if you want individual door/window sensors.
- **"Alarm cleared" notification** — currently only the trigger fires a
  notification; an all-clear message would be easy to add the same way.