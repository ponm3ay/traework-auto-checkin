#!/usr/bin/env node
/**
 * TraeWork CN 每日自动签到
 *
 * 流程：读取本机 Trae 登录态（storage.json -> iCubeAuthInfo://icube.cloudide）
 *      -> AES-128-CBC 解密出 JWT
 *      -> POST 签到 API 完成积分领取
 *
 * 安全约束：只读登录态文件；不打印 token；不修改任何登录态文件。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ---------- 配置 ----------
const AUTH_STORAGE_KEY = 'iCubeAuthInfo://icube.cloudide';
const STATUS_URL = 'https://api.trae.cn/trae/api/v2/ug/checkin_credits/status';
const CLAIM_URL = 'https://api.trae.cn/trae/api/v2/ug/checkin_credits/claim';
const USAGE_URL = 'https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage'; // 积分余额查询（只读）
const MAX_ATTEMPTS = 3;        // 服务器高峰限流（code 9074）时的重试次数
const RETRY_BASE_MS = 5000;    // 重试基础等待
const REQUEST_TIMEOUT_MS = 20000;

// 登录态加密结构常量（AES-128-CBC，SHA-512 密钥派生）
const ENC_HEADER_LEN = 6;      // 密文前缀长度
const ENC_KEY_LEN = 32;        // 内嵌密钥材料长度
const ENC_TAG_LEN = 64;        // 解密后明文头部校验段长度
const ENC_MAT_LEN = 64;        // 密钥派生混淆材料长度
const MIX_A = Uint8Array.from([82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37]);
const MIX_B = Uint8Array.from([31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125]);

// 候选数据目录（按优先级排序，最终取登录态最新鲜的那个）
const CANDIDATE_DATA_DIRS = ['TRAE SOLO CN', 'Trae CN', 'TRAE SOLO', 'Trae'];

const LOG_DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'traework-auto-checkin');
const LOG_FILE = path.join(LOG_DIR, 'checkin.log');

// ---------- 日志（控制台 + 本地文件，绝不输出 token） ----------
function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch (_) { /* 日志写入失败不影响签到 */ }
}

// ---------- 登录态定位 ----------
function findStoragePath() {
  const override = process.env.TRAE_STORAGE_JSON;
  if (override && fs.existsSync(override)) return override;

  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const found = [];
  for (const dir of CANDIDATE_DATA_DIRS) {
    const p = path.join(appData, dir, 'User', 'globalStorage', 'storage.json');
    if (!fs.existsSync(p)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (typeof raw[AUTH_STORAGE_KEY] === 'string' && raw[AUTH_STORAGE_KEY].length > 0) {
        found.push({ path: p, mtime: fs.statSync(p).mtimeMs });
      }
    } catch (_) { /* 跳过损坏文件 */ }
  }
  if (found.length === 0) return null;
  found.sort((a, b) => b.mtime - a.mtime); // 最近活跃的登录态优先
  return found[0].path;
}

// ---------- 登录态解密（AES-128-CBC，SHA-512 密钥派生） ----------
function sha512(buf) {
  return crypto.createHash('sha512').update(buf).digest();
}

function mixMaterial() {
  const out = Buffer.alloc(ENC_MAT_LEN);
  for (let i = 0; i < ENC_MAT_LEN; i++) out[i] = MIX_A[i] ^ MIX_B[i];
  return out;
}

function decryptAuth(encB64) {
  const t = Buffer.from(encB64, 'base64');
  if (t.length <= ENC_HEADER_LEN + ENC_KEY_LEN) throw new Error('密文长度异常');
  const embeddedKey = t.subarray(ENC_HEADER_LEN, ENC_HEADER_LEN + ENC_KEY_LEN);
  const derived = sha512(Buffer.concat([sha512(embeddedKey), mixMaterial()]));
  const aesKey = derived.subarray(0, 16);
  const iv = derived.subarray(16, 32);
  const ciphertext = t.subarray(ENC_HEADER_LEN + ENC_KEY_LEN);
  const decipher = crypto.createDecipheriv('aes-128-cbc', aesKey, iv);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.subarray(ENC_TAG_LEN).toString('utf8');
}

// ---------- API ----------
async function postJson(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: '{}',
      signal: controller.signal,
    });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function payloadOf(json) {
  if (json && typeof json === 'object' && json.data && typeof json.data === 'object') return json.data;
  return json || {};
}

function codeOf(json) {
  if (json && json.code !== undefined && json.code !== null) return Number(json.code);
  return 0;
}

// ---------- 积分余额后缀（展示用，失败不影响签到结果） ----------
async function balanceSuffix(headers) {
  try {
    const u = await postJson(USAGE_URL, headers);
    const us = (u && typeof u === 'object' && u.usage_summary) || null;
    if (us && typeof us.total_amount === 'number') {
      const remain = Math.round((us.total_amount - (us.consumed_amount || 0)) * 100) / 100;
      return `，账户可用积分 ${remain}`;
    }
  } catch (_) { /* 展示性信息，忽略 */ }
  return '';
}

