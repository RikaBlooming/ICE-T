// 自包含更新引擎：拉 B 站数据 → 下载新封面 → 生成 index.html → 生成单文件版
// 纯 Node.js（18+），无第三方依赖，Windows / macOS / Linux 通用
// 用法: node update_site.mjs   (可设环境变量 BILI_MID 覆盖 UP 主 UID)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const MID = process.env.BILI_MID || '387685252';
const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
];
const MIXIN_KEY_ENC_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pickUA = () => UAS[Math.floor(Math.random() * UAS.length)];
let COOKIE = '';

// 先访问 B 站主页拿 buvid3 cookie（风控关键），拿不到也不致命
async function primeCookie() {
  try {
    const res = await fetch('https://www.bilibili.com/', { headers: { 'User-Agent': pickUA() }, redirect: 'follow' });
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    const parts = [];
    for (const c of setCookies) { const name = c.split('=')[0]; if (name && !['_uuid','b_nut'].includes(name)) parts.push(c.split(';')[0]); }
    if (setCookies.length) COOKIE = parts.join('; ');
    console.log('   [cookie] 已获取 buvid3: ' + (COOKIE.includes('buvid3') ? 'OK' : '无'));
  } catch (e) {
    console.log('   [cookie] 获取失败（继续尝试）: ' + e.message);
  }
}

async function fetchJson(url, headers = {}, retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      const h = { 'User-Agent': pickUA(), Referer: 'https://www.bilibili.com/', Accept: 'application/json, text/plain, */*', ...headers };
      if (COOKIE) h.Cookie = COOKIE;
      const res = await fetch(url, { headers: h });
      const text = await res.text();
      if (!text.trim().startsWith('{')) {
        console.log(`  [warn] 非JSON响应(第${i + 1}次, HTTP ${res.status}):`, text.slice(0, 60).replace(/\s+/g, ' '));
        await sleep(2500 * (i + 1));
        continue;
      }
      return JSON.parse(text);
    } catch (e) {
      if (i === retries - 1) throw e;
      await sleep(2500 * (i + 1));
    }
  }
  throw new Error('fetch failed: ' + url);
}

function getMixinKey(orig) {
  let out = '';
  for (const i of MIXIN_KEY_ENC_TAB) out += orig[i] ?? '';
  return out.slice(0, 32);
}

async function getWbiKey() {
  const nav = await fetchJson('https://api.bilibili.com/x/web-interface/nav');
  const imgKey = nav.data.wbi_img.img_url.split('/').pop().split('.')[0];
  const subKey = nav.data.wbi_img.sub_url.split('/').pop().split('.')[0];
  return getMixinKey(imgKey + subKey);
}

function encWbi(params, mixinKey) {
  const wts = Math.round(Date.now() / 1000);
  const p = { ...params, wts };
  const query = Object.keys(p).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(p[k])}`).join('&');
  return `${query}&w_rid=${crypto.createHash('md5').update(query + mixinKey).digest('hex')}`;
}

async function download(url, dest, retries = 4) {
  for (let i = 0; i < retries; i++) {
    try {
      const h = { 'User-Agent': pickUA(), Referer: 'https://www.bilibili.com/' };
      if (COOKIE) h.Cookie = COOKIE;
      const res = await fetch(url, { headers: h });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 800) throw new Error('too small ' + buf.length);
      fs.writeFileSync(dest, buf);
      return buf.length;
    } catch (e) {
      if (i === retries - 1) throw e;
      await sleep(1500 * (i + 1));
    }
  }
  throw new Error('download failed: ' + url);
}

// ---------- 1. 拉取视频列表（双通道：主=列表接口，备=view详情刷新） ----------
console.log('▶ 1/4 拉取最新视频数据 (mid=' + MID + ') ...');
await primeCookie();
let videos = [];
let usedCache = false;

// 主通道：WBI 签名列表接口
async function fetchList() {
  const mixinKey = await getWbiKey();
  let out = [];
  let pn = 1;
  while (true) {
    const q = encWbi({ mid: MID, pn, ps: 50, order: 'pubdate', platform: 'web' }, mixinKey);
    const v = await fetchJson(`https://api.bilibili.com/x/space/wbi/arc/search?${q}`);
    if (v.code !== 0 || !v.data?.list?.vlist?.length) { console.log('  [warn] 分页结束 code=' + v.code); break; }
    out.push(...v.data.list.vlist);
    if (out.length >= v.data.page.count) break;
    pn++;
    await sleep(600);
  }
  return out;
}

