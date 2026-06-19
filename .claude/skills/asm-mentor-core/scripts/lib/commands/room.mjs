// room.mjs — 회의실 예약. availability (live DOM, slots free/taken) + reserve + cancel.
import { url, sel } from '../maps.mjs';
import { withSession, gotoGuarded, regionUrl } from '../session.mjs';
import { evalJson } from '../dom.mjs';
import { artifact, setText } from '../widgets.mjs';
import { AsmError } from '../io.mjs';

function listUrl(region, date) {
  let rel = url('room', 'list');
  if (date) rel += `&sdate=${encodeURIComponent(date)}`;
  return regionUrl(region, rel);
}
function viewUrl(region, date, itemId) {
  return `${regionUrl(region, url('room', 'view'))}&sdate=${encodeURIComponent(date)}&itemId=${encodeURIComponent(itemId)}`;
}

// Discover rooms (itemId, name, full?) from the list page for a date. The reserve
// target is in each room anchor's onclick (location.href='...itemId=N'); fully-booked
// rooms instead carry an alert() onclick.
async function discoverRooms(page) {
  const rooms = await evalJson(page, () => {
    const out = [];
    document.querySelectorAll('a[onclick]').forEach((a) => {
      const oc = a.getAttribute('onclick') || '';
      const name = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (!/스페이스|호실|회의실|하이텐|하이스퀘어|[QS]\d|webex/i.test(name)) return;
      const m = oc.match(/itemId=(\d+)/);
      const short = name.split('이용기간')[0].trim() || name.slice(0, 24);
      if (m) out.push({ itemId: m[1], name: short, full: false, raw: name });
      else if (/예약되었습니다|이미 모든/.test(oc)) out.push({ itemId: null, name: short, full: true, raw: name });
    });
    const seen = {};
    return out.filter((r) => { const k = r.itemId || r.name; return seen[k] ? false : (seen[k] = 1); });
  });
  return rooms.map((r) => {
    const cap = (r.raw || '').match(/(\d+(?:-\d+)?)\s*[인명]/);
    return { itemId: r.itemId, name: r.name, full: r.full, capacity: cap ? cap[1] : null };
  });
}

// The slot grid is injected by JS ~1s after load; poll until it appears.
async function waitSlots(page) {
  for (let i = 0; i < 16; i++) {
    const n = await evalJson(page, () => document.querySelectorAll('input[name="time"]').length);
    if (n > 0) { await page.waitForTimeout(300); return n; }
    await page.waitForTimeout(400);
  }
  return 0;
}

// Read the 30-min slot grid on a room view page (live DOM).
async function readSlots(page) {
  return evalJson(page, () => {
    return [...document.querySelectorAll('input[name="time"]')].map((cb) => {
      const lab = document.querySelector('label[for="' + cb.id + '"]');
      const cd = document.querySelector('input[name="chkData_' + cb.value + '"]');
      const time = cd ? cd.value : (lab ? lab.textContent.replace(/[^0-9:]/g, '') : null);
      const reserver = (cb.title || (lab && lab.title) || '').replace(/예약자\s*:\s*/, '').trim() || null;
      return { idx: Number(cb.value), id: cb.id, time, status: cb.disabled ? 'taken' : 'free', reserver };
    }).filter((s) => s.time);
  });
}

function addMinutes(hhmm, mins) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = h * 60 + m + mins;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

export async function availability(ctx) {
  const { region, state, flags } = ctx;
  const date = flags.date;
  if (!date) throw new AsmError('VALIDATION', 'room-availability requires --date YYYY-MM-DD');
  const wantRoom = flags.room;
  const wantId = flags.itemId;
  return withSession(region, async ({ page }) => {
    await gotoGuarded(page, region, listUrl(region, date), state);
    let rooms = await discoverRooms(page);
    if (wantId) rooms = rooms.filter((r) => String(r.itemId) === String(wantId));
    else if (wantRoom) rooms = rooms.filter((r) => (r.name || '').includes(wantRoom));
    const result = [];
    for (const room of rooms) {
      if (room.full || !room.itemId) { result.push({ ...room, freeCount: 0, slots: [] }); continue; }
      await gotoGuarded(page, region, viewUrl(region, date, room.itemId), state);
      await waitSlots(page);
      const slots = await readSlots(page);
      result.push({ ...room, freeCount: slots.filter((s) => s.status === 'free').length, slots });
    }
    return { region, date, roomCount: result.length, rooms: result };
  }, { state });
}