async function attempt(headers) {
  const st = await postJson(STATUS_URL, headers);
  const sc = codeOf(st);
  if (sc !== 0) {
    return { retry: sc === 9074, error: `查询签到状态失败 code=${sc} ${st.message || ''}`.trim() };
  }
  const sd = payloadOf(st);
  // 字段语义（与 TraeWork 客户端源码一致）：
  //   checked_in     账号级：本账号今日已在任意端完成签到
  //   did_checked_in 设备级：本设备今日已操作过签到
  //   credits        每日签到奖励额度（不是账户余额！）
  //   extra_credits  会员/升级每日加成额度
  const checkedIn = sd.checked_in !== undefined ? !!sd.checked_in : false;
  const didCheckedIn = sd.did_checked_in !== undefined ? !!sd.did_checked_in : false;
  const reward = sd.credits;

  if (checkedIn) {
    const rw = reward !== undefined ? `（每日签到奖励 ${reward} 积分）` : '';
    return { done: true, message: `今日已签到${rw}${await balanceSuffix(headers)}` };
  }
  if (sd.enable === false) {
    return { done: true, message: '签到功能未开启（enable=false）' };
  }
  if (didCheckedIn) {
    // 官方客户端同款限制：本设备今日已操作过，不再重复 claim
    return { done: true, message: '本设备今日已签到过，账号签到需在其他端完成或明日再试' };
  }

  const cl = await postJson(CLAIM_URL, headers);
  const cc = codeOf(cl);
  if (cc === 0) {
    // claim 已签状态下会返回 code 0 但不发放积分（幂等空操作），
    // 因此必须回查状态确认真实生效
    let confirmed = false;
    try {
      const st2 = await postJson(STATUS_URL, headers);
      confirmed = codeOf(st2) === 0 && !!payloadOf(st2).checked_in;
    } catch (_) { /* 回查失败按成功处理 */ }
    if (confirmed) {
      return { done: true, message: `签到成功，获得 ${reward !== undefined ? reward : 100} 积分${await balanceSuffix(headers)}` };
    }
    return { retry: true, error: 'claim 返回成功但服务器签到状态未更新，等待重试核实' };
  }
  return { retry: cc === 9074, error: `领取积分失败 code=${cc} ${cl.message || ''}`.trim() };
}

// ---------- 主流程 ----------
async function main() {
  const storagePath = findStoragePath();
  if (!storagePath) {
    log('ERROR: 未找到 Trae 登录态（storage.json），请先登录 Trae/TraeWork');
    process.exitCode = 2;
    return;
  }

  let storage;
  try {
    storage = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
  } catch (e) {
    log(`ERROR: 读取登录态失败 - ${e.message}`);
    process.exitCode = 2;
    return;
  }

  const enc = storage[AUTH_STORAGE_KEY];
  if (!enc) {
    log('ERROR: 登录态中没有 iCubeAuthInfo，请重新登录 Trae/TraeWork');
    process.exitCode = 2;
    return;
  }

  let auth;
  try {
    auth = JSON.parse(decryptAuth(enc));
  } catch (e) {
    log(`ERROR: 登录态解密失败 - ${e.message}（登录态可能已过期，或客户端加密方式已更新）`);
    process.exitCode = 2;
    return;
  }

  const token = auth.token || auth.accessToken || auth.access_token;
  if (!token) {
    log(`ERROR: 登录态中没有 token，可用字段: ${Object.keys(auth).join(', ')}`);
    process.exitCode = 2;
    return;
  }

  const headers = {
    'Authorization': `Cloud-IDE-JWT ${token}`,
    'Content-Type': 'application/json',
  };
  if (auth.userRegion && auth.userRegion.region) headers['X-User-Region'] = String(auth.userRegion.region);
  if (auth.userId !== undefined && auth.userId !== null) headers['X-User-Id'] = String(auth.userId);
  // 设备标识是签到 API 的隐藏必填项，缺失会返回 code 9004
  if (storage['telemetry.machineId']) headers['X-Machine-Id'] = String(storage['telemetry.machineId']);
  if (storage['telemetry.devDeviceId']) headers['X-Device-Id'] = String(storage['telemetry.devDeviceId']);

  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    let r;
    try {
      r = await attempt(headers);
    } catch (e) {
      r = { retry: true, error: `请求异常 - ${e.message}` };
    }
    if (r.done) {
      log(r.message);
      return;
    }
    log(r.error);
    if (!r.retry || i === MAX_ATTEMPTS) {
      log('ERROR: 签到失败（服务器限流时请稍后重试，定时任务会自动兜底）');
      process.exitCode = 1;
      return;
    }
    const wait = RETRY_BASE_MS * i + Math.floor(Math.random() * 3000);
    log(`等待 ${Math.round(wait / 1000)}s 后重试（${i}/${MAX_ATTEMPTS}）...`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

main().catch((e) => {
  log(`Fatal: ${e.message}`);
  process.exitCode = 1;
});