try {
  videos = await fetchList();
} catch (e) {
  console.log('  [warn] 列表接口异常: ' + e.message);
}

// 备用通道：用缓存的 bvid 列表 + view 接口刷新详情（view 接口风控宽松，确定可用）
if (!videos.length) {
  const cachePath = path.join(ROOT, 'user_videos.json');
  if (fs.existsSync(cachePath)) {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (cached.length) {
      console.log(`  [fallback] 列表接口不可用，改用 view 详情接口刷新 ${cached.length} 个缓存视频 ...`);
      const refreshed = [];
      for (let i = 0; i < cached.length; i++) {
        const bvid = cached[i].bvid;
        try {
          const v = await fetchJson(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
          if (v.code === 0 && v.data) {
            const d = v.data;
            refreshed.push({
              bvid: d.bvid,
              title: d.title,
              pic: d.pic,
              play: d.stat.view,
              length: (() => { const s = d.duration; return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); })(),
              created: d.pubdate,
              comment: d.stat.reply,
            });
          } else {
            refreshed.push(cached[i]);
          }
        } catch (err) {
          refreshed.push(cached[i]);
        }
        if (i % 10 === 9) { console.log(`   ...已刷新 ${i + 1}/${cached.length}`); await sleep(400); }
      }
      videos = refreshed;
      usedCache = true;
    }
  }
}
if (!videos.length) { console.error('✘ 没有任何数据且无缓存可用，退出'); process.exit(1); }
fs.writeFileSync(path.join(ROOT, 'user_videos.json'), JSON.stringify(videos, null, 2), 'utf8');
console.log(`   共 ${videos.length} 个视频` + (usedCache ? '（view接口刷新模式）' : ''));

// ---------- 2. 下载新封面 ----------
console.log('▶ 2/4 同步封面图片（仅下载新增）...');
const outDir = path.join(ROOT, 'assets');
fs.mkdirSync(outDir, { recursive: true });
let downloaded = 0;
for (const v of videos) {
  const fname = v.bvid + '.webp';
  const dest = path.join(outDir, fname);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 800) continue;
  const url = v.pic.replace(/^http:/, 'https:').replace(/@.*$/, '') + '@672w_378h_1c.webp';
  try {
    await download(url, dest);
    downloaded++;
    console.log('   +', fname);
  } catch (e) { console.log('   ! 失败', fname, e.message); }
}
console.log(`   新下载 ${downloaded} 张封面`);

// ---------- 3. 生成 index.html ----------
console.log('▶ 3/4 生成 index.html ...');