export async function reserve(ctx) {
  const { region, state, flags, payload, preview, force } = ctx;
  const p = payload || {};
  const date = flags.date || p.date;
  const itemId = flags.itemId || p.itemId;
  const roomName = flags.room || p.room;
  const startTime = flags.start || p.startTime;
  const endTime = flags.end || p.endTime;
  const title = flags.title || p.title;
  const headcount = flags.num || p.headcount;
  const content = flags.content || p.content || '';
  if (!date || !startTime || !endTime) throw new AsmError('VALIDATION', 'room-reserve requires --date, --start, --end (and --room or --itemId, --title, --num)');
  if (!title) throw new AsmError('VALIDATION', 'room-reserve requires --title');

  return withSession(region, async ({ page }) => {
    // resolve itemId from room name if needed
    let id = itemId;
    if (!id) {
      await gotoGuarded(page, region, listUrl(region, date), state);
      const rooms = await discoverRooms(page);
      const hit = rooms.find((r) => (r.name || '').includes(roomName || '___none___'));
      if (!hit) throw new AsmError('VALIDATION', `회의실 '${roomName}' 을 찾지 못했습니다.`, { rooms: rooms.map((r) => r.name) });
      id = hit.itemId;
    }
    await gotoGuarded(page, region, viewUrl(region, date, id), state);
    await waitSlots(page);
    const slots = await readSlots(page);
    // desired contiguous slots in [startTime, endTime)
    const wanted = [];
    for (let t = startTime; t < endTime; t = addMinutes(t, 30)) {
      const slot = slots.find((s) => s.time === t);
      if (!slot) throw new AsmError('VALIDATION', `슬롯 ${t} 이 존재하지 않습니다 (예약가능 시간 확인).`);
      if (slot.status === 'taken' && !force) throw new AsmError('WRITE_BLOCKED', `슬롯 ${t} 은 이미 예약됨${slot.reserver ? ' (' + slot.reserver + ')' : ''}.`, { slot });
      wanted.push(slot);
    }
    // fill fields
    await setText(page, sel('room', 'title'), title);
    if (headcount != null) await setText(page, sel('room', 'rentNum'), headcount);
    if (content) await setText(page, sel('room', 'infoCn'), content);
    // check each slot checkbox
    for (const s of wanted) {
      await page.locator(`#${s.id}`).check({ timeout: 4000 }).catch(async () => {
        await evalJson(page, (id2) => { const el = document.getElementById(id2); if (el && !el.checked) { el.checked = true; el.dispatchEvent(new Event('click', { bubbles: true })); } return true; }, s.id);
      });
    }
    if (preview) {
      const shot = artifact(`room-${region}-preview.png`);
      await page.screenshot({ path: shot, fullPage: true });
      return { preview: true, region, date, itemId: id, slots: wanted.map((w) => w.time), screenshot: shot };
    }
    page.on('dialog', (d) => d.accept().catch(() => {}));
    const nav = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
    await page.locator(sel('room', 'submitBtn')).first().click();
    await nav;
    const finalUrl = page.url();
    if (/view\.do/.test(finalUrl) && /itemId/.test(finalUrl)) {
      const shot = artifact(`room-${region}-error.png`);
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      throw new AsmError('WRITE_BLOCKED', '예약 제출이 확인되지 않았습니다.', { screenshot: shot, finalUrl });
    }
    return { reserved: true, region, date, itemId: id, slots: wanted.map((w) => w.time), finalUrl };
  }, { state });
}

export async function cancel(ctx) {
  const { region, state, flags, preview } = ctx;
  const rentId = flags.rentId || flags.id;
  if (!rentId) throw new AsmError('VALIDATION', 'room-cancel requires --rentId <id>');
  return withSession(region, async ({ page }) => {
    await gotoGuarded(page, region, `${regionUrl(region, url('room', 'rentView'))}&rentId=${encodeURIComponent(rentId)}`, state);
    const cancelSel = sel('room', 'cancelBtn');
    if ((await page.locator(cancelSel).count()) === 0) {
      throw new AsmError('SELECTOR_NOT_FOUND', '예약취소 버튼을 찾지 못했습니다.', { hint: `recon: --url "${url('room', 'rentView')}&rentId=${rentId}"` });
    }
    if (preview) {
      const shot = artifact(`room-cancel-preview.png`);
      await page.screenshot({ path: shot, fullPage: true });
      return { preview: true, region, rentId, screenshot: shot };
    }
    page.on('dialog', (d) => d.accept().catch(() => {}));
    await page.locator(cancelSel).first().click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    return { cancelled: true, region, rentId };
  }, { state });
}
