'use strict';

const http = require('http');
const https = require('https');

/**
 * XGenClient talks to an alarm panel's local "xGen" web UI — the same
 * endpoints its own browser-based dashboard uses (login.cgi, /user/*.json,
 * /user/keyfunction.cgi). Everything here was reverse-engineered from the
 * panel's own master.js/status.js, not guessed.
 *
 * --- Protocol summary ---------------------------------------------------
 *
 * Login:
 *   POST /login.cgi  body: `lgname=<user>&lgpin=<pin>`
 *   → HTML page with inline JS exposing the initial status snapshot and
 *     a `getSession()` function returning the session token.
 *
 * Session:
 *   Every subsequent call is a POST whose body always starts with
 *   `sess=<token>`, optionally followed by `&<extra params>` (this mirrors
 *   `newAJAXCommand()` in master.js). There is no cookie-based auth — the
 *   token is a plain request parameter.
 *
 * Polling (lightweight):
 *   POST /user/seq.json  body: `sess=...`
 *   → `{ area: [seq, ...], zone: [seq, ...] }`, one sequence number per
 *     8-area "bank". When a bank's number changes:
 *   POST /user/status.json  body: `sess=...&arsel=<bankIndex>`
 *   → `{ abank, aseq, bankstates, system }` — that bank's fresh state.
 *
 * Arm / Disarm:
 *   POST /user/keyfunction.cgi  body: `sess=...&fnum=<n>&start=<bankIndex>&mask=<bitmask>`
 *   where `start = floor((area-1)/8)` and `mask = 1 << ((area-1) % 8)`
 *   locate the target area within its bank. Confirmed function numbers
 *   from the button wiring in status.js: 15 = Arm Away, 1 = Arm Stay,
 *   0 = Disarm. The response is shaped just like /user/status.json's.
 *
 * Session expiry:
 *   The panel signals an expired/invalid session two different ways
 *   depending on the endpoint:
 *     (a) HTTP 3xx redirect (typically to /login.htm) — a browser's XHR
 *         follows this transparently and never sees the 3xx itself; we
 *         have to detect and handle it ourselves (see _isSessionExpired).
 *     (b) HTTP 200 whose body is the login page itself
 *         (starts with "<!DOCTYPE") rather than the expected JSON/JS.
 *   Either case normally triggers an automatic re-login + one retry — see
 *   _authedPost(). This is what stops an expired session from turning
 *   into an endless stream of failed-poll log lines.
 *
 * Session contention (single-session panels):
 *   This panel only appears to track one active session globally — there's
 *   no per-client/per-IP isolation, so logging in from anywhere (this
 *   plugin, or you in a browser on the panel's own web UI) invalidates
 *   whoever was logged in before. That's a firmware limitation; nothing a
 *   client can do changes how many sessions the panel is willing to hold.
 *
 *   What *is* under our control is how aggressively we fight to get the
 *   session back. The original self-healing logic re-logs in the instant
 *   it notices an expired session — which is exactly right for a genuine
 *   idle timeout, but means that if a human logs into the panel's own web
 *   UI while this plugin is polling, the plugin will immediately log back
 *   in and kick them straight back out, every single poll, forever.
 *
 *   _authedPost() now tells those two cases apart by how long the session
 *   actually lasted: a session that dies within
 *   `sessionContentionThresholdMs` of us obtaining it (default 30s — far
 *   shorter than this would ever idle out while polling every 15s) is
 *   almost certainly someone else grabbing it, not a timeout. In that
 *   case we back off instead of relogging in immediately, for
 *   `sessionContentionBaseBackoffMs` (default 60s), doubling on each
 *   further rapid takeover up to `sessionContentionMaxBackoffMs` (default
 *   10 min) — so a human using the panel's web UI gets a growing window of
 *   uninterrupted access instead of being bounced every poll cycle.
 *   Explicit HomeKit commands (arm/disarm) bypass this backoff, since
 *   those represent something you're actively doing right now, not
 *   opportunistic background polling.
 *
 * bankstates bit layout:
 *   A long hex string, one nibble-pair ("byte") per status flag, with one
 *   *bit* per area within that byte (bit n = area n+1 within the bank).
 *   Offsets confirmed from status.js's updateArea():
 *     byte 0  (chars 0-2)   = "ready" (armable / no faults open)
 *     byte 2  (chars 4-6)   = Stay/partial-armed
 *     byte 3  (chars 6-8)   = Away/full-armed
 *     byte 4  (chars 8-10)  = exit delay running (phase 1)
 *     byte 5  (chars 10-12) = exit delay running (phase 2)
 *     bytes 8-11 (16-24)    = alarm conditions (any set = triggered)
 *     byte 18 (chars 36-38) = chime enabled
 *     byte 26 (chars 52-54) = "night" sub-mode of stay-armed
 *     byte 27 (chars 54-56) = walk-test mode
 *     byte 32 (chars 64-66) = fault/warning ("yellow")
 *     bytes 33-36 (66-74)   = entry-delay / info ("blue")
 */