function https(u) { return u.replace(/^http:/, 'https:'); }
function fmtPlay(n) { return n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n); }
function fmtDate(ts) {
  const d = new Date(ts * 1000);
  const p = x => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function parseLen(s) { const p = s.split(':').map(Number); return p[0] * 60 + (p[1] || 0); }
function catOf(v) {
  const t = v.title;
  if (t.includes('不止卡兹')) return '不止卡兹';
  if (t.includes('直播')) return '直播回放';
  if (/战地|BF5|Battlefield|BA\(|MISIDE|米塔/.test(t)) return '战地日常';
  return '杂谈日常';
}

const data = videos.map(v => ({
  title: v.title, play: v.play, playStr: fmtPlay(v.play),
  length: v.length, lenSec: parseLen(v.length),
  date: fmtDate(v.created), created: v.created,
  bvid: v.bvid, pic: 'assets/' + v.bvid + '.webp', cat: catOf(v),
}));
const totalPlay = data.reduce((a, v) => a + v.play, 0);
const avgPlay = Math.round(totalPlay / data.length);
const hot = [...data].sort((a, b) => b.play - a.play)[0];
const longest = [...data].sort((a, b) => b.lenSec - a.lenSec)[0];
const cats = [...new Set(data.map(v => v.cat))];
const catCount = {};
data.forEach(v => catCount[v.cat] = (catCount[v.cat] || 0) + 1);
const featured = data.filter(v => v.cat === '不止卡兹').sort((a, b) => b.play - a.play).slice(0, 3);
const fmtWan = n => (n / 10000).toFixed(1) + '万';

// 页面脚本里要用的数据（注意替换 </script 防注入）
const jsonSafe = JSON.stringify({ data, cats, catCount, featured })
  .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>冰某氚ICE-T · 作战日志</title>
<style>
:root{--bg:#0b0f0c;--bg2:#0f140f;--panel:#141a13;--panel2:#1a2118;--line:#2a3427;--line2:#3a4638;--brass:#c9a15a;--brass-hi:#e6c37e;--brass-dim:#8a6f3c;--red:#b3392b;--red-hi:#d34a38;--paper:#e6dcc0;--text:#d9d3bd;--muted:#8f947d;--stencil:Impact,'Arial Black','SimHei',sans-serif;--serif:Georgia,'Songti SC','STSong','SimSun',serif;--sans:'PingFang SC','Microsoft YaHei','Hiragino Sans GB',sans-serif;--mono:'Courier New','Sarasa Mono SC',Consolas,monospace}
*{margin:0;padding:0;box-sizing:border-box}
html{scroll-behavior:smooth}
body{background:var(--bg);color:var(--text);font-family:var(--sans);line-height:1.6;overflow-x:hidden}
body::before{content:'';position:fixed;inset:0;z-index:999;pointer-events:none;opacity:.05;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)' opacity='0.6'/%3E%3C/svg%3E")}
::selection{background:var(--brass);color:#1a1206}
a{color:inherit;text-decoration:none}
.ticker{background:var(--red);color:#f3ead6;font-family:var(--mono);font-size:12px;letter-spacing:.18em;padding:7px 0;overflow:hidden;white-space:nowrap;border-bottom:1px solid #000}
.ticker span{display:inline-block;padding-left:100%;animation:tick 36s linear infinite}
@keyframes tick{to{transform:translateX(-100%)}}
.hero{position:relative;min-height:92vh;display:flex;align-items:center;padding:70px 6vw 60px;overflow:hidden;background:radial-gradient(1200px 600px at 78% 18%,rgba(201,161,90,.09),transparent 60%),radial-gradient(900px 500px at 10% 85%,rgba(179,57,43,.07),transparent 60%),var(--bg2)}
.hero::before{content:'';position:absolute;inset:0;pointer-events:none;opacity:.5;background-image:linear-gradient(rgba(201,161,90,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(201,161,90,.05) 1px,transparent 1px);background-size:56px 56px;mask-image:radial-gradient(ellipse at center,black 30%,transparent 78%)}
.hero::after{content:'';position:absolute;right:-180px;top:-180px;width:560px;height:560px;border-radius:50%;background:conic-gradient(from 0deg,rgba(201,161,90,.16),transparent 16%);animation:radar 7s linear infinite;border:1px solid rgba(201,161,90,.12);box-shadow:inset 0 0 80px rgba(201,161,90,.05)}
@keyframes radar{to{transform:rotate(360deg)}}
.watermark{position:absolute;right:2vw;bottom:-4vw;font-family:var(--stencil);font-size:clamp(120px,22vw,320px);color:transparent;line-height:1;pointer-events:none;-webkit-text-stroke:1px rgba(201,161,90,.10);letter-spacing:.02em;user-select:none}
.hero-inner{position:relative;z-index:2;display:grid;grid-template-columns:auto 1fr;gap:clamp(30px,5vw,80px);align-items:center;max-width:1200px;margin:0 auto;width:100%}
.avatar-wrap{position:relative;width:clamp(150px,20vw,230px);height:clamp(150px,20vw,230px)}
.avatar-ring{position:absolute;inset:0;border-radius:50%;border:1px dashed var(--brass-dim);animation:spin 22s linear infinite}
.avatar-ring::before,.avatar-ring::after{content:'';position:absolute;width:10px;height:10px;background:var(--brass);border-radius:50%}
.avatar-ring::before{top:-5px;left:50%;transform:translateX(-50%)}
.avatar-ring::after{bottom:-5px;right:8%}
@keyframes spin{to{transform:rotate(360deg)}}
.avatar-frame{position:absolute;inset:14px;border-radius:50%;overflow:hidden;border:3px solid var(--brass);box-shadow:0 0 0 6px rgba(201,161,90,.14),0 0 60px rgba(201,161,90,.25);background:#1a1206}
.avatar-frame img{width:100%;height:100%;object-fit:cover;filter:saturate(.92) contrast(1.05)}
.avatar-frame::after{content:'';position:absolute;inset:0;border-radius:50%;background:radial-gradient(circle at 30% 25%,transparent 55%,rgba(0,0,0,.45))}
.stamp{position:absolute;padding:6px 12px;font-family:var(--stencil);letter-spacing:.28em;font-size:14px;color:var(--red-hi);border:3px double var(--red-hi);border-radius:4px;background:rgba(11,15,12,.72);transform:rotate(-14deg);user-select:none;box-shadow:0 2px 12px rgba(0,0,0,.4)}
.stamp.top{top:-6px;right:-26px;animation:stampIn .8s cubic-bezier(.2,1.6,.4,1) .7s backwards}
.stamp.bot{bottom:2px;left:-40px;transform:rotate(9deg);animation:stampIn .8s cubic-bezier(.2,1.6,.4,1) 1s backwards}
@keyframes stampIn{from{opacity:0;transform:scale(1.6) rotate(-20deg)}}
.kicker{font-family:var(--mono);font-size:13px;letter-spacing:.4em;color:var(--brass);text-transform:uppercase;margin-bottom:14px;display:flex;align-items:center;gap:12px}
.kicker::before{content:'';width:46px;height:1px;background:var(--brass)}
.name-cn{font-family:var(--serif);font-size:clamp(38px,6vw,72px);font-weight:700;color:var(--paper);letter-spacing:.06em;line-height:1.15}
.name-cn em{font-style:normal;color:var(--brass-hi)}
.name-en{font-family:var(--stencil);font-size:clamp(26px,3.6vw,44px);letter-spacing:.1em;color:transparent;-webkit-text-stroke:1px rgba(230,195,126,.75);margin:6px 0 18px}
.motto{display:inline-flex;align-items:center;gap:10px;font-family:var(--serif);font-size:clamp(16px,1.6vw,20px);color:var(--text);border-left:3px solid var(--red);padding-left:14px;margin-bottom:26px}
.motto b{color:var(--brass-hi);font-weight:700}
.stats-chips{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:30px}
.chip{font-family:var(--mono);font-size:12.5px;letter-spacing:.06em;border:1px solid var(--line2);background:rgba(20,26,19,.7);padding:6px 14px;border-radius:2px;color:var(--muted)}
.chip b{color:var(--brass-hi);font-weight:700;font-size:14px;margin-right:4px}
.cta{display:flex;gap:14px;flex-wrap:wrap}
.btn{font-family:var(--stencil);letter-spacing:.22em;font-size:15px;padding:13px 26px;border:1px solid var(--brass);color:var(--brass-hi);position:relative;transition:.25s;background:transparent;cursor:pointer}
.btn::after{content:'';position:absolute;left:6px;top:6px;right:-6px;bottom:-6px;border:1px solid rgba(201,161,90,.35);transition:.25s;z-index:-1}
.btn:hover{background:var(--brass);color:#1a1206;box-shadow:0 0 34px rgba(201,161,90,.35)}
.btn:hover::after{right:0;bottom:0;left:0;top:0}
.btn.solid{background:var(--red);border-color:var(--red);color:#f3ead6}
.btn.solid::after{border-color:rgba(179,57,43,.5)}
.btn.solid:hover{background:var(--red-hi)}
.databar{border-top:1px solid var(--line);border-bottom:1px solid var(--line);background:var(--bg2);display:grid;grid-template-columns:repeat(4,1fr)}
.dcell{padding:30px 26px;text-align:center;border-right:1px solid var(--line);position:relative}
.dcell:last-child{border-right:none}
.dcell .num{font-family:var(--stencil);font-size:clamp(28px,3.4vw,46px);color:var(--paper);letter-spacing:.04em}
.dcell .num small{font-size:.45em;color:var(--brass);letter-spacing:.1em;margin-left:4px}
.dcell .lbl{font-family:var(--mono);font-size:11.5px;letter-spacing:.34em;color:var(--muted);margin-top:6px;text-transform:uppercase}
.dcell .sub{font-size:12px;color:var(--muted);margin-top:4px;font-family:var(--serif)}
.dcell::before{content:'';position:absolute;left:0;bottom:0;height:2px;width:0;background:var(--red);transition:width .6s ease}
.dcell:hover::before{width:100%}
section{position:relative;padding:80px 6vw}
.section-head{max-width:1200px;margin:0 auto 44px}
.sec-tag{font-family:var(--mono);font-size:12px;letter-spacing:.42em;color:var(--brass);text-transform:uppercase;display:flex;align-items:center;gap:14px;margin-bottom:12px}
.sec-tag::after{content:'';flex:1;height:1px;background:linear-gradient(90deg,var(--line2),transparent)}
.sec-title{font-family:var(--serif);font-size:clamp(26px,3.4vw,40px);color:var(--paper);font-weight:700;letter-spacing:.04em}
.sec-title .en{font-family:var(--stencil);color:var(--brass-dim);font-size:.5em;letter-spacing:.3em;vertical-align:middle;margin-left:12px}
.series{background:linear-gradient(rgba(179,57,43,.05),rgba(179,57,43,.05)),var(--bg)}
.series-band{max-width:1200px;margin:0 auto;display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
.scard{position:relative;border:1px solid var(--line);background:var(--panel);overflow:hidden;transition:.35s;cursor:pointer;display:block}
.scard:hover{transform:translateY(-6px);border-color:var(--brass-dim);box-shadow:0 18px 50px rgba(0,0,0,.5)}
.scard .cover{position:relative;aspect-ratio:16/9;overflow:hidden}
.scard .cover img{width:100%;height:100%;object-fit:cover;transition:.6s;filter:saturate(.9)}
.scard:hover .cover img{transform:scale(1.07);filter:saturate(1.05)}
.scard .dur{position:absolute;right:10px;bottom:10px;font-family:var(--mono);font-size:11.5px;background:rgba(0,0,0,.78);color:var(--paper);padding:2px 8px;letter-spacing:.05em}
.scard .body{padding:16px 18px 18px}
.scard .num-tag{font-family:var(--stencil);color:var(--brass-dim);font-size:12px;letter-spacing:.26em;margin-bottom:6px}
.scard h3{font-size:15.5px;color:var(--text);font-weight:600;line-height:1.5;min-height:3em;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.scard .meta{margin-top:12px;display:flex;justify-content:space-between;font-family:var(--mono);font-size:12px;color:var(--muted)}
.scard .meta .play{color:var(--brass-hi)}
.grid-sec{background:var(--bg2)}
.filters{max-width:1200px;margin:0 auto 10px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between}
.tabs{display:flex;flex-wrap:wrap;gap:8px}
.tab{font-family:var(--mono);font-size:12.5px;letter-spacing:.14em;padding:7px 16px;border:1px solid var(--line2);color:var(--muted);cursor:pointer;background:transparent;transition:.2s}
.tab:hover{color:var(--brass-hi);border-color:var(--brass-dim)}
.tab.on{background:var(--brass);color:#1a1206;border-color:var(--brass);font-weight:700}
.searchbox{display:flex;align-items:center;border:1px solid var(--line2);background:var(--panel)}
.searchbox input{background:transparent;border:none;outline:none;color:var(--text);font-family:var(--mono);font-size:12.5px;padding:9px 12px;width:170px}
.searchbox::before{content:'⌕';color:var(--brass-dim);padding-left:10px;font-size:14px}
.sortrow{max-width:1200px;margin:0 auto 26px;display:flex;justify-content:flex-end;gap:8px}
.sortbtn{font-family:var(--mono);font-size:11.5px;letter-spacing:.18em;color:var(--muted);border:1px solid transparent;background:transparent;cursor:pointer;padding:4px 8px;transition:.2s}
.sortbtn.on{color:var(--brass-hi);border-bottom-color:var(--brass)}
.vgrid{max-width:1200px;margin:0 auto;display:grid;grid-template-columns:repeat(4,1fr);gap:18px}
.vcard{position:relative;border:1px solid var(--line);background:var(--panel);transition:.3s;cursor:pointer;display:block;overflow:hidden}
.vcard:hover{transform:translateY(-5px);border-color:var(--brass-dim);box-shadow:0 14px 40px rgba(0,0,0,.55)}
.vcard .cover{position:relative;aspect-ratio:16/9;overflow:hidden;background:#000}
.vcard .cover img{width:100%;height:100%;object-fit:cover;transition:.55s;filter:saturate(.88) brightness(.95)}
.vcard:hover .cover img{transform:scale(1.08);filter:saturate(1.06) brightness(1)}
.vcard .cover::after{content:'';position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,.55),transparent 45%);opacity:0;transition:.3s}
.vcard:hover .cover::after{opacity:1}
.vcard .dur{position:absolute;right:8px;bottom:8px;font-family:var(--mono);font-size:11px;background:rgba(0,0,0,.8);color:var(--paper);padding:1px 7px;z-index:2}
.vcard .cat-tag{position:absolute;left:8px;top:8px;z-index:2;font-family:var(--mono);font-size:10px;letter-spacing:.14em;background:rgba(11,15,12,.82);border:1px solid var(--line2);color:var(--brass);padding:2px 8px}
.vcard .body{padding:12px 14px 14px}
.vcard h3{font-size:13.5px;color:var(--text);font-weight:600;line-height:1.5;min-height:3.6em;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;transition:.2s}
.vcard:hover h3{color:var(--brass-hi)}
.vcard .meta{margin-top:10px;display:flex;justify-content:space-between;font-family:var(--mono);font-size:11.5px;color:var(--muted)}
.vcard .meta .play{color:var(--brass-hi)}
.empty{grid-column:1/-1;text-align:center;color:var(--muted);font-family:var(--mono);padding:60px 0;letter-spacing:.2em}
.quote-band{border-top:1px solid var(--line);border-bottom:1px solid var(--line);background:repeating-linear-gradient(-45deg,rgba(201,161,90,.03) 0 14px,transparent 14px 28px),var(--bg);text-align:center;padding:64px 6vw}
.quote-band .q{font-family:var(--serif);font-size:clamp(20px,2.6vw,30px);color:var(--paper);letter-spacing:.1em;line-height:1.9}
.quote-band .q b{color:var(--brass-hi)}
.quote-band .from{margin-top:16px;font-family:var(--mono);font-size:12px;letter-spacing:.4em;color:var(--muted)}
footer{padding:50px 6vw 40px;background:#080b08;border-top:1px solid var(--line);text-align:center;font-size:12.5px;color:var(--muted)}
footer .flink{font-family:var(--stencil);letter-spacing:.24em;color:var(--brass);font-size:15px}
footer p{margin-top:10px;line-height:1.9}
.reveal{opacity:0;transform:translateY(26px);transition:opacity .7s ease,transform .7s ease}
.reveal.in{opacity:1;transform:none}
.stagger>*{opacity:0;transform:translateY(24px);transition:opacity .55s ease,transform .55s ease}
.stagger.in>*{opacity:1;transform:none}
@media (max-width:1024px){.vgrid{grid-template-columns:repeat(3,1fr)}}
@media (max-width:820px){.hero-inner{grid-template-columns:1fr;text-align:center}.avatar-wrap{margin:0 auto}.kicker{justify-content:center}.kicker::before{display:none}.motto{justify-content:center}.cta{justify-content:center}.stats-chips{justify-content:center}.databar{grid-template-columns:repeat(2,1fr)}.dcell{border-bottom:1px solid var(--line)}.series-band{grid-template-columns:1fr}.vgrid{grid-template-columns:repeat(2,1fr)}.stamp.top{right:0}}
@media (max-width:480px){.vgrid{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="ticker"><span>KARDS · 二战卡牌对战 · 「不止卡兹」深度杂谈 · 战地风云 · 直播日常 · 做一个有理想的人 · B站 UP主 冰某氚ICE-T · </span></div>
<header class="hero">
  <div class="hero-inner">
    <div class="avatar-wrap reveal">
      <div class="avatar-ring"></div>
      <div class="avatar-frame"><img src="assets/avatar.webp" alt="冰某氚ICE-T"></div>
      <div class="stamp top">机密</div>
      <div class="stamp bot">FAN-MADE</div>
    </div>
    <div>
      <div class="kicker reveal">Bilibili Creator · 空间作战日志</div>
      <h1 class="name-cn reveal">冰某氚<em>ICE-T</em></h1>
      <div class="name-en reveal">OPERATION LOG · 2026</div>
      <div class="motto reveal"><b>"</b>做一个有理想的人<b>"</b></div>
      <div class="stats-chips reveal">
        <span class="chip"><b>${data.length}</b> 视频</span>
        <span class="chip"><b>${fmtWan(totalPlay)}</b> 总播放</span>
        <span class="chip"><b>5,845</b> 粉丝</span>
        <span class="chip"><b>699</b> 关注</span>
        <span class="chip"><b>Lv.6</b> 年度大会员</span>
      </div>
      <div class="cta reveal">
        <a class="btn solid" href="https://space.bilibili.com/387685252" target="_blank" rel="noopener">访问主页</a>
        <a class="btn" href="#videos">查看全部视频</a>
      </div>
    </div>
  </div>
  <div class="watermark">ICE-T</div>
</header>
<div class="databar">
  <div class="dcell reveal"><div class="num">${fmtWan(totalPlay)}<small>PLAYS</small></div><div class="lbl">累计播放</div></div>
  <div class="dcell reveal"><div class="num">${fmtWan(avgPlay)}<small>AVG</small></div><div class="lbl">平均播放</div></div>
  <div class="dcell reveal"><div class="num">${(hot.play / 10000).toFixed(1)}<small>万</small></div><div class="lbl">最高播放</div><div class="sub">${hot.title.slice(0, 12)}…</div></div>
  <div class="dcell reveal"><div class="num">${longest.length}<small>MIN</small></div><div class="lbl">最长视频</div><div class="sub">${longest.title.slice(0, 12)}…</div></div>
</div>
<section class="series" id="series">
  <div class="section-head reveal">
    <div class="sec-tag">Featured Series · 招牌系列</div>
    <div class="sec-title">「不止卡兹」<span class="en">KARDS TALKS</span></div>
  </div>
  <div class="series-band stagger" id="featuredGrid"></div>
</section>
<section class="grid-sec" id="videos">
  <div class="section-head reveal">
    <div class="sec-tag">Archive · 视频档案</div>
    <div class="sec-title">全部作战记录<span class="en">${data.length} FILES</span></div>
  </div>
  <div class="filters reveal">
    <div class="tabs" id="tabs"></div>
    <div class="searchbox"><input id="q" type="text" placeholder="搜索标题..."></div>
  </div>
  <div class="sortrow reveal">
    <button class="sortbtn on" data-sort="latest">最新发布</button>
    <button class="sortbtn" data-sort="hot">播放最多</button>
  </div>
  <div class="vgrid" id="grid"></div>
</section>
<div class="quote-band">
  <div class="q reveal">"<b>为什么，。战地6。。，没有。刺刀？！</b>"<br>—— 来自一位认真的吐槽 UP 主</div>
  <div class="from reveal">KARDS · BFV · LIVE · 2022—2026</div>
</div>
<footer>
  <a class="flink" href="https://space.bilibili.com/387685252" target="_blank" rel="noopener">冰某氚ICE-T · 空间入口</a>
  <p>本页面为非官方粉丝向展示页，数据来自 Bilibili 公开接口（${data.length} 个视频 · 更新于 ${data[0].date}）<br>尊重创作，支持正版 · 做一个有理想的人</p>
</footer>
<script>
var PAGE = ${jsonSafe};
var DATA = PAGE.data, CATS = PAGE.cats, CATCOUNT = PAGE.catCount, FEATURED = PAGE.featured;
function coverCard(v){return '<a class="vcard" href="https://www.bilibili.com/video/'+v.bvid+'" target="_blank" rel="noopener"><div class="cover"><img src="'+v.pic+'" alt="'+v.title+'" loading="lazy"><span class="cat-tag">'+v.cat+'</span><span class="dur">'+v.length+'</span></div><div class="body"><h3>'+v.title+'</h3><div class="meta"><span class="play">▶ '+v.playStr+'</span><span>'+v.date+'</span></div></div></a>'}
function seriesCard(v,i){return '<a class="scard" href="https://www.bilibili.com/video/'+v.bvid+'" target="_blank" rel="noopener"><div class="cover"><img src="'+v.pic+'" alt="'+v.title+'" loading="lazy"><span class="dur">'+v.length+'</span></div><div class="body"><div class="num-tag">FILE '+String(i+1).padStart(2,'0')+' · 不止卡兹</div><h3>'+v.title+'</h3><div class="meta"><span class="play">▶ '+v.playStr+'</span><span>'+v.date+'</span></div></div></a>'}
var state={cat:'全部',sort:'latest',q:''};
function renderTabs(){var el=document.getElementById('tabs');var h='<button class="tab on" data-cat="全部">全部 '+DATA.length+'</button>';CATS.forEach(function(c){h+='<button class="tab" data-cat="'+c+'">'+c+' '+CATCOUNT[c]+'</button>'});el.innerHTML=h}
function renderGrid(){var list=DATA.filter(function(v){if(state.cat!=='全部'&&v.cat!==state.cat)return false;if(state.q&&v.title.toLowerCase().indexOf(state.q.toLowerCase())<0)return false;return true});list.sort(function(a,b){return state.sort==='hot'?b.play-a.play:b.created-a.created});var el=document.getElementById('grid');if(!list.length){el.innerHTML='<div class="empty">— 未找到匹配记录 —</div>';return}el.innerHTML=list.map(coverCard).join('')}
function renderFeatured(){document.getElementById('featuredGrid').innerHTML=FEATURED.map(seriesCard).join('')}
document.getElementById('tabs').addEventListener('click',function(e){var b=e.target.closest('.tab');if(!b)return;state.cat=b.dataset.cat;document.querySelectorAll('.tab').forEach(function(t){t.classList.toggle('on',t===b)});renderGrid()});
document.querySelectorAll('.sortbtn').forEach(function(b){b.addEventListener('click',function(){state.sort=b.dataset.sort;document.querySelectorAll('.sortbtn').forEach(function(x){x.classList.toggle('on',x===b)});renderGrid()})});
var qEl=document.getElementById('q');qEl.addEventListener('input',function(){state.q=qEl.value;renderGrid()});
var io=new IntersectionObserver(function(es){es.forEach(function(en){if(en.isIntersecting){en.target.classList.add('in');io.unobserve(en.target)}})},{threshold:0.12});
document.querySelectorAll('.reveal,.stagger').forEach(function(el){io.observe(el)});
renderTabs();renderFeatured();renderGrid();
</script>
</body>
</html>`;

fs.writeFileSync(path.join(ROOT, 'index.html'), html, 'utf8');
console.log('   index.html 已生成 (' + (html.length / 1024).toFixed(0) + ' KB)');

// ---------- 4. 生成单文件版（图片内嵌） ----------
console.log('▶ 4/4 生成单文件版 index-standalone.html ...');
let standalone = html;
standalone = standalone.replace(/src="assets\/([A-Za-z0-9]+\.webp)"/g, (m, fname) => {
  const p = path.join(ROOT, 'assets', fname);
  if (!fs.existsSync(p)) { console.log('   [warn] 缺少', fname); return m; }
  return 'src="data:image/webp;base64,' + fs.readFileSync(p).toString('base64') + '"';
});
standalone = standalone.replace(/"pic":"assets\/([A-Za-z0-9]+\.webp)"/g, (m, fname) => {
  const p = path.join(ROOT, 'assets', fname);
  if (!fs.existsSync(p)) return m;
  return '"pic":"data:image/webp;base64,' + fs.readFileSync(p).toString('base64') + '"';
});
fs.writeFileSync(path.join(ROOT, 'index-standalone.html'), standalone, 'utf8');
const leftover = (standalone.match(/assets\//g) || []).length;
console.log('   index-standalone.html 已生成 (' + (standalone.length / 1024 / 1024).toFixed(2) + ' MB) 残留引用: ' + leftover);

// ---------- 5. 生成部署说明 ----------
const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
console.log('✔ 全部完成 @ ' + stamp);
console.log('   交付物: index.html（普通版）/ index-standalone.html（单文件版）');
