'use strict';

const XGenClient = require('./xgenClient');
const Notifier = require('./notifier');

const PLATFORM_NAME = 'XGenAlarm';
const PLUGIN_NAME = 'homebridge-xgen-alarm';

/**
 * Homebridge dynamic platform exposing one alarm panel area as a HomeKit
 * Security System accessory. See lib/xgenClient.js for the actual wire
 * protocol; this file is just HomeKit/Homebridge plumbing around it:
 * accessory/service setup, state mapping, polling, and alarm
 * notifications.
 */
class XGenAlarmPlatform {
  /**
   * @param {object} log - Homebridge logger.
   * @param {object} config - This platform's block from config.json.
   * @param {object} api - The Homebridge API instance.
   */
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = [];

    if (!this.config.host || !this.config.username || !this.config.pin) {
      this.log.warn('XGenAlarm: host, username and pin are all required — platform disabled.');
      return;
    }

    this.client = new XGenClient(
      {
        host: this.config.host,
        port: this.config.port,
        protocol: this.config.protocol || 'http',
        username: this.config.username,
        pin: this.config.pin,
        rejectUnauthorized: this.config.rejectUnauthorized !== false,
        fnumAway: this.config.fnumAway,
        fnumStay: this.config.fnumStay,
        fnumDisarm: this.config.fnumDisarm,
        // How the plugin behaves when something else (almost always: you,
        // logged into the panel's own web UI) keeps grabbing the single
        // session this panel supports — see "Session contention" in
        // lib/xgenClient.js's class doc comment. Sensible defaults apply
        // if these are left unset.
        sessionContentionThresholdMs: this.config.sessionContentionThresholdMs,
        sessionContentionBaseBackoffMs: this.config.sessionContentionBaseBackoffMs,
        sessionContentionMaxBackoffMs: this.config.sessionContentionMaxBackoffMs,
      },
      this.log
    );

    this.notifier = new Notifier(this.config.notifications, this.log);

    // 1-based area number, matching the numbering used by the panel's own
    // web UI (area 1 = first non-"!" entry in areaNames).
    this.areaNumber = this.config.areaIndex != null ? this.config.areaIndex : 1;
    this.pollInterval = (this.config.pollIntervalSeconds || 15) * 1000;

    // Tracks the previous *raw* derived state (one of XGenClient.STATES)
    // purely so we can edge-detect "just became triggered" for
    // notifications, and "changed at all" for the state-change log line —
    // separate from the HAP-encoded lastCurrentState/lastTargetState below.
    this._lastDerivedState = null;

    // Poll-failure log throttling — see _reportPollFailure(). Without
    // this, a sustained failure (e.g. a session that keeps expiring, or
    // the panel being briefly unreachable) would log an error every single
    // poll interval forever. This also naturally throttles the repeated
    // "skipping request, backing off..." message XGenClient produces
    // while it's deliberately staying off the panel during session
    // contention, since that message stays identical for the duration of
    // a given backoff window.
    this._consecutivePollFailures = 0;
    this._lastPollErrorMessage = null;