class XGenClient {
  /**
   * @param {object} options
   * @param {string} options.host - Panel IP/hostname.
   * @param {'http'|'https'} [options.protocol='http']
   * @param {number} [options.port] - Defaults to 80 (http) / 443 (https).
   * @param {string} options.username - lgname.
   * @param {string} options.pin - lgpin.
   * @param {boolean} [options.rejectUnauthorized=true] - Set false for a
   *   self-signed HTTPS cert.
   * @param {number} [options.fnumAway=15] - /user/keyfunction.cgi fnum for Arm Away.
   * @param {number} [options.fnumStay=1] - fnum for Arm Stay.
   * @param {number} [options.fnumDisarm=0] - fnum for Disarm.
   * @param {number} [options.sessionContentionThresholdMs=30000] - A
   *   session that dies within this long of us obtaining it is treated as
   *   "someone else grabbed it" rather than a normal idle timeout.
   * @param {number} [options.sessionContentionBaseBackoffMs=60000] - How
   *   long to back off after the *first* rapid takeover.
   * @param {number} [options.sessionContentionMaxBackoffMs=600000] - Cap
   *   on the (doubling) backoff after repeated rapid takeovers.
   * @param {Console|object} [log] - Homebridge logger, or console.
   */
  constructor(options, log) {
    this.host = options.host;
    this.protocol = options.protocol === 'https' ? 'https' : 'http';
    this.port = options.port || (this.protocol === 'https' ? 443 : 80);
    this.username = options.username;
    this.pin = options.pin;
    this.rejectUnauthorized = options.rejectUnauthorized !== false;
    this.log = log || console;

    /** @type {string|null} Current session token from getSession(). */
    this.session = null;
    /** @type {Object<string,string>} Cookie jar — kept defensively even
     * though the confirmed protocol uses a `sess` param, not cookies, in
     * case a particular firmware variant also expects one. */
    this.cookies = {};

    /** @type {number[]} One sequence number per 8-area bank. */
    this.areaSequence = [];
    /** @type {string[]} One bankstates hex string per 8-area bank. */
    this.areaStatus = [];
    /** @type {string[]} Decoded area display names, 1 per area slot. */
    this.areaNames = [];
    /** @type {string[]} Decoded system status/fault messages. */
    this.sysStatus = [];

    // Function numbers used by /user/keyfunction.cgi — overridable in
    // config in case a firmware variant differs from the confirmed one.
    this.fnumAway = options.fnumAway != null ? options.fnumAway : 15;
    this.fnumStay = options.fnumStay != null ? options.fnumStay : 1;
    this.fnumDisarm = options.fnumDisarm != null ? options.fnumDisarm : 0;

    // --- Session contention backoff (see class doc comment) ------------
    /** @type {number} Timestamp (ms) of our most recent successful login. */
    this._lastLoginAt = 0;
    /** @type {number} Consecutive rapid takeovers, for the doubling backoff. */
    this._contentionStrikes = 0;
    /** @type {number} Timestamp (ms) until which we deliberately won't
     * try to reclaim the session. */
    this._backoffUntil = 0;

    this.sessionContentionThresholdMs =
      options.sessionContentionThresholdMs != null ? options.sessionContentionThresholdMs : 30 * 1000;
    this.sessionContentionBaseBackoffMs =
      options.sessionContentionBaseBackoffMs != null ? options.sessionContentionBaseBackoffMs : 60 * 1000;
    this.sessionContentionMaxBackoffMs =
      options.sessionContentionMaxBackoffMs != null ? options.sessionContentionMaxBackoffMs : 10 * 60 * 1000;
  }

  /**
   * Human-friendly label for one of the state strings deriveState()
   * returns. Used anywhere *we* control the displayed text (Homebridge
   * logs, the test scripts) — this can't change what the Apple Home app's
   * own Off/Home/Away segmented control says, since those particular
   * strings are fixed by Apple, not exposed to accessories via HomeKit.
   * @param {string} state - One of XGenClient.STATES.
   * @returns {string}
   */
  static labelFor(state) {
    return XGenClient.STATE_LABELS[state] || state;
  }

