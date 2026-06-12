import { serve } from "bun";
import crypto from 'crypto';

const TERMINAL_UUID = "00-00-00-00-00-00";

const CONFIG = {
  TAPO_EMAIL: process.env.TAPO_EMAIL,
  TAPO_PASSWORD: process.env.TAPO_PASSWORD,
  TAPO_DEVICE_IP: process.env.TAPO_DEVICE_IP,
  EMAIL_FROM: process.env.EMAIL_FROM,
  EMAIL_TO: process.env.EMAIL_TO,
  POSTMARK_API_TOKEN: process.env.POSTMARK_API_TOKEN,
  RUNNING_THRESHOLD: parseInt(process.env.RUNNING_THRESHOLD) || 500,
  COOLDOWN_READINGS: parseInt(process.env.COOLDOWN_READINGS) || 3,
};

function validateEnvironment() {
  const errors = [];
  
  if (!CONFIG.TAPO_EMAIL) errors.push('TAPO_EMAIL');
  if (!CONFIG.TAPO_PASSWORD) errors.push('TAPO_PASSWORD');
  if (!CONFIG.TAPO_DEVICE_IP) errors.push('TAPO_DEVICE_IP');
  
  if (errors.length > 0) {
    console.error('❌ Missing required environment variables:');
    errors.forEach(env => console.error(`   • ${env}`));
    console.error('');
    console.error('Please create a .env file with these variables. See .env.example for details.');
    console.error('');
    process.exit(1);
  }
  
  if (!CONFIG.POSTMARK_API_TOKEN) {
    console.log('⚠️  POSTMARK_API_TOKEN not set - email notifications will be disabled');
  }
  if (!CONFIG.EMAIL_TO) {
    console.log('⚠️  EMAIL_TO not set - email notifications will be disabled');
  }
  console.log('');
}

let state = {
  previousPower: 0,
  consecutiveLowReadings: 0,
  notificationSent: false,
  isFirstCheck: true,
};

class TapoCrypto {
  static sha1(data) {
    const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    return crypto.createHash('sha1').update(buffer).digest();
  }
  
  static sha256(data) {
    const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    return crypto.createHash('sha256').update(buffer).digest();
  }
  
  static getRandomBytes(length) {
    return crypto.randomBytes(length);
  }
  
  static concatBuffers(...buffers) {
    return Buffer.concat(buffers);
  }
  
  static arrayToHex(array) {
    return Buffer.from(array).toString('hex');
  }
}

class KlapCipher {
  constructor(key, iv, sig, seq) {
    this.key = key;
    this.iv = iv;
    this.sig = sig;
    this.seq = seq;
    this.seqCounter = 0;
  }
  
  static async create(localSeed, remoteSeed, userHash) {
    const localHash = TapoCrypto.concatBuffers(localSeed, remoteSeed, userHash);
    
    const key = this.keyDerive(localHash);
    const { iv, seq } = this.ivDerive(localHash);
    const sig = this.sigDerive(localHash);
    
    return new KlapCipher(key, iv, sig, seq);
  }
  
  static keyDerive(localHash) {
    const keyInput = TapoCrypto.concatBuffers(Buffer.from('lsk'), localHash);
    const hash = TapoCrypto.sha256(keyInput);
    return hash.slice(0, 16);
  }
  
  static ivDerive(localHash) {
    const ivInput = TapoCrypto.concatBuffers(Buffer.from('iv'), localHash);
    const hash = TapoCrypto.sha256(ivInput);
    const iv = hash.slice(0, 12);
    
    const seqBytes = hash.slice(hash.length - 4);
    const seq = seqBytes.readInt32BE(0);
    
    return { iv, seq };
  }
  
  static sigDerive(localHash) {
    const sigInput = TapoCrypto.concatBuffers(Buffer.from('ldk'), localHash);
    const hash = TapoCrypto.sha256(sigInput);
    return hash.slice(0, 28);
  }
  