    if (this.api) {
      this.api.on('didFinishLaunching', () => this.discoverDevices());
    }
  }

  /**
   * Required by Homebridge: called once per cached accessory from a
   * previous launch, before didFinishLaunching fires.
   * @param {object} accessory
   */
  configureAccessory(accessory) {
    this.accessories.push(accessory);
  }

  /**
   * Creates (or reuses, if cached) the platform accessory and its
   * Security System service, performs the initial login, and starts the
   * polling loop.
   * @returns {Promise<void>}
   */
  async discoverDevices() {
    const uuid = this.api.hap.uuid.generate('xgen-alarm-' + this.config.host + '-' + this.areaNumber);
    let accessory = this.accessories.find((a) => a.UUID === uuid);

    if (!accessory) {
      accessory = new this.api.platformAccessory(this.config.name || 'Alarm Panel', uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    }

    this.setupSecurityService(accessory);

    try {
      await this.client.login();
      this.log.info('XGenAlarm: logged in successfully.');
    } catch (err) {
      this.log.error(`XGenAlarm: initial login failed: ${err.message}`);
    }

    this.startPolling();
  }

  /**
   * Wires up the HomeKit SecuritySystem service's characteristics:
   * CurrentState (read-only, driven by polling) and TargetState
   * (settable — Away/Stay/Disarm only, see the comment below on why
   * Night isn't offered as something HomeKit can request).
   * @param {object} accessory
   */
  setupSecurityService(accessory) {
    const { Service, Characteristic } = this.api.hap;
    const service =
      accessory.getService(Service.SecuritySystem) || accessory.addService(Service.SecuritySystem);

    this.currentStateChar = service.getCharacteristic(Characteristic.SecuritySystemCurrentState);
    this.targetStateChar = service.getCharacteristic(Characteristic.SecuritySystemTargetState);
    
    const modes = this.config.availableModes || ['away', 'stay', 'off'];
    const validValues = [];

    modes.forEach((mode) => {
      switch (mode.toLowerCase()) {
        case 'stay':
          validValues.push(Characteristic.SecuritySystemTargetState.STAY_ARM);
          break;
        case 'away':
          validValues.push(Characteristic.SecuritySystemTargetState.AWAY_ARM);
          break;
        case 'night':
          validValues.push(Characteristic.SecuritySystemTargetState.NIGHT_ARM);
          break;
        case 'off':
        case 'disarm':
          validValues.push(Characteristic.SecuritySystemTargetState.DISARM);
          break;
      }
    });

    if (validValues.length === 0) {
      validValues.push(Characteristic.SecuritySystemTargetState.DISARM);
    }

    this.targetStateChar.setProps({
      validValues,
    });

    this.currentStateChar.onGet(
      () => this.lastCurrentState ?? Characteristic.SecuritySystemCurrentState.DISARMED
    );

    this.targetStateChar.onGet(
      () => this.lastTargetState ?? Characteristic.SecuritySystemTargetState.DISARM
    );
    this.targetStateChar.onSet(async (value) => {
      await this.handleSetTargetState(value);
    });

    this.securityService = service;
  }

  /**
   * Maps one of XGenClient.STATES to the HAP SecuritySystemCurrentState
   * enum value.
   * @param {string} state
   * @returns {number}
   */
  mapToHapCurrent(state) {
    const { Characteristic } = this.api.hap;
    switch (state) {
      case 'AWAY_ARM':
        return Characteristic.SecuritySystemCurrentState.AWAY_ARM;
      case 'STAY_ARM':
        return Characteristic.SecuritySystemCurrentState.STAY_ARM;
      case 'NIGHT_ARM':
        return Characteristic.SecuritySystemCurrentState.NIGHT_ARM;
      case 'ALARM_TRIGGERED':
        return Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED;
      default:
        return Characteristic.SecuritySystemCurrentState.DISARMED;
    }
  }

  /**
   * HomeKit "set target state" handler — translates the HAP enum value
   * into one of our action strings, sends it to the panel, and re-polls
   * shortly after so HomeKit reflects what the panel actually did (not
   * just what we asked for).
   *
   * Note: XGenClient.sendAreaCommand() always gets a real attempt against
   * the panel, even mid session-contention-backoff — see its doc comment.
   * @param {number} value - A Characteristic.SecuritySystemTargetState value.
   * @returns {Promise<void>}
   */
  async handleSetTargetState(value) {
    const { Characteristic, HapStatusError, HAPStatus } = this.api.hap;
    let action;

    switch (value) {
      case Characteristic.SecuritySystemTargetState.AWAY_ARM:
        action = 'AWAY_ARM';
        break;
      case Characteristic.SecuritySystemTargetState.STAY_ARM:
        action = 'STAY_ARM';
        break;
      default:
        action = 'DISARMED';
        break;
    }

    try {
      await this.client.sendAreaCommand(action, this.areaNumber);
      this.log.info(`XGenAlarm: sent ${XGenClient.labelFor(action)} for area ${this.areaNumber}`);
    } catch (err) {
      this.log.error(`XGenAlarm: failed to send ${XGenClient.labelFor(action)}: ${err.message}`);
      // Tell HomeKit the command didn't go through, rather than silently
      // pretending it worked — important for a security accessory.
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    this.applyState();
    setTimeout(() => this.poll(), 3000);
  }

  /**
   * Re-derives this area's state from the client's current cache, updates
   * the HAP characteristics, logs state changes using the friendly labels
   * from XGenClient.STATE_LABELS, and fires a notification on the
   * non-triggered → triggered edge (not on every poll while it stays
   * triggered, and not again until it's gone back to normal first).
   */
  applyState() {
    const state = this.client.deriveState(this.areaNumber);
    const wasTriggered = this._lastDerivedState === 'ALARM_TRIGGERED';
    const isTriggered = state === 'ALARM_TRIGGERED';

    if (state !== this._lastDerivedState) {
      this.log.info(`XGenAlarm: area ${this.areaNumber} is now ${XGenClient.labelFor(state)}`);
    }
    if (isTriggered && !wasTriggered) {
      this._sendAlarmNotification(state);
    }
    this._lastDerivedState = state;
    const { Characteristic } = this.api.hap;

    if (this.lastCurrentState === Characteristic.SecuritySystemCurrentState.NIGHT_ARM) {
      const hasNight = (this.config.availableModes || []).some(m => m.toLowerCase() === 'night');
      this.lastTargetState = hasNight 
        ? Characteristic.SecuritySystemTargetState.NIGHT_ARM 
        : Characteristic.SecuritySystemTargetState.DISARM;
    } else {
      this.lastCurrentState = this.mapToHapCurrent(state);
    }
    // The panel doesn't separately expose "what the user asked for" vs.
    // "what's actually active right now" in what we've parsed, so target
    // mirrors current once a poll/command completes — HomeKit only shows
    // a transient "Arming…" UI for the moment they actually differ.
    // NIGHT_ARM (HAP value 2) has no TargetState equivalent we expose, so
    // fall back to DISARM (3) rather than send HomeKit an invalid value.
    const { Characteristic } = this.api.hap;
    this.lastTargetState =
      this.lastCurrentState === Characteristic.SecuritySystemCurrentState.NIGHT_ARM
        ? Characteristic.SecuritySystemTargetState.DISARM
        : this.lastCurrentState;

    if (this.currentStateChar) this.currentStateChar.updateValue(this.lastCurrentState);
    if (this.targetStateChar) this.targetStateChar.updateValue(this.lastTargetState);
  }

  /**
   * Sends the "alarm triggered" push notification (ntfy/Pushover/webhook,
   * per config) — a no-op if notifications.enabled isn't set. This is in
   * addition to, not instead of, HomeKit's own built-in notification for
   * a "Triggered" Security System accessory.
   * @param {string} state - Will be 'ALARM_TRIGGERED'.
   * @returns {Promise<void>}
   */
  async _sendAlarmNotification(state) {
    const areaName = (this.client.areaNames && this.client.areaNames[this.areaNumber - 1]) || `Area ${this.areaNumber}`;
    const panelName = this.config.name || 'Alarm Panel';
    const faults = (this.client.sysStatus || []).filter((s) => s && s.trim().length);

    await this.notifier.notify({
      title: `🚨 ${panelName}: ${XGenClient.labelFor(state)}`,
      message: faults.length ? `${areaName} — ${faults.join(', ')}` : `${areaName} has been triggered.`,
    });
  }

  /** Runs an immediate poll, then starts the recurring polling interval. */
  startPolling() {
    this.poll();
    this._timer = setInterval(() => this.poll(), this.pollInterval);
  }

  /**
   * One polling cycle: refresh status from the panel, apply it to HomeKit,
   * and surface any panel fault messages — with failures funneled through
   * _reportPollFailure() so a sustained outage doesn't flood the log.
   *
   * This includes the case where XGenClient is deliberately sitting out a
   * poll due to session-contention backoff (see lib/xgenClient.js) — that
   * surfaces here as a regular (throttle-friendly) error, no special-
   * casing needed.
   * @returns {Promise<void>}
   */
  async poll() {
    try {
      const status = await this.client.refreshStatus();
      this.applyState();
      this._reportPollSuccess();

      const faults = (status.sysStatus || []).filter((s) => s && s.trim().length);
      if (faults.length) {
        this.log.warn(`XGenAlarm: panel reports: ${faults.join(', ')}`);
      }
    } catch (err) {
      this._reportPollFailure(err);
    }
  }

  /**
   * Logs a poll success, and — if we were previously in a run of
   * failures — announces the recovery once, then resets the counters.
   */
  _reportPollSuccess() {
    if (this._consecutivePollFailures > 0) {
      this.log.info(`XGenAlarm: status poll recovered after ${this._consecutivePollFailures} failed attempt(s).`);
    }
    this._consecutivePollFailures = 0;
    this._lastPollErrorMessage = null;
  }

  /**
   * Logs a poll failure with throttling: a *new* error message is always
   * logged at error level immediately. A *repeated* identical message
   * (e.g. the panel staying unreachable, a session that keeps expiring,
   * or XGenClient sitting out a session-contention backoff window) is
   * logged at error level again only every 20th occurrence — in between,
   * it drops to debug level (visible with `homebridge -D`), so a
   * sustained condition produces one clear alert instead of one log line
   * per poll forever.
   * @param {Error} err
   */
  _reportPollFailure(err) {
    const message = err.message;
    if (message === this._lastPollErrorMessage) {
      this._consecutivePollFailures++;
      if (this._consecutivePollFailures % 20 === 0) {
        this.log.warn(`XGenAlarm: status poll still failing after ${this._consecutivePollFailures} attempts: ${message}`);
      } else if (this.log.debug) {
        this.log.debug(`XGenAlarm: status poll failed (repeat #${this._consecutivePollFailures}): ${message}`);
      }
    } else {
      this._consecutivePollFailures = 1;
      this._lastPollErrorMessage = message;
      this.log.error(`XGenAlarm: status poll failed: ${message}`);
    }
  }
}

module.exports = (api) => {
  api.registerPlatform(PLATFORM_NAME, XGenAlarmPlatform);
};