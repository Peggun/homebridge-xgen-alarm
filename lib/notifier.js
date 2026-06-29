'use strict';

const http = require('http');
const https = require('https');

/**
 * Sends a push notification through one of a few common channels, using
 * nothing but Node's built-in http(s) module (no new dependencies).
 *
 * This is a *supplement* to HomeKit's own built-in alerting: the Home app
 * will already notify you when a Security System accessory reports
 * "Triggered", as long as notifications are enabled for that accessory
 * (Home app → tap the accessory → Notifications). Notifier exists for
 * everything that built-in path doesn't cover — Android phones, people
 * who don't have Home app notifications on, or just wanting a second,
 * independent path.
 *
 * Supported `service` values:
 *   - 'ntfy'     – https://ntfy.sh (or a self-hosted ntfy server). No
 *                  signup: pick a topic name, subscribe to it in the ntfy
 *                  app or on the website, done.
 */
class Notifier {
  /**
   * @param {object} config - The `notifications` block from Homebridge config.
   * @param {boolean} config.enabled
   * @param {'ntfy'} config.service
   * @param {{server?:string, topic:string, priority?:string}} [config.ntfy]
   * @param {{userKey:string, appToken:string, priority?:string|number}} [config.pushover]
   * @param {{url:string, method?:string, headers?:object, body?:string}} [config.webhook]
   * @param {Console|object} [log] - Homebridge logger, or console.
   */
  constructor(config, log) {
    this.config = config || {};
    this.log = log || console;
  }

  /** @returns {boolean} Whether notifications are configured to be sent. */
  get enabled() {
    return !!this.config.enabled;
  }

  /**
   * Fire-and-forget a notification. Never throws — a notification problem
   * shouldn't take down the rest of the plugin, so failures are just
   * logged as a warning.
   * @param {{title:string, message:string}} notification
   * @returns {Promise<void>}
   */
  async notify({ title, message }) {
    if (!this.enabled) return;
    try {
      switch (this.config.service) {
        case 'ntfy':
          await this._sendNtfy(title, message);
          break;
        default:
          this.log.warn(
            `XGenAlarm: notifications.enabled is true but notifications.service ` +
              `("${this.config.service}") isn't recognised — use ntfy`
          );
      }
    } catch (err) {
      this.log.warn('XGenAlarm: failed to send notification');
      this.log.warn(err);

      if (err.errors) {
        for (const e of err.errors) {
          this.log.warn(
            `${e.code}: ${e.address}:${e.port} (${e.message})`
          );
        }
      }
    }
  }

  /**
   * @param {string} title
   * @param {string} message
   * @returns {Promise<void>}
   */
  async _sendNtfy(title, message) {
    const cfg = this.config.ntfy || {};
    if (!cfg.topic) throw new Error('notifications.ntfy.topic is not set');
    const server = (cfg.server || 'https://ntfy.sh').replace(/\/+$/, '');
    await this._httpRequest(`${server}/${encodeURIComponent(cfg.topic)}`, {
      method: 'POST',
      headers: {
        Title: title,
        Priority: cfg.priority || 'high',
        Tags: 'rotating_light',
      },
      body: message,
    });
  }

  /**
   * Minimal HTTP(S) POST/GET helper — deliberately separate from
   * XGenClient's `_request`, since this one needs to parse arbitrary
   * absolute URLs (different host per notification service) rather than
   * always talking to the same panel.
   * @param {string} urlString
   * @param {{method?:string, headers?:object, body?:string}} options
   * @returns {Promise<string>} Response body, if the request succeeded (2xx).
   */
  _httpRequest(urlString, { method, headers, body }) {
    return new Promise((resolve, reject) => {
      let url;
      try {
        url = new URL(urlString);
      } catch (err) {
        reject(new Error(`Invalid notification URL "${urlString}": ${err.message}`));
        return;
      }

      const lib = url.protocol === 'https:' ? https : http;
      const reqHeaders = { ...headers };
      if (body) reqHeaders['Content-Length'] = Buffer.byteLength(body);

      const req = lib.request(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + (url.search || ''),
          method: method || 'POST',
          headers: reqHeaders,
          timeout: 10000,
        },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(data);
            } else {
              reject(new Error(`Notification request failed with HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
            }
          });
        }
      );
      req.on('timeout', () => req.destroy(new Error('Notification request timed out')));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }
}

module.exports = Notifier;
