import { processPendingSms } from '../services/sms.js';

class SmsDispatcher {
  constructor() {
    this.intervalId = null;
    this.running = false;
  }

  async run() {
    if (this.running) return;
    this.running = true;
    try { await processPendingSms(); }
    catch (error) { console.error('处理待发短信失败:', error.message); }
    finally { this.running = false; }
  }

  start() {
    if (this.intervalId) return;
    this.run();
    this.intervalId = setInterval(() => this.run(), 60 * 1000);
  }

  stop() {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
  }
}

export default new SmsDispatcher();
