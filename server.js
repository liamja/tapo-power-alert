import { serve } from "bun";
import crypto from 'crypto';

const TERMINAL_UUID = "00-00-00-00-00-00";

function parsePort(value) {
  if (value === undefined) return 3000;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '0') return null;
  const port = parseInt(trimmed, 10);
  if (Number.isNaN(port) || port <= 0) return null;
  return port;
}

const CONFIG = {
  TAPO_EMAIL: process.env.TAPO_EMAIL,
  TAPO_PASSWORD: process.env.TAPO_PASSWORD,
  TAPO_DEVICE_IP: process.env.TAPO_DEVICE_IP,
  EMAIL_FROM: process.env.EMAIL_FROM,
  EMAIL_TO: process.env.EMAIL_TO,
  POSTMARK_API_TOKEN: process.env.POSTMARK_API_TOKEN,
  NTFY_TOPIC: process.env.NTFY_TOPIC,
  NTFY_SERVER: process.env.NTFY_SERVER || 'https://ntfy.sh',
  API_KEY: process.env.API_KEY,
  RUNNING_THRESHOLD: parseInt(process.env.RUNNING_THRESHOLD) || 800,
  HEATING_THRESHOLD: parseInt(process.env.HEATING_THRESHOLD) || 1500,
  OFF_THRESHOLD: parseInt(process.env.OFF_THRESHOLD) || 50,
  COOLDOWN_READINGS: parseInt(process.env.COOLDOWN_READINGS) || 3,
  CHECK_INTERVAL: parseInt(process.env.CHECK_INTERVAL) || 60,
  PORT: parsePort(process.env.PORT),
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
  if (!CONFIG.NTFY_TOPIC) {
    console.log('⚠️  NTFY_TOPIC not set - push notifications will be disabled');
  }
  if (!CONFIG.NTFY_TOPIC && !(CONFIG.POSTMARK_API_TOKEN && CONFIG.EMAIL_TO)) {
    console.log('⚠️  No notification channels configured - set NTFY_TOPIC and/or email settings');
  }
  console.log('');
}

let state = {
  previousPower: 0,
  consecutiveLowReadings: 0,
  notificationSent: false,
  hasSeenHeatingThisCycle: false,
  isFirstCheck: true,
};

let tapoClient = null;

function checkApiAuth(req) {
  if (!CONFIG.API_KEY) return true;
  const url = new URL(req.url);
  const headerKey = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  const queryKey = url.searchParams.get('key');
  return headerKey === CONFIG.API_KEY || queryKey === CONFIG.API_KEY;
}

function unauthorizedResponse() {
  return Response.json({ error: 'Unauthorized' }, { status: 401 });
}

function getClientAddress(req, server) {
  const ip = server.requestIP(req);
  if (ip) return ip.address;

  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();

  return req.headers.get('x-real-ip') || 'unknown';
}

function logEndpointAccess(req, server, path, authorized) {
  const client = getClientAddress(req, server);
  const auth = authorized ? 'authorized' : 'unauthorized';
  console.log(`📡 ${new Date().toISOString()} ${req.method} ${path} ${auth} from ${client}`);
}

function guardApiRoute(req, server, path) {
  if (!checkApiAuth(req)) {
    logEndpointAccess(req, server, path, false);
    return unauthorizedResponse();
  }

  logEndpointAccess(req, server, path, true);
  return null;
}

class TapoCrypto {
  static sha1(data) {
    const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    return crypto.createHash('sha1').update(buffer).digest();
  }
  
  static sha256(data) {
    const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    return crypto.createHash('sha256').update(buffer).digest();
  }