  // ---------------------------------------------------------------------
  // Cookie jar (defensive — see constructor doc comment)
  // ---------------------------------------------------------------------

  _cookieHeader() {
    return Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  _storeCookies(setCookieHeaders) {
    if (!setCookieHeaders) return;
    const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    for (const line of list) {
      const pair = line.split(';')[0];
      const idx = pair.indexOf('=');
      if (idx > -1) {
        this.cookies[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
      }
    }
  }

  // ---------------------------------------------------------------------
  // Low-level HTTP
  // ---------------------------------------------------------------------

  /**
   * Issues a single raw HTTP(S) request. Does NOT follow redirects and
   * does NOT throw on non-2xx — callers decide what a given status means
   * (see _isSessionExpired / _authedPost), exactly because this panel uses
   * a 3xx redirect as one of its two "your session expired" signals.
   * @param {{method:string, path:string, body?:string, contentType?:string}} req
   * @returns {Promise<{statusCode:number, body:string, headers:object}>}
   */
  _request({ method, path, body, contentType }) {
    return new Promise((resolve, reject) => {
      const lib = this.protocol === 'https' ? https : http;
      const headers = {};
      if (body) {
        headers['Content-Type'] = contentType || 'application/x-www-form-urlencoded';
        headers['Content-Length'] = Buffer.byteLength(body);
      }
      const cookieHeader = this._cookieHeader();
      if (cookieHeader) headers['Cookie'] = cookieHeader;

      const reqOptions = {
        hostname: this.host,
        port: this.port,
        path,
        method,
        headers,
        timeout: 10000,
      };
      if (this.protocol === 'https') {
        reqOptions.rejectUnauthorized = this.rejectUnauthorized;
      }

      const req = lib.request(reqOptions, (res) => {
        this._storeCookies(res.headers['set-cookie']);
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ statusCode: res.statusCode, body: data, headers: res.headers }));
      });
      req.on('timeout', () => req.destroy(new Error('Request timed out')));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  /**
   * True if `body` (a 200 response) is actually the login page rather
   * than real JSON/data — the same check master.js's pollAJAX() makes.
   * @param {string} body
   * @returns {boolean}
   */
  _isLoginPage(body) {
    return body.slice(0, 9).toUpperCase() === '<!DOCTYPE';
  }

  /**
   * True if `res` indicates the session has expired/was rejected, via
   * either of the two signals the panel uses: an HTTP 3xx redirect (what
   * a browser's XHR would silently follow), or a 200 whose body is the
   * login page itself. See the class doc comment, "Session expiry".
   * @param {{statusCode:number, body:string}} res
   * @returns {boolean}
   */
  _isSessionExpired(res) {
    if (res.statusCode >= 300 && res.statusCode < 400) return true;
    if (res.statusCode === 200 && this._isLoginPage(res.body)) return true;
    return false;
  }

  // ---------------------------------------------------------------------
  // Session contention backoff (see class doc comment)
  // ---------------------------------------------------------------------

  /**
   * True while we're deliberately staying off the panel after detecting
   * that someone else (almost always: a human in the panel's own web UI)
   * keeps grabbing the session back moments after we get it. Background
   * polling (_authedPost's default behaviour) respects this; explicit
   * commands can opt out — see sendAreaCommand().
   * @returns {boolean}
   */
  inSessionBackoff() {
    return Date.now() < this._backoffUntil;
  }

  /**
   * @returns {number} Seconds remaining in the current backoff window (0
   *   if not currently backing off). Only meaningful for logging.
   */
  sessionBackoffRemainingSeconds() {
    return Math.max(0, Math.ceil((this._backoffUntil - Date.now()) / 1000));
  }

  // ---------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------

  /**
   * Logs in and parses the initial status snapshot the panel returns.
   * Populates session/areaNames/areaStatus/areaSequence/sysStatus.
   * @returns {Promise<object>} The parsed status (see parseStatusPage).
   */
  async login() {
    const body = `lgname=${encodeURIComponent(this.username)}&lgpin=${encodeURIComponent(this.pin)}`;
    const res = await this._request({ method: 'POST', path: '/login.cgi', body });

    if (res.statusCode !== 200) {
      throw new Error(`Login failed with HTTP status ${res.statusCode}`);
    }

    const status = this.parseStatusPage(res.body);
    if (!status.session) {
      throw new Error(
        'Login response did not contain the expected status page — check the ' +
          'username/PIN, or this panel\'s firmware may differ from the capture ' +
          'this plugin was built against.'
      );
    }
    this.session = status.session;
    this.areaNames = status.areaNames;
    this.areaStatus = status.areaStatus;
    // The login page's areaSequence array seeds the cache the same way
    // master.js does, so the first /user/seq.json poll only fetches banks
    // that have actually changed since login.
    this.areaSequence = status.areaSequence;
    this.sysStatus = status.sysStatus;
    // Mark when we got this session, so the next expiry can be judged as
    // "normal timeout" vs. "someone else just took it" — see _authedPost.
    this._lastLoginAt = Date.now();
    return status;
  }

  /**
   * Logs out (best-effort — failures are swallowed, since there's nothing
   * useful to do about a failed logout other than let the session expire
   * naturally).
   * @returns {Promise<void>}
   */
  async logout() {
    if (!this.session) return;
    try {
      await this._request({ method: 'POST', path: '/logout.cgi', body: `sess=${this.session}` });
    } catch (err) {
      if (this.log.debug) this.log.debug(`XGenAlarm: logout request failed (ignoring): ${err.message}`);
    }
    this.session = null;
  }

  /**
   * POSTs `sess=<token>[&extra]` to `path`, exactly like master.js's
   * newAJAXCommand(), transparently logging in again (once) if the
   * session has expired. This is the single choke point that makes the
   * whole client self-healing after an expired session — see the class
   * doc comment's "Session expiry" section for why that's necessary.
   *
   * It's also where session-contention backoff lives — see "Session
   * contention" in the class doc comment. A session that dies within
   * `sessionContentionThresholdMs` of us obtaining it is treated as a
   * takeover (back off, don't relogin) rather than a normal expiry
   * (relogin immediately, as before).
   * @param {string} path
   * @param {string} [extra] - Additional `key=value` params, `&`-joined.
   * @param {object} [opts]
   * @param {boolean} [opts.allowDuringBackoff=false] - Bypass the backoff
   *   gate. Used for explicit user-initiated commands (arm/disarm), which
   *   should always get a real attempt rather than being silently skipped.
   * @returns {Promise<string>} The raw response body.
   */
  async _authedPost(path, extra, { allowDuringBackoff = false } = {}) {
    if (!allowDuringBackoff && this.inSessionBackoff()) {
      // Static message text (no live countdown) so repeated skips during
      // the same backoff window dedupe cleanly under the platform's
      // poll-failure throttling instead of logging an "error" every poll.
      throw new Error(
        'XGenAlarm: skipping request — backing off after the session was repeatedly taken over ' +
          "right after logging in (almost always means someone else is logged into the panel's own " +
          'web UI right now).'
      );
    }

    if (!this.session) await this.login();
    const buildBody = () => (extra ? `sess=${this.session}&${extra}` : `sess=${this.session}`);

    let res = await this._request({ method: 'POST', path, body: buildBody() });

    if (this._isSessionExpired(res)) {
      const ageMs = Date.now() - this._lastLoginAt;

      if (ageMs < this.sessionContentionThresholdMs) {
        // Logged in only moments ago and already kicked out again — that
        // isn't a normal idle timeout (we poll far more often than this
        // panel could plausibly time out), it's someone else grabbing the
        // session, almost certainly a human on the panel's own web UI.
        // Relogging in right now would just kick them straight back out
        // again — the endless tug-of-war this exists to avoid. Back off
        // instead, for longer each time this keeps happening.
        this._contentionStrikes++;
        const backoffMs = Math.min(
          this.sessionContentionBaseBackoffMs * 2 ** (this._contentionStrikes - 1),
          this.sessionContentionMaxBackoffMs
        );
        this._backoffUntil = Date.now() + backoffMs;
        throw new Error(
          `XGenAlarm: session was taken over ${Math.round(ageMs / 1000)}s after logging in — likely ` +
            `someone else is using the panel's web UI. Backing off ${Math.round(backoffMs / 1000)}s ` +
            `before trying again (strike ${this._contentionStrikes}).`
        );
      }

      // A genuinely "normal" expiry — reset the contention counter and do
      // the original self-healing relogin.
      this._contentionStrikes = 0;
      if (this.log.debug) {
        const where = res.headers && res.headers.location ? ` (redirected to ${res.headers.location})` : '';
        this.log.debug(`XGenAlarm: session expired while calling ${path}${where} — logging in again.`);
      }
      await this.login();
      res = await this._request({ method: 'POST', path, body: buildBody() });
    } else {
      // A successful authed call means the session is currently stable —
      // relax the contention counter rather than letting old strikes
      // linger indefinitely.
      this._contentionStrikes = 0;
    }

    if (res.statusCode !== 200) {
      throw new Error(`Request to ${path} failed with HTTP status ${res.statusCode}`);
    }
    if (this._isLoginPage(res.body)) {
      throw new Error(`Request to ${path} was redirected to the login page even after logging in again.`);
    }
    return res.body;
  }

  /**
   * @param {string} body
   * @param {string} context - Used in the error message if parsing fails.
   * @returns {object}
   */
  _parseJson(body, context) {
    try {
      return JSON.parse(body);
    } catch (err) {
      throw new Error(`Could not parse JSON from ${context}: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------
  // Status polling
  // ---------------------------------------------------------------------

  /**
   * Mirrors checkAreaSeq()/updateAstate() in status.js: ask which banks
   * changed since we last looked, then pull fresh state only for those.
   * Updates this.areaStatus / this.areaSequence / this.sysStatus in place.
   *
   * Background polling, so this respects session-contention backoff (see
   * _authedPost) — a skipped poll surfaces as a regular (throttle-
   * friendly) error through the normal poll-failure path.
   * @returns {Promise<{areaNames:string[], areaStatus:string[], sysStatus:string[]}>}
   */
  async refreshStatus() {
    const seqBody = await this._authedPost('/user/seq.json');
    const seq = this._parseJson(seqBody, '/user/seq.json');
    const seqArray = seq.area || [];

    for (let i = 0; i < seqArray.length; i++) {
      if (seqArray[i] === this.areaSequence[i]) continue;
      const statusBody = await this._authedPost('/user/status.json', `arsel=${i}`);
      const data = this._parseJson(statusBody, '/user/status.json');
      this.areaSequence[data.abank] = data.aseq;
      this.areaStatus[data.abank] = data.bankstates;
      this.sysStatus = this._decodeStringArray(data.system || []);
    }

    return {
      areaNames: this.areaNames,
      areaStatus: this.areaStatus,
      sysStatus: this.sysStatus,
    };
  }

  // ---------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------

  /**
   * Sends an arm-away / arm-stay / disarm command for a single (1-based)
   * area number, via /user/keyfunction.cgi.
   *
   * Unlike background polling, this bypasses session-contention backoff
   * (`allowDuringBackoff: true`) — this is something you're actively
   * doing right now from HomeKit, not opportunistic polling, so it should
   * always get a real attempt against the panel rather than being
   * silently skipped because someone else was recently using the web UI.
   * @param {'AWAY_ARM'|'STAY_ARM'|'DISARMED'} action
   * @param {number} areaNumber - 1-based, matching the panel's own numbering.
   * @returns {Promise<object>} The parsed `{abank, aseq, bankstates, system}` response.
   */
  async sendAreaCommand(action, areaNumber) {
    const fnumMap = { AWAY_ARM: this.fnumAway, STAY_ARM: this.fnumStay, DISARMED: this.fnumDisarm };
    const fnum = fnumMap[action];
    if (fnum == null) {
      throw new Error(`Unsupported action "${action}" — this panel's web UI only exposes Away/Stay/Disarm.`);
    }

    const start = Math.floor((areaNumber - 1) / 8);
    const mask = 1 << ((areaNumber - 1) % 8);
    const body = await this._authedPost(
      '/user/keyfunction.cgi',
      `fnum=${fnum}&start=${start}&mask=${mask}`,
      { allowDuringBackoff: true }
    );
    const data = this._parseJson(body, '/user/keyfunction.cgi');

    this.areaSequence[data.abank] = data.aseq;
    this.areaStatus[data.abank] = data.bankstates;
    this.sysStatus = this._decodeStringArray(data.system || []);
    return data;
  }

  // ---------------------------------------------------------------------
  // Decoding
  // ---------------------------------------------------------------------

  /**
   * URL-decodes every string in an array, leaving non-strings untouched.
   * Falls back to the original value if decoding fails.
   * @param {Array<string|*>} arr
   * @returns {Array<string|*>}
   */
  _decodeStringArray(arr) {
    return arr.map((v) => {
      if (typeof v !== 'string') return v;
      try {
        return decodeURIComponent(v);
      } catch (e) {
        return v;
      }
    });
  }

  /**
   * Decodes a single area's status bits out of its bank's bankstates hex
   * string. See the class doc comment for the full offset table.
   * @param {number} areaNumber - 1-based.
   * @returns {?{ready:boolean, armedStay:boolean, armedAway:boolean,
   *   exitDelay:boolean, chime:boolean, night:boolean, walkTest:boolean,
   *   fault:boolean, alarm:boolean}} null if this area's bank hasn't been
   *   loaded yet (e.g. before the first login/poll completes).
   */
  decodeAreaState(areaNumber) {
    const bank = Math.floor((areaNumber - 1) / 8);
    const mask = 1 << ((areaNumber - 1) % 8);
    const hex = this.areaStatus[bank];
    if (!hex) return null;

    const byteAt = (offset) => parseInt(hex.substring(offset, offset + 2), 16) || 0;
    const bitSet = (offset) => (byteAt(offset) & mask) !== 0;

    return {
      ready: bitSet(0),
      armedStay: bitSet(4),
      armedAway: bitSet(6),
      exitDelay: bitSet(8) || bitSet(10),
      chime: bitSet(36),
      night: bitSet(52),
      walkTest: bitSet(54),
      fault: bitSet(64),
      alarm: bitSet(16) || bitSet(18) || bitSet(20) || bitSet(22),
    };
  }

  /**
   * Best-effort mapping from decoded bits to one of XGenClient.STATES for
   * a single area. Alarm takes priority over everything else; armed-away
   * over armed-stay; "night" is reported as a distinct *current* state
   * (even though there's no confirmed way to *request* it — see README).
   * @param {number} areaNumber - 1-based.
   * @returns {string} One of XGenClient.STATES.
   */
  deriveState(areaNumber) {
    const bits = this.decodeAreaState(areaNumber);
    if (!bits) return 'DISARMED';
    if (bits.alarm) return 'ALARM_TRIGGERED';
    if (bits.armedAway) return 'AWAY_ARM';
    if (bits.armedStay) return bits.night ? 'NIGHT_ARM' : 'STAY_ARM';
    return 'DISARMED';
  }

  /**
   * Parses the inline-JS status snapshot out of an HTML page (either the
   * login.cgi response, or — defensively — any other page that happens to
   * embed the same variables).
   * @param {string} html
   * @returns {{session:?string, areaNames:string[], areaStatus:string[],
   *   areaSequence:number[], sysStatus:string[], raw:string}}
   */
  parseStatusPage(html) {
    const grab = (re) => {
      const m = html.match(re);
      return m ? m[1] : null;
    };

    const session = grab(/function\s+getSession\s*\(\s*\)\s*\{\s*return\s*"([^"]*)"/);
    const areaNamesRaw = grab(/var\s+areaNames\s*=\s*(\[[^\]]*\])\s*;/);
    const areaStatusRaw = grab(/var\s+areaStatus\s*=\s*(\[[^\]]*\])\s*;/);
    const areaSequenceRaw = grab(/var\s+areaSequence\s*=\s*(\[[^\]]*\])\s*;/);
    const sysStatusRaw = grab(/var\s+sysStatus\s*=\s*(\[[^\]]*\])\s*;/);

    const safeJsonArray = (raw) => {
      if (!raw) return [];
      try {
        return JSON.parse(raw);
      } catch (e) {
        return [];
      }
    };

    return {
      session,
      areaNames: this._decodeStringArray(safeJsonArray(areaNamesRaw)),
      areaStatus: safeJsonArray(areaStatusRaw),
      areaSequence: safeJsonArray(areaSequenceRaw),
      sysStatus: this._decodeStringArray(safeJsonArray(sysStatusRaw)),
      raw: html,
    };
  }
}

/** All state strings deriveState()/decodeAreaState() can produce. */
XGenClient.STATES = ['DISARMED', 'STAY_ARM', 'AWAY_ARM', 'NIGHT_ARM', 'ALARM_TRIGGERED'];

/** Human-friendly display text for each state — see labelFor(). */
XGenClient.STATE_LABELS = Object.freeze({
  DISARMED: 'Disarmed',
  STAY_ARM: 'Armed Stay',
  AWAY_ARM: 'Armed Away',
  NIGHT_ARM: 'Armed Night',
  ALARM_TRIGGERED: 'Alarm Triggered',
});

module.exports = XGenClient;