  encrypt(data) {
    this.seqCounter++;
    const currentSeq = this.seq + this.seqCounter;
    
    const ivSeq = this.getIvSeq(currentSeq);
    
    const cipher = crypto.createCipheriv('aes-128-cbc', this.key, ivSeq);
    cipher.setAutoPadding(true);
    
    let encrypted = cipher.update(data, 'utf8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    
    const seqBuffer = Buffer.allocUnsafe(4);
    seqBuffer.writeInt32BE(currentSeq, 0);
    const signatureInput = TapoCrypto.concatBuffers(this.sig, seqBuffer, encrypted);
    const signature = TapoCrypto.sha256(signatureInput);
    
    const result = TapoCrypto.concatBuffers(signature, encrypted);
    
    return { payload: result, seq: currentSeq };
  }
  
  decrypt(seq, encryptedData) {
    if (encryptedData.length < 32) {
      throw new Error('Encrypted data too short');
    }
    
    const signature = encryptedData.slice(0, 32);
    const cipherBytes = encryptedData.slice(32);
    
    const ivSeq = this.getIvSeq(seq);
    
    const decipher = crypto.createDecipheriv('aes-128-cbc', this.key, ivSeq);
    decipher.setAutoPadding(true);
    
    let decrypted = decipher.update(cipherBytes);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    
    return decrypted.toString('utf8');
  }
  
  getIvSeq(seq) {
    const seqBuffer = Buffer.allocUnsafe(4);
    seqBuffer.writeInt32BE(seq, 0);
    return TapoCrypto.concatBuffers(this.iv, seqBuffer);
  }
}

class KlapProtocol {
  constructor() {
    this.cookie = '';
    this.cipher = null;
    this.baseUrl = '';
  }
  
  async login(deviceIP, username, password) {
    this.baseUrl = `http://${deviceIP}/app`;
    
    console.log(`🔌 Connecting to P110 at ${this.baseUrl}`);
    
    const usernameHash = TapoCrypto.sha1(username);
    const passwordHash = TapoCrypto.sha1(password);
    const authHash = TapoCrypto.sha256(TapoCrypto.concatBuffers(usernameHash, passwordHash));
    
    const localSeed = TapoCrypto.getRandomBytes(16);
    
    const remoteSeed = await this.handshake1(localSeed, authHash);
    await this.handshake2(localSeed, remoteSeed, authHash);
    
    this.cipher = await KlapCipher.create(localSeed, remoteSeed, authHash);
    
    console.log('✅ KLAP authentication successful');
  }
  
