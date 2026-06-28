'use strict';

const Notifier = require('./../lib/notifier');

const notifier = new Notifier({
  enabled: true,
  service: 'ntfy',
  ntfy: {
    server: 'https://ntfy.sh',
    topic: 'a4X9y7SbGBH26b1BGVEAxplsUNq-home-alarm',
    priority: 'high',
  },
}, console);

(async () => {
  console.log('Sending test notification...');

  await notifier.notify({
    title: 'XGen Alarm Test',
    message: 'If you received this, ntfy notifications are working! 🎉',
  });

  console.log('Done.');
})();