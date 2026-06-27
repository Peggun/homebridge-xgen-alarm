'use strict';

/**
 * Minimal stand-ins for the pieces of the Homebridge/HAP API that
 * lib/platform.js touches — just enough to instantiate XGenAlarmPlatform
 * and drive it the same way Homebridge itself would, without needing a
 * real Homebridge process or a real HomeKit pairing.
 */

class FakeCharacteristic {
  constructor() {
    this._getHandler = null;
    this._setHandler = null;
    this.value = null;
    this.props = {};
  }
  onGet(fn) {
    this._getHandler = fn;
    return this;
  }
  onSet(fn) {
    this._setHandler = fn;
    return this;
  }
  setProps(p) {
    this.props = { ...this.props, ...p };
    return this;
  }
  updateValue(v) {
    this.value = v;
    return this;
  }
  /** Mimics what HomeKit would do when a controller reads this characteristic. */
  async read() {
    return this._getHandler ? this._getHandler() : this.value;
  }
  /** Mimics what HomeKit would do when a controller writes this characteristic. */
  async write(v) {
    if (this._setHandler) await this._setHandler(v);
    else this.value = v;
  }
}

class FakeService {
  constructor() {
    this._chars = new Map();
  }
  getCharacteristic(key) {
    if (!this._chars.has(key)) this._chars.set(key, new FakeCharacteristic());
    return this._chars.get(key);
  }
}

class FakeAccessory {
  constructor(name, uuid) {
    this.displayName = name;
    this.UUID = uuid;
    this._services = new Map();
  }
  getService(type) {
    return this._services.get(type) || null;
  }
  addService(type) {
    const s = new FakeService();
    this._services.set(type, s);
    return s;
  }
}

class HapStatusError extends Error {
  constructor(status) {
    super(`HapStatusError(${status})`);
    this.hapStatus = status;
  }
}

/**
 * @returns {object} A fake Homebridge `api` object, with `_emit('didFinishLaunching')`
 *   exposed so tests can trigger the same lifecycle event Homebridge fires.
 */
function createMockHapApi() {
  const Characteristic = {
    SecuritySystemCurrentState: { STAY_ARM: 0, AWAY_ARM: 1, NIGHT_ARM: 2, DISARMED: 3, ALARM_TRIGGERED: 4 },
    SecuritySystemTargetState: { STAY_ARM: 0, AWAY_ARM: 1, NIGHT_ARM: 2, DISARM: 3 },
  };
  const Service = { SecuritySystem: 'SecuritySystem' };
  const HAPStatus = { SERVICE_COMMUNICATION_FAILURE: -70402 };

  const listeners = {};
  return {
    hap: {
      uuid: { generate: (s) => 'uuid-' + s },
      Service,
      Characteristic,
      HapStatusError,
      HAPStatus,
    },
    platformAccessory: FakeAccessory,
    on(event, cb) {
      listeners[event] = cb;
    },
    registerPlatformAccessories() {
      // no-op — tests don't need real HAP registration
    },
    /** Test helper: fires a lifecycle event the same way Homebridge would. */
    _emit(event) {
      if (listeners[event]) listeners[event]();
    },
  };
}

/**
 * @returns {object} A fake Homebridge logger that records every call so
 *   tests can assert on log output (e.g. that errors got throttled).
 */
function createFakeLog() {
  const calls = { info: [], warn: [], error: [], debug: [] };
  const log = (msg) => calls.info.push(msg);
  log.info = (m) => calls.info.push(m);
  log.warn = (m) => calls.warn.push(m);
  log.error = (m) => calls.error.push(m);
  log.debug = (m) => calls.debug.push(m);
  log.calls = calls;
  return log;
}

module.exports = { createMockHapApi, createFakeLog, FakeAccessory, FakeService, FakeCharacteristic, HapStatusError };