  async handshake1(localSeed, authHash) {
    console.log('🤝 Performing handshake1');
    
    const response = await fetch(`${this.baseUrl}/handshake1`, {
      method: 'POST',
      body: localSeed,
      headers: {
        'Content-Type': 'application/octet-stream'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Handshake1 failed: ${response.status}`);
    }
    
    const cookieHeader = response.headers.get('set-cookie');
    if (cookieHeader) {
      const sessionMatch = cookieHeader.match(/TP_SESSIONID=([^;]+)/);
      if (sessionMatch) {
        this.cookie = `TP_SESSIONID=${sessionMatch[1]}`;
      }
    }
    
    const responseBody = Buffer.from(await response.arrayBuffer());
    
    if (responseBody.length < 48) {
      throw new Error('Invalid handshake1 response length');
    }
    
    const remoteSeed = responseBody.slice(0, 16);
    const serverHash = responseBody.slice(16, 48);
    
    const expectedHash = TapoCrypto.sha256(TapoCrypto.concatBuffers(localSeed, remoteSeed, authHash));
    
    if (!serverHash.equals(expectedHash)) {
      throw new Error('Invalid server hash in handshake1. Check credentials.');
    }
    
    console.log('✅ Handshake1 successful');
    return remoteSeed;
  }
  
  async handshake2(localSeed, remoteSeed, authHash) {
    console.log('🤝 Performing handshake2');
    
    const payload = TapoCrypto.sha256(TapoCrypto.concatBuffers(remoteSeed, localSeed, authHash));
    
    const response = await fetch(`${this.baseUrl}/handshake2`, {
      method: 'POST',
      body: payload,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Cookie': this.cookie
      }
    });
    
    if (!response.ok) {
      throw new Error(`Handshake2 failed: ${response.status}`);
    }
    
    console.log('✅ Handshake2 successful');
  }
  
  async executeRequest(request) {
    if (!this.cipher) {
      throw new Error('Not authenticated. Call login() first.');
    }
    
    const requestJson = JSON.stringify(request);
    
    const { payload, seq } = this.cipher.encrypt(requestJson);
    
    const response = await fetch(`${this.baseUrl}/request?seq=${seq}`, {
      method: 'POST',
      body: payload,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Cookie': this.cookie
      }
    });
    
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error('Session timeout. Need to re-authenticate.');
      }
      throw new Error(`Request failed: ${response.status}`);
    }
    
    const responseBody = Buffer.from(await response.arrayBuffer());
    const decryptedResponse = this.cipher.decrypt(seq, responseBody);
    
    return JSON.parse(decryptedResponse);
  }
}

class TapoLocalClient {
  constructor() {
    this.protocol = new KlapProtocol();
  }
  
  async connect(deviceIP, username, password) {
    await this.protocol.login(deviceIP, username, password);
  }
  
  async getEnergyUsage() {
    const request = {
      method: 'get_energy_usage',
      requestTimeMilis: Date.now(),
      terminalUUID: TERMINAL_UUID
    };
    
    const response = await this.protocol.executeRequest(request);
    
    if (response.error_code !== 0) {
      throw new Error(`get_energy_usage error: ${response.msg || 'Unknown error'}`);
    }
    
    return response.result;
  }
}

async function sendNotification(data) {
  if (!CONFIG.POSTMARK_API_TOKEN || !CONFIG.EMAIL_TO) {
    console.log('📧 Email not configured, skipping notification');
    return { success: false, error: 'Email not configured' };
  }
  
  try {
    const subject = '🧺 Dryer Finished!';
    const body = `
Your laundry dryer has finished running!

Current Power: ${data.currentPower.toFixed(1)}W
Previous Power: ${data.previousPower.toFixed(1)}W
Checked at: ${new Date().toLocaleString()}

--
Tapo Power Alert
    `.trim();
    
    const payload = {
      From: CONFIG.EMAIL_FROM || 'Tapo Alert <noreply@yourdomain.com>',
      To: CONFIG.EMAIL_TO,
      Subject: subject,
      TextBody: body,
      MessageStream: 'outbound'
    };
    
    const response = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-Postmark-Server-Token': CONFIG.POSTMARK_API_TOKEN
      },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Postmark error: ${response.status} - ${errorText}`);
    }
    
    const result = await response.json();
    console.log('📧 Notification sent successfully');
    
    return {
      success: true,
      messageId: result.MessageID
    };
  } catch (error) {
    console.error('❌ Email notification failed:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

async function getTapoDeviceStatus() {
  try {
    const client = new TapoLocalClient();
    await client.connect(CONFIG.TAPO_DEVICE_IP, CONFIG.TAPO_EMAIL, CONFIG.TAPO_PASSWORD);
    
    const energyData = await client.getEnergyUsage();
    const currentPowerMw = energyData.current_power || 0;
    const currentPower = currentPowerMw / 1000;
    
    return {
      success: true,
      deviceOnline: true,
      power: currentPower,
      voltage: energyData.voltage_mv ? energyData.voltage_mv / 1000 : undefined,
      current: energyData.current_ma ? energyData.current_ma / 1000 : undefined,
      totalEnergy: energyData.today_energy || energyData.today_energy_wh,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error('❌ Error getting device status:', error.message);
    return {
      success: false,
      deviceOnline: false,
      power: 0,
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}

async function checkDryerStatus() {
  try {
    const deviceStatus = await getTapoDeviceStatus();
    
    if (!deviceStatus.success) {
      console.log(`⚠️  Device offline: ${deviceStatus.error}`);
      return { 
        success: false, 
        error: deviceStatus.error,
        timestamp: new Date().toISOString()
      };
    }
    
    const currentPower = deviceStatus.power;
    const runningThreshold = CONFIG.RUNNING_THRESHOLD;
    const cooldownReadings = CONFIG.COOLDOWN_READINGS;
    
    console.log(`⚡ Power: ${currentPower.toFixed(1)}W (threshold: ${runningThreshold}W, previous: ${state.previousPower.toFixed(1)}W)`);
    
    let notificationResult = null;
    
    if (state.isFirstCheck) {
      console.log('📍 First check - initializing state');
      state.isFirstCheck = false;
    } else {
      const wasRunning = state.previousPower > runningThreshold;
      const isRunning = currentPower > runningThreshold;
      
      if (wasRunning && !isRunning) {
        state.consecutiveLowReadings++;
        
        console.log(`📉 Power dropped: ${state.consecutiveLowReadings}/${cooldownReadings} low readings`);
        
        if (state.consecutiveLowReadings >= cooldownReadings && !state.notificationSent) {
          console.log(`🎉 Dryer finished! Sending notification...`);
          
          notificationResult = await sendNotification({
            currentPower,
            previousPower: state.previousPower
          });
          
          if (notificationResult.success) {
            state.notificationSent = true;
          }
        }
      } else if (isRunning) {
        if (state.notificationSent) {
          console.log('🔄 New cycle detected - resetting notification flag');
        }
        
        state.consecutiveLowReadings = 0;
        state.notificationSent = false;
        console.log(`🔄 Dryer is running (${currentPower.toFixed(1)}W)`);
      } else {
        state.consecutiveLowReadings = 0;
        console.log(`😴 Dryer remains off (${currentPower.toFixed(1)}W)`);
      }
    }
    
    state.previousPower = currentPower;
    
    return {
      success: true,
      currentPower,
      wasRunning: !state.isFirstCheck && state.previousPower > runningThreshold,
      isRunning: currentPower > runningThreshold,
      consecutiveLowReadings: state.consecutiveLowReadings,
      notificationSent: state.notificationSent,
      notificationResult,
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    console.error('❌ Error checking dryer status:', error);
    return { success: false, error: error.message };
  }
}

function resetState() {
  state = {
    previousPower: 0,
    consecutiveLowReadings: 0,
    notificationSent: false,
    isFirstCheck: true,
  };
  console.log('🔄 State reset');
}

function getState() {
  return { ...state };
}

async function validateCredentials() {
  console.log('🔐 Validating Tapo credentials...');
  
  try {
    const client = new TapoLocalClient();
    await client.connect(CONFIG.TAPO_DEVICE_IP, CONFIG.TAPO_EMAIL, CONFIG.TAPO_PASSWORD);
    
    const energyData = await client.getEnergyUsage();
    const currentPower = (energyData.current_power || 0) / 1000;
    
    console.log(`✅ Credentials validated successfully!`);
    console.log(`📊 Device is online and responding`);
    console.log(`⚡ Current power: ${currentPower.toFixed(1)}W`);
    
    if (CONFIG.EMAIL_TO && CONFIG.POSTMARK_API_TOKEN) {
      console.log(`📧 Email notifications enabled: ${CONFIG.EMAIL_TO}`);
    } else {
      console.log(`📧 Email notifications disabled (missing EMAIL_TO or POSTMARK_API_TOKEN)`);
    }
    console.log('');
    return true;
  } catch (error) {
    console.error('❌ Credential validation failed!');
    console.error(`   Error: ${error.message}`);
    console.error('');
    console.error('Please check:');
    console.error('   • TAPO_DEVICE_IP is correct (check router DHCP table)');
    console.error('   • TAPO_EMAIL is your Tapo account email');
    console.error('   • TAPO_PASSWORD is correct');
    console.error('   • Device is powered on and connected to your network');
    console.error('   • Server can reach the device (try: ping <TAPO_DEVICE_IP>)');
    console.error('');
    console.error('Server will continue running, but monitoring will fail until credentials are fixed.');
    console.error('');
    return false;
  }
}

console.log('🚀 Starting Tapo Power Alert...');
console.log('');

validateEnvironment();

validateCredentials().then((credentialsValid) => {
  const status = credentialsValid ? '✅ Ready to monitor' : '⚠️  Running in degraded mode';
  console.log(`🚀 Tapo Power Alert running on http://localhost:${process.env.PORT || 3000}`);
  console.log(`   Status: ${status}`);
  console.log(`📊 Running threshold: ${CONFIG.RUNNING_THRESHOLD}W`);
  console.log(`🔁 Cooldown readings: ${CONFIG.COOLDOWN_READINGS}`);
});

serve({
  port: process.env.PORT || 3000,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    
    switch (path) {
      case '/':
        return new Response('Tapo Power Alert is running', { status: 200 });
      
      case '/health':
        return Response.json({ status: 'healthy', timestamp: new Date().toISOString() });
      
      case '/check':
        const checkResult = await checkDryerStatus();
        return Response.json(checkResult);
      
      case '/status':
        const status = await getTapoDeviceStatus();
        return Response.json(status);
      
      case '/state':
        return Response.json({ ...getState(), timestamp: new Date().toISOString() });
      
      case '/reset':
        resetState();
        return Response.json({ success: true, message: 'State reset', timestamp: new Date().toISOString() });
      
      default:
        return new Response('Not Found', { status: 404 });
    }
  },
});

const CHECK_INTERVAL = (parseInt(process.env.CHECK_INTERVAL) || 300) * 1000;

setInterval(async () => {
  console.log(`\n⏰ ${new Date().toISOString()} - Checking dryer status...`);
  await checkDryerStatus();
}, CHECK_INTERVAL);