  static md5(data) {
    const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    return crypto.createHash('md5').update(buffer).digest();
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

function generateAuthHashV2(username, password) {
  const usernameHash = TapoCrypto.sha1(username);
  const passwordHash = TapoCrypto.sha1(password);
  return TapoCrypto.sha256(TapoCrypto.concatBuffers(usernameHash, passwordHash));
}

function generateAuthHashV1(username, password) {
  const usernameHash = TapoCrypto.md5(username);
  const passwordHash = TapoCrypto.md5(password);
  return TapoCrypto.md5(TapoCrypto.concatBuffers(usernameHash, passwordHash));
}

function handshake1HashV2(localSeed, remoteSeed, authHash) {
  return TapoCrypto.sha256(TapoCrypto.concatBuffers(localSeed, remoteSeed, authHash));
}

function handshake1HashV1(localSeed, remoteSeed, authHash) {
  return TapoCrypto.sha256(TapoCrypto.concatBuffers(localSeed, authHash));
}

function handshake2HashV2(localSeed, remoteSeed, authHash) {
  return TapoCrypto.sha256(TapoCrypto.concatBuffers(remoteSeed, localSeed, authHash));
}

function handshake2HashV1(localSeed, remoteSeed, authHash) {
  return TapoCrypto.sha256(TapoCrypto.concatBuffers(remoteSeed, authHash));
}

function buildAuthCandidates(username, password) {
  const candidates = [
  {
    label: 'KLAP v2 (Tapo account)',
    authHash: generateAuthHashV2(username, password),
    handshake1: handshake1HashV2,
    handshake2: handshake2HashV2,
  },
  {
    label: 'KLAP v1 (Tapo account)',
    authHash: generateAuthHashV1(username, password),
    handshake1: handshake1HashV1,
    handshake2: handshake2HashV1,
  },
  {
    label: 'KLAP v2 (blank credentials)',
    authHash: generateAuthHashV2('', ''),
    handshake1: handshake1HashV2,
    handshake2: handshake2HashV2,
  },
  {
    label: 'KLAP v1 (blank credentials)',
    authHash: generateAuthHashV1('', ''),
    handshake1: handshake1HashV1,
    handshake2: handshake2HashV1,
  },
  {
    label: 'KLAP v2 (Tapo factory default)',
    authHash: generateAuthHashV2('test@tp-link.net', 'test'),
    handshake1: handshake1HashV2,
    handshake2: handshake2HashV2,
  },
  ];

  return candidates;
}

function printAuthTroubleshooting() {
  console.error('Authentication troubleshooting:');
  console.error('   1. In the Tapo app: Me → Third-Party Services → enable Third-Party Compatibility');
  console.error('      (toggle off and on if already enabled)');
  console.error('   2. TAPO_EMAIL and TAPO_PASSWORD must match your Tapo account exactly (case-sensitive)');
  console.error('   3. If the plug was set up while other Tapo devices were plugged in, factory-reset');
  console.error('      the P110 and add it again with only this device powered on');
  console.error('   4. Confirm the IP in the Tapo app matches TAPO_DEVICE_IP');
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
    this.handshake2Fn = handshake2HashV2;
  }
  
  async login(deviceIP, username, password, { quiet = false } = {}) {
    this.baseUrl = `http://${deviceIP}/app`;
    
    if (!quiet) {
      console.log(`🔌 Connecting to P110 at ${this.baseUrl}`);
    }
    
    const localSeed = TapoCrypto.getRandomBytes(16);
    
    const { remoteSeed, authHash, handshake2, label } = await this.handshake1(
      localSeed,
      username,
      password,
      quiet
    );
    this.handshake2Fn = handshake2;
    await this.handshake2(localSeed, remoteSeed, authHash, quiet);
    
    this.cipher = await KlapCipher.create(localSeed, remoteSeed, authHash);
    
    if (!quiet) {
      console.log(`✅ KLAP authentication successful (${label})`);
    }
  }
  
  async handshake1(localSeed, username, password, quiet = false) {
    if (!quiet) {
      console.log('🤝 Performing handshake1');
    }
    
    const response = await fetch(`${this.baseUrl}/handshake1`, {
      method: 'POST',
      body: localSeed,
      headers: {
        'Content-Type': 'application/octet-stream'
      }
    });
    
    if (response.status === 403) {
      throw new Error(
        'Handshake1 forbidden (403). Enable Third-Party Compatibility in the Tapo app: Me → Third-Party Services.'
      );
    }

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
    const candidates = buildAuthCandidates(username, password);

    for (const candidate of candidates) {
      const expectedHash = candidate.handshake1(localSeed, remoteSeed, candidate.authHash);
      if (serverHash.equals(expectedHash)) {
        if (!quiet) {
          console.log(`✅ Handshake1 successful (${candidate.label})`);
        }
        return {
          remoteSeed,
          authHash: candidate.authHash,
          handshake2: candidate.handshake2,
          label: candidate.label,
        };
      }
    }

    throw new Error(
      'Authentication failed during handshake1. The device responded, but credentials did not match.'
    );
  }
  
  async handshake2(localSeed, remoteSeed, authHash, quiet = false) {
    if (!quiet) {
      console.log('🤝 Performing handshake2');
    }
    
    const payload = this.handshake2Fn(localSeed, remoteSeed, authHash);
    
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
    
    if (!quiet) {
      console.log('✅ Handshake2 successful');
    }
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
  
  async connect(deviceIP, username, password, options = {}) {
    await this.protocol.login(deviceIP, username, password, options);
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

async function sendNtfyNotification(data) {
  if (!CONFIG.NTFY_TOPIC) {
    return { success: false, error: 'ntfy not configured' };
  }

  try {
    const url = `${CONFIG.NTFY_SERVER.replace(/\/$/, '')}/${CONFIG.NTFY_TOPIC}`;
    const body = `Dryer finished! Power is now ${data.currentPower.toFixed(1)}W (was ${data.previousPower.toFixed(1)}W).`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Title: "🧺 Dryer Finished!",
        Priority: "default",
        Tags: "laundry,white_check_mark",
        Icon: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/16.0.1/72x72/1f9fa.png",
      },
      body,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`ntfy error: ${response.status} - ${errorText}`);
    }

    console.log('📱 Push notification sent via ntfy');
    return { success: true };
  } catch (error) {
    console.error('❌ ntfy notification failed:', error.message);
    return { success: false, error: error.message };
  }
}

async function sendEmailNotification(data) {
  if (!CONFIG.POSTMARK_API_TOKEN || !CONFIG.EMAIL_TO) {
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
    console.log('📧 Email notification sent successfully');

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

async function sendNotifications(data) {
  const channels = {};

  if (CONFIG.NTFY_TOPIC) {
    channels.ntfy = await sendNtfyNotification(data);
  }

  if (CONFIG.POSTMARK_API_TOKEN && CONFIG.EMAIL_TO) {
    channels.email = await sendEmailNotification(data);
  }

  if (Object.keys(channels).length === 0) {
    console.log('⚠️  No notification channels configured, skipping notification');
    return { success: false, error: 'No notification channels configured', channels };
  }

  const success = Object.values(channels).some(result => result.success);
  return { success, channels };
}

function isSessionError(error) {
  const message = error.message || '';
  return message.includes('Session timeout') || message.includes('re-authenticate');
}

async function getTapoClient(forceReconnect = false) {
  if (forceReconnect) {
    tapoClient = null;
  }

  if (!tapoClient) {
    const client = new TapoLocalClient();
    try {
      await client.connect(
        CONFIG.TAPO_DEVICE_IP,
        CONFIG.TAPO_EMAIL,
        CONFIG.TAPO_PASSWORD,
        { quiet: forceReconnect }
      );
      tapoClient = client;
    } catch (error) {
      tapoClient = null;
      throw error;
    }
  }

  return tapoClient;
}

async function readEnergyUsage(client) {
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
}

async function getTapoDeviceStatus() {
  try {
    let client = await getTapoClient();

    try {
      return await readEnergyUsage(client);
    } catch (error) {
      if (!isSessionError(error)) {
        throw error;
      }

      console.log('🔄 Tapo session expired, reconnecting...');
      client = await getTapoClient(true);
      return await readEnergyUsage(client);
    }
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
    const heatingThreshold = CONFIG.HEATING_THRESHOLD;
    const offThreshold = CONFIG.OFF_THRESHOLD;
    const cooldownReadings = CONFIG.COOLDOWN_READINGS;
    const previousPower = state.previousPower;
    const wasRunning = previousPower > runningThreshold;
    const isRunning = currentPower > runningThreshold;
    const isHeating = currentPower > heatingThreshold;
    const isOff = currentPower < offThreshold;
    
    console.log(`⚡ Power: ${currentPower.toFixed(1)}W (heating: >${heatingThreshold}W, off: <${offThreshold}W, previous: ${previousPower.toFixed(1)}W)`);
    
    let notificationResult = null;
    
    if (state.isFirstCheck) {
      console.log('📍 First check - initializing state');
      state.isFirstCheck = false;
      if (isHeating) {
        state.hasSeenHeatingThisCycle = true;
        console.log(`🔥 Dryer heating (${currentPower.toFixed(1)}W)`);
      } else if (isRunning) {
        console.log(`🌀 Dryer running/cooling (${currentPower.toFixed(1)}W)`);
      } else {
        console.log(`😴 Idle (${currentPower.toFixed(1)}W)`);
      }
    } else if (isHeating) {
      if (state.notificationSent) {
        console.log('🔄 New cycle detected - resetting notification flag');
      }

      state.hasSeenHeatingThisCycle = true;
      state.consecutiveLowReadings = 0;
      state.notificationSent = false;
      console.log(`🔥 Dryer heating (${currentPower.toFixed(1)}W)`);
    } else if (state.hasSeenHeatingThisCycle && isOff) {
      state.consecutiveLowReadings++;

      console.log(`📉 Low power: ${state.consecutiveLowReadings}/${cooldownReadings} consecutive readings`);

      if (state.consecutiveLowReadings >= cooldownReadings && !state.notificationSent) {
        console.log('🎉 Dryer finished! Sending notification...');

        notificationResult = await sendNotifications({
          currentPower,
          previousPower
        });

        if (notificationResult.success) {
          state.notificationSent = true;
        }
      }
    } else if (isRunning) {
      state.consecutiveLowReadings = 0;
      console.log(`🌀 Dryer running/cooling (${currentPower.toFixed(1)}W)`);
    } else {
      console.log(`😴 Idle (${currentPower.toFixed(1)}W)`);
    }
    
    state.previousPower = currentPower;
    
    return {
      success: true,
      currentPower,
      wasRunning,
      isRunning,
      isHeating,
      isOff,
      hasSeenHeatingThisCycle: state.hasSeenHeatingThisCycle,
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
    hasSeenHeatingThisCycle: false,
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
    const client = await getTapoClient();
    const energyData = await client.getEnergyUsage();
    const currentPower = (energyData.current_power || 0) / 1000;
    
    console.log(`✅ Credentials validated successfully!`);
    console.log(`📊 Device is online and responding`);
    console.log(`⚡ Current power: ${currentPower.toFixed(1)}W`);
    
    if (CONFIG.NTFY_TOPIC) {
      console.log(`📱 Push notifications enabled: ${CONFIG.NTFY_SERVER}/${CONFIG.NTFY_TOPIC}`);
    } else {
      console.log(`📱 Push notifications disabled (set NTFY_TOPIC to enable)`);
    }

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
    printAuthTroubleshooting();
    console.error('');
    console.error('Server will continue running, but monitoring will fail until credentials are fixed.');
    console.error('');
    return false;
  }
}

console.log('🚀 Starting Tapo Power Alert...');
console.log('');

validateEnvironment();

async function runDryerStatusCheck() {
  console.log(`\n⏰ ${new Date().toISOString()} - Checking dryer status...`);
  await checkDryerStatus();
}

function startMonitoring() {
  runDryerStatusCheck();
  setInterval(runDryerStatusCheck, CONFIG.CHECK_INTERVAL * 1000);
}

validateCredentials().then((credentialsValid) => {
  const status = credentialsValid ? '✅ Ready to monitor' : '⚠️  Running in degraded mode';
  if (CONFIG.PORT) {
    console.log(`🚀 Tapo Power Alert running on http://localhost:${CONFIG.PORT}`);
  } else {
    console.log('🚀 Tapo Power Alert running (HTTP API disabled)');
  }
  console.log(`   Status: ${status}`);
  console.log(`📊 Heating threshold: ${CONFIG.HEATING_THRESHOLD}W`);
  console.log(`📊 Off threshold: ${CONFIG.OFF_THRESHOLD}W`);
  console.log(`🔁 Cooldown readings: ${CONFIG.COOLDOWN_READINGS} (every ${CONFIG.CHECK_INTERVAL}s)`);
  startMonitoring();
});

if (CONFIG.PORT) {
  serve({
    port: CONFIG.PORT,
    async fetch(req, server) {
      const url = new URL(req.url);
      const path = url.pathname;

      switch (path) {
        case '/':
          return new Response('Tapo Power Alert is running', { status: 200 });

        case '/health':
          return Response.json({ status: 'healthy', timestamp: new Date().toISOString() });

        case '/check': {
          const denied = guardApiRoute(req, server, path);
          if (denied) return denied;
          const checkResult = await checkDryerStatus();
          return Response.json(checkResult);
        }

        case '/status': {
          const denied = guardApiRoute(req, server, path);
          if (denied) return denied;
          const status = await getTapoDeviceStatus();
          return Response.json(status);
        }

        case '/state': {
          const denied = guardApiRoute(req, server, path);
          if (denied) return denied;
          return Response.json({ ...getState(), timestamp: new Date().toISOString() });
        }

        case '/reset': {
          const denied = guardApiRoute(req, server, path);
          if (denied) return denied;
          resetState();
          return Response.json({ success: true, message: 'State reset', timestamp: new Date().toISOString() });
        }

        default:
          return new Response('Not Found', { status: 404 });
      }
    },
  });
}
